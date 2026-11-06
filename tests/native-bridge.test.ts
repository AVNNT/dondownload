import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_BRIDGE_BODY_BYTES,
  parseNativeBridgeEndpoint,
  parseNativeQueueMessage,
  parseQueueDownloadRequest
} from '../src/shared/nativeBridge'
import type { MediaBridgeTarget } from '../src/shared/mediaBridge'
import type { ScanSession } from '../src/shared/scanner'
import { ValidationError } from '../src/shared/validation'
import { AppError } from '../src/main/errors'
import {
  startNativeBridge,
  type BridgeDownloadManager,
  type NativeBridge
} from '../src/main/nativeBridge/server'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'

const publicLookup: PublicTargetLookup = async () => [
  { address: '93.184.216.34', family: 4 }
]

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
    hdr: false,
    filesizeBytes: 10_000,
    estimatedBytes: null,
    sizeIsEstimate: false,
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
    hdr: false,
    filesizeBytes: null,
    estimatedBytes: null,
    sizeIsEstimate: false,
    ...overrides
  }
}

function mediaAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysisId: MEDIA_ANALYSIS_ID,
    title: 'Example media',
    thumbnailUrl: null,
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

interface FakeMediaTarget extends MediaBridgeTarget {
  calls: {
    analyze: unknown[]
    queue: unknown[]
    sniffed: unknown[]
    status: unknown[]
    cancel: unknown[]
  }
  failWith: Error | null
  invalidAnalysis: boolean
  invalidJob: boolean
}

function createMediaTarget(): FakeMediaTarget {
  return {
    calls: { analyze: [], queue: [], sniffed: [], status: [], cancel: [] },
    failWith: null,
    invalidAnalysis: false,
    invalidJob: false,
    async analyzeMedia(input) {
      this.calls.analyze.push(input)
      if (this.failWith) throw this.failWith
      return (this.invalidAnalysis
        ? { ...mediaAnalysis(), extra: true }
        : mediaAnalysis()) as never
    },
    async queueMedia(input) {
      this.calls.queue.push(input)
      if (this.failWith) throw this.failWith
      return (this.invalidJob ? { ...mediaJob(), extra: true } : mediaJob()) as never
    },
    async queueSniffedMedia(input) {
      this.calls.sniffed.push(input)
      if (this.failWith) throw this.failWith
      return (this.invalidJob ? { ...mediaJob(), extra: true } : mediaJob()) as never
    },
    async getMediaStatus(jobId) {
      this.calls.status.push(jobId)
      if (this.failWith) throw this.failWith
      return (this.invalidJob ? { ...mediaJob(), extra: true } : mediaJob()) as never
    },
    async cancelMedia(jobId) {
      this.calls.cancel.push(jobId)
      if (this.failWith) throw this.failWith
      return (this.invalidJob
        ? { ...mediaJob(), extra: true }
        : mediaJob({ status: 'cancelled' })) as never
    }
  }
}

interface FakeManager extends BridgeDownloadManager {
  calls: unknown[]
  failWith: Error | null
  seen: Set<string>
}

function createManager(): FakeManager {
  const calls: unknown[] = []
  const seen = new Set<string>()
  return {
    calls,
    failWith: null,
    seen,
    async add(input: unknown): Promise<unknown> {
      calls.push(input)
      if (this.failWith) throw this.failWith
      const record = input as { url?: unknown; force?: unknown }
      const url = typeof record.url === 'string' ? record.url : ''
      if (record.force !== true && this.seen.has(url)) {
        throw new AppError(
          'DUPLICATE_DOWNLOAD',
          'This URL is already queued or downloading in DonDownload.'
        )
      }
      this.seen.add(url)
      return { accepted: true }
    },
    async addDurable(input: unknown): Promise<{ downloadId: string; persistedAt: number }> {
      await this.add(input)
      return {
        downloadId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        persistedAt: 1_800_000_000_000
      }
    }
  }
}

