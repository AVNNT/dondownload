import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

interface CollectedImage {
  url: string
  fallbackUrl?: string
  width?: number
  height?: number
  alt?: string
}

interface SrcsetCandidate {
  url: string
  width: number
  density: number
}

interface ImageRun {
  stop: () => void
  send: () => void
  count: () => number
}

interface CollectorApi {
  MAX_IMAGES: number
  MIN_IMAGE_EDGE: number
  PROGRESS_MESSAGE: string
  READY_MESSAGE: string
  isPinterestHost: (hostname: unknown) => boolean
  parseSrcset: (value: unknown) => SrcsetCandidate[]
  pickLargestSrcset: (value: unknown) => string | null
  pinterestOriginal: (raw: unknown) => string | null
  pinterestFallback: (raw: unknown) => string | null
  imageIdentity: (raw: unknown) => string | null
  isAvatarUrl: (raw: unknown) => boolean
  isSkippableUrl: (raw: unknown) => boolean
  isDecorativeImage: (image: unknown) => boolean
  toEntry: (raw: unknown, baseUrl?: string) => CollectedImage | null
  mergeImages: (
    existing: readonly CollectedImage[],
    incoming: readonly CollectedImage[],
    limit?: number
  ) => { images: CollectedImage[]; added: number }
  collectFromDocument: (doc: unknown, win?: unknown) => CollectedImage[]
  pageTitle: (doc: unknown) => string
  startRun: (
    doc: unknown,
    win: unknown,
    options?: { maxImages?: number; intervalMs?: number }
  ) => ImageRun
}

const SOURCE = readFileSync(
  path.join(process.cwd(), 'extension', 'image-collector.js'),
  'utf8'
)

// The collector reads `chrome` from its own global, so the sandbox stays around
// for the run tests to install a fake extension runtime in.
const sandbox: Record<string, unknown> = { URL }

const collector = vm.runInNewContext(
  `${SOURCE}\n;globalThis.DonDownloadImageCollector`,
  sandbox
) as CollectorApi

/* ------------------------------ fake page ------------------------------ */

interface FakeRect {
  width: number
  height: number
}

interface FakeImgOptions {
  src?: string
  currentSrc?: string
  srcset?: string
  alt?: string
  naturalWidth?: number
  naturalHeight?: number
  rect?: FakeRect
  hidden?: boolean
}

interface FakeImg {
  tagName: string
  alt: string
  src: string
  currentSrc: string
  naturalWidth: number
  naturalHeight: number
  hidden: boolean
  getAttribute: (name: string) => string | null
  getBoundingClientRect: () => FakeRect
}

function makeImg(options: FakeImgOptions): FakeImg {
  const attributes: Record<string, string> = {}
  if (options.srcset !== undefined) attributes.srcset = options.srcset
  const rect = options.rect ?? { width: 0, height: 0 }
  return {
    tagName: 'IMG',
    alt: options.alt ?? '',
    src: options.src ?? '',
    currentSrc: options.currentSrc ?? '',
    naturalWidth: options.naturalWidth ?? 0,
    naturalHeight: options.naturalHeight ?? 0,
    hidden: options.hidden ?? false,
    getAttribute: (name: string) => attributes[name] ?? null,
    getBoundingClientRect: () => rect
  }
}

interface FakeUiElement {
  textContent: string
  disabled: boolean
  addEventListener: (type: string, handler: () => void) => void
}

interface FakeHost {
  id: string
  style: Record<string, string>
  parentNode: unknown
  attachShadow: (init: { mode: string }) => { innerHTML: string; querySelector: (selector: string) => FakeUiElement }
}

interface FakeUi {
  count: FakeUiElement
  send: FakeUiElement
  stop: FakeUiElement
  host: FakeHost
}

