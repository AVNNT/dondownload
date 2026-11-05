import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// DownloadManager and Aria2Service import Electron for shell/app access. The
// integration test exercises the real aria2 process and real SQLite database,
// so only the Electron module itself is replaced.
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

import { buildAria2Args } from '../src/main/aria2/args'
import { Aria2Client } from '../src/main/aria2/client'
import {
  parseAria2Status,
  type Aria2StatusSnapshot
} from '../src/main/aria2/rpc'
import { Aria2Service } from '../src/main/aria2/service'
import { openDownloadDatabase } from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import { INTERRUPTED_MESSAGE } from '../src/main/downloads/recovery'
import { defaultDownloadSettings } from '../src/shared/settings'
import { parseCapturedSourceInput } from '../src/shared/capturedSource'
import type { DownloadItem } from '../src/shared/types'

/**
 * Optional end-to-end checks against a real aria2c binary. They are skipped
 * unless ARIA2_TEST_BINARY points at one, so the default test suite needs no
 * binary, network access, or installed tools.
 *
 * A local HTTP server serves a throttled >8 MiB payload and implements Range
 * requests (206 + Content-Range) so pause/resume and restart recovery are
 * exercised against real aria2 rather than mocked engine behavior.
 *
 * Example:
 *   $env:ARIA2_TEST_BINARY = 'C:\tools\aria2\aria2c.exe'
 *   npm test
 */
const aria2Binary = process.env.ARIA2_TEST_BINARY
const runIntegration = aria2Binary ? describe : describe.skip
const previousAria2Override = process.env.DONDOWNLOAD_ARIA2_PATH

const SMALL_PAYLOAD_SIZE = 512 * 1024
const LARGE_PAYLOAD_SIZE = 24 * 1024 * 1024 + 321
const THROTTLE_CHUNK_SIZE = 32 * 1024
const THROTTLE_CHUNK_DELAY_MS = 50

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('No port available.'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

/** Deterministic, non-repeating bytes make an exact comparison meaningful. */
function buildPayload(size: number, seed: number): Buffer {
  const payload = Buffer.allocUnsafe(size)
  for (let index = 0; index < size; index += 1) {
    payload[index] = (index * 31 + seed) & 0xff
  }
  return payload
}

interface RangeRequestRecord {
  start: number
  end: number
}

interface TestHttpServer {
  url: (filename: string) => string
  rangeRequests: RangeRequestRecord[]
  largeRequestCount: () => number
  close: () => Promise<void>
}

function parseRangeHeader(
  header: string | undefined,
  totalLength: number
): RangeRequestRecord | null | 'invalid' {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'

  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'

  let start: number
  let end: number
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    start = Math.max(0, totalLength - suffixLength)
    end = totalLength - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? totalLength - 1 : Number(rawEnd)
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalLength
  ) {
    return 'invalid'
  }

  return { start, end: Math.min(end, totalLength - 1) }
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      response.removeListener('drain', finish)
      response.removeListener('close', finish)
      response.removeListener('error', finish)
      resolve()
    }
    response.once('drain', finish)
    response.once('close', finish)
    response.once('error', finish)
  })
}

/** Write slowly enough that a pause reliably lands before completion. */
async function writeThrottled(
  response: ServerResponse,
  body: Buffer
): Promise<void> {
  for (let offset = 0; offset < body.length; offset += THROTTLE_CHUNK_SIZE) {
    if (response.destroyed || response.writableEnded) return

    const chunk = body.subarray(
      offset,
      Math.min(offset + THROTTLE_CHUNK_SIZE, body.length)
    )
    if (!response.write(chunk)) {
      await waitForDrain(response)
    }
    if (offset + THROTTLE_CHUNK_SIZE < body.length) {
      await delay(THROTTLE_CHUNK_DELAY_MS)
    }
  }

  if (!response.destroyed && !response.writableEnded) {
    response.end()
  }
}