let tempDir = ''
let bridge: NativeBridge | null = null
let manager: FakeManager
let media: FakeMediaTarget | null = null
let token = ''
let scanCalls: Array<{ url: string; cookie?: string }> = []
let scanRequested: ScanSession | null = null

const SCAN_SESSION: ScanSession = {
  sessionId: 'scan_0123456789abcdef',
  status: 'scanning',
  origin: 'extension',
  hostname: 'discuss.example',
  message: null,
  signinRequired: false,
  counters: {
    found: 0,
    probing: 0,
    ready: 0,
    signin: 0,
    protected: 0,
    unavailable: 0,
    toolUnavailable: 0
  },
  progress: { fetchedPages: 0, totalItems: 0, queueableItems: 0 },
  items: [],
  removedItemIds: [],
  revision: 0,
  updatedAt: 1_800_000_000_000
}

async function start(options: { media?: boolean; scanner?: boolean } = {}): Promise<void> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-bridge-'))
  manager = createManager()
  media = options.media ? createMediaTarget() : null
  scanCalls = []
  scanRequested = null
  bridge = await startNativeBridge({
    manager,
    userDataPath: tempDir,
    logger: () => undefined,
    publicTargetLookup: publicLookup,
    ...(media ? { mediaBridge: media } : {}),
    ...(options.scanner
      ? {
          scanner: {
            start: (url: string, scanOptions: { origin: 'extension'; cookie?: string }) => {
              scanCalls.push({
                url,
                ...(scanOptions.cookie === undefined
                  ? {}
                  : { cookie: scanOptions.cookie })
              })
              return SCAN_SESSION
            }
          },
          onScanRequested: (session: ScanSession) => {
            scanRequested = session
          }
        }
      : {})
  })
  const state = parseNativeBridgeEndpoint(
    JSON.parse(await readFile(bridge.statePath, 'utf8'))
  )
  token = state.token
}

afterEach(async () => {
  await bridge?.close()
  bridge = null
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

async function post(
  body: string,
  options: {
    authorization?: string | null
    contentType?: string | null
    origin?: string
    secFetchSite?: string
    path?: string
    method?: string
  } = {}
): Promise<Response> {
  if (!bridge) throw new Error('Bridge is not started.')
  const headers: Record<string, string> = {}
  const authorization =
    options.authorization === undefined
      ? `Bearer ${token}`
      : options.authorization
  if (authorization !== null) headers.Authorization = authorization
  const contentType =
    options.contentType === undefined
      ? 'application/json'
      : options.contentType
  if (contentType !== null) headers['Content-Type'] = contentType
  if (options.origin) headers.Origin = options.origin
  if (options.secFetchSite) headers['Sec-Fetch-Site'] = options.secFetchSite

  return fetch(`http://127.0.0.1:${bridge.port}${options.path ?? '/queue-download'}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' ? undefined : body
  })
}

describe('native bridge endpoint state', () => {
  beforeEach(start)

  it('writes a per-user state file with a random token and removes it on close', async () => {
    expect(bridge).not.toBeNull()
    if (!bridge) return

    const state = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )
    expect(state.app).toBe('DonDownload')
    expect(state.version).toBe(1)
    expect(state.port).toBe(bridge.port)
    expect(state.port).toBeGreaterThan(0)
    expect(state.port).toBeLessThanOrEqual(65535)
    expect(state.token).toMatch(/^[0-9a-f]{64}$/)
    expect(state.pid).toBe(process.pid)

    await bridge.close()
    bridge = null
    await expect(readFile(path.join(tempDir, 'native-bridge.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('stops listening after close, so a stale host fails fast', async () => {
    if (!bridge) throw new Error('Bridge is not started.')
    const port = bridge.port
    await bridge.close()
    bridge = null

    await expect(fetch(`http://127.0.0.1:${port}/queue-download`, { method: 'POST' })).rejects.toThrow()
  })
})

