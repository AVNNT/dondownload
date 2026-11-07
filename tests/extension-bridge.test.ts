import { afterEach, describe, expect, it } from 'vitest'
import {
  NATIVE_HOST,
  SCAN_PAGE_MESSAGE_TYPE,
  normalizeCapturedSource,
  probeNativeConnection,
  resetNativeBridgeForTests,
  sendAnalyzeMedia,
  sendQueueCapturedSource,
  sendDownloadStatus,
  sendQueueDownload,
  sendQueueMedia,
  sendScanPage,
  sendShowDownload
} from '../extension/bridge'

const ANALYSIS_ID = 'analysis_0123456789abcdef'
const VIDEO_OPTION_ID = 'option_video_0123456789'

function analysis(): Record<string, unknown> {
  return {
    analysisId: ANALYSIS_ID,
    title: 'Example media',
    durationSeconds: 91.5,
    options: [
      {
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
        estimatedBytes: 12_000,
        sizeIsEstimate: true,
        outputFormats: ['auto', 'mp4', 'mkv'],
        outputSizes: {
          auto: { bytes: 12_000, isEstimate: true },
          mp4: { bytes: 11_000, isEstimate: true }
        },
        formatIds: ['137', '140'],
        hdr: false
      }
    ],
    bestVideoOptionId: VIDEO_OPTION_ID,
    bestAudioOptionId: null,
    thumbnailUrl: 'https://i.ytimg.com/vi/example/hqdefault.jpg',
    expiresAt: 1_800_000_000_000
  }
}

function job(): Record<string, unknown> {
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    analysisId: ANALYSIS_ID,
    optionId: VIDEO_OPTION_ID,
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4 - H.264 + AAC',
    status: 'queued',
    completedBytes: 0,
    totalBytes: null,
    speedBps: 0,
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: null
  }
}

interface FakeNative {
  messages: Array<{ host: string; message: unknown }>
  response: unknown
  runtimeError: string | null
}

function installFakeNative(): FakeNative {
  const fake: FakeNative = { messages: [], response: null, runtimeError: null }
  const chrome: any = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(host: string, message: unknown, callback: (value: unknown) => void) {
        fake.messages.push({ host, message })
        if (fake.runtimeError) {
          chrome.runtime.lastError = { message: fake.runtimeError }
        }
        callback(fake.response)
        chrome.runtime.lastError = undefined
      }
    }
  }
  ;(globalThis as any).chrome = chrome
  return fake
}

afterEach(() => {
  resetNativeBridgeForTests()
  delete (globalThis as any).chrome
})

describe('manual capture is preserved', () => {
  it('sends exactly the validated queue-download envelope', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true }

    const result = await sendQueueDownload('  https://example.com/files/a.bin#frag  ')

    expect(result).toEqual({ ok: true })
    expect(fake.messages).toEqual([
      {
        host: NATIVE_HOST,
        message: {
          type: 'queue-download',
          url: 'https://example.com/files/a.bin'
        }
      }
    ])
  })

  it('keeps the explicit force opt-in for Download again', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true }

    await sendQueueDownload('https://example.com/a.bin', { force: true })

    expect(fake.messages[0]?.message).toEqual({
      type: 'queue-download',
      url: 'https://example.com/a.bin',
      force: true
    })
  })

  it('does not claim success when the app rejects the manual capture', async () => {
    const fake = installFakeNative()
    fake.response = {
      ok: false,
      error: { code: 'DUPLICATE_DOWNLOAD', message: 'Already queued.' }
    }

    const result = await sendQueueDownload('https://example.com/a.bin')
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_DOWNLOAD' }
    })
  })
})

