import { describe, expect, it } from 'vitest'
import { isCookieHopSafe } from '../src/main/net/cookieScope'

describe('fetchPage and publicPreflight cookie scope guard', () => {
  it('allows only the exact original host and scheme', () => {
    expect(
      isCookieHopSafe(
        new URL('https://forum.example/thread/1'),
        new URL('https://forum.example/uploads/a.funscript')
      )
    ).toBe(true)
    expect(
      isCookieHopSafe(
        new URL('http://forum.example/thread/1'),
        new URL('http://forum.example/uploads/a.funscript')
      )
    ).toBe(true)

    // HTTPS -> HTTP downgrade: never send the cookie over plain HTTP.
    expect(
      isCookieHopSafe(
        new URL('https://forum.example/thread/1'),
        new URL('http://forum.example/uploads/a.funscript')
      )
    ).toBe(false)

    // Another host or port is a different origin.
    expect(
      isCookieHopSafe(
        new URL('https://forum.example/thread/1'),
        new URL('https://storage.example/uploads/a.funscript')
      )
    ).toBe(false)
    expect(
      isCookieHopSafe(
        new URL('https://forum.example:8443/thread/1'),
        new URL('https://forum.example/uploads/a.funscript')
      )
    ).toBe(false)
  })
})