describe('native bridge request handling', () => {
  beforeEach(start)

  it('accepts a validated URL through DownloadManager.add and strips the fragment', async () => {
    const response = await post(
      JSON.stringify({ url: '  https://example.com/files/app.zip#section  ' })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, accepted: true })
    expect(manager.calls).toEqual([{ url: 'https://example.com/files/app.zip' }])
  })

  it('reports a duplicate as non-success without accepted:true', async () => {
    const body = JSON.stringify({ url: 'https://example.com/same.zip' })
    const first = await post(body)
    const second = await post(body)

    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, accepted: true })

    expect(second.status).toBe(409)
    const duplicate = (await second.json()) as {
      ok: boolean
      accepted?: boolean
      error: { code: string }
    }
    expect(duplicate.ok).toBe(false)
    expect(duplicate.accepted).toBeUndefined()
    expect(duplicate.error.code).toBe('DUPLICATE_DOWNLOAD')
    expect(manager.calls).toHaveLength(2)
  })

  it('accepts the narrow force opt-in as an explicit second copy', async () => {
    const first = await post(
      JSON.stringify({ url: 'https://example.com/again.zip' })
    )
    const second = await post(
      JSON.stringify({ url: 'https://example.com/again.zip', force: true })
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, accepted: true })
    expect(manager.calls).toEqual([
      { url: 'https://example.com/again.zip' },
      { url: 'https://example.com/again.zip', force: true }
    ])
  })

  it('rejects concurrent identical requests without two accepted jobs', async () => {
    const body = JSON.stringify({ url: 'https://example.com/concurrent.zip' })
    const [first, second] = await Promise.all([post(body), post(body)])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    expect(manager.calls).toHaveLength(2)
  })

  it('rejects malformed JSON and invalid schemas without calling the manager', async () => {
    const malformed = await post('{not json')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_JSON' }
    })

    for (const body of [
      JSON.stringify({ type: 'queue-download', url: 'https://example.com/a' }),
      JSON.stringify({ url: 7 }),
      JSON.stringify({ url: 'https://example.com/a', extra: true }),
      JSON.stringify({}),
      JSON.stringify([])
    ]) {
      const response = await post(body)
      expect(response.status).toBe(400)
      const result = (await response.json()) as { ok: boolean }
      expect(result.ok).toBe(false)
    }

    expect(manager.calls).toHaveLength(0)
  })

  it.each([
    'ftp://example.com/file.zip',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'https://user:password@example.com/file.zip',
    'not a url'
  ])('rejects unsupported URL %s', async (url) => {
    const response = await post(JSON.stringify({ url }))
    expect(response.status).toBe(400)
    const result = (await response.json()) as { ok: boolean; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('INVALID_INPUT')
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects missing and wrong bearer tokens', async () => {
    const missing = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      authorization: null
    })
    expect(missing.status).toBe(401)

    const wrong = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      authorization: `Bearer ${'0'.repeat(64)}`
    })
    expect(wrong.status).toBe(401)

    expect(manager.calls).toHaveLength(0)
  })

  it('rejects browser-originated requests', async () => {
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      origin: 'https://attacker.example'
    })
    expect(response.status).toBe(403)
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects non-JSON content types', async () => {
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      contentType: 'text/plain'
    })
    expect(response.status).toBe(415)
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects an oversized payload safely', async () => {
    const oversized = JSON.stringify({
      url: `https://example.com/${'a'.repeat(MAX_BRIDGE_BODY_BYTES)}`
    })
    const response = await post(oversized)
    expect(response.status).toBe(413)
    expect(manager.calls).toHaveLength(0)
  })

  it('reports failure and not acceptance when the app cannot queue the download', async () => {
    manager.failWith = new AppError(
      'ARIA2_START_FAILED',
      'aria2 could not be started for this test.'
    )
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }))
    expect(response.status).toBe(503)
    const result = (await response.json()) as {
      ok: boolean
      accepted?: boolean
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.accepted).toBeUndefined()
    expect(result.error.code).toBe('ARIA2_START_FAILED')
  })

  it('rejects unsupported methods and unknown routes', async () => {
    const wrongMethod = await post('', { method: 'GET' })
    expect(wrongMethod.status).toBe(405)

    const unknown = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/other'
    })
    expect(unknown.status).toBe(404)
    expect(manager.calls).toHaveLength(0)
  })
})