function serveBuffer(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
  filename: string,
  throttle: boolean,
  range: RangeRequestRecord | null
): void {
  const start = range?.start ?? 0
  const end = range?.end ?? body.length - 1
  const headers: Record<string, string | number> = {
    'content-type': 'application/octet-stream',
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${filename}"`
  }
  if (range) {
    headers['content-range'] = `bytes ${start}-${end}/${body.length}`
  }

  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const slice = body.subarray(start, end + 1)
  if (!throttle) {
    response.end(slice)
    return
  }

  void writeThrottled(response, slice).catch(() => {
    if (!response.destroyed) response.destroy()
  })
}

function startHttpServer(
  smallPayload: Buffer,
  largePayload: Buffer
): Promise<TestHttpServer> {
  const rangeRequests: RangeRequestRecord[] = []
  const sockets = new Set<Socket>()
  let largeRequests = 0

  const server = createHttpServer((request, response) => {
    // Client disconnects during pause are normal; never surface them as
    // unhandled response errors.
    response.on('error', () => undefined)

    const pathname = new URL(
      request.url ?? '/',
      'http://127.0.0.1'
    ).pathname

    if (pathname === '/integration-sample.bin') {
      serveBuffer(
        request,
        response,
        smallPayload,
        'integration-sample.bin',
        false,
        null
      )
      return
    }

    if (pathname === '/range-sample.bin') {
      largeRequests += 1
      const range = parseRangeHeader(
        request.headers.range,
        largePayload.length
      )
      if (range === 'invalid') {
        response.writeHead(416, {
          'content-range': `bytes */${largePayload.length}`
        })
        response.end()
        return
      }
      if (range) rangeRequests.push(range)
      serveBuffer(
        request,
        response,
        largePayload,
        'range-sample.bin',
        true,
        range
      )
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('Not found')
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        reject(new Error('HTTP test server did not start.'))
        return
      }

      resolve({
        url: (filename: string) =>
          `http://127.0.0.1:${address.port}/${filename}`,
        rangeRequests,
        largeRequestCount: () => largeRequests,
        close: async () => {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.closeAllConnections?.()
          await new Promise<void>((done) => {
            server.close(() => done())
          })
        }
      })
    })
  })
}

async function waitForAria2Status(
  client: Aria2Client,
  gid: string,
  predicate: (status: Aria2StatusSnapshot) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<Aria2StatusSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last: Aria2StatusSnapshot | null = null

  while (Date.now() < deadline) {
    last = parseAria2Status(
      await client.call<unknown>('aria2.tellStatus', [gid])
    )
    if (predicate(last)) return last
    await delay(100)
  }

  throw new Error(
    `Timed out waiting for ${label}. Last aria2 status: ${JSON.stringify(last)}`
  )
}

function getDownload(manager: DownloadManager, id: string): DownloadItem {
  const download = manager
    .getSnapshot()
    .downloads.find((record) => record.id === id)
  if (!download) throw new Error(`Download ${id} is missing from the snapshot.`)
  return download
}

async function waitForDownload(
  manager: DownloadManager,
  id: string,
  predicate: (download: DownloadItem) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<DownloadItem> {
  const deadline = Date.now() + timeoutMs
  let last: DownloadItem | null = null

  while (Date.now() < deadline) {
    last = getDownload(manager, id)
    if (predicate(last)) return last
    await delay(100)
  }

  throw new Error(
    `Timed out waiting for ${label}. Last download state: ${JSON.stringify(last)}`
  )
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null) return

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      child.removeListener('exit', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('exit', finish)
  })
}

async function removeDirectory(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch {
      if (attempt === 9) return
      await delay(200)
    }
  }
}