describe('captured progressive source envelope', () => {
  it('sends a verified progressive URL and sanitized filename through the same native host', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true, operation: 'queue-captured-source' }

    const result = await sendQueueCapturedSource(
      'https://cdn.example/video/clip.mp4?sig=abc#t=2',
      'clip.mp4'
    )

    expect(result).toEqual({ ok: true })
    expect(fake.messages).toEqual([
      {
        host: NATIVE_HOST,
        message: {
          type: 'queue-captured-source',
          url: 'https://cdn.example/video/clip.mp4?sig=abc',
          filename: 'clip.mp4'
        }
      }
    ])
  })

  it('rejects blob, manifest and unrecognized sources before native messaging', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true }

    for (const [url, code] of [
      ['blob:https://example.com/abc', 'UNSUPPORTED_URL'],
      ['https://cdn.example/index.m3u8', 'CAPTURED_SOURCE_UNSUPPORTED'],
      ['https://cdn.example/manifest.mpd', 'CAPTURED_SOURCE_UNSUPPORTED'],
      ['https://cdn.example/stream', 'CAPTURED_SOURCE_UNVERIFIED'],
      ['https://cdn.example/video.mp4', 'INVALID_FILENAME']
    ] as const) {
      const result = await sendQueueCapturedSource(
        url,
        code === 'INVALID_FILENAME' ? '../escape.mp4' : undefined
      )
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe(code)
    }
    expect(fake.messages).toHaveLength(0)
  })

  it('accepts an extensionless CDN URL only with exact complete-file response evidence', () => {
    expect(normalizeCapturedSource('https://cdn.example/stream?id=1', 'clip.webm')).toMatchObject({
      ok: false,
      code: 'CAPTURED_SOURCE_UNVERIFIED'
    })
    expect(
      normalizeCapturedSource('https://cdn.example/stream?id=1', 'clip.webm', {
        contentType: 'video/webm',
        expectedBytes: 1234
      })
    ).toEqual({
      ok: true,
      url: 'https://cdn.example/stream?id=1',
      filename: 'clip.webm',
      contentType: 'video/webm',
      expectedBytes: 1234
    })
  })

  it('does not claim success when the desktop bridge rejects the source', async () => {
    const fake = installFakeNative()
    fake.response = {
      ok: false,
      error: { code: 'DUPLICATE_DOWNLOAD', message: 'Already queued.' }
    }

    const result = await sendQueueCapturedSource('https://cdn.example/clip.mp4')
    expect(result).toMatchObject({ ok: false, error: { code: 'DUPLICATE_DOWNLOAD' } })
  })
})

describe('media native envelopes', () => {
  it('sends an exact analyze-media envelope and validates the response', async () => {
    const fake = installFakeNative()
    fake.response = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }

    const result = await sendAnalyzeMedia('https://example.com/watch?v=1#x')

    expect(result).toMatchObject({
      ok: true,
      analysis: {
        title: 'Example media',
        thumbnailUrl: 'https://i.ytimg.com/vi/example/hqdefault.jpg',
        options: [
          {
            estimatedBytes: 12_000,
            outputSizes: {
              mp4: { bytes: 11_000, isEstimate: true }
            },
            formatIds: ['137', '140']
          }
        ]
      }
    })
    expect(fake.messages).toEqual([
      {
        host: NATIVE_HOST,
        message: { type: 'analyze-media', url: 'https://example.com/watch?v=1' }
      }
    ])
  })

  it('sends only opaque analysis/option IDs when queueing', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, operation: 'queue-media', job: job() }

    const result = await sendQueueMedia({
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID
    })

    expect(result).toMatchObject({ ok: true, job: { status: 'queued' } })
    expect(fake.messages[0]?.message).toEqual({
      type: 'queue-media',
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID
    })
  })

  it('rejects a raw selector before touching native messaging', async () => {
    const fake = installFakeNative()

    const result = await sendQueueMedia({
      analysisId: 'bestvideo+bestaudio',
      optionId: VIDEO_OPTION_ID
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_MEDIA_OPTION' } })
    expect(fake.messages).toHaveLength(0)
  })

  it('rejects an unexpected or malformed native response safely', async () => {
    const fake = installFakeNative()
    fake.response = {
      ok: true,
      operation: 'analyze-media',
      analysis: { ...analysis(), cookies: [] }
    }

    const result = await sendAnalyzeMedia('https://example.com/watch')
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_RESPONSE_INVALID' }
    })
  })

  it('reports a native host runtime error with a safe code', async () => {
    const fake = installFakeNative()
    fake.runtimeError = 'Specified native messaging host not found.'

    const result = await sendAnalyzeMedia('https://example.com/watch')
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_HOST_NOT_REGISTERED' }
    })
  })
})