describe('captured source bridge route', () => {
  beforeEach(start)

  it('queues one verified progressive source through strict durable acceptance', async () => {
    const response = await post(
      JSON.stringify({
        url: 'https://cdn.example/video/clip.mp4?sig=abc',
        filename: 'clip.mp4'
      }),
      { path: '/queue-captured-source' }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      accepted: true,
      operation: 'queue-captured-source',
      durable: true,
      receipt: {
        downloadId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        persistedAt: 1_800_000_000_000
      }
    })
    expect(manager.calls).toEqual([
      {
        url: 'https://cdn.example/video/clip.mp4?sig=abc',
        filename: 'clip.mp4'
      }
    ])
  })

  it('rejects private targets, manifests and unsupported filenames before the manager', async () => {
    for (const body of [
      { url: 'http://127.0.0.1/video.mp4' },
      { url: 'https://cdn.example/live/index.m3u8' },
      { url: 'https://cdn.example/stream', filename: 'clip.m3u8' },
      { url: 'https://cdn.example/video.mp4', filename: '../clip.mp4' }
    ]) {
      const response = await post(JSON.stringify(body), {
        path: '/queue-captured-source'
      })
      expect(response.status).toBe(400)
    }
    expect(manager.calls).toHaveLength(0)
  })

  it('reports a duplicate captured source as non-success', async () => {
    const body = JSON.stringify({
      url: 'https://cdn.example/video/clip.mp4',
      filename: 'clip.mp4'
    })
    await post(body, { path: '/queue-captured-source' })
    const duplicate = await post(body, { path: '/queue-captured-source' })

    expect(duplicate.status).toBe(409)
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_DOWNLOAD' }
    })
  })

  it('keeps authentication and body limits on the captured route', async () => {
    const unauthorized = await post(
      JSON.stringify({ url: 'https://cdn.example/video/clip.mp4' }),
      { path: '/queue-captured-source', authorization: null }
    )
    expect(unauthorized.status).toBe(401)

    const browser = await post(
      JSON.stringify({ url: 'https://cdn.example/video/clip.mp4' }),
      { path: '/queue-captured-source', origin: 'https://example.com' }
    )
    expect(browser.status).toBe(403)
    expect(manager.calls).toHaveLength(0)
  })
})

