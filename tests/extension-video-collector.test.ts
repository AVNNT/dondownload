import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { resetNativeBridgeForTests } from '../extension/bridge'
import { runVideoScan } from '../extension/video-scan'

interface CollectedSource {
  url: string
  kind: string
  label?: string
  width?: number
  height?: number
  sizeBytes?: number
}

interface CollectedMedia {
  pageUrl: string
  title: string | null
  thumbnailUrl: string | null
  durationSeconds: number | null
  sources: CollectedSource[]
}

interface CollectorApi {
  MAX_SOURCES: number
  WAIT_MS: number
  RUN_KEY: string
  normalizeUrl: (value: unknown, base?: string) => string | null
  kindFromUrl: (url: string) => string | null
  heightFromLabel: (value: unknown) => number | null
  readSources: (doc: unknown, win: unknown) => CollectedMedia
  hasPlayableMedia: (doc: unknown) => boolean
  collectVideo: (
    doc: unknown,
    win: unknown,
    options?: Record<string, unknown>
  ) => Promise<CollectedMedia>
  startRun: (doc: unknown, win: unknown, options?: Record<string, unknown>) => boolean
}

const SOURCE = readFileSync(
  path.join(process.cwd(), 'extension', 'video-collector.js'),
  'utf8'
)

function loadCollector(): { api: CollectorApi; sandbox: Record<string, unknown> } {
  const sandbox: Record<string, unknown> = { URL, Promise, Date, setTimeout }
  const api = vm.runInNewContext(
    `${SOURCE}\n;globalThis.DonDownloadVideoCollector`,
    sandbox
  ) as CollectorApi
  return { api, sandbox }
}

/* ------------------------------ fake page ------------------------------ */

interface FakeNode {
  tagName: string
  attrs: Record<string, string>
  children: FakeNode[]
  textContent: string
  currentSrc: string
  getAttribute: (name: string) => string | null
  querySelectorAll: (selector: string) => FakeNode[]
}

function node(
  tagName: string,
  attrs: Record<string, string> = {},
  options: { text?: string; currentSrc?: string; children?: FakeNode[] } = {}
): FakeNode {
  const children = options.children ?? []
  return {
    tagName: tagName.toUpperCase(),
    attrs,
    children,
    textContent: options.text ?? '',
    currentSrc: options.currentSrc ?? '',
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null
    },
    querySelectorAll(selector: string) {
      return selector === 'source'
        ? children.filter((child) => child.tagName === 'SOURCE')
        : []
    }
  }
}

function document(url: string, nodes: readonly FakeNode[]) {
  return {
    URL: url,
    baseURI: url,
    title: '',
    querySelectorAll(selector: string) {
      const tag = selector.toUpperCase()
      return nodes.filter((entry) => entry.tagName === tag)
    }
  }
}

function windowFor(href: string) {
  return { location: { href }, setTimeout }
}

const PAGE_URL = 'https://hanime1.me/watch?v=1234'

const HANIME1_DOM = [
  node('meta', { property: 'og:title', content: '  Big   Buck   Bunny  ' }),
  node('meta', { property: 'og:image', content: 'https://hanime1.me/thumbs/1.jpg' }),
  node('meta', { property: 'og:video:duration', content: '3723' }),
  node('video', { poster: 'https://hanime1.me/thumbs/poster.jpg' }, {
    children: [
      node('source', {
        src: 'https://v.hanime1.me/media/1080.mp4',
        size: '1080',
        type: 'video/mp4'
      }),
      node('source', {
        src: 'https://v.hanime1.me/media/720.mp4',
        size: '720',
        type: 'video/mp4'
      })
    ]
  })
]

/* ------------------------------ collector ------------------------------ */