describe('scan this page message', () => {
  it('sends only the validated URL and an optional exact-host cookie', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true }

    const result = await sendScanPage(
      '  https://discuss.example/t/topic/346779#post-4 ',
      'auth=1; theme=dark'
    )

    expect(result).toEqual({ ok: true })
    expect(fake.messages).toEqual([
      {
        host: NATIVE_HOST,
        message: {
          type: SCAN_PAGE_MESSAGE_TYPE,
          url: 'https://discuss.example/t/topic/346779',
          cookie: 'auth=1; theme=dark'
        }
      }
    ])
  })

  it('never sends a cookie when the user has not opted in', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true }

    await sendScanPage('https://discuss.example/t/topic/346779')

    expect(fake.messages[0]?.message).toEqual({
      type: 'scan-page',
      url: 'https://discuss.example/t/topic/346779'
    })
  })

  it('rejects invalid URLs, cookies and unexpected native responses', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, accepted: true }

    await expect(sendScanPage('file:///secret')).resolves.toMatchObject({
      ok: false
    })
    await expect(
      sendScanPage('https://discuss.example/t/topic/1', 'auth=1\r\nX: y')
    ).resolves.toMatchObject({ ok: false })
    expect(fake.messages).toHaveLength(0)

    fake.response = { ok: true, accepted: false }
    const rejected = await sendScanPage('https://discuss.example/t/topic/1')
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_RESPONSE_INVALID' }
    })
  })
})

describe('hand-off card bridge operations', () => {
  const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

  it('asks only for the progress of one validated download id', async () => {
    const fake = installFakeNative()
    fake.response = {
      ok: true,
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    }

    await expect(sendDownloadStatus(DOWNLOAD_ID)).resolves.toEqual({
      ok: true,
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    })
    expect(fake.messages).toEqual([
      {
        host: NATIVE_HOST,
        message: { type: 'download-status', downloadId: DOWNLOAD_ID }
      }
    ])
  })

  it('rejects a malformed id and any unexpected status field', async () => {
    const fake = installFakeNative()
    await expect(sendDownloadStatus('not-a-uuid')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_DOWNLOAD_ID' }
    })
    await expect(sendDownloadStatus(42)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_DOWNLOAD_ID' }
    })
    expect(fake.messages).toHaveLength(0)

    for (const response of [
      { ok: true, status: 'downloading', completedBytes: 1, totalBytes: 2, filename: 'a.zip' },
      { ok: true, status: 'running', completedBytes: -1, totalBytes: 2, filename: 'a.zip' },
      { ok: true, status: 'running', completedBytes: 1, totalBytes: 2, filename: 'C:\\a.zip' },
      {
        ok: true,
        status: 'running',
        completedBytes: 1,
        totalBytes: 2,
        filename: 'a.zip',
        url: 'https://example.com/files/a.zip'
      },
      { ok: true, status: 'running', completedBytes: 1, totalBytes: 2 }
    ]) {
      fake.response = response
      await expect(sendDownloadStatus(DOWNLOAD_ID)).resolves.toMatchObject({
        ok: false,
        error: { code: 'DOWNLOAD_STATUS_INVALID' }
      })
    }

    // A safe error message is kept; a URL or a path is dropped.
    fake.response = {
      ok: true,
      status: 'error',
      completedBytes: 0,
      totalBytes: 2,
      filename: 'a.zip',
      errorMessage: 'Disk full'
    }
    await expect(sendDownloadStatus(DOWNLOAD_ID)).resolves.toMatchObject({
      ok: true,
      status: 'error',
      errorMessage: 'Disk full'
    })
    fake.response = {
      ok: true,
      status: 'error',
      completedBytes: 0,
      totalBytes: 2,
      filename: 'a.zip',
      errorMessage: 'Failed: https://example.com/files/a.zip'
    }
    const dropped = await sendDownloadStatus(DOWNLOAD_ID)
    expect(dropped).toMatchObject({ ok: true, status: 'error' })
    expect(dropped).not.toHaveProperty('errorMessage')

    // An app-side rejection is reported as such.
    fake.response = {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'DonDownload does not have that download.' }
    }
    await expect(sendDownloadStatus(DOWNLOAD_ID)).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' }
    })
  })

  it('confirms a Show request only on an explicit answer', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, shown: true }
    await expect(sendShowDownload(DOWNLOAD_ID)).resolves.toEqual({ ok: true })
    expect(fake.messages).toEqual([
      {
        host: NATIVE_HOST,
        message: { type: 'show-download', downloadId: DOWNLOAD_ID }
      }
    ])

    for (const response of [
      { ok: true },
      { ok: true, shown: false },
      { ok: false, error: { code: 'SHOW_DOWNLOAD_UNAVAILABLE', message: 'No.' } }
    ]) {
      fake.response = response
      await expect(sendShowDownload(DOWNLOAD_ID)).resolves.toMatchObject({
        ok: false
      })
    }

    await expect(sendShowDownload('nope')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_DOWNLOAD_ID' }
    })
  })
})

