import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const hostExecutable = path.join(
  process.cwd(),
  'native',
  'dondownload-native-host.exe'
)
const hostAvailable = process.platform === 'win32' && existsSync(hostExecutable)
const describeWindows = hostAvailable ? describe : describe.skip

interface RequestRecord {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

interface FakeApp {
  port: number
  token: string
  requests: RequestRecord[]
  close: () => Promise<void>
}

interface HostRun {
  code: number | null
  stdout: Buffer
  stderr: string
}

const tempDirs: string[] = []
const servers: FakeApp[] = []

function frame(payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function parseFrames(buffer: Buffer): unknown[] {
  const responses: unknown[] = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    offset += 4
    if (offset + length > buffer.length) break
    responses.push(JSON.parse(buffer.subarray(offset, offset + length).toString('utf8')))
    offset += length
  }
  return responses
}

const MEDIA_ANALYSIS_ID = 'analysis_0123456789abcdef'
const VIDEO_OPTION_ID = 'option_video_0123456789'
const AUDIO_OPTION_ID = 'option_audio_0123456789'
const JOB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function videoOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'video',
    optionId: VIDEO_OPTION_ID,
    label: '1080p MP4 - H.264 + AAC',
    container: 'mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'avc1',
    audioCodec: 'mp4a',
    hasAudio: true,
    requiresMerge: true,
    filesizeBytes: 10_000,
    ...overrides
  }
}

function audioOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'audio',
    optionId: AUDIO_OPTION_ID,
    label: 'Audio only - Opus',
    container: 'opus',
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: 'opus',
    hasAudio: true,
    requiresMerge: false,
    filesizeBytes: null,
    ...overrides
  }
}

function mediaAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysisId: MEDIA_ANALYSIS_ID,
    title: 'Example media',
    durationSeconds: 91.5,
    options: [videoOption(), audioOption()],
    bestVideoOptionId: VIDEO_OPTION_ID,
    bestAudioOptionId: AUDIO_OPTION_ID,
    expiresAt: 1_800_000_000_000,
    ...overrides
  }
}

function mediaJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    analysisId: MEDIA_ANALYSIS_ID,
    optionId: VIDEO_OPTION_ID,
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4 - H.264 + AAC',
    status: 'downloading',
    completedBytes: 512,
    totalBytes: 1024,
    speedBps: 64,
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    completedAt: null,
    ...overrides
  }
}

function jsonRespond(
  body: unknown,
  status = 200
): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

function runHost(
  frames: Buffer[],
  options: { args?: string[]; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<HostRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(hostExecutable, options.args ?? [], {
      windowsHide: true,
      env: { ...process.env, ...options.env }
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Native host did not exit in time.'))
    }, options.timeoutMs ?? 10_000)

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8')
      })
    })
    child.stdin.on('error', () => {
      // The process may reject the origin and exit before reading stdin.
    })
    child.stdin.end(Buffer.concat(frames))
  })
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-native-host-'))
  tempDirs.push(dir)
  return dir
}

async function startFakeApp(
  respond: (response: ServerResponse) => void = (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, accepted: true }))
  }
): Promise<FakeApp> {
  const requests: RequestRecord[] = []
  const token = randomBytes(32).toString('hex')
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body
      })
      respond(response)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const app: FakeApp = {
    port: address.port,
    token,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      })
  }
  servers.push(app)
  return app
}

async function writeState(
  dir: string,
  options: { port: number; token: string; startedAt?: number } | { raw: string }
): Promise<string> {
  const statePath = path.join(dir, 'native-bridge.json')
  const value =
    'raw' in options
      ? options.raw
      : JSON.stringify({
          app: 'DonDownload',
          version: 1,
          port: options.port,
          token: options.token,
          pid: process.pid,
          startedAt: options.startedAt ?? Date.now()
        })
  await writeFile(statePath, value, 'utf8')
  return statePath
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await server.close()
    })
  )
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true })
    })
  )
})

