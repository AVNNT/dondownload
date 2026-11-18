import { describe, expect, it } from 'vitest'
import {
  ValidationError,
  guessFilenameFromUrl,
  normalizeHttpUrl,
  parseAddDownloadInput,
  parseAria2Gid,
  parseDownloadId,
  sanitizeFilename
} from '../src/shared/validation'

describe('normalizeHttpUrl', () => {
  it('accepts http and https URLs and removes the fragment', () => {
    expect(normalizeHttpUrl('https://example.com/file.zip#section')).toBe(
      'https://example.com/file.zip'
    )
    expect(normalizeHttpUrl('  http://example.com/a?b=1  ')).toBe(
      'http://example.com/a?b=1'
    )
  })

  it.each([
    ['', 'empty'],
    ['not a url', 'garbage'],
    ['ftp://example.com/file.zip', 'ftp'],
    ['file:///C:/Windows/System32/calc.exe', 'file'],
    ['javascript:alert(1)', 'javascript'],
    ['data:text/plain,hello', 'data'],
    ['https://user:pass@example.com/file.zip', 'credentials'],
    ['https://example.com/a\nb', 'control characters']
  ])('rejects %s (%s)', (value) => {
    expect(() => normalizeHttpUrl(value)).toThrow(ValidationError)
  })

  it('rejects non-strings and overlong URLs', () => {
    expect(() => normalizeHttpUrl(42)).toThrow(ValidationError)
    expect(() => normalizeHttpUrl(`https://example.com/${'a'.repeat(5000)}`)).toThrow(
      ValidationError
    )
  })
})

describe('sanitizeFilename', () => {
  it('strips path separators and traversal sequences', () => {
    const result = sanitizeFilename('../../Windows/System32/evil.exe')
    expect(result).not.toContain('/')
    expect(result).not.toContain('\\')
    expect(result).not.toBe('..')
    expect(result.length).toBeGreaterThan(0)
  })

  it('removes Windows-reserved characters and trailing dots', () => {
    expect(sanitizeFilename('report<1>:"|?*.pdf... ')).toBe('report_1______.pdf')
  })

  it('prefixes reserved device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON')
    expect(sanitizeFilename('con.txt')).toBe('_con.txt')
    expect(sanitizeFilename('COM1.log')).toBe('_COM1.log')
  })

  it('keeps the extension when truncating long names', () => {
    const result = sanitizeFilename(`${'a'.repeat(300)}.zip`)
    expect(result.length).toBeLessThanOrEqual(180)
    expect(result.endsWith('.zip')).toBe(true)
  })

  it('rejects empty, dot-only, and non-string names', () => {
    expect(() => sanitizeFilename('   ')).toThrow(ValidationError)
    expect(() => sanitizeFilename('...')).toThrow(ValidationError)
    expect(() => sanitizeFilename(10)).toThrow(ValidationError)
  })
})

describe('parseAddDownloadInput', () => {
  it('normalises URL and optional file name', () => {
    expect(
      parseAddDownloadInput({
        url: ' https://example.com/file.zip#x ',
        filename: '  My File.zip  ',
        ignored: true
      })
    ).toEqual({ url: 'https://example.com/file.zip', filename: 'My File.zip' })
  })

  it('omits blank and null file names', () => {
    expect(parseAddDownloadInput({ url: 'https://example.com/a', filename: '  ' })).toEqual({
      url: 'https://example.com/a'
    })
    expect(parseAddDownloadInput({ url: 'https://example.com/a', filename: null })).toEqual({
      url: 'https://example.com/a'
    })
  })

  it('passes through only an explicit boolean force opt-in', () => {
    expect(
      parseAddDownloadInput({ url: 'https://example.com/a', force: true })
    ).toEqual({ url: 'https://example.com/a', force: true })
    expect(
      parseAddDownloadInput({ url: 'https://example.com/a', force: false })
    ).toEqual({ url: 'https://example.com/a' })
  })

  it('accepts only a valid opaque destination token', () => {
    const token = 'a'.repeat(32)
    expect(
      parseAddDownloadInput({
        url: 'https://example.com/a',
        destinationToken: token
      })
    ).toEqual({ url: 'https://example.com/a', destinationToken: token })
    expect(() =>
      parseAddDownloadInput({
        url: 'https://example.com/a',
        destinationToken: 'short'
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseAddDownloadInput({
        url: 'https://example.com/a',
        destinationToken: 42
      })
    ).toThrow(ValidationError)
  })

  it('accepts only exact-key per-download controls', () => {
    const controls = {
      scheduledAt: Date.UTC(2026, 10, 4, 12, 30),
      speedLimitBps: 1024 * 1024,
      connections: 4
    }
    expect(
      parseAddDownloadInput({ url: 'https://example.com/a', controls })
    ).toEqual({ url: 'https://example.com/a', controls })

    expect(() =>
      parseAddDownloadInput({
        url: 'https://example.com/a',
        controls: { ...controls, url: 'https://leak.example' }
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseAddDownloadInput({
        url: 'https://example.com/a',
        controls: { scheduledAt: null, speedLimitBps: null }
      })
    ).toThrow(/missing/)
    expect(() =>
      parseAddDownloadInput({
        url: 'https://example.com/a',
        controls: { ...controls, connections: 0 }
      })
    ).toThrow(/Invalid/)
  })

  it('rejects invalid payload shapes', () => {
    expect(() => parseAddDownloadInput(null)).toThrow(ValidationError)
    expect(() => parseAddDownloadInput([])).toThrow(ValidationError)
    expect(() => parseAddDownloadInput({ url: 'https://example.com/a', filename: 7 })).toThrow(
      ValidationError
    )
    expect(() => parseAddDownloadInput({ url: 'https://example.com/a', force: 'yes' })).toThrow(
      ValidationError
    )
  })
})

describe('identifiers', () => {
  it('accepts UUID v4 download ids only', () => {
    expect(parseDownloadId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    )
    expect(() => parseDownloadId('../../etc/passwd')).toThrow(ValidationError)
    expect(() => parseDownloadId('f47ac10b-58cc-1372-a567-0e02b2c3d479')).toThrow(
      ValidationError
    )
  })

  it('accepts 16-character hexadecimal aria2 GIDs only', () => {
    expect(parseAria2Gid('0123456789abcdef')).toBe('0123456789abcdef')
    expect(() => parseAria2Gid('not-a-gid')).toThrow(ValidationError)
    expect(() => parseAria2Gid('0123456789ABCDE')).toThrow(ValidationError)
  })
})

describe('guessFilenameFromUrl', () => {
  it('decodes the final URL segment without allowing path escapes', () => {
    expect(guessFilenameFromUrl('https://example.com/files/my%20file.zip')).toBe(
      'my file.zip'
    )
    expect(guessFilenameFromUrl('https://example.com/a%2Fb.zip')).toBe('a_b.zip')
  })

  it('falls back to a safe default', () => {
    expect(guessFilenameFromUrl('https://example.com/')).toBe('download')
  })
})