interface FakeNativePort {
  posted: Array<Record<string, unknown>>
  messageListener: ((value: unknown) => void) | null
  disconnectListener: (() => void) | null
  onMessage: { addListener(listener: (value: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
  postMessage(message: Record<string, unknown>): void
  disconnect(): void
  reply(value: Record<string, unknown>): void
  close(): void
}

interface FakePortChrome {
  port: FakeNativePort
  oneShot: Array<{ host: string; message: unknown }>
  response: unknown
  runtimeError: string | null
}

function installFakePort(): FakePortChrome {
  const fake: FakePortChrome = {
    port: null as any,
    oneShot: [],
    response: null,
    runtimeError: null
  }
  const port: FakeNativePort = {
    posted: [],
    messageListener: null,
    disconnectListener: null,
    onMessage: {
      addListener(listener) {
        port.messageListener = listener
      }
    },
    onDisconnect: {
      addListener(listener) {
        port.disconnectListener = listener
      }
    },
    postMessage(message) {
      port.posted.push(message)
    },
    disconnect() {
      // The bridge never disconnects the port itself.
    },
    reply(value) {
      if (port.messageListener) port.messageListener(value)
    },
    close() {
      if (port.disconnectListener) port.disconnectListener()
    }
  }
  fake.port = port
  const chrome: any = {
    runtime: {
      lastError: undefined,
      connectNative() {
        return port
      },
      sendNativeMessage(host: string, message: unknown, callback: (value: unknown) => void) {
        fake.oneShot.push({ host, message })
        if (fake.runtimeError) chrome.runtime.lastError = { message: fake.runtimeError }
        callback(fake.response)
        chrome.runtime.lastError = undefined
      }
    }
  }
  ;(globalThis as any).chrome = chrome
  return fake
}

describe('one persistent native port serves every request', () => {
  it('multiplexes concurrent requests by id and hides the transport id', async () => {
    const fake = installFakePort()

    const queued = sendQueueDownload('https://example.com/files/a.bin')
    const probed = probeNativeConnection()

    expect(fake.port.posted).toHaveLength(2)
    expect(fake.port.posted[0]).toEqual({
      type: 'queue-download',
      url: 'https://example.com/files/a.bin',
      id: '1'
    })
    expect(fake.port.posted[1]).toEqual({ type: 'probe', id: '2' })

    // Replies may arrive out of order; the echoed id routes each one.
    fake.port.reply({ id: '2', ok: true, operation: 'probe' })
    fake.port.reply({ id: '1', ok: true, accepted: true })

    await expect(probed).resolves.toEqual({ ok: true })
    await expect(queued).resolves.toEqual({ ok: true })
    // The one-shot path was never used.
    expect(fake.oneShot).toHaveLength(0)
  })

  it('reuses the same port for later requests', async () => {
    const fake = installFakePort()
    const first = sendQueueDownload('https://example.com/a.bin')
    fake.port.reply({ id: '1', ok: true })
    await expect(first).resolves.toEqual({ ok: true })

    const second = sendQueueDownload('https://example.com/b.bin')
    fake.port.reply({ id: '2', ok: true })
    await expect(second).resolves.toEqual({ ok: true })
    expect(fake.port.posted.map((message) => message.id)).toEqual(['1', '2'])
  })

  it('falls back to one native message when the port closes unanswered', async () => {
    const fake = installFakePort()
    const pending = sendQueueDownload('https://example.com/files/a.bin')
    fake.response = { ok: true, accepted: true }

    fake.port.close()

    await expect(pending).resolves.toEqual({ ok: true })
    expect(fake.oneShot).toEqual([
      {
        host: NATIVE_HOST,
        message: { type: 'queue-download', url: 'https://example.com/files/a.bin' }
      }
    ])
  })

  it('reports a host that disconnects with an error instead of retrying', async () => {
    const fake = installFakePort()
    const pending = sendQueueDownload('https://example.com/files/a.bin')
    ;(globalThis as any).chrome.runtime.lastError = {
      message: 'Specified native messaging host not found.'
    }

    fake.port.close()

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'NATIVE_HOST_NOT_REGISTERED' }
    })
    expect(fake.oneShot).toHaveLength(0)
  })
})
