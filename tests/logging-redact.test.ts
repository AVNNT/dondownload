import { describe, expect, it } from 'vitest'
import {
  errorLine,
  formatLogMessage,
  redact,
  stringify
} from '../src/main/logging/redact'

const PROFILE = 'C:\\Users\\Ada'
const OPTIONS = { userPaths: [PROFILE, 'C:\\Users\\Ada\\AppData\\Local\\Temp'] }
const SEP = ' ' + String.fromCharCode(0x23CE) + ' '

describe('redact: URLs', () => {
  it('keeps only the scheme and host of an ordinary link', () => {
    expect(redact('Downloading https://example.com/files/report.pdf?token=abc')).toBe(
      'Downloading https://example.com/'
    )
  })

  it('drops the query string and fragment', () => {
    expect(redact('retry https://cdn.example.org/a/b#section')).toBe(
      'retry https://cdn.example.org/'
    )
  })

  it('drops credentials embedded in the authority', () => {
    expect(redact('ftp://user:secret@files.example.net/private/x.zip')).toBe(
      'ftp://files.example.net/'
    )
  })

  it('keeps the port, which is not personal data', () => {
    expect(redact('bridge at http://127.0.0.1:53211/bridge')).toBe(
      'bridge at http://127.0.0.1:53211/'
    )
  })

  it('redacts every URL in a longer message', () => {
    expect(
      redact('a https://one.example.com/x b https://two.example.com/y?q=1 c')
    ).toBe('a https://one.example.com/ b https://two.example.com/ c')
  })

  it('keeps sentence punctuation outside the redacted link', () => {
    expect(redact('See https://example.com/page.')).toBe('See https://example.com/.')
  })

  it('keeps a host that looks like a header name intact', () => {
    expect(redact('https://cookie.example.com/x/y')).toBe(
      'https://cookie.example.com/'
    )
  })

  it('does not treat a bare scheme name as a URL', () => {
    expect(redact('the http fetch failed')).toBe('the http fetch failed')
  })

  it('redacts file:// URLs too', () => {
    expect(redact('file:///C:/Users/Ada/Downloads/private.mp4')).not.toContain(
      'private'
    )
  })
})

describe('redact: user paths', () => {
  it('replaces the profile path with %USERPROFILE%', () => {
    expect(
      redact(`${PROFILE}\\Downloads\\holiday.mp4 could not be moved`, OPTIONS)
    ).toBe('%USERPROFILE%\\Downloads\\holiday.mp4 could not be moved')
  })

  it('matches any case and either slash direction', () => {
    expect(redact('c:/users/ada/Downloads/x.txt', OPTIONS)).toBe(
      '%USERPROFILE%/Downloads/x.txt'
    )
  })

  it('reduces a windows path outside the profile to an extension', () => {
    expect(redact('saved to D:\\Media\\Holiday 2024\\beach.mkv')).toBe(
      'saved to <path>.mkv'
    )
  })

  it('reduces a quoted windows path to an extension', () => {
    expect(redact('saved to "D:\\Media\\Holiday 2024\\beach.mkv"')).toBe(
      'saved to "<path>.mkv"'
    )
  })

  it('reduces an UNC path to an extension', () => {
    expect(redact('open \\\\nas\\share\\Private\\bills.pdf')).toBe(
      'open <path>.pdf'
    )
  })

  it('reduces a POSIX path to an extension', () => {
    expect(redact('missing /home/ada/private/report.pdf')).toBe(
      'missing <path>.pdf'
    )
  })

  it('replaces a folder name that has no extension at all', () => {
    expect(redact('cannot create C:\\SecretFolder\\')).toBe('cannot create <path>')
  })

  it('leaves ordinary prose and short relative names alone', () => {
    expect(redact('aria2 exited with code 1; the request timed out')).toBe(
      'aria2 exited with code 1; the request timed out'
    )
    expect(redact('sha256 3f2a9c: mismatch')).toBe('sha256 3f2a9c: mismatch')
  })
})