describe('media bridge routes', () => {
  beforeEach(async () => {
    await start({ media: true })
  })

  it('serves analyze-media with the exact response DTO and normalized URL', async () => {
    const response = await post(
      JSON.stringify({ url: '  https://example.com/watch?v=1#fragment  ' }),
      { path: '/analyze-media' }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      operation: 'analyze-media',
      analysis: mediaAnalysis()
    })
    expect(media?.calls.analyze).toEqual([
      { url: 'https://example.com/watch?v=1' }
    ])
    expect(manager.calls).toHaveLength(0)
  })

  it('forwards one opted-in cookie on analyze and queue, within the bound', async () => {
    const analyze = await post(
      JSON.stringify({
        url: 'https://example.com/watch?v=1',
        cookie: 'session=abc; theme=dark'
      }),
      { path: '/analyze-media' }
    )
    expect(analyze.status).toBe(200)
    expect(media?.calls.analyze).toEqual([
      { url: 'https://example.com/watch?v=1', cookie: 'session=abc; theme=dark' }
    ])

    const queue = await post(
      JSON.stringify({
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        cookie: 'session=abc; theme=dark'
      }),
      { path: '/queue-media' }
    )
    expect(queue.status).toBe(200)
    expect(media?.calls.queue.at(-1)).toEqual({
      analysisId: MEDIA_ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID,
      cookie: 'session=abc; theme=dark'
    })

    for (const body of [
      { url: 'https://example.com/a', cookie: 'x'.repeat(8193) },
      { url: 'https://example.com/a', cookie: 'a=b\r\nInjected: 1' },
      { url: 'https://example.com/a', cookie: 7 }
    ]) {
      const response = await post(JSON.stringify(body), {
        path: '/analyze-media'
      })
      expect(response.status).toBe(400)
    }
  })

  it('serves queue-media with opaque IDs and the optional force opt-in', async () => {
    const plain = await post(
      JSON.stringify({
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID
      }),
      { path: '/queue-media' }
    )
    expect(plain.status).toBe(200)
    expect(await plain.json()).toEqual({
      ok: true,
      operation: 'queue-media',
      job: mediaJob()
    })

    const forced = await post(
      JSON.stringify({
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: AUDIO_OPTION_ID,
        force: true
      }),
      { path: '/queue-media' }
    )
    expect(forced.status).toBe(200)
    expect(await forced.json()).toEqual({
      ok: true,
      operation: 'queue-media',
      job: mediaJob()
    })

    expect(media?.calls.queue).toEqual([
      { analysisId: MEDIA_ANALYSIS_ID, optionId: VIDEO_OPTION_ID },
      {
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: AUDIO_OPTION_ID,
        force: true
      }
    ])
  })

  it('maps MEDIA_DUPLICATE_JOB to 409 instead of a generic 400', async () => {
    if (media) {
      media.failWith = new AppError(
        'MEDIA_DUPLICATE_JOB',
        'This media job is already queued or downloading.'
      )
    }
    const response = await post(
      JSON.stringify({
        analysisId: MEDIA_ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID
      }),
      { path: '/queue-media' }
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'MEDIA_DUPLICATE_JOB',
        message: 'This media job is already queued or downloading.'
      }
    })
  })

  it('serves media-status and cancel-media with the exact job DTO', async () => {
    const status = await post(JSON.stringify({ jobId: JOB_ID }), {
      path: '/media-status'
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({
      ok: true,
      operation: 'media-status',
      job: mediaJob()
    })

    const cancelled = await post(JSON.stringify({ jobId: JOB_ID }), {
      path: '/cancel-media'
    })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toEqual({
      ok: true,
      operation: 'cancel-media',
      job: mediaJob({ status: 'cancelled' })
    })

    expect(media?.calls.status).toEqual([JOB_ID])
    expect(media?.calls.cancel).toEqual([JOB_ID])
  })

  it.each([
    '/analyze-media',
    '/queue-media',
    '/media-status',
    '/cancel-media'
  ])('requires the bearer token on %s', async (route) => {
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: route,
      authorization: null
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' }
    })
    expect(media?.calls).toEqual({ analyze: [], queue: [], sniffed: [], status: [], cancel: [] })
  })

  it.each([
    ['Origin', { origin: 'https://attacker.example' }],
    ['Sec-Fetch-Site', { secFetchSite: 'cross-site' }]
  ])('rejects browser %s headers on every media route', async (_label, options) => {
    for (const route of [
      '/analyze-media',
      '/queue-media',
      '/media-status',
      '/cancel-media'
    ]) {
      const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
        path: route,
        ...options
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: 'ORIGIN_REJECTED' }
      })
    }
    expect(media?.calls).toEqual({ analyze: [], queue: [], sniffed: [], status: [], cancel: [] })
  })

  it.each([
    ['/analyze-media', { url: 'https://example.com/a', extra: true }],
    ['/analyze-media', { url: 7 }],
    ['/queue-media', { analysisId: 'bestvideo+bestaudio', optionId: VIDEO_OPTION_ID }],
    ['/queue-media', { analysisId: MEDIA_ANALYSIS_ID, optionId: VIDEO_OPTION_ID, dir: 'C:\\' }],
    ['/media-status', { jobId: '../not-a-job' }],
    ['/cancel-media', { jobId: JOB_ID, force: true }]
  ])('rejects invalid %s bodies without calling the target', async (route, body) => {
    const response = await post(JSON.stringify(body), { path: route })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false })
    expect(media?.calls).toEqual({ analyze: [], queue: [], sniffed: [], status: [], cancel: [] })
  })

  it('applies the existing content-type and body limits to media routes', async () => {
    const wrongType = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/analyze-media',
      contentType: 'text/plain'
    })
    expect(wrongType.status).toBe(415)

    const oversized = await post(
      JSON.stringify({ url: `https://example.com/${'a'.repeat(MAX_BRIDGE_BODY_BYTES)}` }),
      { path: '/analyze-media' }
    )
    expect(oversized.status).toBe(413)
    expect(media?.calls.analyze).toHaveLength(0)
  })

  it('rejects an invalid target response without leaking it', async () => {
    if (media) media.invalidAnalysis = true
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/analyze-media'
    })
    expect(response.status).toBe(500)
    const result = (await response.json()) as {
      ok: boolean
      error: { code: string; message: string }
      analysis?: unknown
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('MEDIA_RESPONSE_INVALID')
    expect(result.analysis).toBeUndefined()
    expect(result.error.message).not.toMatch(/https?:\/\//)
  })

  it('sanitizes target errors that contain a URL', async () => {
    if (media) {
      media.failWith = new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'Failed for https://example.com/private'
      )
    }
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/analyze-media'
    })
    expect(response.status).toBe(503)
    const result = (await response.json()) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('MEDIA_ANALYSIS_FAILED')
    expect(result.error.message).not.toMatch(/https?:\/\//)
  })

  it('keeps queue-download unchanged when a media target is wired', async () => {
    const response = await post(
      JSON.stringify({ url: 'https://example.com/files/app.zip#section' })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, accepted: true })
    expect(manager.calls).toEqual([{ url: 'https://example.com/files/app.zip' }])
    expect(media?.calls.analyze).toHaveLength(0)
  })
})