function makeUi(): FakeUi {
  const element = (): FakeUiElement => ({
    textContent: '',
    disabled: false,
    addEventListener: () => {}
  })
  const count = element()
  const send = element()
  const stop = element()
  const shadow = {
    innerHTML: '',
    querySelector: (selector: string) => {
      if (selector === '.count') return count
      if (selector === '[data-role="send"]') return send
      return stop
    }
  }
  return {
    count,
    send,
    stop,
    host: { id: '', style: {}, parentNode: null, attachShadow: () => shadow }
  }
}

interface FakeDocument {
  baseURI: string
  title: string
  documentElement: { scrollHeight: number; appendChild: (node: unknown) => void }
  body: { scrollHeight: number }
  createElement: (tagName: string) => FakeHost
  querySelectorAll: (selector: string) => unknown[]
}

function makeDocument(images: readonly FakeImg[], ui: FakeUi = makeUi()): FakeDocument {
  return {
    baseURI: 'https://www.pinterest.com/search/pins/?q=coats',
    title: '  Autumn   coats ',
    documentElement: { scrollHeight: 1000, appendChild: () => {} },
    body: { scrollHeight: 1000 },
    createElement: () => ui.host,
    querySelectorAll: (selector: string) => (selector === 'img' ? [...images] : [])
  }
}

interface FakeWindow {
  scrollY: number
  innerHeight: number
  location: { href: string }
  scrollTo: (options: number | { top?: number }) => void
  setTimeout: (handler: () => void, delay: number) => number
  clearTimeout: (id: number) => void
}

/** A window whose timers are driven by the test, one scroll round at a time. */
function makeWindow(): { win: FakeWindow; runNextRound: () => boolean } {
  const timers = new Map<number, () => void>()
  let nextId = 1
  const win: FakeWindow = {
    scrollY: 0,
    innerHeight: 800,
    location: { href: 'https://www.pinterest.com/search/pins/?q=coats' },
    scrollTo: () => {},
    setTimeout: (handler: () => void) => {
      const id = nextId
      nextId += 1
      timers.set(id, handler)
      return id
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    }
  }
  return {
    win,
    runNextRound: () => {
      for (const [id, handler] of timers) {
        timers.delete(id)
        handler()
        return true
      }
      return false
    }
  }
}

interface FakeMessage {
  type?: string
  count?: number
  text?: string
  images?: CollectedImage[]
  pageTitle?: string
}

/** A fake extension runtime that records every message the page sends. */
function makeChrome(): { api: Record<string, unknown>; messages: FakeMessage[] } {
  const messages: FakeMessage[] = []
  return {
    messages,
    api: {
      runtime: {
        lastError: undefined,
        sendMessage: (message: FakeMessage, callback?: (response: unknown) => void) => {
          messages.push(message)
          if (typeof callback === 'function') callback({ ok: true })
        }
      }
    }
  }
}

function withChrome<T>(api: Record<string, unknown>, body: () => T): T {
  sandbox.chrome = api
  try {
    return body()
  } finally {
    delete sandbox.chrome
  }
}

const PIN_236 = 'https://i.pinimg.com/236x/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'
const PIN_736 = 'https://i.pinimg.com/736x/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'
const PIN_ORIGINAL =
  'https://i.pinimg.com/originals/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'

// One real Pinterest search result: 236x .jpg thumbnails, and an /originals/
// file that is a .png (HEAD: originals .png 200, originals .jpg 403,
// 736x .jpg 200, 736x .png 403).
const REAL_HASH = '14fa908f8e913d49d15029554b0b96c2'
const REAL_DIR = '14/fa/90'
const REAL_236 = `https://i.pinimg.com/236x/${REAL_DIR}/${REAL_HASH}.jpg`
const REAL_736 = `https://i.pinimg.com/736x/${REAL_DIR}/${REAL_HASH}.jpg`
const REAL_ORIGINAL_PNG = `https://i.pinimg.com/originals/${REAL_DIR}/${REAL_HASH}.png`
const REAL_ORIGINAL_JPG = `https://i.pinimg.com/originals/${REAL_DIR}/${REAL_HASH}.jpg`
const REAL_SRCSET =
  `${REAL_236} 1x, ` +
  `https://i.pinimg.com/474x/${REAL_DIR}/${REAL_HASH}.jpg 2x, ` +
  `${REAL_736} 3x, ` +
  `${REAL_ORIGINAL_PNG} 4x`

