import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import { openDownloadDatabase, type DownloadDatabase } from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import type { CookieTargetResolver } from '../src/main/downloads/manager'
import {
  startNativeBridge,
  type BridgeDownloadManager,
  type NativeBridge
} from '../src/main/nativeBridge/server'
import { parseNativeBridgeEndpoint } from '../src/shared/nativeBridge'

const tempDirs: string[] = []
const managers: DownloadManager[] = []
const bridges: NativeBridge[] = []
const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

interface AriaCall {
  method: string
  params: unknown[]
}

async function makeWorkspace(): Promise<{
  dir: string
  database: DownloadDatabase
  downloadDir: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-durable-'))
  tempDirs.push(dir)
  return {
    dir,
    database: openDownloadDatabase(path.join(dir, 'downloads.sqlite3')),
    downloadDir: path.join(dir, 'downloads')
  }
}

function createManager(
  database: DownloadDatabase | null,
  downloadDir: string,
  options: { resolveCookieTarget?: CookieTargetResolver } = {}
): { manager: DownloadManager; calls: AriaCall[]; gids: string[] } {
  const calls: AriaCall[] = []
  const gids: string[] = []
  let nextGid = 0
  const state: Aria2State = {
    status: 'ready',
    version: 'test-aria2',
    binaryPath: null,
    message: null,
    hint: null
  }
  const client = {
    call: async (method: string, params: unknown[]): Promise<unknown> => {
      calls.push({ method, params })
      if (method === 'aria2.addUri') {
        nextGid += 1
        const gid = nextGid.toString(16).padStart(16, '0')
        gids.push(gid)
        return gid
      }
      if (
        method === 'aria2.forceRemove' ||
        method === 'aria2.removeDownloadResult'
      ) {
        return 'OK'
      }
      throw new Error(`Unexpected method ${method}`)
    }
  }
  const aria2 = {
    getState: () => ({ ...state }),
    getReadyClient: () => client,
    getClient: async () => client,
    start: async () => client,
    stop: async () => undefined,
    restart: async () => undefined
  } as unknown as Aria2Service
  const manager = new DownloadManager(
    aria2,
    downloadDir,
    () => undefined,
    database,
    {
      now: () => 1_800_000_000_000,
      ...(options.resolveCookieTarget === undefined
        ? {}
        : { resolveCookieTarget: options.resolveCookieTarget })
    }
  )
  managers.push(manager)
  return { manager, calls, gids }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    try {
      await bridge.close()
    } catch {
      // Best effort for a failing test.
    }
  }
  for (const manager of managers.splice(0)) {
    try {
      manager.close()
    } catch {
      // Best effort for a failing test.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('browser login jobs stay out of persistence', () => {
  it('passes one-job headers to aria2, stores no cookie, and fails honestly after restart', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir, {
      resolveCookieTarget: async (input) => ({ finalUrl: input.url })
    })
    const cookie = 'session=super-secret-cookie-value'
    const receipt = await manager.addDurable({
      url: 'https://example.com/files/report.zip',
      requestHeaders: {
        referer: 'https://example.com/page',
        userAgent: 'BrowserAgent/1.0',
        cookie
      }
    })
    expect(receipt.downloadId).toBeTruthy()

    const addCall = calls.find((entry) => entry.method === 'aria2.addUri')
    const options = addCall?.params[1] as Record<string, unknown>
    expect(options.header).toEqual([`Cookie: ${cookie}`])
    expect(options.referer).toBe('https://example.com/page')
    expect(options['user-agent']).toBe('BrowserAgent/1.0')

    // The database stores only a boolean marker. Read the main file and WAL so
    // a value accidentally written to either is caught.
    const persisted: Buffer[] = []
    for (const name of ['downloads.sqlite3', 'downloads.sqlite3-wal']) {
      try {
        persisted.push(await readFile(path.join(dir, name)))
      } catch {
        // WAL may not exist after a checkpoint.
      }
    }
    const persistedText = Buffer.concat(persisted).toString('latin1')
    expect(persistedText).toContain('report.zip')
    expect(persistedText).not.toContain('super-secret-cookie-value')
    expect(persistedText).not.toContain('Cookie:')

    manager.close()
    const reopened = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
    const restarted = createManager(reopened, downloadDir)
    await restarted.manager.reconcileDownloads()
    const row = restarted.manager
      .getSnapshot()
      .downloads.find((entry) => entry.id === receipt.downloadId)
    expect(row).toMatchObject({
      status: 'error',
      errorMessage:
        'This download needs your browser login again — click it in the browser to restart'
    })
    await expect(restarted.manager.retry(receipt.downloadId)).rejects.toMatchObject(
      { code: 'HANDOFF_NEEDS_BROWSER_LOGIN' }
    )
  })
})