describe('media bridge without a target', () => {
  beforeEach(start)

  it('authenticates first, then reports a safe unavailable error', async () => {
    const unauthorized = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/analyze-media',
      authorization: null
    })
    expect(unauthorized.status).toBe(401)

    const unavailable = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/analyze-media'
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      ok: false,
      error: {
        code: 'MEDIA_UNAVAILABLE',
        message: 'Media operations are not available.'
      }
    })
  })
})

describe('shared native bridge schemas', () => {
  it('accepts only the single queue-download operation with exactly type and url', () => {
    expect(
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com/file.zip#x'
      })
    ).toEqual({ type: 'queue-download', url: 'https://example.com/file.zip' })

    expect(() =>
      parseNativeQueueMessage({ type: 'open-window', url: 'https://example.com' })
    ).toThrow(ValidationError)
    expect(() =>
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com',
        command: 'calc.exe'
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseNativeQueueMessage({ type: 'queue-download', url: 'file:///C:/x' })
    ).toThrow(ValidationError)
  })

  it('accepts only an optional boolean force flag beyond the URL', () => {
    expect(
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com/a',
        force: true
      })
    ).toEqual({
      type: 'queue-download',
      url: 'https://example.com/a',
      force: true
    })
    expect(() =>
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com/a',
        force: 'yes'
      })
    ).toThrow(ValidationError)
  })

  it('accepts only a url body and optional force flag for the loopback request', () => {
    expect(parseQueueDownloadRequest({ url: 'http://example.com/a' })).toEqual({
      url: 'http://example.com/a'
    })
    expect(
      parseQueueDownloadRequest({ url: 'https://example.com/a', force: true })
    ).toEqual({ url: 'https://example.com/a', force: true })
    expect(() =>
      parseQueueDownloadRequest({ url: 'https://example.com/a', filename: 'x.exe' })
    ).toThrow(ValidationError)
    expect(() => parseQueueDownloadRequest({ url: 'https://example.com', dir: 'C:\\' })).toThrow(
      ValidationError
    )
    expect(() =>
      parseQueueDownloadRequest({ url: 'https://example.com/a', force: 'yes' })
    ).toThrow(ValidationError)
  })
})