runIntegration('aria2 HTTP integration', () => {
  let httpServer: TestHttpServer | null = null
  let child: ChildProcess | null = null
  let client: Aria2Client | null = null
  let downloadDir = ''
  let url = ''
  let rangeUrl = ''
  let payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let rangePayload: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  const services: Aria2Service[] = []
  const managers: DownloadManager[] = []
  const tempDirs: string[] = []

  const requireClient = (): Aria2Client => {
    if (!client) throw new Error('aria2 client is not ready.')
    return client
  }

  beforeAll(async () => {
    payload = buildPayload(SMALL_PAYLOAD_SIZE, 0x61)
    rangePayload = buildPayload(LARGE_PAYLOAD_SIZE, 0x17)

    httpServer = await startHttpServer(payload, rangePayload)
    url = httpServer.url('integration-sample.bin')
    rangeUrl = httpServer.url('range-sample.bin')

    downloadDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dondownload-integration-')
    )
    tempDirs.push(downloadDir)

    // Aria2Service locates the binary through the same public override a user
    // would use, so the restart test runs the real production launch path.
    process.env.DONDOWNLOAD_ARIA2_PATH = aria2Binary as string

    const port = await findFreePort()
    const secret = 'integration-test-secret'
    child = spawn(
      aria2Binary as string,
      buildAria2Args({ port, secret, downloadDir }),
      { shell: false, windowsHide: true, stdio: 'ignore' }
    )
    client = new Aria2Client(port, secret)

    let ready = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await client.getVersion()
        ready = true
        break
      } catch {
        await delay(100)
      }
    }
    expect(ready).toBe(true)
  }, 30_000)

  afterAll(async () => {
    for (const manager of managers.splice(0)) {
      try {
        manager.close()
      } catch {
        // Best effort during teardown.
      }
    }
    for (const service of services.splice(0)) {
      try {
        await service.stop()
      } catch {
        // Best effort during teardown.
      }
    }
    try {
      await client?.call('aria2.shutdown')
    } catch {
      // aria2 may already have exited.
    }
    if (child) {
      child.kill()
      await waitForExit(child, 3_000)
    }
    if (httpServer) {
      try {
        await httpServer.close()
      } catch {
        // Best effort during teardown.
      }
      httpServer = null
    }
    for (const dir of tempDirs.splice(0)) {
      await removeDirectory(dir)
    }
    if (previousAria2Override === undefined) {
      delete process.env.DONDOWNLOAD_ARIA2_PATH
    } else {
      process.env.DONDOWNLOAD_ARIA2_PATH = previousAria2Override
    }
  })

  it('downloads a real file over HTTP and reports completion', async () => {
    const activeClient = requireClient()
    const gid = await activeClient.call<string>('aria2.addUri', [
      [url],
      { dir: downloadDir, out: 'integration-sample.bin', 'max-tries': '1' }
    ])
    expect(gid).toMatch(/^[0-9a-f]{16}$/i)

    const status = await waitForAria2Status(
      activeClient,
      gid,
      (current) => current.status === 'complete' || current.status === 'error',
      'the HTTP download to finish',
      20_000
    )

    expect(status.status).toBe('complete')
    expect(status.completedLength).toBe(payload.length)

    const downloaded = await fs.readFile(
      path.join(downloadDir, 'integration-sample.bin')
    )
    expect(downloaded.length).toBe(payload.length)
    expect(downloaded.equals(payload)).toBe(true)
  }, 30_000)

  it('queues a captured progressive source through the exact contract and verifies bytes', async () => {
    if (!httpServer) throw new Error('HTTP test server is not ready.')

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dondownload-captured-source-integration-')
    )
    tempDirs.push(root)
    const capturedDir = path.join(root, 'downloads')
    const filename = 'captured-sample.mp4'
    const filePath = path.join(capturedDir, filename)
    const service = new Aria2Service(() => capturedDir)
    const manager = new DownloadManager(service, capturedDir, () => undefined)
    services.push(service)
    managers.push(manager)

    await service.start()

    // The fixture origin is loopback, so this focused integrity check uses the
    // same shared input contract and the same DownloadManager.add route that the
    // native bridge calls after its public-target check. Public/private target
    // rejection is covered separately with an injected DNS lookup; no target
    // validation is weakened here or in production.
    const captured = parseCapturedSourceInput({ url, filename })
    const observedAt = Date.now()
    const added = await manager.add(captured)
    const acceptedMs = Date.now() - observedAt
    const id = added.downloads[0]?.id
    if (!id) throw new Error('The captured source has no download id.')

    const accepted = getDownload(manager, id)
    expect(accepted.filename).toBe(filename)
    const completed = await waitForDownload(
      manager,
      id,
      (download) => download.status === 'complete',
      'the captured progressive fixture to complete',
      20_000
    )
    const completedMs = Date.now() - observedAt
    expect(completed.completedBytes).toBe(payload.length)

    const downloaded = await fs.readFile(filePath)
    const expectedHash = createHash('sha256').update(payload).digest('hex')
    const actualHash = createHash('sha256').update(downloaded).digest('hex')
    expect(downloaded.length).toBe(payload.length)
    expect(actualHash).toBe(expectedHash)

    console.info(
      `[captured-source fixture] bytes=${payload.length} accepted=${acceptedMs}ms complete=${completedMs}ms`
    )
  }, 30_000)

  it('pauses and resumes a real HTTP Range download to completion', async () => {
    const activeClient = requireClient()
    const filename = 'range-resume-sample.bin'
    const filePath = path.join(downloadDir, filename)

    const gid = await activeClient.call<string>('aria2.addUri', [
      [rangeUrl],
      {
        dir: downloadDir,
        out: filename,
        'max-tries': '1',
        'continue': 'true'
      }
    ])
    expect(gid).toMatch(/^[0-9a-f]{16}$/i)

    const partial = await waitForAria2Status(
      activeClient,
      gid,
      (current) =>
        current.status === 'active' &&
        current.completedLength > 0 &&
        current.completedLength < rangePayload.length &&
        (httpServer?.rangeRequests.length ?? 0) > 0,
      'a partial Range download',
      20_000
    )
    expect(partial.totalLength).toBe(rangePayload.length)
    expect(httpServer?.rangeRequests.length ?? 0).toBeGreaterThan(0)

    await activeClient.call('aria2.pause', [gid])
    const paused = await waitForAria2Status(
      activeClient,
      gid,
      (current) => current.status === 'paused',
      'aria2 to pause the transfer',
      10_000
    )
    expect(paused.completedLength).toBeGreaterThan(0)
    expect(paused.completedLength).toBeLessThan(rangePayload.length)

    const pausedSize = (await fs.stat(filePath)).size
    expect(pausedSize).toBeGreaterThan(0)

    await delay(500)
    const stillPaused = await waitForAria2Status(
      activeClient,
      gid,
      (current) => current.status === 'paused',
      'the paused transfer to stay paused',
      5_000
    )
    expect(stillPaused.completedLength).toBe(paused.completedLength)

    await activeClient.call('aria2.unpause', [gid])
    const completed = await waitForAria2Status(
      activeClient,
      gid,
      (current) => current.status === 'complete' || current.status === 'error',
      'the resumed download to finish',
      45_000
    )
    expect(completed.status).toBe('complete')
    expect(completed.completedLength).toBe(rangePayload.length)

    expect(httpServer?.rangeRequests.length ?? 0).toBeGreaterThan(0)
    expect(
      (httpServer?.rangeRequests ?? []).some((range) => range.start > 0)
    ).toBe(true)

    const downloaded = await fs.readFile(filePath)
    expect(downloaded.length).toBe(rangePayload.length)
    expect(downloaded.equals(rangePayload)).toBe(true)
  }, 60_000)

  it('holds a scheduled download before submitting it to real aria2, then starts it when due', async () => {
    if (!httpServer) throw new Error('HTTP test server is not ready.')

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dondownload-schedule-integration-')
    )
    tempDirs.push(root)
    const scheduledDir = path.join(root, 'downloads')
    const filename = 'scheduled-sample.bin'
    const filePath = path.join(scheduledDir, filename)
    const service = new Aria2Service(() => scheduledDir)
    const manager = new DownloadManager(
      service,
      scheduledDir,
      () => undefined
    )
    services.push(service)
    managers.push(manager)

    await service.start()
    const scheduledAt = Date.now() + 2_500
    const added = await manager.add({
      url,
      filename,
      controls: {
        scheduledAt,
        speedLimitBps: null,
        connections: null
      }
    })
    const id = added.downloads[0]?.id
    if (!id) throw new Error('The scheduled download has no id.')

    const held = getDownload(manager, id)
    expect(held.status).toBe('waiting')
    expect(held.blockReason).toBe('scheduled')
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })

    // Check before the due timestamp that the manager has not submitted a
    // transfer or created its output. All network traffic remains loopback-only.
    await delay(Math.max(100, scheduledAt - Date.now() - 300))
    expect(Date.now()).toBeLessThan(scheduledAt)
    expect(getDownload(manager, id).status).toBe('waiting')
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })

    const completed = await waitForDownload(
      manager,
      id,
      (download) => download.status === 'complete',
      'the scheduled local download to start and complete',
      20_000
    )
    expect(completed.completedBytes).toBe(payload.length)
    const downloaded = await fs.readFile(filePath)
    expect(downloaded.equals(payload)).toBe(true)
  }, 30_000)

  it('holds outside-hours work, honors Start Now, and lets active work finish after close', async () => {
    if (!httpServer) throw new Error('HTTP test server is not ready.')

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dondownload-hours-integration-')
    )
    tempDirs.push(root)
    const hoursDir = path.join(root, 'downloads')
    const service = new Aria2Service(() => hoursDir)
    let fakeNow = new Date(2026, 10, 4, 18, 0, 0).getTime()
    const manager = new DownloadManager(
      service,
      hoursDir,
      () => undefined,
      null,
      {
        now: () => fakeNow,
        settings: () => ({
          ...defaultDownloadSettings(),
          allowedHours: { enabled: true, start: '09:00', end: '17:00' }
        })
      }
    )
    services.push(service)
    managers.push(manager)
    await service.start()

    const queuedName = 'outside-hours-sample.bin'
    const queued = await manager.add({ url, filename: queuedName })
    const queuedId = queued.downloads[0]?.id
    if (!queuedId) throw new Error('The outside-hours download has no id.')
    expect(getDownload(manager, queuedId)).toMatchObject({
      status: 'waiting',
      blockReason: 'allowed-hours'
    })
    await expect(
      fs.stat(path.join(hoursDir, queuedName))
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await manager.startNow(queuedId)
    const overrideComplete = await waitForDownload(
      manager,
      queuedId,
      (download) => download.status === 'complete',
      'Start Now to override closed allowed hours',
      20_000
    )
    expect(overrideComplete.completedBytes).toBe(payload.length)

    // Start a throttled loopback transfer just before the exclusive end. After
    // the policy pass at 17:00, it must remain active and complete normally.
    fakeNow = new Date(2026, 10, 4, 16, 59, 0).getTime()
    const activeName = 'active-after-hours-sample.bin'
    const active = await manager.add({ url: rangeUrl, filename: activeName })
    const activeId = active.downloads.find(
      (download) => download.filename === activeName
    )?.id
    if (!activeId) throw new Error('The active-hours download has no id.')
    const progressing = await waitForDownload(
      manager,
      activeId,
      (download) => download.status === 'active' && download.completedBytes > 0,
      'the in-hours transfer to make progress',
      20_000
    )
    expect(progressing.totalBytes).toBe(rangePayload.length)

    fakeNow = new Date(2026, 10, 4, 17, 0, 0).getTime()
    await manager.refreshPolicy()
    expect(getDownload(manager, activeId).status).toBe('active')

    const completed = await waitForDownload(
      manager,
      activeId,
      (download) => download.status === 'complete',
      'an active transfer to finish after allowed hours close',
      60_000
    )
    expect(completed.completedBytes).toBe(rangePayload.length)
    expect(
      (await fs.readFile(path.join(hoursDir, activeName))).equals(rangePayload)
    ).toBe(true)
  }, 90_000)

  it('marks a lost transfer interrupted after restart, keeps the partial file, and retries it with Range', async () => {
    const testServer = httpServer
    if (!testServer) throw new Error('HTTP test server is not ready.')

    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'dondownload-restart-integration-')
    )
    tempDirs.push(root)
    const databasePath = path.join(root, 'downloads.sqlite3')
    const restartDir = path.join(root, 'downloads')
    const filename = 'restart-sample.bin'
    const filePath = path.join(restartDir, filename)

    let firstManager: DownloadManager | null = null
    let secondManager: DownloadManager | null = null
    let firstService: Aria2Service | null = null
    let secondService: Aria2Service | null = null

    try {
      firstManager = new DownloadManager(
        (firstService = new Aria2Service(() => restartDir)),
        restartDir,
        () => undefined,
        openDownloadDatabase(databasePath)
      )
      services.push(firstService)
      managers.push(firstManager)
      await firstService.start()

      const added = await firstManager.add({ url: rangeUrl, filename })
      const id = added.downloads[0]?.id
      if (!id) throw new Error('The added download has no id.')

      const active = await waitForDownload(
        firstManager,
        id,
        (download) => download.status === 'active' && download.completedBytes > 0,
        'the download to make progress',
        20_000
      )
      expect(active.totalBytes).toBe(rangePayload.length)

      // Pause first so the partial file is stable and deterministic, then
      // resume and close while active. A real app restart would persist the
      // active/waiting state this way; the next daemon no longer knows the GID.
      await firstManager.pause(id)
      const pausedBytes = getDownload(firstManager, id).completedBytes
      expect(pausedBytes).toBeGreaterThan(0)
      expect(pausedBytes).toBeLessThan(rangePayload.length)
      expect((await fs.stat(filePath)).size).toBeGreaterThan(0)

      await firstManager.resume(id)
      await waitForDownload(
        firstManager,
        id,
        (download) =>
          download.status === 'active' && download.completedBytes > pausedBytes,
        'the download to resume before the restart',
        20_000
      )
      firstManager.flushPersistence()
      expect(getDownload(firstManager, id).status).toBe('active')

      // Stop the old daemon and close everything as an app shutdown would.
      firstManager.close()
      await firstService.stop()
      await delay(500)

      const keptSize = (await fs.stat(filePath)).size
      expect(keptSize).toBeGreaterThan(0)
      const requestsBeforeRestart = testServer.largeRequestCount()

      const reopenedDatabase = openDownloadDatabase(databasePath)
      secondService = new Aria2Service(() => restartDir)
      services.push(secondService)
      await secondService.start()
      secondManager = new DownloadManager(
        secondService,
        restartDir,
        () => undefined,
        reopenedDatabase
      )
      managers.push(secondManager)

      await secondManager.reconcileDownloads()

      const recovered = getDownload(secondManager, id)
      expect(recovered.status).toBe('interrupted')
      expect(recovered.errorMessage).toBe(INTERRUPTED_MESSAGE)
      expect((await fs.stat(filePath)).size).toBe(keptSize)

      // Reconciliation must not re-add the transfer. Wait well past the poll
      // interval and confirm neither progress nor new HTTP traffic happens.
      await delay(1_500)
      const afterReconcile = getDownload(secondManager, id)
      expect(afterReconcile.status).toBe('interrupted')
      expect(afterReconcile.completedBytes).toBe(recovered.completedBytes)
      expect(testServer.largeRequestCount()).toBe(requestsBeforeRestart)
      expect((await fs.stat(filePath)).size).toBe(keptSize)

      const rangeCountBeforeRetry = testServer.rangeRequests.length
      await secondManager.retry(id)
      const completed = await waitForDownload(
        secondManager,
        id,
        (download) => download.status === 'complete',
        'the retried download to finish',
        60_000
      )
      expect(completed.completedBytes).toBe(rangePayload.length)

      const retryRanges = testServer.rangeRequests.slice(rangeCountBeforeRetry)
      expect(retryRanges.length).toBeGreaterThan(0)
      expect(retryRanges.some((range) => range.start > 0)).toBe(true)

      const downloaded = await fs.readFile(filePath)
      expect(downloaded.length).toBe(rangePayload.length)
      expect(downloaded.equals(rangePayload)).toBe(true)
    } finally {
      for (const manager of [firstManager, secondManager]) {
        try {
          manager?.close()
        } catch {
          // Best effort if the test failed midway.
        }
      }
      for (const service of [firstService, secondService]) {
        try {
          await service?.stop()
        } catch {
          // Best effort if the test failed midway.
        }
      }
    }
  }, 120_000)
})