function realPinImg(): FakeImg {
  return makeImg({
    src: REAL_236,
    currentSrc: REAL_236,
    srcset: REAL_SRCSET,
    naturalWidth: 235,
    naturalHeight: 351,
    alt: 'a coat'
  })
}

describe('image collector srcset handling', () => {
  it('parses width and density descriptors', () => {
    expect(collector.parseSrcset('a.jpg 1x, b.jpg 2x')).toEqual([
      { url: 'a.jpg', width: 0, density: 1 },
      { url: 'b.jpg', width: 0, density: 2 }
    ])
    expect(collector.parseSrcset('a.jpg 236w, b.jpg 736w')).toEqual([
      { url: 'a.jpg', width: 236, density: 0 },
      { url: 'b.jpg', width: 736, density: 0 }
    ])
    expect(collector.parseSrcset('')).toEqual([])
    expect(collector.parseSrcset(null)).toEqual([])
  })

  it('picks the largest candidate and keeps a bare URL usable', () => {
    expect(collector.pickLargestSrcset('a.jpg 236w, b.jpg 736w, c.jpg 1200w')).toBe(
      'c.jpg'
    )
    expect(collector.pickLargestSrcset('a.jpg 1x, b.jpg 3x, c.jpg 2x')).toBe('b.jpg')
    expect(collector.pickLargestSrcset('only.jpg')).toBe('only.jpg')
    expect(collector.pickLargestSrcset(undefined)).toBeNull()
  })
})

describe('image collector Pinterest rewriting', () => {
  it('rewrites every size folder to /originals/', () => {
    for (const url of [
      PIN_236,
      PIN_736,
      'https://i.pinimg.com/60x60/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg',
      'https://i.pinimg.com/75x75_RS/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg',
      'https://i.pinimg.com/474x/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'
    ]) {
      expect(collector.pinterestOriginal(url)).toBe(PIN_ORIGINAL)
    }
    expect(collector.pinterestOriginal(PIN_ORIGINAL)).toBe(PIN_ORIGINAL)
  })

  it('builds the 736x fallback and ignores non-pinimg URLs', () => {
    expect(collector.pinterestFallback(PIN_236)).toBe(PIN_736)
    expect(collector.pinterestFallback('https://cdn.example/a.jpg')).toBeNull()
    expect(collector.pinterestOriginal('https://cdn.example/a.jpg')).toBeNull()
    expect(collector.pinterestOriginal('not a url')).toBeNull()
  })

  it('collapses size variants into one identity', () => {
    expect(collector.imageIdentity(PIN_236)).toBe(collector.imageIdentity(PIN_736))
    expect(collector.imageIdentity(PIN_236)).toBe(collector.imageIdentity(PIN_ORIGINAL))
    expect(collector.imageIdentity(PIN_236)).toMatch(/^pin:aa\/bb\/cc\//)
    // The /originals/ file of a pin can be a .png behind .jpg thumbnails.
    expect(collector.imageIdentity(REAL_236)).toBe(collector.imageIdentity(REAL_ORIGINAL_PNG))
    expect(collector.imageIdentity(REAL_236)).toBe(collector.imageIdentity(REAL_ORIGINAL_JPG))
    expect(collector.imageIdentity('https://cdn.example/a.jpg')).toBe(
      'https://cdn.example/a.jpg'
    )
    expect(collector.imageIdentity('javascript:alert(1)')).toBeNull()
  })

  it('recognizes Pinterest hosts only', () => {
    expect(collector.isPinterestHost('www.pinterest.com')).toBe(true)
    expect(collector.isPinterestHost('i.pinimg.com')).toBe(true)
    expect(collector.isPinterestHost('pinterest.co.uk')).toBe(true)
    expect(collector.isPinterestHost('notpinterest.com')).toBe(false)
    expect(collector.isPinterestHost(undefined)).toBe(false)
  })
})

describe('image collector filtering', () => {
  it('drops inline, blob, extension and svg sources', () => {
    for (const url of [
      'data:image/png;base64,AAAA',
      'blob:https://example.com/1234',
      'chrome-extension://abc/icon.png',
      'https://cdn.example/sprite.svg',
      '',
      42
    ]) {
      expect(collector.isSkippableUrl(url)).toBe(true)
    }
    expect(collector.isSkippableUrl('https://cdn.example/a.jpg')).toBe(false)
  })

  it('drops avatars and profile pictures', () => {
    expect(collector.isAvatarUrl('https://i.pinimg.com/75x75_RS/aa/bb/cc/x.jpg')).toBe(
      true
    )
    expect(collector.isAvatarUrl('https://cdn.example/avatars/1.png')).toBe(true)
    expect(collector.isAvatarUrl('https://cdn.example/profile-pics/1.png')).toBe(true)
    expect(collector.isAvatarUrl('https://cdn.example/photos/1.png')).toBe(false)
  })

  it('drops tiny images and non-objects', () => {
    expect(collector.isDecorativeImage(null)).toBe(true)
    expect(collector.isDecorativeImage('nope')).toBe(true)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 40, height: 40 })
    ).toBe(true)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 900, height: 20 })
    ).toBe(true)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 900, height: 600 })
    ).toBe(false)
    expect(collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg' })).toBe(false)
  })

  it('keeps landscape thumbnails and drops avatars and spacers', () => {
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 120, height: 80 })
    ).toBe(false)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 80, height: 120 })
    ).toBe(false)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 60, height: 60 })
    ).toBe(true)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/pixel.gif', width: 1, height: 1 })
    ).toBe(true)
    expect(
      collector.isDecorativeImage({
        url: 'https://i.pinimg.com/75x75_RS/aa/bb/cc/x.jpg',
        width: 75,
        height: 75
      })
    ).toBe(true)
  })
})

