import { describe, expect, it } from 'vitest'
import type { MediaAnalysis, MediaFormatOption } from '../src/shared/media'
import { AppError } from '../src/main/errors'
import {
  resolveVideoCandidates,
  videoIdentityForUrl,
  type VideoResolution
} from '../src/main/scanner/videoResolver'

const VIDEO_URL = 'https://www.youtube.com/watch?v=AbCdEf12345'

function option(
  overrides: Partial<MediaFormatOption> & { optionId: string }
): MediaFormatOption {
  return {
    kind: 'video',
    label: '1080p · MP4',
    container: 'mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'avc1',
    audioCodec: 'aac',
    hasAudio: true,
    requiresMerge: false,
    filesizeBytes: null,
    estimatedBytes: 100 * 1024 * 1024,
    sizeIsEstimate: true,
    outputFormats: ['auto', 'mp4', 'mkv'],
    ...overrides
  }
}

function analysis(
  overrides: Partial<MediaAnalysis> = {}
): MediaAnalysis {
  const options: MediaFormatOption[] = [
    option({ optionId: 'opt_1080' }),
    option({
      optionId: 'opt_720',
      label: '720p · MP4',
      width: 1280,
      height: 720,
      estimatedBytes: 50 * 1024 * 1024
    }),
    option({
      optionId: 'opt_audio',
      kind: 'audio',
      label: 'Audio only · M4A',
      container: 'm4a',
      width: null,
      height: null,
      videoCodec: null,
      filesizeBytes: 5 * 1024 * 1024,
      estimatedBytes: 5 * 1024 * 1024,
      sizeIsEstimate: false
    })
  ]
  return {
    analysisId: 'analysis_1',
    title: 'A public demo video',
    thumbnailUrl: 'https://i.example/thumb.jpg',
    durationSeconds: 123.9,
    options,
    bestVideoOptionId: 'opt_1080',
    bestAudioOptionId: 'opt_audio',
    expiresAt: 10_000,
    ...overrides
  }
}

async function resolveOne(
  analyze: Parameters<typeof resolveVideoCandidates>[1]['analyze'],
  options: { cap?: number } = {}
): Promise<VideoResolution> {
  let result: VideoResolution | null = null
  await resolveVideoCandidates(
    [{ url: VIDEO_URL, fallbackName: 'fallback title' }],
    {
      analyze,
      ...options,
      onResult: (_index, resolution) => {
        result = resolution
      }
    }
  )
  if (result === null) throw new Error('no resolution')
  return result
}

