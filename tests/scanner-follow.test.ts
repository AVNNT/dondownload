import { describe, expect, it } from 'vitest'
import type { MediaAnalysis } from '../src/shared/media'
import type { ScanSession } from '../src/shared/scanner'
import {
  extractFollowCandidates,
  scoreFollowLink
} from '../src/main/scanner/follow'
import { isRobotsAllowed, parseRobots } from '../src/main/scanner/robots'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const BASE = 'https://site.example/thread/1'

function analysis(): MediaAnalysis {
  return {
    analysisId: 'analysis_1',
    title: 'Demo video',
    thumbnailUrl: null,
    durationSeconds: 42,
    options: [
      {
        kind: 'video',
        optionId: 'opt_1',
        label: '1080p · MP4',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'aac',
        hasAudio: true,
        requiresMerge: false,
        filesizeBytes: 1000,
        estimatedBytes: 1000,
        sizeIsEstimate: false,
        outputFormats: ['auto']
      }
    ],
    bestVideoOptionId: 'opt_1',
    bestAudioOptionId: null,
    expiresAt: 9_999_999
  }
}

function htmlPage(url: string, body: string) {
  return {
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

function fetcherFor(
  pages: Record<string, string>,
  options: {
    robots?: Record<string, string>
    fetched?: string[]
    onFetch?: () => void
  } = {}
): ScanPageFetcher {
  return async (input) => {
    options.fetched?.push(input.url)
    options.onFetch?.()
    if (input.url.endsWith('/robots.txt')) {
      const origin = new URL(input.url).origin
      const text = options.robots?.[origin] ?? ''
      return {
        finalUrl: input.url,
        status: 200,
        contentType: 'text/plain',
        contentDisposition: null,
        body: text,
        bytes: Buffer.byteLength(text)
      }
    }
    const body = pages[input.url]
    if (body === undefined) {
      throw Object.assign(new Error('not found'), {
        code: 'SCAN_FETCH_FAILED'
      })
    }
    return htmlPage(input.url, body)
  }
}

function managed(
  fetcher: ScanPageFetcher,
  options: {
    now?: () => number
    budget?: number
    followPages?: number
    updates?: ScanSession[]
  } = {}
): ScanSessionManager {
  return new ScanSessionManager({
    fetchPage: fetcher,
    analyzeMedia: async () => analysis(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.budget === undefined ? {} : { sessionBudgetMs: options.budget }),
    ...(options.followPages === undefined
      ? {}
      : { followPages: options.followPages }),
    probeItem: async (input) => ({
      status: 'found',
      verified: false,
      contentType: null,
      contentDisposition: null,
      sizeBytes: null,
      finalUrl: null,
      classification: {
        category: 'page',
        kind: 'page-link',
        name: input.url,
        extension: null
      },
      reason: null
    }),
    onUpdate: (session) => options.updates?.push(session)
  })
}

describe('follow scoring', () => {
  it('follows embeds, video hosts and same-site watch paths', () => {
    expect(
      scoreFollowLink({
        url: 'https://www.youtube.com/watch?v=AbCdEf12345',
        baseUrl: BASE
      })
    ).toMatchObject({ reason: 'video-host' })
    expect(
      scoreFollowLink({
        url: 'https://player.example/embed/abc',
        baseUrl: BASE,
        isEmbed: true
      })
    ).toMatchObject({ reason: 'embed' })
    expect(
      scoreFollowLink({ url: 'https://site.example/video/one', baseUrl: BASE })
    ).toMatchObject({ reason: 'video-path' })
    expect(
      scoreFollowLink({
        url: 'https://site.example/thread/2',
        baseUrl: BASE,
        text: 'Watch the clip'
      })
    ).toMatchObject({ reason: 'video-text' })
  })

  it('applies forum navigation only to the scanned forum host', () => {
    const forum = 'https://discuss.eroscripts.com/t/example-topic/346779'
    const forumHost = 'discuss.eroscripts.com'

    // Other sites use these first path segments for real content.
    for (const url of [
      'https://pixeldrain.com/u/abc123',
      'https://example.com/t/clip',
      'https://example.com/new/video1'
    ]) {
      expect(scoreFollowLink({ url, baseUrl: forum, forumHost })).not.toBeNull()
    }

    // The scanned forum's own navigation is still never followed.
    for (const url of [
      'https://discuss.eroscripts.com/t/other-topic/1',
      'https://discuss.eroscripts.com/u/user',
      'https://discuss.eroscripts.com/c/cat',
      'https://discuss.eroscripts.com/new'
    ]) {
      expect(scoreFollowLink({ url, baseUrl: forum, forumHost })).toBeNull()
    }
  })

  it('never follows pagination, login or external non-video links', () => {
    expect(
      scoreFollowLink({ url: 'https://site.example/page/2', baseUrl: BASE })
    ).toBeNull()
    expect(
      scoreFollowLink({ url: 'https://site.example/?page=2', baseUrl: BASE })
    ).toBeNull()
    expect(
      scoreFollowLink({ url: 'https://site.example/login', baseUrl: BASE })
    ).toBeNull()
    expect(
      scoreFollowLink({ url: 'https://site.example/category/action', baseUrl: BASE })
    ).toBeNull()
    expect(
      scoreFollowLink({ url: 'https://other.example/article', baseUrl: BASE })
    ).toBeNull()
  })

  it('treats Discourse nofollow as a ranking hint, not a hard block', () => {
    // Discourse adds rel="nofollow ugc" to every user link. A video-shaped
    // link is still followed at a lower priority; an article link stays out.
    expect(
      scoreFollowLink({
        url: 'https://site.example/video/one',
        baseUrl: BASE,
        rel: 'nofollow ugc'
      })
    ).toMatchObject({ reason: 'video-path' })
    expect(
      scoreFollowLink({
        url: 'https://unknown-video.example/watch?v=1234',
        baseUrl: BASE,
        rel: 'nofollow ugc',
        text: 'watch on hanime1'
      })
    ).toMatchObject({ reason: 'video-path' })
    expect(
      scoreFollowLink({
        url: 'https://site.example/article/random',
        baseUrl: BASE,
        rel: 'nofollow ugc'
      })
    ).toBeNull()
  })

  it('extracts iframe embeds and honours rel attributes', () => {
    const candidates = extractFollowCandidates(
      `<a href="/video/one" rel="nofollow">one</a>
       <a href="/video/two">two</a>
       <iframe src="https://player.example/embed/x" title="Clip"></iframe>`,
      BASE
    )
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://site.example/video/one',
          rel: 'nofollow'
        }),
        expect.objectContaining({
          url: 'https://site.example/video/two'
        }),
        expect.objectContaining({
          url: 'https://player.example/embed/x',
          isEmbed: true,
          nameHint: 'Clip'
        })
      ])
    )
  })
})

