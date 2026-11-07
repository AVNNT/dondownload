import { describe, expect, it } from 'vitest'
import {
  classifyScanCandidate,
  filenameFromContentDisposition,
  isVideoPageHost
} from '../src/main/scanner/classify'
import {
  extractCandidates
} from '../src/main/scanner/extract'
import {
  normalizeScanUrl,
  resolveScanUrl
} from '../src/main/scanner/extract/url'
import {
  hasDiscourseGenerator,
  scanDiscourseTopic
} from '../src/main/scanner/extract/discourse'

const PAGE_URL = 'https://discuss.example/t/example-topic/346779'

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <base href="https://discuss.example/t/example-topic/" />
  <meta name="generator" content="Discourse 3.2.0" />
  <meta property="og:video" content="https://cdn.example/og-video.mp4" />
  <meta name="twitter:player:stream" content="https://stream.example/live.m3u8" />
  <meta property="og:image" content="https://cdn.example/cover.jpg" />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"VideoObject","name":"JSON video","contentUrl":"/media/json-video.webm","embedUrl":"https://www.youtube.com/embed/abcdef"}
  </script>
</head>
<body>
  <video src="/videos/inline.mp4" poster="/images/poster.jpg"></video>
  <audio><source src="/audio/track.mp3" /></audio>
  <img src="/images/one.png" srcset="/images/small.png 32w, /images/large.png 1280w" />
  <img src="/images/icon.svg" />
  <img src="data:image/gif;base64,AAAA" />
  <iframe src="https://www.youtube.com/embed/xyz"></iframe>
  <a class="attachment" href="/uploads/short-url/abc.funscript">x.roll.funscript</a>
  <a href="/files/archive.zip" download>download archive</a>
  <a href="/t/another-topic/1">Another discussion page</a>
  <script>
    const source = "https:\\/\\/cdn.example\\/stream\\/master.m3u8?token=1";
  </script>
</body>
</html>`

describe('generic HTML extraction', () => {
  it('extracts meta, JSON-LD, media elements, images, embeds, anchors and scripts', () => {
    const candidates = extractCandidates(FIXTURE_HTML, PAGE_URL)
    const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]))

    expect(byUrl.has('https://cdn.example/og-video.mp4')).toBe(true)
    expect(byUrl.has('https://stream.example/live.m3u8')).toBe(true)
    expect(byUrl.has('https://cdn.example/cover.jpg')).toBe(true)
    expect(
      byUrl.has('https://discuss.example/media/json-video.webm')
    ).toBe(true)
    expect(byUrl.has('https://discuss.example/videos/inline.mp4')).toBe(true)
    expect(byUrl.has('https://discuss.example/images/poster.jpg')).toBe(true)
    expect(byUrl.has('https://discuss.example/audio/track.mp3')).toBe(true)
    expect(byUrl.has('https://discuss.example/images/large.png')).toBe(true)
    expect(byUrl.has('https://www.youtube.com/embed/xyz')).toBe(true)
    expect(
      byUrl.get('https://discuss.example/uploads/short-url/abc.funscript')
    ).toMatchObject({ nameHint: 'x.roll.funscript', isAttachment: true })
    expect(byUrl.get('https://discuss.example/files/archive.zip')).toMatchObject({
      downloadAttribute: true
    })
    expect(
      byUrl.get(
        'https://cdn.example/stream/master.m3u8?token=1'
      )
    ).toMatchObject({ fromScript: true })

    // Tracking-sized and data/icon images are dropped.
    expect(byUrl.has('https://discuss.example/images/small.png')).toBe(false)
    expect(byUrl.has('https://discuss.example/images/icon.svg')).toBe(false)
    expect(
      [...byUrl.keys()].some((value) => value.startsWith('data:'))
    ).toBe(false)
    // A plain discussion page link is not a file candidate.
    expect(byUrl.has('https://discuss.example/t/another-topic/1')).toBe(false)
  })

  it('keeps a script URL whole when a media extension sits in an earlier segment', () => {
    const html = `<!doctype html>
<html>
  <body>
    <script>
      var flashvars_1 = {
        "mediaDefinitions": [
          {"format":"hls","videoUrl":"https://hv-h.phncdn.com/hls/videos/202310/23/440000000/1080P_4000K_65036195.mp4/master.m3u8?h=abc&e=1700000000&f=1","quality":"1080"},
          {"format":"mp4","videoUrl":"https://ev-h.phncdn.com/videos/202310/23/440000000/240P_1000K_65036195.mp4?validfrom=1&hash=x","quality":"240"}
        ]
      };
    </script>
  </body>