describe('video resolver', () => {
  it('resolves a ready video with safe formats, metadata and an estimated size', async () => {
    const resolution = await resolveOne(async () => analysis())

    expect(resolution).toMatchObject({
      status: 'ready',
      title: 'A public demo video',
      thumbnailUrl: 'https://i.example/thumb.jpg',
      durationSeconds: 123,
      width: 1920,
      height: 1080,
      bestResolution: '1080p',
      sizeBytes: 100 * 1024 * 1024,
      sizeIsEstimate: true,
      bestOptionId: 'opt_1080',
      analysisId: 'analysis_1',
      reason: null
    })
    expect(resolution.formats.map((format) => format.optionId)).toEqual([
      'opt_1080',
      'opt_720',
      'opt_audio'
    ])
    const withoutThumbnail = { ...resolution, thumbnailUrl: null }
    expect(JSON.stringify(withoutThumbnail)).not.toContain('http')
    expect(JSON.stringify(resolution)).not.toContain('format_url')
  })

  it('maps DRM, sign-in and unsupported failures to distinct states', async () => {
    const drm = await resolveOne(async () => {
      throw new AppError('MEDIA_DRM_PROTECTED', 'drm')
    })
    expect(drm.status).toBe('protected')
    expect(drm.reason).toMatch(/DRM-protected/)

    const signin = await resolveOne(async () => {
      throw new AppError('MEDIA_ANALYSIS_SIGNIN', 'sign in')
    })
    expect(signin.status).toBe('signin')

    const genericSignin = await resolveOne(async () => {
      throw new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'Sign in to confirm your age'
      )
    })
    expect(genericSignin.status).toBe('signin')

    const unsupported = await resolveOne(async () => {
      throw new AppError('MEDIA_UNSUPPORTED_MEDIA', 'unsupported')
    })
    expect(unsupported.status).toBe('browser-only')
    expect(unsupported.reason).toMatch(/open it in your browser/)
  })

  it('turns a missing yt-dlp into a tool state without failing the scan', async () => {
    const calls: string[] = []
    const resolutions: VideoResolution[] = []
    await resolveVideoCandidates(
      [
        { url: VIDEO_URL, fallbackName: 'a' },
        { url: 'https://vimeo.com/1', fallbackName: 'b' },
        { url: 'https://vimeo.com/2', fallbackName: 'c' }
      ],
      {
        analyze: async (url) => {
          calls.push(url)
          throw new AppError('MEDIA_TOOL_UNAVAILABLE', 'missing')
        },
        onResult: (_index, resolution) => resolutions.push(resolution)
      }
    )

    expect(resolutions.length).toBeGreaterThan(0)
    expect(
      resolutions.every((resolution) => resolution.status === 'tool-unavailable')
    ).toBe(true)
    expect(
      resolutions.every((resolution) =>
        /yt-dlp is not available/.test(resolution.reason ?? '')
      )
    ).toBe(true)
    // The runner stops launching further analyses once the tool is missing.
    expect(calls.length).toBeLessThanOrEqual(2)
  })

  it('aborts in-flight analyses when the session is cancelled', async () => {
    const controller = new AbortController()
    let sawAbort = false
    let started: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const run = resolveVideoCandidates(
      [{ url: VIDEO_URL, fallbackName: 'a' }],
      {
        signal: controller.signal,
        analyze: async (_url, options) => {
          started()
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                sawAbort = true
                reject(new AppError('MEDIA_ANALYSIS_CANCELLED', 'cancelled'))
              },
              { once: true }
            )
          })
        },
        onResult: () => undefined
      }
    )
    await ready
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'SCAN_CANCELLED' })
    expect(sawAbort).toBe(true)
  })

  it('caps analyses and keeps at most two running', async () => {
    const inputs = Array.from({ length: 12 }, (_value, index) => ({
      url: `https://www.youtube.com/watch?v=id${index}`,
      fallbackName: `video ${index}`
    }))
    let active = 0
    let maximum = 0
    let calls = 0
    await resolveVideoCandidates(inputs, {
      cap: 5,
      analyze: async () => {
        calls += 1
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return analysis()
      },
      onResult: () => undefined
    })

    expect(calls).toBe(5)
    expect(maximum).toBeLessThanOrEqual(2)
  })

  it('passes the cookie only to the exact host', async () => {
    const seen: Array<{ url: string; cookie?: string }> = []
    await resolveVideoCandidates(
      [
        { url: 'https://www.youtube.com/watch?v=a', fallbackName: 'a' },
        { url: 'https://vimeo.com/2', fallbackName: 'b' }
      ],
      {
        cookieHost: 'www.youtube.com',
        cookie: 'auth=1',
        analyze: async (url, options) => {
          seen.push({
            url,
            ...(options?.cookie === undefined ? {} : { cookie: options.cookie })
          })
          return analysis()
        },
        onResult: () => undefined
      }
    )

    expect(seen).toEqual(
      expect.arrayContaining([
        { url: 'https://www.youtube.com/watch?v=a', cookie: 'auth=1' },
        { url: 'https://vimeo.com/2' }
      ])
    )
  })
})

describe('video identity', () => {
  it('merges the same video reached through different URL shapes', () => {
    expect(videoIdentityForUrl('https://youtu.be/AbCdEf12345')).toBe(
      'youtube:AbCdEf12345'
    )
    expect(
      videoIdentityForUrl('https://www.youtube.com/watch?v=AbCdEf12345&t=3')
    ).toBe('youtube:AbCdEf12345')
    expect(
      videoIdentityForUrl('https://www.youtube.com/embed/AbCdEf12345')
    ).toBe('youtube:AbCdEf12345')
    expect(videoIdentityForUrl('https://vimeo.com/76979871')).toBe(
      'vimeo:76979871'
    )
    expect(videoIdentityForUrl('https://vimeo.com/76979872')).not.toBe(
      'vimeo:76979871'
    )
    expect(videoIdentityForUrl('https://example.com/watch/video')).toBeNull()
  })
})