describe('detected media route', () => {
  beforeEach(async () => {
    await start({ media: true })
  })

  function body(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      url: 'https://cdn.example/media/clip.mp4',
      pageUrl: 'https://site.example/watch/1',
      referer: 'https://site.example/watch/1',
      userAgent: 'Mozilla/5.0 Browser',
      kind: 'file',
      title: 'A clip',
      ...overrides
    })
  }

  it('queues a detected file with one-job referer/UA/cookie headers', async () => {
    const response = await post(
      body({ filename: 'A clip.mp4', cookie: 'auth=1' }),
      { path: '/queue-sniffed-media' }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, accepted: true })
    expect(manager.calls).toEqual([
      {
        url: 'https://cdn.example/media/clip.mp4',
        filename: 'A clip.mp4',
        requestHeaders: {
          referer: 'https://site.example/watch/1',
          userAgent: 'Mozilla/5.0 Browser',
          cookie: 'auth=1'
        }
      }
    ])
  })

  it('rejects private targets, non-http URLs and oversized headers', async () => {
    const privateResponse = await post(
      body({ url: 'http://127.0.0.1/clip.mp4' }),
      { path: '/queue-sniffed-media' }
    )
    expect(privateResponse.status).toBe(400)
    expect(await privateResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'MEDIA_TARGET_NOT_PUBLIC' }
    })

    const badScheme = await post(body({ url: 'ftp://cdn.example/clip.mp4' }), {
      path: '/queue-sniffed-media'
    })
    expect(badScheme.status).toBe(400)

    const oversized = await post(body({ userAgent: 'x'.repeat(513) }), {
      path: '/queue-sniffed-media'
    })
    expect(oversized.status).toBe(400)
    expect(manager.calls).toHaveLength(0)
  })

  it('delegates an HLS manifest to a normal media job and rejects cookie injection', async () => {
    const response = await post(
      body({
        url: 'https://cdn.example/master.m3u8',
        kind: 'hls',
        variant: {
          url: 'https://cdn.example/high.m3u8',
          label: '720p',
          width: 1280,
          height: 720,
          bandwidth: 2400000
        }
      }),
      { path: '/queue-sniffed-media' }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, accepted: true })
    expect(media && media.calls.sniffed).toHaveLength(1)
    expect(media && media.calls.sniffed[0]).toMatchObject({
      kind: 'hls',
      variant: { url: 'https://cdn.example/high.m3u8', height: 720 }
    })

    const injected = await post(body({ cookie: 'a=1\r\nX-Evil: yes' }), {
      path: '/queue-sniffed-media'
    })
    expect(injected.status).toBe(400)
  })
})

describe('native bridge scan-page route', () => {
  beforeEach(() => start({ scanner: true }))

  it('accepts the exact body the native host forwards (no type field)', async () => {
    const response = await post(
      JSON.stringify({
        url: 'https://discuss.example/t/topic/346779',
        cookie: 'auth=1'
      }),
      { path: '/scan-page' }
    )

    expect(response.status).toBe(200)
    expect(scanCalls).toHaveLength(1)
  })

  it('still rejects a different operation type on the scan route', async () => {
    const response = await post(
      JSON.stringify({ type: 'download', url: 'https://discuss.example/t/1' }),
      { path: '/scan-page' }
    )
    expect(response.status).toBe(400)
  })

  it('starts a discovery-only scan and brings the desktop view forward', async () => {
    const response = await post(
      JSON.stringify({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/346779',
        cookie: 'auth=1'
      }),
      { path: '/scan-page' }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      accepted: true,
      operation: 'scan-page'
    })
    expect(scanCalls).toEqual([
      {
        url: 'https://discuss.example/t/topic/346779',
        cookie: 'auth=1'
      }
    ])
    expect(scanRequested?.sessionId).toBe(SCAN_SESSION.sessionId)
    // This route never queues.
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects extra fields and invalid cookies without starting a scan', async () => {
    const extra = await post(
      JSON.stringify({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/346779',
        headers: {}
      }),
      { path: '/scan-page' }
    )
    expect(extra.status).toBe(400)

    const injected = await post(
      JSON.stringify({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/346779',
        cookie: 'a=1\r\nX-Evil: yes'
      }),
      { path: '/scan-page' }
    )
    expect(injected.status).toBe(400)
    expect(scanCalls).toHaveLength(0)
  })
})
