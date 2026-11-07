import { describe, expect, it } from 'vitest'
import {
  classifyScanCandidate,
  isLikelyVideoPageUrl
} from '../src/main/scanner/classify'
import { extractCandidates } from '../src/main/scanner/extract'
import { scoreFollowLink } from '../src/main/scanner/follow'
import {
  hasSingleVideoRules,
  isKnownVideoHost,
  isSingleVideoPageUrl,
  isVideoHostVideoUrl
} from '../src/main/scanner/videoHosts'

const FORUM = 'https://discuss.example/t/example-topic/1'

/** One single-video URL per host that yt-dlp supports. */
const SINGLE_VIDEO_URLS = [
  'https://www.pornhub.com/view_video.php?viewkey=ph5f1234abcd',
  'https://de.pornhub.com/view_video.php?viewkey=1234567',
  'https://www.pornhub.com/embed/ph5f1234abcd',
  'https://www.eporner.com/video-AbC123xYz/some-slug/',
  'https://www.eporner.com/hd-porn/AbC123xYz/some-slug/',
  'https://www.eporner.com/embed/AbC123xYz/',
  'https://www.xvideos.com/video12345678/some_slug',
  'https://www.xvideos.com/video.abc123/some_slug',
  'https://www.xnxx.com/video-12345678/some_slug',
  'https://xhamster.com/videos/some-slug-xhzx1a2',
  'https://xhamster.desi/videos/some-slug-xhzx1a2',
  'https://xhamster2.com/embed/xhzx1a2',
  'https://spankbang.com/abc123/video/some-slug',
  'https://spankbang.com/abc123/embed/',
  'https://www.redtube.com/1234567',
  'https://www.youporn.com/watch/1234567/some-slug/',
  'https://hanime1.me/watch?v=1234'
]

/** Listings, hubs and search pages on the same hosts: never a video. */
const NON_VIDEO_URLS = [
  'https://www.pornhub.com/',
  'https://www.pornhub.com/model/someone',
  'https://www.pornhub.com/categories',
  'https://www.pornhub.com/video/search?search=example',
  'https://www.pornhub.com/view_video.php',
  'https://www.eporner.com/',
  'https://www.eporner.com/cat/amateur/',
  'https://www.eporner.com/search/amateur/?q=example',
  'https://www.xvideos.com/',
  'https://www.xvideos.com/tags/amateur',
  'https://www.xvideos.com/channels/someone',
  'https://www.xvideos.com/video',
  'https://www.xnxx.com/tags/amateur',
  'https://www.xnxx.com/video-',
  'https://xhamster.com/',
  'https://xhamster.com/categories/amateur',
  'https://xhamster.com/videos/amateur',
  'https://xhamster.com/channels/someone',
  'https://spankbang.com/',
  'https://spankbang.com/tag/amateur',
  'https://spankbang.com/new',
  'https://www.redtube.com/pornstar/someone',
  'https://www.redtube.com/category/amateur',
  'https://www.youporn.com/category/amateur/',
  'https://www.youporn.com/watch/',
  'https://hanime1.me/',
  'https://hanime1.me/search?q=example'
]

describe('shared video host rules', () => {
  it('matches known video hosts and their subdomains', () => {
    expect(isKnownVideoHost('pornhub.com')).toBe(true)
    expect(isKnownVideoHost('de.pornhub.com')).toBe(true)
    expect(isKnownVideoHost('www.eporner.com')).toBe(true)
    expect(isKnownVideoHost('www.youtube.com')).toBe(true)
    expect(isKnownVideoHost('m.youtube.com')).toBe(true)
    expect(isKnownVideoHost('player.vimeo.com')).toBe(true)
    expect(isKnownVideoHost('hanime1.me')).toBe(true)
    expect(isKnownVideoHost('fake-pornhub.com')).toBe(false)
    expect(isKnownVideoHost('youtube.com.evil.example')).toBe(false)
    expect(isKnownVideoHost('example.com')).toBe(false)
  })

  it('keeps the permissive behaviour for hosts without a single-video rule', () => {
    expect(hasSingleVideoRules('www.youtube.com')).toBe(false)
    expect(isVideoHostVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isVideoHostVideoUrl('https://www.youtube.com/channel/abc')).toBe(true)
    expect(hasSingleVideoRules('de.pornhub.com')).toBe(true)
  })

  it('recognises single-video URLs on every supported host', () => {
    for (const url of SINGLE_VIDEO_URLS) {
      expect(isSingleVideoPageUrl(url), url).toBe(true)
      expect(isVideoHostVideoUrl(url), url).toBe(true)
      expect(isLikelyVideoPageUrl(url), url).toBe(true)
      expect(classifyScanCandidate({ url }), url).toMatchObject({
        category: 'video',
        kind: 'page-link'
      })
    }
  })

  it('rejects listings, hubs and search pages on the same hosts', () => {
    for (const url of NON_VIDEO_URLS) {
      expect(isSingleVideoPageUrl(url), url).toBe(false)
      expect(isVideoHostVideoUrl(url), url).toBe(false)
      expect(isLikelyVideoPageUrl(url), url).toBe(false)
      expect(classifyScanCandidate({ url }), url).toMatchObject({
        category: 'page',
        kind: 'page-link'
      })
    }
  })

  it('never treats an embed on a rule host as a video unless the rule matches', () => {
    expect(
      classifyScanCandidate({
        url: 'https://www.pornhub.com/embed/ph5f1234abcd',
        isEmbed: true
      })
    ).toMatchObject({ category: 'video', kind: 'page-link' })
    expect(
      classifyScanCandidate({
        url: 'https://www.pornhub.com/model/someone',
        isEmbed: true
      })
    ).toMatchObject({ category: 'page', kind: 'page-link' })
  })
})

