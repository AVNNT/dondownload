import { afterEach, describe, expect, it } from 'vitest'
import {
  MEDIA_MESSAGE_TYPES,
  analyzeEmbeddedPageForSender,
  analyzeMediaForSender,
  authorizeMediaSender,
  queueCapturedSourceForSender,
  queueMediaForSender
} from '../extension/media-bridge'
import {
  originToMatchPattern,
  overlayRegistrationForOrigin
} from '../extension/site-policy'

const EXTENSION_ID = 'a'.repeat(32)
const ORIGIN = 'https://example.com'
const TAB_URL = 'https://example.com/watch?v=1'
const PATTERN = originToMatchPattern(ORIGIN) as string
const ANALYSIS_ID = 'analysis_0123456789abcdef'
const VIDEO_OPTION_ID = 'option_video_0123456789'
const AUDIO_OPTION_ID = 'option_audio_0123456789'
const JOB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

interface FakeChrome {
  api: any
  state: {
    granted: Set<string>
    registered: boolean
    tracked: Record<string, number[]>
    nativeMessages: Array<{ host: string; message: unknown }>
    calls: string[]
    permissions: Set<string>
    captureSettings: Record<string, unknown> | null
    cookies: Array<{ name: string; value: string }>
    cookieQueries: string[]
  }
  nativeResponse: unknown
  nativeError: string | null
}

function createFakeChrome(): FakeChrome {
  const fake: FakeChrome = {
    api: null as any,
    state: {
      granted: new Set([PATTERN]),
      registered: true,
      tracked: { [ORIGIN]: [7] },
      nativeMessages: [],
      calls: [],
      permissions: new Set<string>(),
      captureSettings: null,
      cookies: [],
      cookieQueries: []
    },
    nativeResponse: null,
    nativeError: null
  }

  const registration = overlayRegistrationForOrigin(ORIGIN)
  if (!registration) throw new Error('registration fixture is invalid')

  fake.api = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      sendNativeMessage(host: string, message: unknown, callback: (value: unknown) => void) {
        fake.state.calls.push('native')
        fake.state.nativeMessages.push({ host, message })
        if (fake.nativeError) {
          fake.api.runtime.lastError = { message: fake.nativeError }
        }
        callback(fake.nativeResponse)
        fake.api.runtime.lastError = undefined
      }
    },
    permissions: {
      async contains(permission: {
        origins?: string[]
        permissions?: string[]
      }) {
        fake.state.calls.push('contains')
        if (permission.origins) {
          return permission.origins.every((origin) =>
            fake.state.granted.has(origin)
          )
        }
        return (permission.permissions ?? []).every((name) =>
          fake.state.permissions.has(name)
        )
      }
    },
    cookies: {
      async getAll({ url }: { url: string }) {
        fake.state.cookieQueries.push(url)
        return fake.state.cookies
      }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }: { ids?: string[] } = {}) {
        if (!fake.state.registered) return []
        if (!ids || ids.includes(registration.id)) return [{ ...registration }]
        return []
      }
    },
    storage: {
      local: {
        async get(key: string) {
          return fake.state.captureSettings === null
            ? {}
            : { [key]: fake.state.captureSettings }
        },
        async set() {}
      },
      session: {
        async get(key: string) {
          return { [key]: fake.state.tracked }
        },
        async set(values: Record<string, unknown>) {
          Object.assign(fake.state, values)
        },
        async remove(key: string) {
          if (key === 'dondownloadOverlayTabs') fake.state.tracked = {}
        }
      }
    }
  }

  return fake
}

function validSender(overrides: Record<string, unknown> = {}): any {
  return {
    id: EXTENSION_ID,
    url: TAB_URL,
    frameId: 0,
    tab: { id: 7, url: TAB_URL },
    ...overrides
  }
}

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

function analysis(): Record<string, unknown> {
  return {
    analysisId: ANALYSIS_ID,
    title: 'Example media',
    durationSeconds: 91.5,
    options: [videoOption(), audioOption()],
    bestVideoOptionId: VIDEO_OPTION_ID,
    bestAudioOptionId: AUDIO_OPTION_ID,
    expiresAt: 1_800_000_000_000
  }
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
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
    completedAt: null,
    ...overrides
  }
}

function useChrome(fake: FakeChrome): void {
  ;(globalThis as any).chrome = fake.api
}

afterEach(() => {
  delete (globalThis as any).chrome
})