describe('video collector DOM reading', () => {
  const { api: collector } = loadCollector()

  it('reads <video><source size> renditions best first with a clean title', () => {
    const result = collector.readSources(
      document(PAGE_URL, HANIME1_DOM),
      windowFor(PAGE_URL)
    )

    expect(result.pageUrl).toBe(PAGE_URL)
    expect(result.title).toBe('Big Buck Bunny')
    expect(result.thumbnailUrl).toBe('https://hanime1.me/thumbs/1.jpg')
    expect(result.durationSeconds).toBe(3723)
    expect(result.sources.map((source) => source.url)).toEqual([
      'https://v.hanime1.me/media/1080.mp4',
      'https://v.hanime1.me/media/720.mp4'
    ])
    expect(result.sources[0]).toMatchObject({ kind: 'file', height: 1080 })
    expect(result.sources[1]).toMatchObject({ kind: 'file', height: 720 })
  })

  it('reads the attached currentSrc of an HLS player', () => {
    const dom = [
      node('video', {}, {
        currentSrc: 'https://cdn.example/hls/master.m3u8',
        children: []
      })
    ]
    const result = collector.readSources(document(PAGE_URL, dom), windowFor(PAGE_URL))

    expect(result.sources).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/hls/master.m3u8',
        kind: 'hls'
      })
    ])
  })

  it('keeps each rendition of a mediaDefinitions player with its own quality', () => {
    const script = node(
      'script',
      {},
      {
        text: `var flashvars = {
          "mediaDefinitions": [
            {"format":"hls","videoUrl":"https://ev.phncdn.example/1080P.m3u8","quality":"1080"},
            {"format":"mp4","videoUrl":"https://ev.phncdn.example/720P.mp4","quality":"720"}
          ]
        };`
      }
    )
    const result = collector.readSources(
      document('https://www.pornhub.example/view_video.php?viewkey=1', [script]),
      windowFor('https://www.pornhub.example/view_video.php?viewkey=1')
    )

    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({
      url: 'https://ev.phncdn.example/1080P.m3u8',
      kind: 'hls',
      height: 1080
    })
    expect(result.sources[1]).toMatchObject({
      url: 'https://ev.phncdn.example/720P.mp4',
      kind: 'file',
      height: 720
    })
  })

  it('resolves relative sources and drops data: and credential URLs', () => {
    const dom = [
      node('video', {}, {
        children: [
          node('source', { src: '/media/one.mp4' }),
          node('source', { src: 'data:video/mp4;base64,AAAA' }),
          node('source', { src: 'https://user:pass@cdn.example/secret.mp4' })
        ]
      })
    ]
    const result = collector.readSources(
      document('https://site.example/watch/1', dom),
      windowFor('https://site.example/watch/1')
    )

    expect(result.sources.map((source) => source.url)).toEqual([
      'https://site.example/media/one.mp4'
    ])
  })

  it('reports nothing for a page without a player and does not wait', async () => {
    const doc = document(PAGE_URL, [
      node('meta', { property: 'og:title', content: 'Challenge' })
    ])
    let timers = 0
    const win = {
      location: { href: PAGE_URL },
      setTimeout: (...args: Parameters<typeof setTimeout>) => {
        timers += 1
        return setTimeout(...args)
      }
    }

    expect(collector.hasPlayableMedia(doc)).toBe(false)
    const result = await collector.collectVideo(doc, win, { waitMs: 6000 })
    expect(result.sources).toEqual([])
    expect(result.title).toBe('Challenge')
    // A page that is not a video page must not delay the normal page scan.
    expect(timers).toBe(0)
  })

  it('caps the reported sources', () => {
    const sources = Array.from({ length: 40 }, (_entry, index) =>
      node('source', { src: `https://cdn.example/${index}.mp4` })
    )
    const result = collector.readSources(
      document(PAGE_URL, [node('video', {}, { children: sources })]),
      windowFor(PAGE_URL)
    )

    expect(result.sources).toHaveLength(collector.MAX_SOURCES)
  })

  it('publishes its bounded result on the run key', async () => {
    const doc = document(PAGE_URL, HANIME1_DOM)
    const { api, sandbox } = loadCollector()

    expect(api.startRun(doc, windowFor(PAGE_URL), { waitMs: 0 })).toBe(true)
    const run = sandbox[api.RUN_KEY] as { result: CollectedMedia | null }
    for (let attempt = 0; attempt < 50 && run.result === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(run.result?.sources).toHaveLength(2)
  })
})