describe('redact: cookies, tokens and headers', () => {
  it('redacts credential-shaped query parameters without a scheme', () => {
    expect(redact('retry?token=abc123&sig=deadbeef&x=1')).toBe(
      'retry?token=[redacted]&sig=[redacted]&x=1'
    )
  })

  it('redacts an Authorization header value', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe(
      'Authorization: [redacted]'
    )
  })

  it('redacts a Cookie header and everything after it', () => {
    expect(redact('Cookie: SID=abc; CSRF=xyz')).toBe('Cookie: [redacted]')
  })

  it('redacts bearer tokens mentioned in prose', () => {
    expect(redact('sent bearer abcdefghijkl to the bridge')).toBe(
      'sent bearer [redacted] to the bridge'
    )
  })

  it('redacts API-key style environment assignments', () => {
    expect(redact('DONDOWNLOAD_API_TOKEN=supersecretvalue')).toBe(
      'DONDOWNLOAD_API_TOKEN=[redacted]'
    )
  })

  it('redacts a bare secret name with no prefix', () => {
    // Regression: the name group used to require at least one character before
    // the keyword, so the most common exact names were never redacted.
    expect(redact('token=abc123 secret=hunter2 password=pw')).toBe(
      'token=[redacted] secret=[redacted] password=[redacted]'
    )
    expect(redact('api_key=abc123')).toBe('api_key=[redacted]')
    expect(redact('apikey: abc123')).toBe('apikey: [redacted]')
    // A Cookie-shaped name is caught by the header rule first; the value is
    // redacted either way.
    expect(redact('auth-cookie=abc123')).toBe('auth-cookie: [redacted]')
  })

  it('redacts long opaque tokens', () => {
    const blob = 'a'.repeat(48)
    expect(redact(`value ${blob} end`)).toBe('value [redacted] end')
  })

  it('redacts injected secret values anywhere in the text', () => {
    expect(
      redact('proxy failed for hunter2-password', {
        secretValues: ['hunter2-password']
      })
    ).toBe('proxy failed for [redacted]')
  })
})

describe('redact: shape', () => {
  it('collapses multi-line input into one record', () => {
    const input =
      'first' +
      String.fromCharCode(10) +
      'second' +
      String.fromCharCode(13, 10) +
      'third'
    expect(redact(input)).toBe(`first${SEP}second${SEP}third`)
  })

  it('never throws and never echoes input on an internal failure', () => {
    const hostile = {
      replace: () => {
        throw new Error('boom')
      }
    }
    expect(redact(hostile as unknown as string)).toBe(
      '[log entry could not be redacted]'
    )
  })

  it('is idempotent for already redacted text', () => {
    const once = redact(`${PROFILE}\\x https://example.com/a?token=1`, OPTIONS)
    expect(redact(once, OPTIONS)).toBe(once)
  })
})

describe('formatLogMessage', () => {
  it('fills printf placeholders with redacted arguments', () => {
    expect(
      formatLogMessage('tool %s exited with code %d', ['yt-dlp', 1], OPTIONS)
    ).toBe('tool yt-dlp exited with code 1')
  })

  it('redacts arguments that are URLs or paths', () => {
    expect(
      formatLogMessage('fetch %s', ['https://example.com/private?k=v'], OPTIONS)
    ).toBe('fetch https://example.com/')
    expect(formatLogMessage('open %s', [`${PROFILE}\\a\\b.mkv`], OPTIONS)).toBe(
      'open %USERPROFILE%\\a\\b.mkv'
    )
  })

  it('appends leftover arguments instead of dropping them', () => {
    expect(formatLogMessage('done', ['https://example.com/x'], OPTIONS)).toBe(
      'done https://example.com/'
    )
  })
})

describe('stringify / errorLine', () => {
  it('keeps the error name, code and message only', () => {
    const error = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED'
    })
    expect(errorLine(error)).toBe('Error [ECONNREFUSED]: connection refused')
  })

  it('formats primitives without throwing on cycles', () => {
    expect(stringify(null)).toBe('null')
    expect(stringify(undefined)).toBe('undefined')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stringify(cyclic)).toBe('[object Object]')
  })
})