describe('media sender authorization', () => {
  it('accepts only our own top-frame content script on a registered, tracked, granted origin', async () => {
    const fake = createFakeChrome()
    useChrome(fake)

    const result = await authorizeMediaSender(fake.api, validSender())
    expect(result).toMatchObject({
      ok: true,
      origin: ORIGIN,
      tabId: 7,
      url: TAB_URL
    })
    expect(fake.state.calls).toEqual(['contains'])
  })

  it.each([
    ['another extension id', validSender({ id: 'b'.repeat(32) })],
    ['missing tab', { id: EXTENSION_ID, url: TAB_URL, frameId: 0 }],
    ['non-integer tab id', validSender({ tab: { id: '7', url: TAB_URL } })],
    ['negative tab id', validSender({ tab: { id: -1, url: TAB_URL } })],
    ['a subframe', validSender({ frameId: 1 })],
    ['a chrome page', validSender({ url: 'chrome://settings/', tab: { id: 7, url: 'chrome://settings/' } })],
    ['a file page', validSender({ url: 'file:///C:/secret', tab: { id: 7, url: 'file:///C:/secret' } })],
    ['a mismatched sender/tab origin', validSender({ url: 'https://attacker.example/watch' })],
    ['missing sender url', validSender({ url: undefined })]
  ])('rejects %s without a native call', async (_label, sender) => {
    const fake = createFakeChrome()
    useChrome(fake)

    const result = await authorizeMediaSender(fake.api, sender)
    expect(result.ok).toBe(false)
    expect(fake.state.nativeMessages).toHaveLength(0)
  })

  it('rejects an ungranted exact origin', async () => {
    const fake = createFakeChrome()
    fake.state.granted.clear()
    useChrome(fake)

    const result = await authorizeMediaSender(fake.api, validSender())
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } })
    expect(fake.state.nativeMessages).toHaveLength(0)
  })

  it('rejects a page without the saved exact-origin registration', async () => {
    const fake = createFakeChrome()
    fake.state.registered = false
    useChrome(fake)

    const result = await authorizeMediaSender(fake.api, validSender())
    expect(result).toMatchObject({ ok: false, error: { code: 'OVERLAY_NOT_REGISTERED' } })
    expect(fake.state.nativeMessages).toHaveLength(0)
  })

  it('rejects a tab that is not tracked as running the overlay', async () => {
    const fake = createFakeChrome()
    fake.state.tracked = { [ORIGIN]: [99] }
    useChrome(fake)

    const result = await authorizeMediaSender(fake.api, validSender())
    expect(result).toMatchObject({ ok: false, error: { code: 'TAB_NOT_ASSOCIATED' } })
    expect(fake.state.nativeMessages).toHaveLength(0)
  })
})