describe('scanner discovery of rule-host videos', () => {
  it('extracts pornhub and eporner anchors as video candidates', () => {
    const candidates = extractCandidates(
      `<a href="https://www.pornhub.com/view_video.php?viewkey=ph5f1234abcd">Pornhub video</a>
       <a href="https://www.pornhub.com/model/someone">Pornhub model</a>
       <a href="https://www.eporner.com/video-AbC123xYz/some-slug/">Eporner video</a>
       <a href="https://www.eporner.com/cat/amateur/">Eporner category</a>`,
      FORUM
    )
    const urls = candidates.map((candidate) => candidate.url)
    expect(urls).toContain(
      'https://www.pornhub.com/view_video.php?viewkey=ph5f1234abcd'
    )
    expect(urls).toContain('https://www.eporner.com/video-AbC123xYz/some-slug/')
    expect(urls).not.toContain('https://www.pornhub.com/model/someone')
    expect(urls).not.toContain('https://www.eporner.com/cat/amateur/')

    const videos = candidates.map((candidate) =>
      classifyScanCandidate({ url: candidate.url })
    )
    for (const video of videos) {
      expect(video).toMatchObject({ category: 'video', kind: 'page-link' })
    }
  })

  it('follows matching links as video-host links and drops the rest', () => {
    for (const url of SINGLE_VIDEO_URLS) {
      const decision = scoreFollowLink({
        url,
        baseUrl: FORUM,
        forumHost: 'discuss.example',
        text: 'watch'
      })
      expect(decision, url).not.toBeNull()
      expect(decision).toMatchObject({ reason: 'video-host' })
      expect(decision!.score).toBeGreaterThan(0)
    }

    for (const url of NON_VIDEO_URLS) {
      expect(
        scoreFollowLink({
          url,
          baseUrl: FORUM,
          forumHost: 'discuss.example',
          text: 'watch'
        }),
        url
      ).toBeNull()
    }
  })
})

/**
 * Real asset URLs from a live pornhub homepage scan. Every one of them keeps a
 * `/videos/<date>/<id>/…` path, so only the extension and the host can tell them
 * apart from a watchable page.
 */
const CDN_ASSET_URLS = [
  'https://pix-fl.phncdn.com/c6371/videos/202310/23/440000000/original/(m=eGJF8f)(mh=xyz)12.jpg',
  'https://pix-fl.phncdn.com/c6371/videos/202310/23/440000000/plain/rs:fit:2000:1000:1/w:720/h:405/x:0/y:0/12.webp',
  'https://ei.phncdn.com/videos/202310/23/440000000/original/(m=eGJF8f)(mh=xyz)12.jpg',
  'https://img.xvideos-cdn.com/videos/202310/23/440000000/original/preview.jpg',
  'https://static.eporner.com/videos/202310/23/440000000/preview',
  'https://cdn.example.com/videos/202310/23/440000000/original/preview',
  'https://thumb.example.com/videos/202310/23/440000000/original/preview',
  'https://example.com/videos/202310/23/440000000/original/preview.gif'
]

/** Profile and hub links: only `/<user>/status/<id>` is a video. */
const NON_VIDEO_TWITTER_URLS = [
  'https://twitter.com/someone',
  'https://x.com/someone',
  'https://twitter.com/someone/media',
  'https://x.com/someone/status/',
  'https://twitter.com/someone/status/notanid',
  'https://twitter.com/search?q=example',
  'https://x.com/i/lists/1234'
]

const TWITTER_STATUS_URLS = [
  'https://twitter.com/someone/status/1234567890',
  'https://x.com/someone/status/1234567890',
  'https://x.com/i/web/status/1234567890'
]

describe('scanner asset and profile detection', () => {
  it('never treats a CDN asset URL as a video page', () => {
    for (const url of CDN_ASSET_URLS) {
      expect(isLikelyVideoPageUrl(url), url).toBe(false)
      expect(classifyScanCandidate({ url }), url).not.toMatchObject({
        category: 'video',
        kind: 'page-link'
      })
    }
  })

  it('keeps a real single-video page on a rule host a video page', () => {
    for (const url of SINGLE_VIDEO_URLS) {
      expect(isLikelyVideoPageUrl(url), url).toBe(true)
    }
  })

  it('treats only a twitter/x status link as a video page', () => {
    for (const url of NON_VIDEO_TWITTER_URLS) {
      expect(isSingleVideoPageUrl(url), url).toBe(false)
      expect(isVideoHostVideoUrl(url), url).toBe(false)
      expect(isLikelyVideoPageUrl(url), url).toBe(false)
      expect(classifyScanCandidate({ url }), url).toMatchObject({
        category: 'page',
        kind: 'page-link'
      })
    }
    for (const url of TWITTER_STATUS_URLS) {
      expect(isSingleVideoPageUrl(url), url).toBe(true)
      expect(isLikelyVideoPageUrl(url), url).toBe(true)
      expect(classifyScanCandidate({ url }), url).toMatchObject({
        category: 'video',
        kind: 'page-link'
      })
    }
  })
})