describe('robots parser', () => {
  it('uses the longest matching rule and lets Allow win a tie', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /private\nAllow: /private/ok\n'
    )
    expect(isRobotsAllowed(rules, '/private/x')).toBe(false)
    expect(isRobotsAllowed(rules, '/private/ok/1')).toBe(true)
    expect(isRobotsAllowed(rules, '/public')).toBe(true)
  })

  it('prefers a scanner-specific group over the wildcard group', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: DonDownload\nAllow: /\n'
    )
    expect(isRobotsAllowed(rules, '/anything', 'DonDownload')).toBe(true)
  })
})

describe('recursive scanner discovery', () => {
  it('follows video pages one level deep, avoids cycles and honours robots', async () => {
    const pages: Record<string, string> = {
      [BASE]: `
        <a href="/video/one">watch one</a>
        <a href="/video/two">watch two</a>
        <a href="/video/blocked">blocked</a>
        <a href="/page/2">next</a>
        <a href="/login">login</a>
        <a rel="nofollow" href="/video/nofollow">nofollow</a>
        <a rel="nofollow ugc" href="/article/random">random article</a>
        <a href="https://other.example/article">external</a>
      `,
      'https://site.example/video/one': `
        <a href="/video/two">back to two</a>
        <a href="/video/three">three</a>
        <a class="attachment" href="/uploads/from-linked-page.zip">from-linked-page.zip</a>
      `,
      'https://site.example/video/two': `
        <a href="/video/one">cycle</a>
        <a href="/video/four">four</a>
      `,
      'https://site.example/video/three': '<a href="/video/deep">too deep</a>',
      'https://site.example/video/four': '',
      'https://site.example/video/deep': ''
    }
    const fetched: string[] = []
    const fetcher = fetcherFor(pages, {
      robots: {
        'https://site.example': 'User-agent: *\nDisallow: /video/blocked\n'
      },
      fetched
    })
    const sessions = managed(fetcher, { followPages: 10 })
    const started = sessions.start(BASE)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.status).toBe('done')
    expect(fetched).toContain('https://site.example/video/one')
    expect(fetched).toContain('https://site.example/video/two')
    // One level only: links found on a followed page are listed, not followed.
    expect(fetched).not.toContain('https://site.example/video/three')
    expect(fetched).not.toContain('https://site.example/video/four')
    expect(fetched).not.toContain('https://site.example/video/deep')
    expect(fetched).not.toContain('https://site.example/video/blocked')
    expect(fetched).toContain('https://site.example/video/nofollow')
    expect(fetched).not.toContain('https://site.example/article/random')
    expect(fetched).not.toContain('https://site.example/page/2')
    expect(fetched).not.toContain('https://site.example/login')
    expect(fetched).not.toContain('https://other.example/article')
    // Files found on a directly linked page still count.
    expect(JSON.stringify(done.items)).toContain('from-linked-page.zip')
    // Followed same-site video paths become resolvable video page links.
    expect(
      done.items.filter(
        (item) => item.category === 'video' && item.kind === 'page-link'
      ).length
    ).toBeGreaterThanOrEqual(3)
    // Each page was requested at most once (cycle prevention).
    const pageFetches = fetched.filter((url) => !url.endsWith('/robots.txt'))
    expect(new Set(pageFetches).size).toBe(pageFetches.length)
    // One robots.txt read per host for the whole session.
    expect(
      fetched.filter((url) => url.endsWith('/robots.txt'))
    ).toHaveLength(1)
  })

  it('fetches the pasted URL even when robots.txt disallows it', async () => {
    const fetched: string[] = []
    const fetcher = fetcherFor(
      {
        [BASE]: '<a href="/video/one">one</a>',
        'https://site.example/video/one': ''
      },
      {
        robots: { 'https://site.example': 'User-agent: *\nDisallow: /thread\n' },
        fetched
      }
    )
    const sessions = managed(fetcher)
    const started = sessions.start(BASE)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(fetched[0]).toBe(BASE)
    expect(done.progress.fetchedPages).toBeGreaterThanOrEqual(1)
    // The followed page is not under the disallowed prefix, so it is read.
    expect(fetched).toContain('https://site.example/video/one')
  })

  it('fetches at most two pages per host concurrently', async () => {
    const pages: Record<string, string> = {
      [BASE]: Array.from(
        { length: 6 },
        (_value, index) => `<a href="/video/${index}">video ${index}</a>`
      ).join('')
    }
    for (let index = 0; index < 6; index += 1) {
      pages[`https://site.example/video/${index}`] = ''
    }
    let active = 0
    let maximum = 0
    const base = fetcherFor(pages)
    const fetcher: ScanPageFetcher = async (input, options) => {
      if (!input.url.endsWith('/robots.txt')) {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
      }
      return base(input, options)
    }
    const sessions = managed(fetcher, { followPages: 10 })
    const started = sessions.start(BASE)
    await sessions.waitForScan(started.sessionId)

    expect(maximum).toBeLessThanOrEqual(2)
  })

  it('deduplicates the same video found through different embeds', async () => {
    const fetcher: ScanPageFetcher = async () =>
      htmlPage(
        BASE,
        `<a href="https://youtu.be/AbCdEf12345">one</a>
         <a href="https://www.youtube.com/watch?v=AbCdEf12345">two</a>
         <a href="https://www.youtube.com/embed/AbCdEf12345">three</a>`
      )
    const sessions = managed(fetcher, { followPages: 1 })
    const started = sessions.start(BASE)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(
      done.items.filter((item) => item.category === 'video')
    ).toHaveLength(1)
  })

  it('reports a limited session when the time budget is exhausted', async () => {
    let now = 1_000
    const pages: Record<string, string> = {
      [BASE]: Array.from(
        { length: 10 },
        (_value, index) => `<a href="/video/${index}">video ${index}</a>`
      ).join('')
    }
    for (let index = 0; index < 10; index += 1) {
      pages[`https://site.example/video/${index}`] = ''
    }
    const fetcher = fetcherFor(pages, {
      onFetch: () => {
        now += 1_500
      }
    })
    const sessions = managed(fetcher, {
      now: () => now,
      budget: 4_000,
      followPages: 25
    })
    const started = sessions.start(BASE)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.status).toBe('limited')
    expect(done.message).toMatch(/time limit/i)
  })
})
