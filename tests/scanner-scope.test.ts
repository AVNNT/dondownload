import { describe, expect, it } from 'vitest'
import type { MediaAnalysis } from '../src/shared/media'
import { MAX_SCAN_FOLLOW_DEPTH, MAX_SCAN_FOLLOW_PAGES } from '../src/shared/scanner'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const TOPIC = 'https://forum.example/t/example-topic/346779'
const VIDEO = 'https://hanime1.me/watch?v=demo123'

function videoAnalysis(): MediaAnalysis {
  return {
    analysisId: 'analysis_demo',
    title: 'Demo video',
    thumbnailUrl: null,
    durationSeconds: 120,
    options: [
      {
        kind: 'video',
        optionId: 'opt_demo',
        label: '1080p MP4',
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
    bestVideoOptionId: 'opt_demo',
    bestAudioOptionId: null,
    expiresAt: 9_999_999
  }
}

function html(url: string, body: string) {
  return {
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

function json(url: string, value: unknown) {
  const body = JSON.stringify(value)
  return {
    finalUrl: url,
    status: 200,
    contentType: 'application/json',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

/**
 * The rendered topic page carries Discourse's site chrome: suggested/related
 * topics, user pages, category and tag listings. Only post content is scanned,
 * and navigation links are never followed.
 */
const RENDERED_TOPIC = `<!doctype html>
<html><head>
  <meta name="generator" content="Discourse 3.2.0">
  <title>Example topic</title>
</head><body>
  <div id="suggested-topics">
    <a href="/t/other-topic/999">Suggested: watch this video</a>
    <a href="/t/another-topic/1000">Related clip collection</a>
  </div>
  <nav>
    <a href="/u/alice">Alice profile video</a>
    <a href="/c/videos">Video category</a>
    <a href="/tag/video">video tag</a>
    <a href="/latest">Latest videos</a>
    <a href="/search?q=video">Search video</a>
  </nav>
  <div id="post_1"></div>
</body></html>`

const TOPIC_JSON = {
  id: 346779,
  title: 'The actual topic',
  slug: 'example-topic',
  // Discourse also returns suggested/related topic lists; the adapter must not
  // harvest them as candidates.
  suggested_topics: [{ id: 999, title: 'Suggested: watch this video' }],
  related_topics: [{ id: 1000, title: 'Related clip collection' }],
  post_stream: {
    stream: [1],
    posts: [
      {
        id: 1,
        post_number: 1,
        username: 'author',
        cooked: `<p>Watch here: <a href="${VIDEO}">hanime1 video</a></p>
          <p><a class="attachment" href="/uploads/demo.funscript">demo.funscript</a></p>`
      }
    ]
  }
}

function fetcher(fetched: string[]): ScanPageFetcher {
  return async (input) => {
    fetched.push(input.url)
    if (input.url.endsWith('/robots.txt')) {
      return {
        finalUrl: input.url,
        status: 200,
        contentType: 'text/plain',
        contentDisposition: null,
        body: '',
        bytes: 0
      }
    }
    if (input.url === TOPIC) return html(TOPIC, RENDERED_TOPIC)
    if (input.url === 'https://forum.example/t/346779.json') {
      return json(input.url, TOPIC_JSON)
    }
    if (input.url === VIDEO) {
      return html(
        VIDEO,
        `<a href="https://hanime1.me/watch?v=deeper-level">too deep</a>`
      )
    }
    if (input.url.endsWith('.funscript')) {
      return {
        finalUrl: input.url,
        status: 200,
        contentType: 'text/plain',
        contentDisposition: null,
        body: '{}',
        bytes: 2
      }
    }
    throw Object.assign(new Error('not found'), { code: 'SCAN_FETCH_FAILED' })
  }
}

describe('scoped forum scan', () => {
  it('keeps a Discourse topic to its posts and directly linked pages', async () => {
    const fetched: string[] = []
    const sessions = new ScanSessionManager({
      fetchPage: fetcher(fetched),
      analyzeMedia: async () => videoAnalysis(),
      probeItem: async (input) => ({
        status: 'ready',
        verified: true,
        contentType: 'text/plain',
        contentDisposition: null,
        sizeBytes: 128,
        finalUrl: input.url,
        classification: classifyScanCandidate({
          url: input.url,
          contentType: 'text/plain'
        }),
        reason: null
      }),
      onUpdate: () => undefined
    })

    const started = sessions.start(TOPIC)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.status).toBe('done')
    expect(done.title).toBe('The actual topic')
    expect(done.hostname).toBe('forum.example')

    // The topic's own JSON is read; the post's video is resolved as a video
    // card (through the media engine), not fetched as a discovery page.
    expect(fetched).toContain('https://forum.example/t/346779.json')
    expect(fetched).not.toContain(VIDEO)

    // Forum navigation is never followed.
    for (const forbidden of [
      'https://forum.example/t/other-topic/999',
      'https://forum.example/t/another-topic/1000',
      'https://forum.example/u/alice',
      'https://forum.example/c/videos',
      'https://forum.example/tag/video',
      'https://forum.example/latest',
      'https://forum.example/search?q=video',
      'https://hanime1.me/watch?v=deeper-level'
    ]) {
      expect(fetched).not.toContain(forbidden)
    }

    // Navigation anchors are also absent from the rendered item list.
    expect(JSON.stringify(done.items)).not.toContain('Suggested: watch this video')
    expect(JSON.stringify(done.items)).not.toContain('Related clip collection')
    expect(JSON.stringify(done.items)).not.toContain('Alice profile video')

    // Post content survives: the script attachment and the linked video.
    expect(done.items.some((item) => item.category === 'script')).toBe(true)
    expect(
      done.items.some((item) => item.category === 'video' && item.kind === 'page-link')
    ).toBe(true)
    expect(done.progress.fetchedPages).toBeLessThanOrEqual(MAX_SCAN_FOLLOW_PAGES)
  })

  it('caps following at one level and ten pages', () => {
    expect(MAX_SCAN_FOLLOW_DEPTH).toBe(1)
    expect(MAX_SCAN_FOLLOW_PAGES).toBe(10)
  })
})
