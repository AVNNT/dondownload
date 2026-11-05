import { describe, expect, it } from 'vitest'
import {
  buildNetscapeCookieFile,
  cookieFileDomain
} from '../src/main/media/cookies'

describe('one-job Netscape cookie files', () => {
  it('writes valid pairs for the site domain and includes subdomains', () => {
    const body = buildNetscapeCookieFile(
      'session=abc=def; theme=dark; empty=',
      'www.vimeo.com'
    )
    expect(body).toContain('# Netscape HTTP Cookie File')
    expect(body).toContain('.vimeo.com\tTRUE\t/\tTRUE\t0\tsession\tabc=def')
    expect(body).toContain('.vimeo.com\tTRUE\t/\tTRUE\t0\ttheme\tdark')
    expect(body).toContain('.vimeo.com\tTRUE\t/\tTRUE\t0\tempty\t')
    expect(body).not.toContain('www.vimeo.com')
  })

  it('drops malformed names, values and header injection attempts', () => {
    const body = buildNetscapeCookieFile(
      'good=1; bad name=2; =missing; tab\tname=3; line\rbreak=4; other=5',
      'example.com'
    )
    expect(body).toContain('\tgood\t1')
    expect(body).toContain('\tother\t5')
    expect(body).not.toContain('bad name')
    expect(body).not.toContain('missing')
    expect(body).not.toContain('\r')
    expect(body.split('\n').every((line) => !line.includes('\t3'))).toBe(true)
  })

  it('uses the registrable-ish domain for multi-part suffixes and IPs', () => {
    expect(cookieFileDomain('www.example.co.uk')).toBe('example.co.uk')
    expect(cookieFileDomain('news.example.com')).toBe('example.com')
    expect(cookieFileDomain('example.com')).toBe('example.com')
    expect(cookieFileDomain('127.0.0.1')).toBe('127.0.0.1')
    expect(cookieFileDomain('localhost')).toBe('localhost')
  })

  it('requires a host', () => {
    expect(() => buildNetscapeCookieFile('a=1', '')).toThrow()
  })
})
