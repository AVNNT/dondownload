import { describe, expect, it } from 'vitest'
import {
  MAX_SCAN_URLS,
  buildScanSends,
  groupScanUrlsByOrigin,
  parseScanUrlList
} from '../extension/scan-urls.js'

const LINKS = Array.from(
  { length: MAX_SCAN_URLS + 3 },
  (_value, index) => `https://forum.example/t/topic-${index}/${1000 + index}`
)

describe('extension scan URL list', () => {
  it('parses one URL per line, deduplicates and limits to ten', () => {
    const text = [
      LINKS[0],
      '',
      `  ${LINKS[1]}  `,
      // Same URL after normalization (scheme case and fragment).
      `${LINKS[0]?.replace('https://', 'HTTPS://')}#section`,
      'not a url',
      ...LINKS.slice(2)
    ].join('\n')

    const parsed = parseScanUrlList(text)
    expect(parsed.urls).toHaveLength(MAX_SCAN_URLS)
    expect(new Set(parsed.urls).size).toBe(parsed.urls.length)
    expect(parsed.duplicates).toBe(1)
    expect(parsed.invalid).toEqual(['not a url'])
    expect(parsed.overLimit).toBe(3)
    expect(MAX_SCAN_URLS).toBe(10)
  })

  it('reports every invalid line and non-http schemes', () => {
    const parsed = parseScanUrlList(
      ['ftp://files.example/a', 'javascript:alert(1)', '', LINKS[0]].join('\r\n')
    )
    expect(parsed.urls).toEqual([LINKS[0]])
    expect(parsed.invalid).toEqual(['ftp://files.example/a', 'javascript:alert(1)'])
    expect(parsed.overLimit).toBe(0)
  })

  it('groups URLs by exact origin and keeps first-seen order', () => {
    const groups = groupScanUrlsByOrigin([
      'https://one.example/a',
      'https://two.example/b',
      'https://one.example/c',
      'not a url'
    ])
    expect(groups).toEqual([
      { origin: 'https://one.example', urls: ['https://one.example/a', 'https://one.example/c'] },
      { origin: 'https://two.example', urls: ['https://two.example/b'] }
    ])
  })
})

describe('extension scan sends', () => {
  it('keeps the cookie on its own origin only', () => {
    const sends = buildScanSends([
      { origin: 'https://one.example', url: 'https://one.example/a', cookie: 'a=1' },
      { origin: 'https://two.example', url: 'https://two.example/b' },
      // A mixed entry is dropped instead of leaking one site's cookie.
      { origin: 'https://one.example', url: 'https://two.example/c', cookie: 'a=1' }
    ])
    expect(sends).toEqual([
      { url: 'https://one.example/a', cookie: 'a=1' },
      { url: 'https://two.example/b' }
    ])
  })

  it('never attaches a cookie to an origin it was not read for', () => {
    const sends = buildScanSends([
      { origin: 'https://one.example', url: 'https://evil.example/a', cookie: 'auth=1' }
    ])
    expect(sends).toEqual([])
  })
})
