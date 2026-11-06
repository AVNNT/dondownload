import { describe, expect, it } from 'vitest'
import type { MediaAnalysis } from '../src/shared/media'
import { AppError } from '../src/main/errors'
import {
  classifyScanCandidate,
  isLikelyVideoPageUrl
} from '../src/main/scanner/classify'
import { extractCandidates } from '../src/main/scanner/extract'
import { scoreFollowLink } from '../src/main/scanner/follow'
import { resolveVideoCandidates } from '../src/main/scanner/videoResolver'

const DISCOURSE = 'https://discuss.example/t/topic/1'

function analysis(): MediaAnalysis {
  return {
    analysisId: 'analysis_1',
    title: 'Demo',
    thumbnailUrl: null,
    durationSeconds: 10,
    options: [],
    bestVideoOptionId: null,
    bestAudioOptionId: null,
    expiresAt: 10_000
  }
}

describe('browser-only video classification', () => {
  it('recognises a hanime1-style watch link as a video page link', () => {
    expect(
      classifyScanCandidate({ url: 'https://hanime1.me/watch?v=1234' })
    ).toMatchObject({ category: 'video', kind: 'page-link' })
    expect(
      classifyScanCandidate({ url: 'https://media.example/video/abc-123' })
    ).toMatchObject({ category: 'video', kind: 'page-link' })
    expect(isLikelyVideoPageUrl('https://example.com/v/abc')).toBe(true)
    expect(isLikelyVideoPageUrl('https://example.com/embed/xyz')).toBe(true)
  })

  it('leaves article, listing, MEGA and direct file links alone', () => {
    expect(
      classifyScanCandidate({ url: 'https://example.com/article/how-to-do-things' })
    ).toMatchObject({ category: 'page', kind: 'page-link' })
    expect(
      classifyScanCandidate({ url: 'https://example.com/videos' })
    ).toMatchObject({ category: 'page', kind: 'page-link' })
    expect(
      classifyScanCandidate({ url: 'https://mega.nz/file/AbCdEf123' })
    ).toMatchObject({ category: 'page', kind: 'page-link' })
    expect(
      classifyScanCandidate({ url: 'https://cdn.example/clip.mp4' })
    ).toMatchObject({ category: 'video', kind: 'file' })

    expect(isLikelyVideoPageUrl('https://example.com/article/how-to')).toBe(false)
    expect(isLikelyVideoPageUrl('https://example.com/videos')).toBe(false)
    expect(isLikelyVideoPageUrl('https://example.com/video/one.mp4')).toBe(false)
    expect(isLikelyVideoPageUrl('https://mega.nz/file/AbCdEf123')).toBe(false)
  })

  it('extracts a hanime1 anchor from a Discourse-style page', () => {
    const candidates = extractCandidates(
      `<a href="/article/random">article</a>
       <a href="https://hanime1.me/watch?v=1234" rel="nofollow ugc">Hanime1 Watch Video</a>`,
      DISCOURSE
    )
    expect(candidates.map((entry) => entry.url)).toContain(
      'https://hanime1.me/watch?v=1234'
    )
    expect(candidates.map((entry) => entry.url)).not.toContain(
      'https://discuss.example/article/random'
    )
  })

  it('follows nofollow video links but not nofollow article links', () => {
    expect(
      scoreFollowLink({
        url: 'https://unknown-video.example/watch?v=1234',
        baseUrl: DISCOURSE,
        rel: 'nofollow ugc',
        text: 'Hanime1 Watch Video'
      })
    ).toMatchObject({ reason: 'video-path' })
    expect(
      scoreFollowLink({
        url: 'https://discuss.example/article/random',
        baseUrl: DISCOURSE,
        rel: 'nofollow ugc'
      })
    ).toBeNull()
    expect(
      scoreFollowLink({
        url: 'https://discuss.example/login',
        baseUrl: DISCOURSE,
        rel: 'nofollow ugc'
      })
    ).toBeNull()
    expect(
      scoreFollowLink({
        url: 'https://discuss.example/?page=2',
        baseUrl: DISCOURSE,
        rel: 'nofollow ugc'
      })
    ).toBeNull()
  })
})

describe('browser-only resolver outcome', () => {
  async function resolveWith(error: unknown): Promise<{
    status: string
    reason: string | null
    calls: number
  }> {
    let calls = 0
    let status = ''
    let reason: string | null = null
    await resolveVideoCandidates(
      [{ url: 'https://hanime1.me/watch?v=1234', fallbackName: 'Hanime1' }],
      {
        analyze: async () => {
          calls += 1
          throw error
        },
        onResult: (_index, resolution) => {
          status = resolution.status
          reason = resolution.reason
        }
      }
    )
    return { status, reason, calls }
  }

  it('marks a Cloudflare 403 challenge as browser-only without retrying', async () => {
    const result = await resolveWith(
      new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'ERROR: HTTP Error 403: Forbidden challenge-platform'
      )
    )
    expect(result.status).toBe('browser-only')
    expect(result.reason).toMatch(/open it in your browser/)
    expect(result.calls).toBe(1)
  })

  it('marks an unsupported extractor as browser-only without retrying', async () => {
    const result = await resolveWith(
      new AppError(
        'MEDIA_ANALYSIS_EXTRACTOR_FAILED',
        'ERROR: Unsupported URL: https://hanime1.me/watch?v=1234'
      )
    )
    expect(result.status).toBe('browser-only')
    expect(result.calls).toBe(1)
  })

  it('keeps a resolved video ready', async () => {
    let calls = 0
    let status = ''
    await resolveVideoCandidates(
      [{ url: 'https://hanime1.me/watch?v=1234', fallbackName: 'Hanime1' }],
      {
        analyze: async () => {
          calls += 1
          return analysis()
        },
        onResult: (_index, resolution) => {
          status = resolution.status
        }
      }
    )
    expect(status).toBe('ready')
    expect(calls).toBe(1)
  })
})
