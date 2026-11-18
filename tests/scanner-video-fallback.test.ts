import { describe, expect, it, vi } from 'vitest'
import type { MediaAnalysis } from '../src/shared/media'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import {
  MAX_SCAN_VIDEO_MEDIA_SOURCES,
  parseScanVideoRequest
} from '../src/shared/scanVideo'
import { AppError } from '../src/main/errors'
import { BatchManager } from '../src/main/batches/manager'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import { ScanQueueService } from '../src/main/scanner/queue'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'

const FORUM_URL = 'https://forum.example/thread/hanime'
const HANIME_URL = 'https://hanime1.me/watch?v=1234'
/** A second hanime1 page, so the video link is same-host with the scan. */
const SELF_URL = 'https://hanime1.me/watch?v=9999'
const COOKIE = 'cf_clearance=secret-clearance'

const lookup: PublicTargetLookup = async () => [
  { address: '93.184.216.34', family: 4 }
]

const HANIME_HTML = `<!doctype html>
<html>
  <head>
    <title>Hanime1</title>
    <meta property="og:title" content="  Big   Buck   Bunny  ">
    <meta property="og:image" content="https://hanime1.me/thumbs/1234.jpg">
  </head>
  <body>
    <video controls>
      <source src="https://v.hanime1.me/media/1080.mp4" size="1080" type="video/mp4">
      <source src="https://v.hanime1.me/media/720.mp4" size="720" type="video/mp4">
    </video>
  </body>
</html>`

const HLS_HTML = `<!doctype html>
<html>
  <head><meta property="og:title" content="Live stream"></head>
  <body>
    <script>player.setup({ sources: [{ src: "https://cdn.example/hls/master.m3u8", label: "1080p" }] });</script>
  </body>
</html>`

const CHALLENGE_HTML = `<!doctype html>
<html>
  <head><title>Just a moment...</title></head>
  <body><div id="cf-challenge-running">Checking your browser</div></body>
</html>`

const FORUM_HTML = `<a href="${HANIME_URL}">Hanime1 Watch Video</a>`

