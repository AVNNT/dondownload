import { describe, expect, it } from 'vitest'
import {
  MAX_SCAN_IMAGES,
  imageFolderName,
  parseScanImagesRequest
} from '../src/shared/scanImages'

const PAGE_URL = 'https://www.pinterest.com/ideas/autumn-outfits/9/'

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pageUrl: PAGE_URL,
    pageTitle: 'Autumn outfit ideas',
    images: [{ url: 'https://i.pinimg.com/originals/aa/bb/cc/x.jpg' }],
    ...overrides
  }
}

describe('image scan request validation', () => {
  it('accepts one image and normalizes the page URL', () => {
    const parsed = parseScanImagesRequest(request())
    expect(parsed.type).toBe('scan-images')
    expect(parsed.pageUrl).toBe(PAGE_URL)
    expect(parsed.pageTitle).toBe('Autumn outfit ideas')
    expect(parsed.images).toEqual([
      { url: 'https://i.pinimg.com/originals/aa/bb/cc/x.jpg' }
    ])
  })

  it('keeps the Pinterest fallback only when it differs', () => {
    const parsed = parseScanImagesRequest(
      request({
        images: [
          {
            url: 'https://i.pinimg.com/originals/aa/bb/cc/x.jpg',
            fallbackUrl: 'https://i.pinimg.com/736x/aa/bb/cc/x.jpg',
            width: 1200,
            height: 1800,
            alt: '  a coat  '
          },
          {
            url: 'https://cdn.example/a.png',
            fallbackUrl: 'https://cdn.example/a.png'
          }
        ]
      })
    )
    expect(parsed.images[0]).toEqual({
      url: 'https://i.pinimg.com/originals/aa/bb/cc/x.jpg',
      fallbackUrl: 'https://i.pinimg.com/736x/aa/bb/cc/x.jpg',
      width: 1200,
      height: 1800,
      alt: 'a coat'
    })
    expect(parsed.images[1]).toEqual({ url: 'https://cdn.example/a.png' })
  })

  it('deduplicates by URL and keeps first-seen order', () => {
    const parsed = parseScanImagesRequest(
      request({
        images: [
          { url: 'https://cdn.example/b.png' },
          { url: 'https://cdn.example/a.png' },
          { url: 'https://cdn.example/b.png' }
        ]
      })
    )
    expect(parsed.images.map((image) => image.url)).toEqual([
      'https://cdn.example/b.png',
      'https://cdn.example/a.png'
    ])
  })

  it('rejects non-http, credential, relative and empty URLs', () => {
    for (const url of [
      'file:///C:/secret.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'https://user:pass@cdn.example/a.png',
      '/relative/a.png',
      ''
    ]) {
      expect(() => parseScanImagesRequest(request({ images: [{ url }] }))).toThrow()
    }
  })

  it('rejects an empty, oversized or malformed list', () => {
    expect(() => parseScanImagesRequest(request({ images: [] }))).toThrow()
    expect(() =>
      parseScanImagesRequest(
        request({
          images: Array.from({ length: MAX_SCAN_IMAGES + 1 }, (_value, index) => ({
            url: `https://cdn.example/${index}.png`
          }))
        })
      )
    ).toThrow()
    expect(() => parseScanImagesRequest(request({ images: 'nope' }))).toThrow()
    expect(() =>
      parseScanImagesRequest(request({ images: [{ url: 'https://cdn.example/a.png', extra: 1 }] }))
    ).toThrow()
  })

  it('accepts exactly the cap and rejects unsupported top-level fields', () => {
    const parsed = parseScanImagesRequest(
      request({
        images: Array.from({ length: MAX_SCAN_IMAGES }, (_value, index) => ({
          url: `https://cdn.example/${index}.png`
        }))
      })
    )
    expect(parsed.images).toHaveLength(MAX_SCAN_IMAGES)
    expect(MAX_SCAN_IMAGES).toBe(1000)
    expect(parseScanImagesRequest(request({ cookie: 'a=1' })).cookie).toBe('a=1')
    expect(() => parseScanImagesRequest(request({ extra: true }))).toThrow()
  })

  it('rejects a wrong operation type and a bad cookie', () => {
    expect(() => parseScanImagesRequest(request({ type: 'scan-page' }))).toThrow()
    expect(() => parseScanImagesRequest(request({ type: 'scan-images' }))).not.toThrow()
    expect(() =>
      parseScanImagesRequest(request({ type: 'scan-images', cookie: 'bad\nheader' }))
    ).toThrow()
  })

  it('falls back to a readable title and caps its length', () => {
    expect(parseScanImagesRequest(request({ pageTitle: '   ' })).pageTitle).toBe(
      'Untitled page'
    )
    const long = parseScanImagesRequest(request({ pageTitle: 'x'.repeat(400) }))
    expect(long.pageTitle).toHaveLength(200)
  })
})

describe('image batch folder name', () => {
  it('reduces a page title to one safe path segment', () => {
    expect(imageFolderName('Autumn outfit ideas')).toBe('Autumn outfit ideas')
    expect(imageFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(imageFolderName('  ...trailing dots...  ')).toBe('trailing dots')
    expect(imageFolderName('')).toBe('Images')
    expect(imageFolderName('   ')).toBe('Images')
    expect(imageFolderName('../../etc')).toBe('etc')
  })

  it('caps the length and escapes Windows device names', () => {
    expect(imageFolderName('x'.repeat(400)).length).toBeLessThanOrEqual(80)
    expect(imageFolderName('CON')).toBe('_CON')
    expect(imageFolderName('nul')).toBe('_nul')
  })
})
