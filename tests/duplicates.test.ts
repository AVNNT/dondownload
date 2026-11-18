import { describe, expect, it } from 'vitest'
import {
  normalizeDuplicateUrl,
  parseDuplicateCheckUrl
} from '../src/shared/duplicates'
import { duplicateNotice } from '../src/renderer/src/lib/duplicateNotice'

describe('normalizeDuplicateUrl', () => {
  it.each<[string, string]>([
    // Scheme and host are lowercased.
    ['HTTPS://Example.COM/File.ZIP', 'https://example.com/File.ZIP'],
    // Default ports are removed, non-default ports are kept.
    ['https://example.com:443/file.zip', 'https://example.com/file.zip'],
    ['http://example.com:80/file.zip', 'http://example.com/file.zip'],
    ['https://example.com:8443/file.zip', 'https://example.com:8443/file.zip'],
    // Fragments are dropped, including a MEGA-style key fragment.
    ['https://example.com/file.zip#section', 'https://example.com/file.zip'],
    ['https://mega.nz/file/abc#key', 'https://mega.nz/file/abc'],
    // The query string is significant and preserved.
    ['https://example.com/download?id=7&v=2', 'https://example.com/download?id=7&v=2'],
    ['HTTPS://EXAMPLE.com/download?ID=7#x', 'https://example.com/download?ID=7'],
    // Whitespace around the URL is not significant.
    ['  https://example.com/a  ', 'https://example.com/a']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDuplicateUrl(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'not a url',
    'ftp://example.com/file.zip',
    'https://user:pass@example.com/file.zip',
    null,
    undefined,
    42
  ])('returns null for %s', (input) => {
    expect(normalizeDuplicateUrl(input)).toBeNull()
  })

  it('validates a renderer-provided check URL', () => {
    expect(parseDuplicateCheckUrl('HTTPS://Example.com:443/a#x')).toBe(
      'https://example.com/a'
    )
    expect(() => parseDuplicateCheckUrl('ftp://example.com/a')).toThrow()
    expect(() => parseDuplicateCheckUrl('nope')).toThrow()
  })
})

describe('duplicateNotice', () => {
  it('describes a finished duplicate with the file actions', () => {
    const notice = duplicateNotice(
      {
        kind: 'download',
        state: 'finished',
        id: 'id',
        filename: 'report.pdf',
        date: Date.UTC(2026, 4, 6, 12),
        fileExists: true
      },
      'en-US'
    )

    expect(notice.title).toBe('Already downloaded on May 6, 2026 · report.pdf')
    expect(notice.actions).toEqual(['open', 'show', 'again'])
    expect(notice.canOpen).toBe(true)
    expect(notice.detail).toBeNull()
  })

  it('keeps only Download again when the finished file is gone', () => {
    const notice = duplicateNotice({
      kind: 'download',
      state: 'finished',
      id: 'id',
      filename: 'report.pdf',
      date: Date.UTC(2026, 4, 6),
      fileExists: false
    })

    expect(notice.actions).toEqual(['again'])
    expect(notice.canOpen).toBe(false)
    expect(notice.detail).toMatch(/no longer/)
  })

  it('offers only Show it for an active duplicate', () => {
    const notice = duplicateNotice({
      kind: 'download',
      state: 'active',
      id: 'id',
      filename: 'report.pdf',
      date: 1,
      fileExists: false
    })

    expect(notice.title).toBe('Already in your list')
    expect(notice.actions).toEqual(['reveal'])
  })
})