describe('strict durable hand-off', () => {
  it('returns a verified receipt, rolls back uncertain aria2 work, and exposes a separate fail-closed route', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    const { manager, calls, gids } = createManager(database, downloadDir)

    const receipt = await manager.addDurable({
      url: 'https://example.com/files/report.zip'
    })
    expect(receipt).toEqual({
      downloadId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      persistedAt: 1_800_000_000_000
    })
    expect(database.loadAll()).toHaveLength(1)
    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(calls.map((entry) => entry.method)).toEqual(['aria2.addUri'])

    // A failed/uncertain SQLite write must remove both the local row and the
    // aria2 job it just queued, then report failure so the browser keeps its
    // own download.
    const writeFailure = vi
      .spyOn(database, 'saveDurable')
      .mockImplementation(() => {
        throw new Error('disk unavailable')
      })
    await expect(
      manager.addDurable({ url: 'https://example.com/files/second.zip' })
    ).rejects.toMatchObject({ code: 'DURABLE_PERSISTENCE_FAILED' })
    writeFailure.mockRestore()

    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(database.loadAll()).toHaveLength(1)
    expect(gids).toHaveLength(2)
    expect(calls.map((entry) => entry.method)).toEqual([
      'aria2.addUri',
      'aria2.addUri',
      'aria2.forceRemove',
      'aria2.removeDownloadResult'
    ])
    expect(calls[2]?.params).toEqual([gids[1]])

    // No database means no durable promise: reject before queuing anything.
    const noDatabaseDir = path.join(dir, 'no-database')
    const noDatabase = createManager(null, noDatabaseDir)
    await expect(
      noDatabase.manager.addDurable({
        url: 'https://example.com/files/third.zip'
      })
    ).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' })
    expect(noDatabase.calls).toEqual([])
    expect(noDatabase.manager.getSnapshot().downloads).toHaveLength(0)

    // The bridge route is separate from queue-download and requires the
    // additive manager capability. Without it the browser download is kept.
    const bridgeManager: BridgeDownloadManager = {
      add: async () => ({ accepted: true }),
      addDurable: async () => ({
        downloadId: DOWNLOAD_ID,
        persistedAt: 1_800_000_000_000
      })
    }
    let preflightCalls = 0
    const bridge = await startNativeBridge({
      manager: bridgeManager,
      userDataPath: dir,
      logger: () => undefined,
      publicTargetLookup: async () => [
        { address: '93.184.216.34', family: 4 }
      ],
      publicResourcePreflight: async (input) => {
        preflightCalls += 1
        return {
          finalUrl: input.url,
          status: 206,
          contentType: 'application/zip',
          contentDisposition: null,
          totalBytes: 4
        }
      }
    })
    bridges.push(bridge)
    const endpoint = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )

    async function postHandoff(body: unknown): Promise<Response> {
      return fetch(`http://127.0.0.1:${endpoint.port}/handoff-download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    }

    const accepted = await postHandoff({
      url: 'https://example.com/files/report.zip'
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      ok: true,
      accepted: true,
      operation: 'handoff-download',
      durable: true,
      receipt: {
        downloadId: DOWNLOAD_ID,
        persistedAt: 1_800_000_000_000
      }
    })
    expect(preflightCalls).toBe(1)

    delete bridgeManager.addDurable
    const unavailable = await postHandoff({
      url: 'https://example.com/files/report.zip'
    })
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'HANDOFF_UNAVAILABLE' }
    })
  })

  it('answers a duplicate browser hand-off with the existing completed receipt and never preflights or downloads again', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    await mkdir(downloadDir, { recursive: true })
    const filePath = path.join(downloadDir, 'already-here.zip')
    await writeFile(filePath, 'data')
    const now = Date.UTC(2026, 2, 4, 5, 6, 7)
    database.save({
      record: {
        id: DOWNLOAD_ID,
        gid: '0123456789abcdef',
        url: 'https://example.com/files/already-here.zip',
        filename: 'already-here.zip',
        dir: downloadDir,
        filePath,
        status: 'complete',
        totalBytes: 4,
        completedBytes: 4,
        speedBps: 0,
        etaSeconds: 0,
        errorMessage: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
        completedAt: now
      },
      explicitFilename: null
    })
    const { manager, calls } = createManager(database, downloadDir)
    const duplicates: unknown[] = []
    let preflightCalls = 0

    const bridge = await startNativeBridge({
      manager,
      userDataPath: dir,
      logger: () => undefined,
      publicTargetLookup: async () => [
        { address: '93.184.216.34', family: 4 }
      ],
      publicResourcePreflight: async (input) => {
        preflightCalls += 1
        return {
          finalUrl: input.url,
          status: 206,
          contentType: 'application/zip',
          contentDisposition: null,
          totalBytes: 4
        }
      },
      onDuplicateHandoff: (duplicate) => {
        duplicates.push(duplicate)
      }
    })
    bridges.push(bridge)
    const endpoint = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )

    const response = await fetch(
      `http://127.0.0.1:${endpoint.port}/handoff-download`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: 'HTTPS://Example.com:443/files/already-here.zip#again'
        })
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      accepted: true,
      operation: 'handoff-download',
      durable: true,
      receipt: { downloadId: DOWNLOAD_ID, persistedAt: now }
    })
    // The indexed local lookup answered before any network probe or job.
    expect(preflightCalls).toBe(0)
    expect(calls).toEqual([])
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toMatchObject({
      kind: 'download',
      state: 'finished',
      filename: 'already-here.zip',
      fileExists: true
    })
    expect(manager.getSnapshot().downloads).toHaveLength(1)
  })

  it('reuses the hand-off preflight final URL so a cross-host redirect reaches aria2 without the cookie', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    const finalUrl =
      'https://storage.example/bucket/report.zip?X-Amz-Signature=abc'
    // The bridge's preflight already verified `finalUrl`; the manager receives
    // it as `resolvedUrl` and must hand exactly that to aria2. The resolver
    // stands in for the production one, which re-validates the value over DNS.
    const { manager, calls } = createManager(database, downloadDir, {
      resolveCookieTarget: async (input) => ({
        finalUrl: input.resolvedUrl ?? input.url
      })
    })

    const bridge = await startNativeBridge({
      manager,
      userDataPath: dir,
      logger: () => undefined,
      publicTargetLookup: async () => [
        { address: '93.184.216.34', family: 4 }
      ],
      publicResourcePreflight: async () => ({
        finalUrl,
        status: 206,
        contentType: 'application/zip',
        contentDisposition: null,
        totalBytes: 4
      })
    })
    bridges.push(bridge)
    const endpoint = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )

    const response = await fetch(
      `http://127.0.0.1:${endpoint.port}/handoff-download`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: 'https://discuss.example/files/report.zip',
          filename: 'report.zip',
          cookie: 'forum_session=secret'
        })
      }
    )
    expect(response.status).toBe(200)

    const addCall = calls.find((entry) => entry.method === 'aria2.addUri')
    const urls = addCall?.params[0] as string[]
    const options = addCall?.params[1] as Record<string, unknown>
    expect(urls).toEqual([finalUrl])
    expect(options.header).toBeUndefined()
  })
})