describe('image collector entries', () => {
  it('reports the original plus the 736x fallback for Pinterest', () => {
    expect(
      collector.toEntry({ url: PIN_236, width: 236, height: 354.4, alt: '  a coat ' })
    ).toEqual({
      url: PIN_ORIGINAL,
      fallbackUrl: PIN_736,
      width: 236,
      height: 354,
      alt: 'a coat'
    })
  })

  it('keeps only the url for ordinary images', () => {
    expect(collector.toEntry({ url: 'https://cdn.example/a.jpg', width: 800, height: 600 })).toEqual(
      { url: 'https://cdn.example/a.jpg', width: 800, height: 600 }
    )
  })

  it('resolves relative URLs and rejects unsafe ones', () => {
    expect(collector.toEntry({ url: '/a.jpg' }, 'https://example.com/page')).toEqual({
      url: 'https://example.com/a.jpg'
    })
    expect(collector.toEntry({ url: 'file:///C:/a.jpg' })).toBeNull()
    expect(collector.toEntry({ url: 'https://user:pass@cdn.example/a.jpg' })).toBeNull()
    expect(collector.toEntry({ url: 'https://cdn.example/75x75_RS/a.jpg' })).toBeNull()
    expect(collector.toEntry({ url: 'https://cdn.example/a.jpg', width: 20, height: 20 })).toBeNull()
    expect(collector.toEntry(null)).toBeNull()
  })

  it('caps the alt text length', () => {
    const entry = collector.toEntry({ url: 'https://cdn.example/a.jpg', alt: 'x'.repeat(400) })
    expect(entry?.alt).toHaveLength(200)
  })
})