/* ------------------------------ extension runner ------------------------------ */

interface FakeChrome {
  scripting: {
    executeScript: (input: Record<string, unknown>) => Promise<unknown>
  }
  runtime: {
    lastError: undefined
    sendNativeMessage: (
      host: string,
      message: unknown,
      callback: (value: unknown) => void
    ) => void
  }
  cookies: {
    getAll: (input: unknown, callback: (cookies: unknown[]) => void) => void
  }
  permissions: { contains: (input: unknown) => Promise<boolean> }
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>
    }
  }
}

function fakeChrome(options: {
  collected: unknown
  cookieOptIn?: boolean
}): { chrome: FakeChrome; native: unknown[] } {
  const native: unknown[] = []
  const chrome: FakeChrome = {
    scripting: {
      executeScript: async (input) => {
        if (Array.isArray(input.files)) return [{ result: null }]
        const source = String(input.func)
        if (source.includes('startRun')) return [{ result: true }]
        return [{ result: options.collected }]
      }
    },
    runtime: {
      lastError: undefined,
      sendNativeMessage(_host, message, callback) {
        native.push(message)
        callback({ ok: true, accepted: true })
      }
    },
    cookies: {
      getAll(_input, callback) {
        callback([{ name: 'cf_clearance', value: 'clearance-token' }])
      }
    },
    permissions: {
      contains: () => Promise.resolve(true)
    },
    storage: {
      local: {
        get: (key: string) =>
          Promise.resolve({
            [key]: {
              cookieOptInOrigins:
                options.cookieOptIn === false ? [] : ['https://hanime1.me']
            }
          })
      }
    }
  }
  return { chrome, native }
}

afterEach(() => {
  resetNativeBridgeForTests()
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('extension video scan runner', () => {
  const collected = {
    pageUrl: PAGE_URL,
    title: 'Big Buck Bunny',
    sources: [
      {
        url: 'https://v.hanime1.me/media/1080.mp4',
        kind: 'file',
        label: '1080',
        height: 1080
      }
    ]
  }

  it('forwards the collected media with the one-shot same-origin cookie', async () => {
    const { chrome, native } = fakeChrome({ collected })
    ;(globalThis as { chrome?: unknown }).chrome = chrome

    const result = await runVideoScan(
      chrome,
      { tabId: 7, pageUrl: PAGE_URL },
      { sleep: async () => undefined }
    )

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      sourceCount: 1,
      cookieAttached: true
    })
    expect(native).toHaveLength(1)
    expect(native[0]).toMatchObject({
      type: 'scan-video',
      pageUrl: PAGE_URL,
      title: 'Big Buck Bunny',
      cookie: 'cf_clearance=clearance-token'
    })
  })

  it('reports sent: false when the page exposed no media', async () => {
    const { chrome, native } = fakeChrome({
      collected: { pageUrl: PAGE_URL, title: null, sources: [] }
    })
    ;(globalThis as { chrome?: unknown }).chrome = chrome

    const result = await runVideoScan(
      chrome,
      { tabId: 7, pageUrl: PAGE_URL },
      { sleep: async () => undefined }
    )

    expect(result).toMatchObject({ ok: true, sent: false, sourceCount: 0 })
    expect(native).toEqual([])
  })

  it('refuses a tab it cannot identify', async () => {
    const { chrome, native } = fakeChrome({ collected })
    ;(globalThis as { chrome?: unknown }).chrome = chrome

    const result = await runVideoScan(chrome, { pageUrl: PAGE_URL })
    expect(result).toMatchObject({ ok: false })
    expect(native).toEqual([])
  })
})