</html>`
    const urls = extractCandidates(html, 'https://www.pornhub.example/view_video.php?viewkey=1')
      .filter((candidate) => candidate.fromScript)
      .map((candidate) => candidate.url)

    expect(urls).toContain(
      'https://hv-h.phncdn.com/hls/videos/202310/23/440000000/1080P_4000K_65036195.mp4/master.m3u8?e=1700000000&f=1&h=abc'
    )
    expect(urls).toContain(
      'https://ev-h.phncdn.com/videos/202310/23/440000000/240P_1000K_65036195.mp4?hash=x&validfrom=1'
    )
  })

  it('resolves relative links against <base> and rejects non-HTTP schemes', () => {
    expect(resolveScanUrl('/x.zip', 'https://example.com/a/b')).toBe(
      'https://example.com/x.zip'
    )
    expect(resolveScanUrl('javascript:alert(1)', 'https://example.com')).toBeNull()
    expect(resolveScanUrl('data:text/plain,hi', 'https://example.com')).toBeNull()
  })
})

describe('relative href resolution', () => {
  // Real video sites emit root-relative hrefs. `new URL('/video-x/')` throws,
  // so an unresolved href never matched a host rule and the link was dropped
  // before `resolveScanUrl` ever saw it.
  it('keeps an eporner video link written as a root-relative href', () => {
    const html = `<!doctype html>
<html><head><title>eporner</title></head>
<body>
  <a href="/video-n6g7P51nAb4/slug/">Video title</a>
  <a href="/cat/all/">All categories</a>
  <a href="/cat/amateur/">Amateur</a>
</body></html>`
    const candidates = extractCandidates(html, 'https://www.eporner.com/')
    const urls = candidates.map((candidate) => candidate.url)
    expect(urls).toContain('https://www.eporner.com/video-n6g7P51nAb4/slug/')
    expect(urls.some((url) => url.includes('/cat/'))).toBe(false)
  })

  it('keeps a pornhub view_video.php link written as a root-relative href', () => {
    const html = `<!doctype html>
<html><head><title>pornhub</title></head>
<body>
  <a href="/view_video.php?viewkey=6ad5604c442b5">Video title</a>
  <a href="/video?c=24">Categories</a>
</body></html>`
    const candidates = extractCandidates(html, 'https://www.pornhub.com/')
    const urls = candidates.map((candidate) => candidate.url)
    expect(urls).toContain(
      'https://www.pornhub.com/view_video.php?viewkey=6ad5604c442b5'
    )
    expect(urls.some((url) => url.includes('/video?c='))).toBe(false)
  })

  it('resolves a relative href against a <base href> that appears before it', () => {
    const html = `<!doctype html>
