import { describe, expect, it } from 'vitest'
import {
  extractVideoMedia,
  heightFromLabel
} from '../src/main/scanner/extract/videoMedia'
import { normalizeScanUrl } from '../src/main/scanner/extract/url'

const HANIME1_URL = 'https://hanime1.me/watch?v=1234'

/**
 * Fixtures only: the extractor is pure, so every case here is a page the app
 * cannot read with yt-dlp (no extractor, Cloudflare, an age gate) but whose own
 * markup still names its media.
 */
const HANIME1_PAGE = `<!doctype html>
<html>
  <head>
    <title>Hanime1 &amp; Friends</title>
    <meta property="og:title" content="  Big   Buck   Bunny  ">
    <meta property="og:image" content="https://hanime1.me/thumbs/1234.jpg">
    <meta property="og:video:duration" content="PT1H2M3S">
  </head>
  <body>
    <video poster="https://hanime1.me/thumbs/poster.jpg" controls>
      <source src="https://v.hanime1.me/media/1080.mp4" size="1080" type="video/mp4">
      <source src="https://v.hanime1.me/media/720.mp4" size="720" type="video/mp4">
    </video>
  </body>
</html>`

const PORNHUB_PAGE = `<!doctype html>
<html>
  <head><title>Pornhub video</title></head>
  <body>
    <script>
      var flashvars_123 = {
        "mediaDefinitions": [
          {"format":"hls","videoUrl":"https://ev.phncdn.example/hls/videos/1/1080P_4000K.m3u8","quality":"1080","defaultQuality":false},
          {"format":"mp4","videoUrl":"https://ev.phncdn.example/videos/1/720P_1500K.mp4","quality":"720"}
        ]
      };
    </script>
  </body>
</html>`

const EPORNER_PAGE = `<!doctype html>
<html>
  <head><title>Eporner video</title></head>
  <body>
    <script>
      player.load({
        sources: [
          { src: "https://cdn.eporner.example/1080p.mp4", label: "1080p", res: "1080" },
          { src: "https://cdn.eporner.example/480p.mp4", label: "480p", res: "480" }
        ]
      });
    </script>
  </body>
</html>`

const OG_VIDEO_PAGE = `<!doctype html>
<html>
  <head>
    <title>Plain clip</title>
    <meta property="og:video:secure_url" content="https://cdn.example/clips/plain.mp4">
  </head>
  <body><p>Nothing else.</p></body>
</html>`

const CLOUDFLARE_PAGE = `<!doctype html>
<html>
  <head><title>Just a moment...</title></head>
  <body>
    <div id="cf-challenge-running">
      Checking your browser before accessing hanime1.me.
      Enable JavaScript and cookies to continue.
    </div>
    <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
  </body>
</html>`