describe('automatic browser download takeover', () => {
  it('accepts a direct media file and keeps the browser cookies in memory only', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir, {
      resolveCookieTarget: async (input) => ({ finalUrl: input.url })
    })
    const cookie = 'session=super-secret-video-cookie'
    const preflights: unknown[] = []

    const bridge = await startNativeBridge({
      manager,
      userDataPath: dir,
      logger: () => undefined,
      publicTargetLookup: async () => [
        { address: '93.184.216.34', family: 4 }
      ],
      publicResourcePreflight: async (input) => {
        preflights.push(input)
        return {
          finalUrl: input.url,
          status: 206,
          contentType: 'video/mp4',
          contentDisposition: null,
          totalBytes: 25_000_000
        }
      }
    })
    bridges.push(bridge)
    const endpoint = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )

    async function postHandoff(body: unknown): Promise<Response> {
      return fetch(`http://127.0.0.1:${endpoint.port}/handoff-download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    }

    const accepted = await postHandoff({
      url: 'https://example.com/media/clip.mp4',
      filename: 'clip.mp4',
      expectedBytes: 25_000_000,
      expectedContentType: 'video/mp4',
      referer: 'https://example.com/watch',
      userAgent: 'BrowserAgent/1.0',
      cookie
    })
    expect(accepted.status).toBe(200)
    const body = (await accepted.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      accepted: true,
      durable: true,
      operation: 'handoff-download'
    })

    // The preflight saw the browser headers and was allowed to accept media.
    expect(preflights).toHaveLength(1)
    expect(preflights[0]).toMatchObject({
      url: 'https://example.com/media/clip.mp4',
      allowMedia: true,
      expectedContentType: 'video/mp4',
      expectedBytes: 25_000_000,
      requestHeaders: {
        referer: 'https://example.com/watch',
        userAgent: 'BrowserAgent/1.0',
        cookie
      }
    })

    const addCall = calls.find((entry) => entry.method === 'aria2.addUri')
    const urls = addCall?.params[0] as string[]
    const options = addCall?.params[1] as Record<string, unknown>
    expect(urls).toEqual(['https://example.com/media/clip.mp4'])
    expect(options.header).toEqual([`Cookie: ${cookie}`])
    expect(options.referer).toBe('https://example.com/watch')

    // The cookie lives only in the manager's in-memory request-header map and
    // never reaches SQLite, a session file or the download row.
    const receipt = body.receipt as { downloadId: string }
    const stored = manager
      .getSnapshot()
      .downloads.find((entry) => entry.id === receipt.downloadId)
    expect(stored).toMatchObject({ url: 'https://example.com/media/clip.mp4' })
    expect(JSON.stringify(stored)).not.toContain('super-secret-video-cookie')

    const persisted: Buffer[] = []
    for (const name of ['downloads.sqlite3', 'downloads.sqlite3-wal']) {
      try {
        persisted.push(await readFile(path.join(dir, name)))
      } catch {
        // WAL may not exist after a checkpoint.
      }
    }
    const persistedText = Buffer.concat(persisted).toString('latin1')
    expect(persistedText).toContain('clip.mp4')
    expect(persistedText).not.toContain('super-secret-video-cookie')
    expect(persistedText).not.toContain('Cookie:')
    expect(JSON.stringify(database.loadAll())).not.toContain(
      'super-secret-video-cookie'
    )

    // A restart cannot recover the cookie: the job fails honestly instead of
    // retrying without the login.
    manager.close()
    const reopened = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
    const restarted = createManager(reopened, downloadDir)
    await restarted.manager.reconcileDownloads()
    const afterRestart = restarted.manager
      .getSnapshot()
      .downloads.find((entry) => entry.id === receipt.downloadId)
    expect(afterRestart).toMatchObject({ status: 'error' })
    expect(JSON.stringify(afterRestart)).not.toContain(
      'super-secret-video-cookie'
    )
  })

  it('still rejects HTML pages, HLS/DASH manifests and segments', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir)
    const bridge = await startNativeBridge({
      manager,
      userDataPath: dir,
      logger: () => undefined,
      publicTargetLookup: async () => [
        { address: '93.184.216.34', family: 4 }
      ],
      publicResourcePreflight: async (input) => ({
        finalUrl: input.url,
        status: 206,
        contentType: 'video/mp4',
        contentDisposition: null,
        totalBytes: 4
      })
    })
    bridges.push(bridge)
    const endpoint = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )

    for (const body of [
      { url: 'https://example.com/page/index.html', expectedContentType: 'text/html' },
      { url: 'https://example.com/media/master.m3u8' },
      { url: 'https://example.com/media/manifest.mpd' },
      { url: 'https://example.com/media/segment.m4s' },
      { url: 'https://example.com/download', filename: 'saved.html' },
      { url: 'https://example.com/download', expectedContentType: 'application/x-mpegurl' }
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${endpoint.port}/handoff-download`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }
      )
      expect(response.status, JSON.stringify(body)).toBe(400)
      const result = (await response.json()) as Record<string, unknown>
      expect(result).toMatchObject({ ok: false })
    }
    expect(calls).toEqual([])
  })
})