describe('image collector merging', () => {
  it('deduplicates by identity and reports the additions', () => {
    const merged = collector.mergeImages(
      [{ url: PIN_ORIGINAL }],
      [{ url: PIN_736 }, { url: 'https://cdn.example/a.jpg' }, { url: PIN_236 }]
    )
    expect(merged.added).toBe(1)
    expect(merged.images.map((image) => image.url)).toEqual([
      PIN_ORIGINAL,
      'https://cdn.example/a.jpg'
    ])
  })

  it('honours the cap and skips malformed entries', () => {
    const merged = collector.mergeImages(
      [],
      [
        { url: 'https://cdn.example/1.jpg' },
        { url: 'https://cdn.example/2.jpg' },
        { url: 'https://cdn.example/3.jpg' },
        { nope: true } as unknown as CollectedImage
      ],
      2
    )
    expect(merged.images).toHaveLength(2)
    expect(merged.added).toBe(2)
    expect(collector.MAX_IMAGES).toBe(1000)
  })
})

describe('image collector page collection', () => {
  it('reports one entry per pin, with the original the page really has', () => {
    const images = collector.collectFromDocument(makeDocument([realPinImg()]), makeWindow().win)
    expect(images).toEqual([
      {
        url: REAL_ORIGINAL_PNG,
        fallbackUrl: REAL_736,
        width: 235,
        height: 351,
        alt: 'a coat'
      }
    ])
  })

  it('synthesizes the original when the page has no /originals/ candidate', () => {
    const images = collector.collectFromDocument(
      makeDocument([
        makeImg({
          src: PIN_236,
          currentSrc: PIN_236,
          srcset: `${PIN_236} 1x, https://i.pinimg.com/474x/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg 2x, ${PIN_736} 3x`,
          naturalWidth: 236,
          naturalHeight: 354
        })
      ]),
      makeWindow().win
    )
    expect(images).toEqual([
      { url: PIN_ORIGINAL, fallbackUrl: PIN_736, width: 236, height: 354 }
    ])
  })

  it('keeps normal thumbnails and drops icons, avatars and spacers', () => {
    const commons =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Landscape.jpg/120px-Landscape.jpg'
    const images = collector.collectFromDocument(
      makeDocument([
        makeImg({ src: commons, naturalWidth: 120, naturalHeight: 80 }),
        makeImg({
          src: 'https://i.pinimg.com/60x60/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg',
          naturalWidth: 60,
          naturalHeight: 60
        }),
        makeImg({
          src: 'https://i.pinimg.com/75x75_RS/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg',
          naturalWidth: 75,
          naturalHeight: 75
        }),
        makeImg({ src: 'https://cdn.example/pixel.gif', naturalWidth: 1, naturalHeight: 1 })
      ]),
      makeWindow().win
    )
    expect(images.map((image) => image.url)).toEqual([commons])
  })

  it('falls back to the rendered box before an image is decoded', () => {
    const images = collector.collectFromDocument(
      makeDocument([
        makeImg({
          src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/L.jpg/120px-L.jpg',
          rect: { width: 120, height: 80 }
        })
      ]),
      makeWindow().win
    )
    expect(images).toHaveLength(1)
  })
})

describe('image collector merge upgrades', () => {
  it('upgrades a synthesized original once the srcset shows the real one', () => {
    const thumbnailOnly = collector.collectFromDocument(
      makeDocument([
        makeImg({ src: REAL_236, currentSrc: REAL_236, naturalWidth: 235, naturalHeight: 351 })
      ]),
      makeWindow().win
    )
    expect(thumbnailOnly).toEqual([
      { url: REAL_ORIGINAL_JPG, fallbackUrl: REAL_736, width: 235, height: 351 }
    ])

    const withSrcset = collector.collectFromDocument(
      makeDocument([realPinImg()]),
      makeWindow().win
    )
    const merged = collector.mergeImages(thumbnailOnly, withSrcset)
    expect(merged.added).toBe(0)
    expect(merged.images).toEqual([
      {
        url: REAL_ORIGINAL_PNG,
        fallbackUrl: REAL_736,
        width: 235,
        height: 351,
        alt: 'a coat'
      }
    ])

    // A later round that lost the srcset must not downgrade the real original.
    const again = collector.mergeImages(merged.images, thumbnailOnly)
    expect(again.images.map((image) => image.url)).toEqual([REAL_ORIGINAL_PNG])
  })
})