describe('video page media extraction', () => {
  it('reads hanime1-style <video><source size> renditions best first', () => {
    const result = extractVideoMedia(HANIME1_PAGE, HANIME1_URL)

    expect(result.blocked).toBeNull()
    expect(result.title).toBe('Big Buck Bunny')
    expect(result.thumbnailUrl).toBe('https://hanime1.me/thumbs/1234.jpg')
    expect(result.durationSeconds).toBe(3723)
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://v.hanime1.me/media/1080.mp4',
      'https://v.hanime1.me/media/720.mp4'
    ])
    expect(result.sources[0]).toMatchObject({ kind: 'file', height: 1080 })
    expect(result.sources[1]).toMatchObject({ kind: 'file', height: 720 })
  })

  it('reads Pornhub-style mediaDefinitions JSON from an inline script', () => {
    const result = extractVideoMedia(
      PORNHUB_PAGE,
      'https://www.pornhub.example/view_video.php?viewkey=1'
    )

    expect(result.blocked).toBeNull()
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({
      url: 'https://ev.phncdn.example/hls/videos/1/1080P_4000K.m3u8',
      kind: 'hls',
      height: 1080
    })
    expect(result.sources[1]).toMatchObject({
      url: 'https://ev.phncdn.example/videos/1/720P_1500K.mp4',
      kind: 'file',
      height: 720
    })
  })

  it('keeps the full Pornhub HLS URL whose path carries an .mp4 segment', () => {
    const hls =
      'https://hv-h.phncdn.com/hls/videos/202310/23/440000000/1080P_4000K_65036195.mp4/master.m3u8?h=abc&e=1700000000&f=1'
    const mp4 =
      'https://ev-h.phncdn.com/videos/202310/23/440000000/240P_1000K_65036195.mp4?validfrom=1&hash=x'
    const page = `<!doctype html>
<html>
  <body>
    <script>
      var flashvars_1 = {
        "mediaDefinitions": [
          {"format":"hls","videoUrl":"${hls}","quality":"1080"},
          {"format":"mp4","videoUrl":"${mp4}","quality":"240"}
        ]
      };
    </script>
  </body>
</html>`
    const result = extractVideoMedia(page, 'https://www.pornhub.example/view_video.php?viewkey=1')

    // The extractor normalizes each URL (sorted query parameters), so the whole
    // path and its query are compared after the same normalization.
    const normalized = (value: string): string => normalizeScanUrl(value)
    expect(result.sources.map((source) => normalized(source.url)).sort()).toEqual(
      [hls, mp4].map(normalized).sort()
    )
    const byUrl = new Map(result.sources.map((source) => [normalized(source.url), source]))
    expect(byUrl.get(normalized(hls))).toMatchObject({ kind: 'hls', height: 1080 })
    expect(byUrl.get(normalized(mp4))).toMatchObject({ kind: 'file', height: 240 })
  })

  it('reads Eporner-style sources arrays with labels', () => {
    const result = extractVideoMedia(
      EPORNER_PAGE,
      'https://www.eporner.example/video-abc'
    )

    expect(result.sources.map((source) => source.url)).toEqual([
      'https://cdn.eporner.example/1080p.mp4',
      'https://cdn.eporner.example/480p.mp4'
    ])
    expect(result.sources[0]).toMatchObject({ kind: 'file', label: '1080p', height: 1080 })
    expect(result.sources[1]).toMatchObject({ kind: 'file', label: '480p', height: 480 })
  })

  it('reads a plain og:video page and cleans the title', () => {
    const result = extractVideoMedia(OG_VIDEO_PAGE, 'https://site.example/watch/1')

    expect(result.title).toBe('Plain clip')
    expect(result.blocked).toBeNull()
    expect(result.sources).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/clips/plain.mp4',
        kind: 'file'
      })
    ])
  })

  it('reports a Cloudflare challenge page as blocked with no sources', () => {
    const result = extractVideoMedia(CLOUDFLARE_PAGE, HANIME1_URL)

    expect(result.sources).toEqual([])
    expect(result.blocked).toBe('challenge')
  })

  it('resolves root-relative player URLs against the page', () => {
    const result = extractVideoMedia(
      `<script>var config = { "videoUrl": "/media/stream.m3u8" };</script>`,
      'https://site.example/watch/1'
    )

    expect(result.sources).toEqual([
      expect.objectContaining({
        url: 'https://site.example/media/stream.m3u8',
        kind: 'hls'
      })
    ])
  })

  it('drops non-http(s) and credential-bearing URLs', () => {
    const result = extractVideoMedia(
      `<video>
         <source src="data:video/mp4;base64,AAAA" type="video/mp4">
         <source src="https://user:pass@cdn.example/secret.mp4" type="video/mp4">
         <source src="https://cdn.example/ok.mp4" type="video/mp4">
       </video>`,
      'https://site.example/watch/1'
    )

    expect(result.sources.map((source) => source.url)).toEqual([
      'https://cdn.example/ok.mp4'
    ])
  })

  it('deduplicates the same URL and keeps the first quality hint', () => {
    const result = extractVideoMedia(
      `<video>
         <source src="https://cdn.example/a.mp4" label="720p">
         <source src="https://cdn.example/a.mp4" label="1080p">
       </video>`,
      'https://site.example/watch/1'
    )

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ label: '720p', height: 720 })
  })
})

describe('video quality labels', () => {
  it('reads pixel heights from player labels', () => {
    expect(heightFromLabel('1080p')).toBe(1080)
    expect(heightFromLabel('1920x1080')).toBe(1080)
    expect(heightFromLabel('4K')).toBe(2160)
    expect(heightFromLabel('Full HD')).toBe(1080)
    expect(heightFromLabel('720')).toBe(720)
    expect(heightFromLabel('auto')).toBeNull()
    expect(heightFromLabel(null)).toBeNull()
  })
})