function pageResult(url: string, body: string) {
  return {
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

const htmlProbe: ProbeScanItemFn = async (input) => ({
  status: 'found',
  verified: false,
  contentType: 'text/html',
  contentDisposition: null,
  sizeBytes: null,
  finalUrl: null,
  classification: classifyScanCandidate({
    url: input.url,
    contentType: 'text/html'
  }),
  reason: null
})

function unsupported(): never {
  throw new AppError(
    'MEDIA_ANALYSIS_EXTRACTOR_FAILED',
    `ERROR: Unsupported URL: ${HANIME_URL}`
  )
}

interface HarnessOptions {
  /** Page bodies by URL; anything else answers with the hanime1 fixture. */
  bodies?: Record<string, string>
  analyze?: (url: string, options?: { cookie?: string }) => Promise<MediaAnalysis>
  fetchPage?: ScanPageFetcher
}

function harness(options: HarnessOptions = {}) {
  const bodies = options.bodies ?? {}
  const analyze = vi.fn(options.analyze ?? (async () => unsupported()))
  const fetches: Array<{ url: string; cookie: string | undefined }> = []
  const fetcher: ScanPageFetcher = async (input) => {
    fetches.push({ url: input.url, cookie: input.cookie })
    if (options.fetchPage !== undefined) return options.fetchPage(input)
    return pageResult(input.url, bodies[input.url] ?? HANIME_HTML)
  }
  const sessions = new ScanSessionManager({
    fetchPage: fetcher,
    probeItem: htmlProbe,
    lookup,
    followDepth: 0,
    analyzeMedia: analyze,
    onUpdate: () => undefined
  })
  return { sessions, analyze, fetches }
}

async function scan(
  sessions: ScanSessionManager,
  url: string,
  cookie?: string
) {
  const started = sessions.start(url, cookie === undefined ? {} : { cookie })
  await sessions.waitForScan(started.sessionId)
  return sessions.getSession(started.sessionId)
}

/* ------------------------------ page fallback ------------------------------ */

describe('video page fallback', () => {
  it('turns a yt-dlp-unsupported page into a ready card with real qualities', async () => {
    const { sessions, analyze, fetches } = harness({ bodies: { [FORUM_URL]: FORUM_HTML } })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!

    expect(analyze).toHaveBeenCalledWith(HANIME_URL, expect.anything())
    expect(fetches.map((entry) => entry.url)).toContain(HANIME_URL)

    expect(video).toMatchObject({
      status: 'ready',
      verified: true,
      name: 'Big Buck Bunny',
      bestResolution: '1080p',
      unavailableReason: null
    })
    expect(video.formats?.map((format) => format.label)).toEqual([
      '1080p · MP4',
      '720p · MP4'
    ])
    expect(video.bestOptionId).toBe(video.formats?.[0]?.optionId)
    // The renderer only ever sees opaque option IDs and display metadata.
    expect(JSON.stringify(session)).not.toContain('v.hanime1.me')
    expect(JSON.stringify(session)).not.toContain('/media/1080.mp4')
  })

  it('keeps a Cloudflare challenge page browser-only with its reason', async () => {
    const { sessions } = harness({ bodies: { [FORUM_URL]: FORUM_HTML, [HANIME_URL]: CHALLENGE_HTML } })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!

    expect(video.status).toBe('browser-only')
    expect(video.unavailableReason).toMatch(/open it in your browser/)
    expect(video.formats ?? []).toEqual([])
  })

  it('keeps the card browser-only when the page fetch itself fails', async () => {
    const { sessions } = harness({
      fetchPage: async (input) => {
        if (input.url === FORUM_URL) return pageResult(FORUM_URL, FORUM_HTML)
        throw new AppError('SCAN_FETCH_BLOCKED', 'HTTP 403')
      }
    })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!

    expect(video.status).toBe('browser-only')
    expect(video.unavailableReason).toMatch(/open it in your browser/)
  })

  it('drops media whose host is not public and stays browser-only', async () => {
    const { sessions } = harness({
      bodies: {
        [FORUM_URL]: FORUM_HTML,
        [HANIME_URL]: `<video><source src="http://127.0.0.1/private.mp4" size="1080"></video>`
      }
    })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!

    expect(video.status).toBe('browser-only')
  })

  it('never sends the forum cookie to the video host', async () => {
    const { sessions, analyze, fetches } = harness({
      bodies: { [FORUM_URL]: FORUM_HTML }
    })
    await scan(sessions, FORUM_URL, COOKIE)

    // yt-dlp and the fallback fetch both ran for the hanime1 page only.
    expect(analyze).toHaveBeenCalledWith(HANIME_URL, {
      signal: expect.anything()
    })
    const videoFetch = fetches.find((entry) => entry.url === HANIME_URL)
    expect(videoFetch?.cookie).toBeUndefined()
    // The forum page itself still gets its own cookie.
    expect(fetches.find((entry) => entry.url === FORUM_URL)?.cookie).toBe(COOKIE)
  })

  it('sends the cookie to yt-dlp and the page fetch on a same-host scan', async () => {
    const { sessions, analyze, fetches } = harness({
      bodies: {
        [SELF_URL]: `<a href="${HANIME_URL}">Hanime1 Watch Video</a>`,
        [HANIME_URL]: HANIME_HTML
      }
    })
    const session = await scan(sessions, SELF_URL, COOKIE)

    expect(analyze).toHaveBeenCalledWith(HANIME_URL, {
      cookie: COOKIE,
      signal: expect.anything()
    })
    expect(fetches.find((entry) => entry.url === HANIME_URL)?.cookie).toBe(COOKIE)
    expect(session.items.some((item) => item.status === 'ready')).toBe(true)
  })
})

/* ------------------------------ browser tab merge ------------------------------ */

describe('browser tab media merge', () => {
  const reported = {
    type: 'scan-video' as const,
    pageUrl: HANIME_URL,
    title: 'Big Buck Bunny',
    sources: [
      {
        url: 'https://v.hanime1.me/media/1080.mp4',
        kind: 'file' as const,
        label: '1080p',
        height: 1080
      }
    ]
  }

  it('upgrades the browser-only card of the originating session in place', async () => {
    const { sessions } = harness({ bodies: { [FORUM_URL]: FORUM_HTML, [HANIME_URL]: CHALLENGE_HTML } })
    const before = await scan(sessions, FORUM_URL)
    const video = before.items.find((item) => item.category === 'video')!
    expect(video.status).toBe('browser-only')

    const after = await sessions.startVideoMedia(reported)
    expect(after.sessionId).toBe(before.sessionId)

    const upgraded = after.items.find((item) => item.id === video.id)!
    expect(upgraded).toMatchObject({
      status: 'ready',
      name: 'Big Buck Bunny',
      bestResolution: '1080p'
    })
    expect(upgraded.formats).toHaveLength(1)
    expect(JSON.stringify(after)).not.toContain('v.hanime1.me')
  })

  it('creates a one-card session when no scan is waiting for the page', async () => {
    const { sessions } = harness()
    const session = await sessions.startVideoMedia(reported)

    expect(session.items).toHaveLength(1)
    expect(session.items[0]).toMatchObject({
      category: 'video',
      kind: 'page-link',
      status: 'ready',
      name: 'Big Buck Bunny'
    })
  })

  it('refuses a page that is not a single video page', async () => {
    const { sessions } = harness()
    await expect(
      sessions.startVideoMedia({ ...reported, pageUrl: 'https://forum.example/thread/1' })
    ).rejects.toMatchObject({ code: 'SCAN_VIDEO_NOT_A_VIDEO_PAGE' })
  })

  it('keeps the card browser-only when the tab reported no media', async () => {
    const { sessions } = harness({ bodies: { [FORUM_URL]: FORUM_HTML, [HANIME_URL]: CHALLENGE_HTML } })
    await scan(sessions, FORUM_URL)

    const after = await sessions.startVideoMedia({ ...reported, sources: [] })
    const video = after.items.find((item) => item.category === 'video')!
    expect(video.status).toBe('browser-only')
    expect(video.unavailableReason).toMatch(/open it in your browser/)
  })
})

/* ------------------------------ queue ------------------------------ */

function mediaJob(input: unknown) {
  const record = input as { analysisId?: string; optionId?: string }
  return {
    id: 'media_job_1',
    analysisId: record.analysisId ?? 'stream_1',
    optionId: record.optionId ?? 'stream_1',
    kind: 'video' as const,
    title: 'Big Buck Bunny',
    label: '1080p',
    status: 'queued' as const,
    completedBytes: 0,
    totalBytes: 1000,
    speedBps: 0,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null
  }
}

function createBatchManager() {
  const added: unknown[] = []
  const sniffed: unknown[] = []
  const downloads = {
    add: vi.fn(async (input: unknown): Promise<AppSnapshot> => {
      added.push(input)
      const record = input as { url: string; filename?: string }
      const child: DownloadItem = {
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gid: 'gid',
        url: record.url,
        filename: record.filename ?? 'video.mp4',
        dir: 'C:\\Downloads',
        filePath: null,
        status: 'queued',
        totalBytes: 2048,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: 1,
        updatedAt: 1,
        completedAt: null
      }
      return {
        aria2: {
          status: 'ready',
          version: '1.37.0',
          binaryPath: null,
          message: null,
          hint: null
        },
        downloads: [child]
      }
    }),
    pause: vi.fn(async () => undefined),
    getItem: vi.fn(() => null),
    getSnapshot: vi.fn(() => ({
      aria2: {
        status: 'ready' as const,
        version: '1.37.0',
        binaryPath: null,
        message: null,
        hint: null
      },
      downloads: []
    }))
  }
  const queueMedia = vi.fn(async (input: unknown) => mediaJob(input))
  const queueSniffedMedia = vi.fn(async (input: unknown) => {
    sniffed.push(input)
    return mediaJob(input)
  })
  const batches = new BatchManager({
    downloads,
    mediaJobs: {
      analyzeMedia: vi.fn(),
      queueMedia,
      queueSniffedMedia,
      cancelMedia: vi.fn(),
      getMediaSnapshot: vi.fn(() => ({ tool: {} as never, jobs: [] })),
      getJob: vi.fn(() => null)
    },
    collectionEngine: {
      analyzeCollection: vi.fn(),
      resolveCollectionEntries: vi.fn()
    },
    pixeldrain: { parseLink: vi.fn(), resolveFile: vi.fn(), resolveList: vi.fn() },
    onUpdate: () => undefined,
    pollIntervalMs: 0
  })
  return { batches, added, sniffed, queueSniffedMedia }
}

describe('direct media queue path', () => {
  it('queues a direct mp4 through the downloader with the page as Referer', async () => {
    const { sessions } = harness({ bodies: { [FORUM_URL]: FORUM_HTML } })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!
    const { batches, added } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: htmlProbe,
      now: () => 1_000
    })

    const result = await queue.queueSelection(
      session.sessionId,
      [video.id],
      [{ itemId: video.id, optionId: video.bestOptionId ?? undefined }]
    )
    await batches.waitForIdle()

    expect(result.queuedItemIds).toEqual([video.id])
    expect(result.batch?.items[0]?.kind).toBe('download')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      url: 'https://v.hanime1.me/media/1080.mp4',
      requestHeaders: { referer: HANIME_URL }
    })
  })

  it('queues an HLS manifest through the media engine as a sniffed stream', async () => {
    const { sessions } = harness({
      bodies: {
        [FORUM_URL]: `<a href="${HANIME_URL}">Hanime1</a>`,
        [HANIME_URL]: HLS_HTML
      }
    })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!
    expect(video.status).toBe('ready')

    const { batches, queueSniffedMedia, sniffed } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: htmlProbe,
      now: () => 1_000
    })

    const result = await queue.queueSelection(session.sessionId, [video.id])
    await batches.waitForIdle()

    expect(result.batch?.items[0]?.kind).toBe('media')
    expect(queueSniffedMedia).toHaveBeenCalledTimes(1)
    expect(sniffed[0]).toMatchObject({
      url: 'https://cdn.example/hls/master.m3u8',
      pageUrl: HANIME_URL,
      referer: HANIME_URL,
      kind: 'hls',
      userAgent: 'DonDownload/1.1.0'
    })
  })

  it('rejects a format that does not belong to the card', async () => {
    const { sessions } = harness({ bodies: { [FORUM_URL]: FORUM_HTML } })
    const session = await scan(sessions, FORUM_URL)
    const video = session.items.find((item) => item.category === 'video')!
    const { batches } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: htmlProbe,
      now: () => 1_000
    })

    await expect(
      queue.queueSelection(session.sessionId, [video.id], [
        { itemId: video.id, optionId: 'not-an-option' }
      ])
    ).rejects.toMatchObject({ code: 'SCAN_OPTION_INVALID' })
  })
})