describe('image collector run hand-off', () => {
  function readyMessages(messages: readonly FakeMessage[]): FakeMessage[] {
    return messages.filter((message) => message.type === collector.READY_MESSAGE)
  }

  it('sends automatically when the run goes idle', () => {
    const chrome = makeChrome()
    withChrome(chrome.api, () => {
      const ui = makeUi()
      const page = makeDocument([realPinImg()], ui)
      const window = makeWindow()
      const run = collector.startRun(page, window.win, { intervalMs: 1 })

      expect(run.count()).toBe(1)
      // The button is there for sending early, before the run ends.
      expect(ui.send.disabled).toBe(false)

      let rounds = 0
      while (window.runNextRound() && rounds < 10) rounds += 1

      const ready = readyMessages(chrome.messages)
      expect(ready).toHaveLength(1)
      expect(ready[0]?.images).toEqual([
        {
          url: REAL_ORIGINAL_PNG,
          fallbackUrl: REAL_736,
          width: 235,
          height: 351,
          alt: 'a coat'
        }
      ])
      expect(ready[0]?.pageTitle).toBe('Autumn coats')
      expect(ui.count.textContent).toBe('Sent to DonDownload')
      expect(ui.send.disabled).toBe(true)
    })
  })

  it('sends automatically when the run hits the image limit', () => {
    const chrome = makeChrome()
    withChrome(chrome.api, () => {
      const ui = makeUi()
      const page = makeDocument(
        [
          makeImg({ src: 'https://cdn.example/1.jpg', naturalWidth: 800, naturalHeight: 600 }),
          makeImg({ src: 'https://cdn.example/2.jpg', naturalWidth: 800, naturalHeight: 600 })
        ],
        ui
      )
      const window = makeWindow()
      const run = collector.startRun(page, window.win, { maxImages: 1 })

      expect(run.count()).toBe(1)
      const ready = readyMessages(chrome.messages)
      expect(ready).toHaveLength(1)
      expect(ready[0]?.images).toHaveLength(1)
      const progress = chrome.messages.filter(
        (message) => message.type === collector.PROGRESS_MESSAGE
      )
      expect(progress[progress.length - 1]?.text).toBe('1 images found (limit)')
    })
  })

  it('sends automatically when the user presses Stop', () => {
    const chrome = makeChrome()
    withChrome(chrome.api, () => {
      const ui = makeUi()
      const page = makeDocument([realPinImg()], ui)
      const window = makeWindow()
      const run = collector.startRun(page, window.win, { intervalMs: 1 })

      run.stop()

      const ready = readyMessages(chrome.messages)
      expect(ready).toHaveLength(1)
      expect(ready[0]?.images).toHaveLength(1)
      expect(ui.stop.disabled).toBe(true)
    })
  })

  it('reports an empty run without sending anything', () => {
    const chrome = makeChrome()
    withChrome(chrome.api, () => {
      const ui = makeUi()
      const page = makeDocument([], ui)
      const window = makeWindow()
      collector.startRun(page, window.win, { intervalMs: 1 })

      let rounds = 0
      while (window.runNextRound() && rounds < 10) rounds += 1

      expect(readyMessages(chrome.messages)).toHaveLength(0)
      expect(ui.count.textContent).toBe('No images found')
      expect(ui.send.disabled).toBe(true)
    })
  })
})

describe('image collector page title', () => {
  it('cleans and caps the document title', () => {
    expect(collector.pageTitle({ title: '  Autumn   outfit\nideas ' })).toBe(
      'Autumn outfit ideas'
    )
    expect(collector.pageTitle({ title: 'x'.repeat(400) })).toHaveLength(200)
    expect(collector.pageTitle(null)).toBe('')
  })
})