<html><head><base href="https://www.eporner.com/" /></head>
<body><a href="video-abc12345/slug/">Video title</a></body></html>`
    const candidates = extractCandidates(html, 'https://www.eporner.com/cat/all/')
    expect(candidates.map((candidate) => candidate.url)).toContain(
      'https://www.eporner.com/video-abc12345/slug/'
    )
  })
})

describe('URL normalization and dedupe keys', () => {
  it('lowercases the host and removes fragments and tracking parameters', () => {
    const normalized = normalizeScanUrl(
      'HTTPS://Example.COM/files/a.zip?utm_source=x&b=2&a=1&fbclid=abc&si=xyz#part'
    )
    expect(normalized).toBe('https://example.com/files/a.zip?a=1&b=2')
    expect(normalizeScanUrl(normalized)).toBe(normalized)
  })

  it('sorts query parameters so equivalent URLs dedupe together', () => {
    const left = normalizeScanUrl('https://example.com/f?b=2&a=1')
    const right = normalizeScanUrl('https://EXAMPLE.com/f?a=1&b=2#frag')
    expect(left).toBe(right)
    expect(extractCandidates(
      '<a href="https://example.com/f.zip?b=2&a=1">one</a><a href="https://example.com/f.zip?a=1&b=2#x">two</a>',
      'https://example.com/'
    )).toHaveLength(1)
  })
})

describe('classification', () => {
  it('treats HTML served from a .mp4 path as a page', () => {
    expect(
      classifyScanCandidate({
        url: 'https://cdn.example/clip.mp4',
        contentType: 'text/html; charset=utf-8'
      })
    ).toMatchObject({ category: 'page', kind: 'page-link' })
  })

  it('keeps a .funscript as a script when served as JSON or octet-stream', () => {
    expect(
      classifyScanCandidate({
        url: 'https://forum.example/uploads/short-url/a.funscript',
        contentType: 'application/json'
      })
    ).toMatchObject({ category: 'script', kind: 'file' })
    expect(
      classifyScanCandidate({
        url: 'https://forum.example/uploads/short-url/a.funscript',
        contentType: 'application/octet-stream'
      })
    ).toMatchObject({ category: 'script', kind: 'file' })
    expect(
      classifyScanCandidate({ url: 'https://forum.example/x.roll.funscript' })
    ).toMatchObject({ category: 'script', name: 'x.roll.funscript' })
  })

  it('uses Content-Disposition attachment names when classifying a file', () => {
    const name = filenameFromContentDisposition(
      'attachment; filename="my archive.zip"'
    )
    expect(name).toBe('my archive.zip')
    expect(
      classifyScanCandidate({
        url: 'https://files.example/download?id=42',
        contentDisposition: 'attachment; filename="my archive.zip"',
        contentType: 'application/octet-stream'
      })
    ).toMatchObject({ category: 'archive', kind: 'file', name: 'my archive.zip' })
  })

  it('lists known video pages as page links without pretending they are files', () => {
    expect(isVideoPageHost('www.youtube.com')).toBe(true)
    expect(
      classifyScanCandidate({
        url: 'https://www.youtube.com/watch?v=abc',
        nameHint: 'Example video'
      })
    ).toMatchObject({ category: 'video', kind: 'page-link' })
    expect(
      classifyScanCandidate({ url: 'https://pixeldrain.com/u/AbCd1234' })
    ).toMatchObject({ category: 'other', kind: 'file' })
  })
})

describe('Discourse adapter', () => {
  it('detects the generator tag', () => {
    expect(hasDiscourseGenerator(FIXTURE_HTML)).toBe(true)
    expect(hasDiscourseGenerator('<meta name="generator" content="WordPress" />')).toBe(
      false
    )
  })

  it('falls back to generic extraction when a topic-shaped URL is not Discourse', async () => {
    const result = await scanDiscourseTopic({
      pageUrl: 'https://forum.example/t/not-discourse/12345',
      html: '<html><body><a href="/a.zip">a</a></body></html>',
      allowApiProbe: true,
      fetcher: async (url) => ({
        body: '<html>not json</html>',
        finalUrl: url
      })
    })
    expect(result.detected).toBe(true)
    expect(result.candidates).toEqual([])
  })

  it('reads every post chunk and tags funscript attachments with post/author', async () => {
    const calls: string[] = []
    const topic = {
      id: 346779,
      title: 'Example topic',
      slug: 'example-topic',
      post_stream: {
        posts: [
          {
            id: 101,
            post_number: 1,
            username: 'alice',
            cooked:
              '<p><a class="attachment" href="/uploads/short-url/a.funscript">x.roll.funscript</a></p>'
          },
          {
            id: 102,
            post_number: 2,
            username: 'bob',
            cooked:
              '<p><a href="https://www.youtube.com/watch?v=abc">Watch</a></p>'
          }
        ],
        stream: [101, 102, 103, 104]
      }
    }
    const postsChunk = {
      post_stream: {
        posts: [
          {
            id: 103,
            post_number: 3,
            username: 'carol',
            cooked:
              '<p><a class="attachment" href="/uploads/short-url/b.funscript">multi-axis.funscript</a></p>'
          },
          {
            id: 104,
            post_number: 4,
            username: 'dave',
            cooked: '<video src="/uploads/clip.mp4"></video>'
          }
        ]
      }
    }

    const fetcher = async (url: string) => {
      calls.push(url)
      if (url.endsWith('/346779.json')) {
        return { body: JSON.stringify(topic), finalUrl: url }
      }
      return { body: JSON.stringify(postsChunk), finalUrl: url }
    }

    const result = await scanDiscourseTopic({
      pageUrl: PAGE_URL,
      html: FIXTURE_HTML,
      fetcher
    })

    expect(result.detected).toBe(true)
    expect(result.title).toBe('Example topic')
    expect(result.pagesFetched).toBe(2)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('post_ids%5B%5D=103')
    expect(calls[1]).toContain('post_ids%5B%5D=104')

    const funscripts = result.candidates.filter(
      (candidate) => candidate.url.endsWith('.funscript')
    )
    expect(funscripts.map((candidate) => candidate.nameHint)).toEqual([
      'x.roll.funscript',
      'multi-axis.funscript'
    ])
    expect(funscripts.map((candidate) => candidate.postNumber)).toEqual([1, 3])
    expect(funscripts.map((candidate) => candidate.author)).toEqual([
      'alice',
      'carol'
    ])

    const youtube = result.candidates.find((candidate) =>
      candidate.url.includes('youtube.com/watch')
    )
    expect(youtube).toMatchObject({ postNumber: 2, author: 'bob' })
  })
})