/* ------------------------------ bridge contract ------------------------------ */

describe('scan-video bridge contract', () => {
  const valid = {
    type: 'scan-video',
    pageUrl: HANIME_URL,
    title: 'Big Buck Bunny',
    sources: [
      {
        url: 'https://v.hanime1.me/media/1080.mp4',
        kind: 'file',
        label: '1080p',
        height: 1080
      }
    ]
  }

  it('accepts a validated report and deduplicates its sources', () => {
    const parsed = parseScanVideoRequest({
      ...valid,
      sources: [...valid.sources, ...valid.sources]
    })
    expect(parsed.pageUrl).toBe(HANIME_URL)
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.title).toBe('Big Buck Bunny')
  })

  it('accepts an empty report so the card can stay browser-only', () => {
    expect(parseScanVideoRequest({ ...valid, sources: [] }).sources).toEqual([])
  })

  it('keeps the one-shot cookie when it is a valid header', () => {
    expect(parseScanVideoRequest({ ...valid, cookie: COOKIE }).cookie).toBe(COOKIE)
  })

  it('rejects unknown fields, bad kinds and non-public URLs', () => {
    expect(() =>
      parseScanVideoRequest({ ...valid, extra: true })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseScanVideoRequest({
        ...valid,
        sources: [{ url: 'https://cdn.example/a.mp4', kind: 'rtmp' }]
      })
    ).toThrow(/kind is unsupported/)
    expect(() =>
      parseScanVideoRequest({
        ...valid,
        sources: [{ url: 'file:///C:/private/a.mp4', kind: 'file' }]
      })
    ).toThrow()
    expect(() =>
      parseScanVideoRequest({
        ...valid,
        sources: [{ url: 'https://cdn.example/a.mp4', kind: 'file', extra: 1 }]
      })
    ).toThrow(/unsupported fields/)
  })

  it('caps the reported source list', () => {
    const sources = Array.from(
      { length: MAX_SCAN_VIDEO_MEDIA_SOURCES + 1 },
      (_entry, index) => ({
        url: `https://cdn.example/${index}.mp4`,
        kind: 'file'
      })
    )
    expect(() => parseScanVideoRequest({ ...valid, sources })).toThrow(
      /at most/
    )
  })

  it('rejects a cookie that is not a header value', () => {
    expect(() =>
      parseScanVideoRequest({ ...valid, cookie: 'bad\r\nX-Injected: 1' })
    ).toThrow(/request header value is invalid/)
  })
})