describe('authorized media operations', () => {
  it('analyzes the trusted tab URL, ignoring any URL in the content message', async () => {
    const fake = createFakeChrome()
    fake.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }
    useChrome(fake)

    const result = await analyzeMediaForSender(
      fake.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )

    expect(result).toMatchObject({ ok: true, analysis: { title: 'Example media' } })
    expect(fake.state.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: { type: 'analyze-media', url: TAB_URL }
      }
    ])
    expect(fake.state.calls).toEqual(['contains', 'native'])
  })

  it('rejects a content-supplied URL field before any native call', async () => {
    const fake = createFakeChrome()
    useChrome(fake)

    const result = await analyzeMediaForSender(
      fake.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE, url: 'https://attacker.example/' },
      validSender()
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } })
    expect(fake.state.nativeMessages).toHaveLength(0)
  })

  it('analyzes one visible embed URL separately after the exact-origin authorization', async () => {
    const fake = createFakeChrome()
    fake.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }
    useChrome(fake)

    const result = await analyzeEmbeddedPageForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.ANALYZE_EMBED,
        embedUrl: 'https://player.example/embed/abc?x=1#frag'
      },
      validSender()
    )

    expect(result).toMatchObject({ ok: true, analysis: { title: 'Example media' } })
    expect(fake.state.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: {
          type: 'analyze-media',
          url: 'https://player.example/embed/abc?x=1'
        }
      }
    ])
    expect(fake.state.calls).toEqual(['contains', 'native'])
  })

  it('rejects a non-http(s) embed URL before any native call', async () => {
    for (const embedUrl of [
      'blob:https://example.com/abc',
      'javascript:alert(1)',
      'file:///secret.mp4',
      'https://user:pw@player.example/embed'
    ]) {
      const fake = createFakeChrome()
      useChrome(fake)
      const result = await analyzeEmbeddedPageForSender(
        fake.api,
        { type: MEDIA_MESSAGE_TYPES.ANALYZE_EMBED, embedUrl },
        validSender()
      )
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } })
      expect(fake.state.nativeMessages).toHaveLength(0)
    }
  })

  it('queues one opaque analysis/option pair', async () => {
    const fake = createFakeChrome()
    fake.nativeResponse = { ok: true, operation: 'queue-media', job: job() }
    useChrome(fake)

    const result = await queueMediaForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.QUEUE,
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID
      },
      validSender()
    )

    expect(result).toMatchObject({ ok: true, job: { status: 'queued' } })
    expect(fake.state.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: {
          type: 'queue-media',
          analysisId: ANALYSIS_ID,
          optionId: VIDEO_OPTION_ID
        }
      }
    ])
    expect(fake.state.calls).toEqual(['contains', 'native'])
  })

  it('sends opted-in cookies for this exact origin on analyze and queue', async () => {
    const fake = createFakeChrome()
    fake.state.captureSettings = { cookieOptInOrigins: [ORIGIN] }
    fake.state.permissions.add('cookies')
    fake.state.cookies = [
      { name: 'session', value: 'abc' },
      { name: 'theme', value: 'dark' }
    ]
    fake.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }
    useChrome(fake)

    await analyzeMediaForSender(
      fake.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )
    expect(fake.state.cookieQueries).toEqual([TAB_URL])
    expect(fake.state.nativeMessages[0]?.message).toEqual({
      type: 'analyze-media',
      url: TAB_URL,
      cookie: 'session=abc; theme=dark'
    })

    fake.nativeResponse = { ok: true, operation: 'queue-media', job: job() }
    await queueMediaForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.QUEUE,
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID
      },
      validSender()
    )
    expect(fake.state.nativeMessages[1]?.message).toEqual({
      type: 'queue-media',
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID,
      cookie: 'session=abc; theme=dark'
    })
  })

  it('never reads cookies without the exact-origin opt-in and permission', async () => {
    const noOptIn = createFakeChrome()
    noOptIn.state.permissions.add('cookies')
    noOptIn.state.cookies = [{ name: 'session', value: 'abc' }]
    noOptIn.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }
    useChrome(noOptIn)
    await analyzeMediaForSender(
      noOptIn.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )
    expect(noOptIn.state.cookieQueries).toEqual([])
    expect(noOptIn.state.nativeMessages[0]?.message).toEqual({
      type: 'analyze-media',
      url: TAB_URL
    })

    const noPermission = createFakeChrome()
    noPermission.state.captureSettings = { cookieOptInOrigins: [ORIGIN] }
    noPermission.state.cookies = [{ name: 'session', value: 'abc' }]
    noPermission.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }
    useChrome(noPermission)
    await analyzeMediaForSender(
      noPermission.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )
    expect(noPermission.state.cookieQueries).toEqual([])
    expect(noPermission.state.nativeMessages[0]?.message).toEqual({
      type: 'analyze-media',
      url: TAB_URL
    })
  })

  it('queues a detected progressive source only after the exact tab authorization', async () => {
    const fake = createFakeChrome()
    fake.nativeResponse = { ok: true, accepted: true }
    useChrome(fake)

    const result = await queueCapturedSourceForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.CAPTURE_QUEUE,
        url: 'https://cdn.example/clip.mp4?sig=abc',
        filename: 'clip.mp4'
      },
      validSender()
    )

    expect(result).toEqual({ ok: true })
    expect(fake.state.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: {
          type: 'queue-captured-source',
          url: 'https://cdn.example/clip.mp4?sig=abc',
          filename: 'clip.mp4'
        }
      }
    ])
    expect(fake.state.calls).toEqual(['contains', 'native'])
  })

  it('rejects a captured source from an untracked tab or with extra fields', async () => {
    const fake = createFakeChrome()
    fake.state.tracked = { [ORIGIN]: [99] }
    useChrome(fake)

    const untracked = await queueCapturedSourceForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.CAPTURE_QUEUE,
        url: 'https://cdn.example/clip.mp4'
      },
      validSender()
    )
    expect(untracked).toMatchObject({
      ok: false,
      error: { code: 'TAB_NOT_ASSOCIATED' }
    })

    fake.state.tracked = { [ORIGIN]: [7] }
    const extra = await queueCapturedSourceForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.CAPTURE_QUEUE,
        url: 'https://cdn.example/clip.mp4',
        pageUrl: 'https://attacker.example/'
      },
      validSender()
    )
    expect(extra).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } })
    expect(fake.state.nativeMessages).toHaveLength(0)
  })

  it('rejects a raw selector or an extra field before any native call', async () => {
    const fake = createFakeChrome()
    useChrome(fake)

    const raw = await queueMediaForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.QUEUE,
        analysisId: 'bestvideo+bestaudio',
        optionId: VIDEO_OPTION_ID
      },
      validSender()
    )
    expect(raw).toMatchObject({ ok: false, error: { code: 'INVALID_MEDIA_OPTION' } })

    const extra = await queueMediaForSender(
      fake.api,
      {
        type: MEDIA_MESSAGE_TYPES.QUEUE,
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        url: 'https://attacker.example/'
      },
      validSender()
    )
    expect(extra).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } })
    expect(fake.state.nativeMessages).toHaveLength(0)
  })

  it('re-checks the grant before every native call and blocks after revocation', async () => {
    const fake = createFakeChrome()
    fake.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    }
    useChrome(fake)

    await analyzeMediaForSender(
      fake.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )
    fake.state.granted.clear()

    const revoked = await analyzeMediaForSender(
      fake.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )

    expect(revoked).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } })
    expect(fake.state.nativeMessages).toHaveLength(1)
    expect(fake.state.calls).toEqual(['contains', 'native', 'contains'])
  })

  it('rejects an invalid native response shape with a safe error', async () => {
    const fake = createFakeChrome()
    fake.nativeResponse = {
      ok: true,
      operation: 'analyze-media',
      analysis: { ...analysis(), extra: true }
    }
    useChrome(fake)

    const result = await analyzeMediaForSender(
      fake.api,
      { type: MEDIA_MESSAGE_TYPES.ANALYZE },
      validSender()
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_RESPONSE_INVALID' }
    })
    if (result.ok === false) {
      expect(result.error.message).not.toMatch(/https?:\/\//)
    }
  })
})