describeWindows('Windows native messaging host', () => {
  it('forwards exactly one validated queue-download request to the app', async () => {
    const app = await startFakeApp()
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [frame(JSON.stringify({ type: 'queue-download', url: 'https://example.com/files/a.bin?x=1' }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    expect(run.code).toBe(0)
    expect(parseFrames(run.stdout)).toEqual([{ ok: true, accepted: true }])
    expect(app.requests).toHaveLength(1)
    expect(app.requests[0]).toMatchObject({
      method: 'POST',
      url: '/queue-download',
      authorization: `Bearer ${app.token}`,
      contentType: 'application/json; charset=utf-8'
    })
    expect(app.requests[0]?.body).toEqual({
      url: 'https://example.com/files/a.bin?x=1'
    })
  })

  it('forwards the narrow force opt-in only when it is exactly true', async () => {
    const app = await startFakeApp()
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [
        frame(
          JSON.stringify({
            type: 'queue-download',
            url: 'https://example.com/files/a.bin',
            force: true
          })
        )
      ],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    expect(run.code).toBe(0)
    expect(parseFrames(run.stdout)).toEqual([{ ok: true, accepted: true }])
    expect(app.requests[0]?.body).toEqual({
      url: 'https://example.com/files/a.bin',
      force: true
    })
  })

  it('forwards repeated frames to the app, which owns duplicate policy', async () => {
    const app = await startFakeApp()
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })
    const message = JSON.stringify({
      type: 'queue-download',
      url: 'https://example.com/same.bin'
    })

    const run = await runHost([frame(message), frame(message)], {
      env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
    })

    expect(run.code).toBe(0)
    expect(parseFrames(run.stdout)).toEqual([
      { ok: true, accepted: true },
      { ok: true, accepted: true }
    ])
    expect(app.requests).toHaveLength(2)
  })

  it('prefers the newest endpoint state when more than one per-user state exists', async () => {
    const oldApp = await startFakeApp()
    const newApp = await startFakeApp()
    const dir = await makeTempDir()

    const oldDir = path.join(dir, 'old')
    await mkdir(oldDir, { recursive: true })
    const oldState = await writeState(oldDir, {
      port: oldApp.port,
      token: oldApp.token,
      startedAt: 1_000
    })

    const appData = path.join(dir, 'appdata')
    const candidateDir = path.join(appData, 'dondownload')
    await mkdir(candidateDir, { recursive: true })
    await writeState(candidateDir, {
      port: newApp.port,
      token: newApp.token,
      startedAt: 2_000
    })

    const run = await runHost(
      [frame(JSON.stringify({ type: 'queue-download', url: 'https://example.com/newest.bin' }))],
      {
        env: {
          APPDATA: appData,
          DONDOWNLOAD_BRIDGE_STATE: oldState
        }
      }
    )

    expect(run.code).toBe(0)
    expect(parseFrames(run.stdout)).toEqual([{ ok: true, accepted: true }])
    expect(oldApp.requests).toHaveLength(0)
    expect(newApp.requests).toHaveLength(1)
  })

  it.each([
    ['unsupported operation', JSON.stringify({ type: 'open-window', url: 'https://example.com/a' })],
    ['extra command field', JSON.stringify({ type: 'queue-download', url: 'https://example.com/a', command: 'calc.exe' })],
    ['non-boolean force', JSON.stringify({ type: 'queue-download', url: 'https://example.com/a', force: 'yes' })],
    ['ftp URL', JSON.stringify({ type: 'queue-download', url: 'ftp://example.com/a' })],
    ['file URL', JSON.stringify({ type: 'queue-download', url: 'file:///C:/Windows/System32/calc.exe' })],
    ['credentials', JSON.stringify({ type: 'queue-download', url: 'https://user:pass@example.com/a' })],
    ['malformed JSON', '{not json']
  ])('rejects %s before contacting the app', async (_label, payload) => {
    const app = await startFakeApp()
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost([frame(payload)], {
      env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
    })

    expect(run.code).toBe(0)
    const responses = parseFrames(run.stdout) as Array<{ ok: boolean }>
    expect(responses).toHaveLength(1)
    expect(responses[0]?.ok).toBe(false)
    expect(app.requests).toHaveLength(0)
  })

  it('rejects an oversized frame header without allocating it', async () => {
    const app = await startFakeApp()
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })
    const header = Buffer.alloc(4)
    header.writeUInt32LE(1024 * 1024 + 1, 0)

    const run = await runHost([header], {
      env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
    })

    expect(run.code).toBe(1)
    const responses = parseFrames(run.stdout) as Array<{
      ok: boolean
      error: { code: string }
    }>
    expect(responses[0]?.ok).toBe(false)
    expect(responses[0]?.error.code).toBe('FRAME_TOO_LARGE')
    expect(app.requests).toHaveLength(0)
  })

  it('rejects invalid frame lengths and invalid UTF-8 safely', async () => {
    const app = await startFakeApp()
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const zeroLength = await runHost([Buffer.alloc(4)], {
      env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
    })
    expect(zeroLength.code).toBe(1)
    expect(
      (parseFrames(zeroLength.stdout) as Array<{ error: { code: string } }>)[0]?.error.code
    ).toBe('FRAME_INVALID')

    const invalidUtf8 = await runHost([frame(Buffer.from([0xff, 0xfe, 0xfd]))], {
      env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
    })
    expect(invalidUtf8.code).toBe(0)
    expect(
      (parseFrames(invalidUtf8.stdout) as Array<{ error: { code: string } }>)[0]?.error.code
    ).toBe('INVALID_JSON')
    expect(app.requests).toHaveLength(0)
  })

  it('reports a prompt failure when the app is not running', async () => {
    const dir = await makeTempDir()
    // A valid state file pointing at a port that is not listening models a
    // stale endpoint left by a crash.
    const statePath = await writeState(dir, { port: 1, token: 'a'.repeat(64) })

    const run = await runHost(
      [frame(JSON.stringify({ type: 'queue-download', url: 'https://example.com/a' }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    expect(run.code).toBe(0)
    const responses = parseFrames(run.stdout) as Array<{
      ok: boolean
      error: { code: string; message: string }
    }>
    expect(responses[0]?.ok).toBe(false)
    expect(responses[0]?.error.code).toBe('APP_NOT_RUNNING')
    expect(responses[0]?.error.message).toMatch(/not running|unavailable/i)
  })

  it('reports failure when no endpoint state exists', async () => {
    const dir = await makeTempDir()
    const run = await runHost(
      [frame(JSON.stringify({ type: 'queue-download', url: 'https://example.com/a' }))],
      {
        env: {
          APPDATA: dir,
          DONDOWNLOAD_BRIDGE_STATE: path.join(dir, 'missing.json')
        }
      }
    )

    expect(run.code).toBe(0)
    expect(
      (parseFrames(run.stdout) as Array<{ error: { code: string } }>)[0]?.error.code
    ).toBe('APP_NOT_RUNNING')
  })

  it('passes an app rejection through without claiming acceptance', async () => {
    const app = await startFakeApp((response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: 'ARIA2_START_FAILED', message: 'aria2 is unavailable.' }
        })
      )
    })
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [frame(JSON.stringify({ type: 'queue-download', url: 'https://example.com/a' }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    const responses = parseFrames(run.stdout) as Array<{
      ok: boolean
      accepted?: boolean
      error: { code: string }
    }>
    expect(responses[0]?.ok).toBe(false)
    expect(responses[0]?.accepted).toBeUndefined()
    expect(responses[0]?.error.code).toBe('ARIA2_START_FAILED')
  })

  it('rejects a direct non-extension caller origin', async () => {
    const run = await runHost([], { args: ['https://attacker.example/'] })
    expect(run.code).toBe(3)
    expect(run.stdout).toHaveLength(0)
  })

  it('forwards analyze-media with the exact route, auth and body', async () => {
    const app = await startFakeApp(
      jsonRespond({ ok: true, operation: 'analyze-media', analysis: mediaAnalysis() })
    )
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [
        frame(
          JSON.stringify({
            type: 'analyze-media',
            url: 'https://example.com/watch?v=1#fragment'
          })
        )
      ],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    expect(run.code).toBe(0)
    expect(parseFrames(run.stdout)).toEqual([
      { ok: true, operation: 'analyze-media', analysis: mediaAnalysis() }
    ])
    expect(app.requests).toHaveLength(1)
    expect(app.requests[0]).toMatchObject({
      method: 'POST',
      url: '/analyze-media',
      authorization: `Bearer ${app.token}`,
      contentType: 'application/json; charset=utf-8'
    })
    expect(app.requests[0]?.body).toEqual({
      url: 'https://example.com/watch?v=1'
    })
  })

  it(
    'lets analyze-media outlast the regular 20s bridge timeout',
    async () => {
      // Longer than the regular 20s timeout, but well below the 90s analyze
      // budget, so the regression stays bounded.
      const responseDelayMs = 22_000
      const app = await startFakeApp((response) => {
        const timer = setTimeout(() => {
          if (response.writableEnded || response.destroyed) return
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({
              ok: true,
              operation: 'analyze-media',
              analysis: mediaAnalysis()
            })
          )
        }, responseDelayMs)
        response.on('close', () => clearTimeout(timer))
      })
      const dir = await makeTempDir()
      const statePath = await writeState(dir, { port: app.port, token: app.token })

      const run = await runHost(
        [
          frame(
            JSON.stringify({
              type: 'analyze-media',
              url: 'https://example.com/watch?v=slow'
            })
          )
        ],
        {
          env: { DONDOWNLOAD_BRIDGE_STATE: statePath },
          timeoutMs: 40_000
        }
      )

      expect(run.code).toBe(0)
      expect(parseFrames(run.stdout)).toEqual([
        { ok: true, operation: 'analyze-media', analysis: mediaAnalysis() }
      ])
      expect(app.requests).toHaveLength(1)
      expect(app.requests[0]).toMatchObject({ url: '/analyze-media' })
    },
    45_000
  )

  it('forwards queue-media with opaque IDs and only an explicit force', async () => {
    const app = await startFakeApp(
      jsonRespond({ ok: true, operation: 'queue-media', job: mediaJob() })
    )
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [
        frame(
          JSON.stringify({
            type: 'queue-media',
            analysisId: MEDIA_ANALYSIS_ID,
            optionId: VIDEO_OPTION_ID
          })
        ),
        frame(
          JSON.stringify({
            type: 'queue-media',
            analysisId: MEDIA_ANALYSIS_ID,
            optionId: AUDIO_OPTION_ID,
            force: true
          })
        )
      ],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    expect(run.code).toBe(0)
    expect(parseFrames(run.stdout)).toEqual([
      { ok: true, operation: 'queue-media', job: mediaJob() },
      { ok: true, operation: 'queue-media', job: mediaJob() }
    ])
    expect(app.requests.map((request) => request.url)).toEqual([
      '/queue-media',
      '/queue-media'
    ])
    expect(app.requests.map((request) => request.body)).toEqual([
      { analysisId: MEDIA_ANALYSIS_ID, optionId: VIDEO_OPTION_ID },
      {
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: AUDIO_OPTION_ID,
        force: true
      }
    ])
  })

  it('forwards media-status and cancel-media with the exact job ID', async () => {
    const statusApp = await startFakeApp(
      jsonRespond({ ok: true, operation: 'media-status', job: mediaJob() })
    )
    const statusDir = await makeTempDir()
    const statusState = await writeState(statusDir, {
      port: statusApp.port,
      token: statusApp.token
    })

    const statusRun = await runHost(
      [frame(JSON.stringify({ type: 'media-status', jobId: JOB_ID }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statusState } }
    )
    expect(statusRun.code).toBe(0)
    expect(parseFrames(statusRun.stdout)).toEqual([
      { ok: true, operation: 'media-status', job: mediaJob() }
    ])
    expect(statusApp.requests[0]).toMatchObject({ url: '/media-status' })
    expect(statusApp.requests[0]?.body).toEqual({ jobId: JOB_ID })

    const cancelApp = await startFakeApp(
      jsonRespond({
        ok: true,
        operation: 'cancel-media',
        job: mediaJob({ status: 'cancelled' })
      })
    )
    const cancelDir = await makeTempDir()
    const cancelState = await writeState(cancelDir, {
      port: cancelApp.port,
      token: cancelApp.token
    })

    const cancelRun = await runHost(
      [frame(JSON.stringify({ type: 'cancel-media', jobId: JOB_ID }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: cancelState } }
    )
    expect(cancelRun.code).toBe(0)
    expect(parseFrames(cancelRun.stdout)).toEqual([
      {
        ok: true,
        operation: 'cancel-media',
        job: mediaJob({ status: 'cancelled' })
      }
    ])
    expect(cancelApp.requests[0]).toMatchObject({ url: '/cancel-media' })
    expect(cancelApp.requests[0]?.body).toEqual({ jobId: JOB_ID })
  })

  it.each([
    [
      'analyze-media with an extra field',
      JSON.stringify({
        type: 'analyze-media',
        url: 'https://example.com/a',
        cookie: 'SID=1'
      })
    ],
    [
      'queue-media with a raw selector',
      JSON.stringify({
        type: 'queue-media',
        analysisId: 'bestvideo+bestaudio',
        optionId: VIDEO_OPTION_ID
      })
    ],
    [
      'queue-media with a non-boolean force',
      JSON.stringify({
        type: 'queue-media',
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        force: 'yes'
      })
    ],
    [
      'media-status with a path-like job ID',
      JSON.stringify({ type: 'media-status', jobId: '../job' })
    ],
    [
      'cancel-media with an extra field',
      JSON.stringify({ type: 'cancel-media', jobId: JOB_ID, force: true })
    ]
  ])('rejects %s before contacting the app', async (_label, payload) => {
    const app = await startFakeApp(
      jsonRespond({ ok: true, operation: 'analyze-media', analysis: mediaAnalysis() })
    )
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost([frame(payload)], {
      env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
    })

    expect(run.code).toBe(0)
    const responses = parseFrames(run.stdout) as Array<{ ok: boolean }>
    expect(responses).toHaveLength(1)
    expect(responses[0]?.ok).toBe(false)
    expect(app.requests).toHaveLength(0)
  })

  it('rejects a malformed media response instead of passing it through', async () => {
    const app = await startFakeApp(
      jsonRespond({
        ok: true,
        operation: 'analyze-media',
        analysis: { ...mediaAnalysis(), extra: true }
      })
    )
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [frame(JSON.stringify({ type: 'analyze-media', url: 'https://example.com/a' }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    const responses = parseFrames(run.stdout) as Array<{
      ok: boolean
      error: { code: string }
    }>
    expect(responses[0]?.ok).toBe(false)
    expect(responses[0]?.error.code).toBe('APP_RESPONSE_INVALID')
  })

  it('passes a safe media app rejection through without claiming success', async () => {
    const app = await startFakeApp(
      jsonRespond(
        {
          ok: false,
          error: {
            code: 'MEDIA_ANALYSIS_EXPIRED',
            message: 'Analyze the page again.'
          }
        },
        409
      )
    )
    const dir = await makeTempDir()
    const statePath = await writeState(dir, { port: app.port, token: app.token })

    const run = await runHost(
      [frame(JSON.stringify({ type: 'analyze-media', url: 'https://example.com/a' }))],
      { env: { DONDOWNLOAD_BRIDGE_STATE: statePath } }
    )

    const responses = parseFrames(run.stdout) as Array<{
      ok: boolean
      error: { code: string; message: string }
    }>
    expect(responses[0]?.ok).toBe(false)
    expect(responses[0]?.error.code).toBe('MEDIA_ANALYSIS_EXPIRED')
    expect(responses[0]?.error.message).toBe('Analyze the page again.')
  })
})
