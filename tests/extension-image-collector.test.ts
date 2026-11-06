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
  pageTitle: (doc: unknown) => string
}

const SOURCE = readFileSync(
  path.join(process.cwd(), 'extension', 'image-collector.js'),
  'utf8'
)

const collector = vm.runInNewContext(
  `${SOURCE}\n;globalThis.DonDownloadImageCollector`,
  { URL }
) as CollectorApi

const PIN_236 = 'https://i.pinimg.com/236x/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'
const PIN_736 = 'https://i.pinimg.com/736x/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'
const PIN_ORIGINAL =
  'https://i.pinimg.com/originals/aa/bb/cc/0f1e2d3c4b5a69788796a5b4.jpg'

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
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 900, height: 40 })
    ).toBe(true)
    expect(
      collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg', width: 900, height: 600 })
    ).toBe(false)
    expect(collector.isDecorativeImage({ url: 'https://cdn.example/a.jpg' })).toBe(false)
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

describe('image collector page title', () => {
  it('cleans and caps the document title', () => {
    expect(collector.pageTitle({ title: '  Autumn   outfit\nideas ' })).toBe(
      'Autumn outfit ideas'
    )
    expect(collector.pageTitle({ title: 'x'.repeat(400) })).toHaveLength(200)
    expect(collector.pageTitle(null)).toBe('')
  })
})
