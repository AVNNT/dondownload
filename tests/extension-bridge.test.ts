import { afterEach, describe, expect, it } from 'vitest'
import {
  NATIVE_HOST,
  sendAnalyzeMedia,
  sendQueueDownload,
  sendQueueMedia
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
        filesizeBytes: 10_000
      }
    ],
    bestVideoOptionId: VIDEO_OPTION_ID,
    bestAudioOptionId: null,
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

describe('media native envelopes', () => {
  it('sends an exact analyze-media envelope and validates the response', async () => {
    const fake = installFakeNative()
    fake.response = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }

    const result = await sendAnalyzeMedia('https://example.com/watch?v=1#x')

    expect(result).toMatchObject({ ok: true, analysis: { title: 'Example media' } })
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
