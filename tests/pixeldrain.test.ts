import { describe, expect, it } from 'vitest'
import { parseCollectionPreview } from '../src/shared/batches'
import {
  DEFAULT_PIXELDRAIN_TIMEOUT_MS,
  MAX_PIXELDRAIN_LIST_FILES,
  PIXELDRAIN_API_BASE,
  PIXELDRAIN_ORIGIN,
  PixeldrainError,
  createPixeldrainAdapter,
  parsePixeldrainLink,
  parsePixeldrainUrl,
  resolvePixeldrainFile,
  resolvePixeldrainLink,
  resolvePixeldrainList,
  type PixeldrainFetch
} from '../src/main/hosts/pixeldrain'

const FILE_ID = 'AbC_12'
const FILE_LINK = `${PIXELDRAIN_ORIGIN}/u/${FILE_ID}`
const LIST_ID = 'L8bhwx'
const LIST_LINK = `${PIXELDRAIN_ORIGIN}/l/${LIST_ID}`

interface RecordedCall {
  url: string
  init: RequestInit
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): { fetch: PixeldrainFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return handler(url, init)
    }
  }
}

function jsonResponse(
  payload: unknown,
  options: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...options.headers
    }
  })
}

function textResponse(
  body: string,
  options: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body, {
    status: options.status ?? 200,
    headers: options.headers
  })
}

function fileInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    id: FILE_ID,
    name: 'example-video.mp4',
    size: 12_345_678,
    mime_type: 'video/mp4',
    date_upload: '2020-02-04T18:34:05.706801Z',
    availability: '',
    availability_message: '',
    can_download: true,
    ...overrides
  }
}

function listFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    id: '_SqVWi',
    name: '01 Song.mp3',
    size: 123_456,
    mime_type: 'audio/mpeg',
    availability: '',
    availability_message: '',
    can_download: true,
    ...overrides
  }
}

function listResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const files = [
    listFile(),
    listFile({ id: 'RKwgZb', name: '02 Hangar 18.mp3' }),
    listFile({ id: 'DRaL_e', name: '03 Take No Prisoners.mp3' })
  ]
  return {
    success: true,
    id: LIST_ID,
    title: 'Rust in Peace',
    date_created: '2020-02-04T18:34:13.466276Z',
    file_count: files.length,
    can_edit: false,
    files,
    ...overrides
  }
}

async function expectErrorCode(
  action: (() => Promise<unknown>) | Promise<unknown>,
  code: string
): Promise<PixeldrainError> {
  const promise = typeof action === 'function' ? action() : action
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PixeldrainError)
    expect((error as PixeldrainError).code).toBe(code)
    return error as PixeldrainError
  }
  throw new Error(`Expected ${code}`)
}

function expectParseError(value: unknown): void {
  try {
    parsePixeldrainLink(value)
  } catch (error) {
    expect(error).toBeInstanceOf(PixeldrainError)
    expect((error as PixeldrainError).code).toBe('PIXELDRAIN_INVALID_LINK')
    return
  }
  throw new Error(`Expected an invalid link: ${String(value)}`)
}

describe('Pixeldrain public link parsing', () => {
  it('accepts canonical public file and list links only', () => {
    expect(parsePixeldrainLink(FILE_LINK)).toEqual({
      kind: 'file',
      id: FILE_ID,
      sourceUrl: FILE_LINK
    })
    expect(parsePixeldrainLink(`${FILE_LINK}/`)).toEqual({
      kind: 'file',
      id: FILE_ID,
      sourceUrl: FILE_LINK
    })
    expect(parsePixeldrainLink(LIST_LINK)).toEqual({
      kind: 'list',
      id: LIST_ID,
      sourceUrl: LIST_LINK
    })
    expect(parsePixeldrainUrl(` ${LIST_LINK} `)).toEqual({
      kind: 'list',
      id: LIST_ID,
      sourceUrl: LIST_LINK
    })
  })

  it('rejects non-canonical hosts, schemes, paths and query data', () => {
    for (const value of [
      '',
      'not a url',
      `http://pixeldrain.com/u/${FILE_ID}`,
      `https://www.pixeldrain.com/u/${FILE_ID}`,
      `https://pixeldra.in/u/${FILE_ID}`,
      `https://pixeldrain.com:443/u/${FILE_ID}`,
      `https://user:secret@pixeldrain.com/u/${FILE_ID}`,
      `https://pixeldrain.com/api/file/${FILE_ID}`,
      `https://pixeldrain.com/api/file/${FILE_ID}/info`,
      `https://pixeldrain.com/d/${FILE_ID}`,
      `https://pixeldrain.com/u/${FILE_ID}/extra`,
      `https://pixeldrain.com/u/${FILE_ID}?download`,
      `https://pixeldrain.com/u/${FILE_ID}#fragment`,
      `https://pixeldrain.com/u/${FILE_ID}%2Fextra`,
      'https://pixeldrain.com/u/abc',
      'https://pixeldrain.com/u/abc.def',
      'https://pixeldrain.com/l/',
      `https://pixeldrain.com/l/${'a'.repeat(33)}`,
      `https://pixeldrain.com/u/${FILE_ID}\u0000`
    ]) {
      expectParseError(value)
    }
    expectParseError(undefined)
    expectParseError(42)
  })

  it('never calls the injected fetch for an invalid link', async () => {
    const mock = mockFetch(() => jsonResponse(fileInfo()))

    await expectErrorCode(
      resolvePixeldrainLink(`https://example.com/u/${FILE_ID}`, {
        fetch: mock.fetch
      }),
      'PIXELDRAIN_INVALID_LINK'
    )
    expect(mock.calls).toHaveLength(0)
  })

  it('does not treat a list link as a single file or vice versa', async () => {
    const mock = mockFetch(() => jsonResponse(fileInfo()))

    await expectErrorCode(
      resolvePixeldrainFile(LIST_LINK, { fetch: mock.fetch }),
      'PIXELDRAIN_INVALID_LINK'
    )
    await expectErrorCode(
      resolvePixeldrainList(FILE_LINK, { fetch: mock.fetch }),
      'PIXELDRAIN_INVALID_LINK'
    )
    expect(mock.calls).toHaveLength(0)
  })
})

describe('Pixeldrain single file resolution', () => {
  it('requests only documented file info and returns the raw endpoint URL', async () => {
    const mock = mockFetch(() => jsonResponse(fileInfo()))

    const resolved = await resolvePixeldrainFile(FILE_LINK, {
      fetch: mock.fetch
    })

    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]?.url).toBe(
      `${PIXELDRAIN_API_BASE}/file/${FILE_ID}/info`
    )
    expect(mock.calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit'
    })
    const headers = new Headers(mock.calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('range')).toBeNull()
    expect(mock.calls[0]?.init.signal).toBeInstanceOf(AbortSignal)

    expect(resolved).toEqual({
      kind: 'file',
      fileId: FILE_ID,
      name: 'example-video.mp4',
      size: 12_345_678,
      mimeType: 'video/mp4',
      sourceUrl: FILE_LINK,
      downloadUrl: `${PIXELDRAIN_API_BASE}/file/${FILE_ID}`
    })
    expect(resolved.downloadUrl).not.toContain('?')
  })

  it('sanitizes provider file names without exposing paths', async () => {
    const mock = mockFetch(() =>
      jsonResponse(fileInfo({ name: '../../etc/passwd' }))
    )

    const resolved = await resolvePixeldrainFile(FILE_LINK, {
      fetch: mock.fetch
    })

    expect(resolved.name).not.toContain('/')
    expect(resolved.name).not.toContain('\\')
    expect(resolved.name).not.toBe('')
    expect(resolved.name).not.toBe('..')
  })

  it('uses the adapter factory with its injected fetch defaults', async () => {
    const mock = mockFetch(() => jsonResponse(fileInfo()))
    const adapter = createPixeldrainAdapter({ fetch: mock.fetch })

    expect(adapter.parseLink(FILE_LINK)).toMatchObject({ kind: 'file' })
    const resolved = await adapter.resolveFile(FILE_LINK)
    expect(resolved.fileId).toBe(FILE_ID)
    expect(mock.calls).toHaveLength(1)
  })

  it('rejects malformed, mismatched and unsafe file metadata', async () => {
    for (const payload of [
      fileInfo({ id: 'Other1' }),
      fileInfo({ name: '' }),
      fileInfo({ name: 'x'.repeat(256) }),
      fileInfo({ name: 'bad\u0000name.mp4' }),
      fileInfo({ size: -1 }),
      fileInfo({ size: 1.5 }),
      fileInfo({ size: Number.MAX_SAFE_INTEGER + 1 }),
      fileInfo({ mime_type: 42 }),
      fileInfo({ availability: 42 }),
      fileInfo({ availability: 'not a code' }),
      fileInfo({ can_download: 'yes' }),
      fileInfo({ success: 'yes' })
    ]) {
      const mock = mockFetch(() => jsonResponse(payload))
      await expectErrorCode(
        resolvePixeldrainFile(FILE_LINK, { fetch: mock.fetch }),
        'PIXELDRAIN_INVALID_RESPONSE'
      )
    }
  })

  it('rejects malformed JSON, wrong content types and oversized bodies', async () => {
    const malformed = mockFetch(() => textResponse('{'))
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: malformed.fetch }),
      'PIXELDRAIN_INVALID_RESPONSE'
    )

    const html = mockFetch(() =>
      textResponse('<html>not json</html>', {
        headers: { 'content-type': 'text/html' }
      })
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: html.fetch }),
      'PIXELDRAIN_INVALID_RESPONSE'
    )

    const oversized = mockFetch(() =>
      jsonResponse(fileInfo({ name: 'x'.repeat(200) }))
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, {
        fetch: oversized.fetch,
        maxResponseBytes: 64
      }),
      'PIXELDRAIN_RESPONSE_TOO_LARGE'
    )
  })

  it('does not download the file body', async () => {
    const mock = mockFetch(() => jsonResponse(fileInfo()))

    await resolvePixeldrainFile(FILE_LINK, { fetch: mock.fetch })

    expect(mock.calls.map((call) => call.url)).toEqual([
      `${PIXELDRAIN_API_BASE}/file/${FILE_ID}/info`
    ])
  })
})

describe('Pixeldrain public list preview', () => {
  it('builds an opaque renderer-safe preview and internal entry metadata', async () => {
    const mock = mockFetch(() =>
      jsonResponse(
        listResponse({
          files: [
            listFile(),
            listFile({
              id: 'RKwgZb',
              name: '02 Hangar 18.mp3',
              availability: 'file_rate_limited_captcha_required'
            }),
            listFile({
              id: 'DRaL_e',
              name: '03 Take No Prisoners.mp3',
              can_download: false
            })
          ],
          file_count: 3
        })
      )
    )

    const resolved = await resolvePixeldrainList(LIST_LINK, {
      fetch: mock.fetch
    })

    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]?.url).toBe(
      `${PIXELDRAIN_API_BASE}/list/${LIST_ID}`
    )
    expect(mock.calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'manual'
    })

    expect(resolved.kind).toBe('list')
    expect(resolved.listId).toBe(LIST_ID)
    expect(resolved.sourceUrl).toBe(LIST_LINK)
    expect(resolved.title).toBe('Rust in Peace')

    const preview = resolved.preview
    expect(preview.kind).toBe('pixeldrain-list')
    expect(preview.title).toBe('Rust in Peace')
    expect(preview.entryCount).toBe(3)
    expect(preview.availableCount).toBe(1)
    expect(preview.unavailableCount).toBe(2)
    expect(preview.entries.map((entry) => entry.position)).toEqual([0, 1, 2])
    expect(preview.entries[0]).toMatchObject({
      title: '01 Song.mp3',
      availability: 'available',
      errorCode: null,
      errorReason: null
    })
    expect(preview.entries[1]).toMatchObject({
      title: '02 Hangar 18.mp3',
      availability: 'unavailable',
      errorCode: 'unsupported'
    })
    expect(preview.entries[2]).toMatchObject({
      title: '03 Take No Prisoners.mp3',
      availability: 'unavailable',
      errorCode: 'private'
    })

    expect(preview.id).toMatch(/^colprev_[A-Za-z0-9]+$/)
    for (const entry of preview.entries) {
      expect(entry.id).toMatch(/^colentry_[A-Za-z0-9]+$/)
      expect(entry.id).not.toContain('_SqVWi')
      expect(entry.id).not.toContain('RKwgZb')
      expect(entry.id).not.toContain('DRaL_e')
    }
    expect(() => parseCollectionPreview(preview)).not.toThrow()

    expect(resolved.entries).toHaveLength(3)
    expect(resolved.entries[0]).toMatchObject({
      entryId: preview.entries[0]?.id,
      position: 0,
      fileId: '_SqVWi',
      name: '01 Song.mp3',
      size: 123_456,
      mimeType: 'audio/mpeg',
      sourceUrl: `${PIXELDRAIN_ORIGIN}/u/_SqVWi`,
      downloadUrl: `${PIXELDRAIN_API_BASE}/file/_SqVWi`,
      availability: 'available'
    })
    expect(resolved.entries[1]?.downloadUrl).toBeNull()
    expect(resolved.entries[1]?.errorReason).toContain('CAPTCHA')
    expect(resolved.entries[2]?.downloadUrl).toBeNull()
    expect(resolved.entries[2]?.errorReason).not.toMatch(/https?:\/\//)
    expect(JSON.stringify(preview)).not.toContain('RKwgZb')
    expect(JSON.stringify(preview)).not.toContain(PIXELDRAIN_ORIGIN)
  })

  it('keeps list entries as preview/selection data and never queues them', async () => {
    const mock = mockFetch(() => jsonResponse(listResponse()))
    const resolved = await resolvePixeldrainList(LIST_LINK, {
      fetch: mock.fetch
    })

    expect(Object.keys(resolved).sort()).toEqual([
      'entries',
      'kind',
      'listId',
      'preview',
      'sourceUrl',
      'title'
    ])
    expect(resolved.preview.entries).toHaveLength(3)
    expect(resolved.entries).toHaveLength(3)
    expect(mock.calls).toHaveLength(1)
  })

  it('marks legal takedowns and provider errors as independent unavailable entries', async () => {
    const mock = mockFetch(() =>
      jsonResponse(
        listResponse({
          files: [
            listFile({ id: 'Legal1', availability: 'unavailable_for_legal_reasons' }),
            listFile({ id: 'Gone11', success: false, value: 'not_found' }),
            listFile({ id: 'Rate11', availability: 'transfer_limit_exceeded' })
          ],
          file_count: 3
        })
      )
    )

    const resolved = await resolvePixeldrainList(LIST_LINK, {
      fetch: mock.fetch
    })

    expect(resolved.preview.availableCount).toBe(0)
    expect(resolved.preview.unavailableCount).toBe(3)
    expect(resolved.preview.entries.map((entry) => entry.errorCode)).toEqual([
      'removed',
      'removed',
      'unavailable'
    ])
    for (const entry of resolved.entries) {
      expect(entry.downloadUrl).toBeNull()
    }
    expect(resolved.entries[1]?.sourceUrl).toBe(
      `${PIXELDRAIN_ORIGIN}/u/Gone11`
    )
    expect(JSON.stringify(resolved.preview)).not.toContain('Gone11')
  })

  it('sanitizes and bounds list titles and entry names', async () => {
    const mock = mockFetch(() =>
      jsonResponse(
        listResponse({
          title: '  A   list\nwith\tcontrol  ',
          files: [listFile({ name: '../../escape\\name.mp3' })],
          file_count: 1
        })
      )
    )

    const resolved = await resolvePixeldrainList(LIST_LINK, {
      fetch: mock.fetch
    })

    expect(resolved.title).toBe('A list with control')
    expect(resolved.preview.title).toBe('A list with control')
    expect(resolved.preview.entries[0]?.title).not.toContain('/')
    expect(resolved.preview.entries[0]?.title).not.toContain('\\')

    const longTitle = mockFetch(() =>
      jsonResponse(listResponse({ title: 'x'.repeat(301) }))
    )
    await expectErrorCode(
      resolvePixeldrainList(LIST_LINK, { fetch: longTitle.fetch }),
      'PIXELDRAIN_INVALID_RESPONSE'
    )
  })

  it('accepts 500 files and rejects lists above the adapter bound', async () => {
    const files = Array.from(
      { length: MAX_PIXELDRAIN_LIST_FILES },
      (_, index) =>
        listFile({
          id: `f${index.toString().padStart(4, '0')}`,
          name: `file-${index}.bin`
        })
    )
    const accepted = mockFetch(() =>
      jsonResponse(
        listResponse({ files, file_count: MAX_PIXELDRAIN_LIST_FILES })
      )
    )

    const resolved = await resolvePixeldrainList(LIST_LINK, {
      fetch: accepted.fetch
    })
    expect(resolved.preview.entryCount).toBe(MAX_PIXELDRAIN_LIST_FILES)
    expect(resolved.entries).toHaveLength(MAX_PIXELDRAIN_LIST_FILES)

    const tooManyFiles = [
      ...files,
      listFile({ id: 'extra1', name: 'extra.bin' })
    ]
    const rejected = mockFetch(() =>
      jsonResponse(
        listResponse({ files: tooManyFiles, file_count: tooManyFiles.length })
      )
    )
    await expectErrorCode(
      resolvePixeldrainList(LIST_LINK, { fetch: rejected.fetch }),
      'PIXELDRAIN_TOO_MANY_FILES'
    )
  })

  it('rejects malformed and inconsistent list responses', async () => {
    for (const payload of [
      listResponse({ id: 'OtherID' }),
      listResponse({ file_count: 4 }),
      listResponse({ files: [listFile({ size: 'large' })], file_count: 1 }),
      listResponse({ files: [listFile({ id: 'bad.id' })], file_count: 1 }),
      listResponse({ files: [listFile({ name: '' })], file_count: 1 }),
      listResponse({ files: [listFile({ success: false, size: 'oops' })], file_count: 1 }),
      listResponse({ files: 'not-an-array' }),
      listResponse({ title: 42 }),
      listResponse({ file_count: -1 })
    ]) {
      const mock = mockFetch(() => jsonResponse(payload))
      await expectErrorCode(
        resolvePixeldrainList(LIST_LINK, { fetch: mock.fetch }),
        'PIXELDRAIN_INVALID_RESPONSE'
      )
    }

    const oversized = mockFetch(() =>
      jsonResponse(listResponse({ title: 'x'.repeat(200) }))
    )
    await expectErrorCode(
      resolvePixeldrainList(LIST_LINK, {
        fetch: oversized.fetch,
        maxResponseBytes: 64
      }),
      'PIXELDRAIN_RESPONSE_TOO_LARGE'
    )
  })

  it('returns an empty preview for an empty list response', async () => {
    const mock = mockFetch(() =>
      jsonResponse(listResponse({ files: [], file_count: 0 }))
    )

    const resolved = await resolvePixeldrainList(LIST_LINK, {
      fetch: mock.fetch
    })

    expect(resolved.preview.entryCount).toBe(0)
    expect(resolved.preview.availableCount).toBe(0)
    expect(resolved.preview.unavailableCount).toBe(0)
    expect(resolved.entries).toEqual([])
  })
})

describe('Pixeldrain redirects and provider failures', () => {
  it('refuses redirects instead of following them', async () => {
    const redirect = mockFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/file' }
        })
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: redirect.fetch }),
      'PIXELDRAIN_REDIRECT_REFUSED'
    )
    expect(redirect.calls).toHaveLength(1)

    const redirectedResponse = jsonResponse(fileInfo())
    Object.defineProperty(redirectedResponse, 'redirected', { value: true })
    const redirected = mockFetch(() => redirectedResponse)
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: redirected.fetch }),
      'PIXELDRAIN_REDIRECT_REFUSED'
    )
    expect(redirected.calls).toHaveLength(1)
  })

  it('distinguishes rate limiting from other 403/429 responses', async () => {
    const rateLimited = mockFetch(() =>
      jsonResponse(
        {
          success: false,
          value: 'ip_rate_limit_reached',
          message: 'raw provider message with https://pixeldrain.com/private'
        },
        { status: 429 }
      )
    )
    const error = await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: rateLimited.fetch }),
      'PIXELDRAIN_RATE_LIMITED'
    )
    expect(error.message).not.toContain('raw provider message')
    expect(error.message).not.toContain('https://')
    expect(rateLimited.calls).toHaveLength(1)
  })

  it('reports CAPTCHA and hotlink restrictions without retrying or bypassing', async () => {
    const captcha = mockFetch(() =>
      jsonResponse(
        {
          success: false,
          value: 'file_rate_limited_captcha_required',
          message: 'complete the captcha at https://pixeldrain.com/u/secret'
        },
        { status: 403 }
      )
    )
    const captchaError = await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: captcha.fetch }),
      'PIXELDRAIN_CAPTCHA_REQUIRED'
    )
    expect(captchaError.message).toContain('CAPTCHA')
    expect(captchaError.message).not.toContain('https://')
    expect(captcha.calls).toHaveLength(1)

    const hotlink = mockFetch(() =>
      jsonResponse(
        {
          success: false,
          value: 'hotlink_detected',
          message: 'premium required'
        },
        { status: 403 }
      )
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: hotlink.fetch }),
      'PIXELDRAIN_HOTLINK_REQUIRED'
    )
    expect(hotlink.calls).toHaveLength(1)
  })

  it('maps not found, legal takedown, private and server failures truthfully', async () => {
    const cases: Array<[number, string | null, string]> = [
      [404, 'not_found', 'PIXELDRAIN_NOT_FOUND'],
      [451, 'unavailable_for_legal_reasons', 'PIXELDRAIN_UNAVAILABLE'],
      [401, 'authentication_required', 'PIXELDRAIN_PRIVATE'],
      [403, 'forbidden', 'PIXELDRAIN_PRIVATE'],
      [500, 'internal', 'PIXELDRAIN_SERVER_ERROR'],
      [400, 'invalid_endpoint', 'PIXELDRAIN_UNSUPPORTED']
    ]

    for (const [status, value, code] of cases) {
      const mock = mockFetch(() =>
        jsonResponse(
          { success: false, value, message: 'raw provider error text' },
          { status }
        )
      )
      const error = await expectErrorCode(
        resolvePixeldrainFile(FILE_LINK, { fetch: mock.fetch }),
        code
      )
      expect(error.message).not.toContain('raw provider error text')
      expect(error.httpStatus).toBe(status)
      expect(mock.calls).toHaveLength(1)
    }
  })

  it('treats a 200 success:false response as an error', async () => {
    const mock = mockFetch(() =>
      jsonResponse({ success: false, value: 'not_found', message: 'gone' })
    )

    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: mock.fetch }),
      'PIXELDRAIN_NOT_FOUND'
    )
  })

  it('maps provider availability on a single file instead of returning a URL', async () => {
    const captcha = mockFetch(() =>
      jsonResponse(
        fileInfo({
          availability: 'file_rate_limited_captcha_required',
          availability_message: 'Complete the captcha'
        })
      )
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: captcha.fetch }),
      'PIXELDRAIN_CAPTCHA_REQUIRED'
    )

    const legal = mockFetch(() =>
      jsonResponse(
        fileInfo({ availability: 'unavailable_for_legal_reasons' })
      )
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: legal.fetch }),
      'PIXELDRAIN_UNAVAILABLE'
    )

    const privateFile = mockFetch(() =>
      jsonResponse(fileInfo({ can_download: false }))
    )
    await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: privateFile.fetch }),
      'PIXELDRAIN_PRIVATE'
    )
  })

  it('reports network errors and timeouts without raw error text', async () => {
    const network = mockFetch(() => {
      throw new Error('connect ECONNREFUSED https://pixeldrain.com/secret')
    })
    const networkError = await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, { fetch: network.fetch }),
      'PIXELDRAIN_NETWORK_ERROR'
    )
    expect(networkError.message).not.toContain('ECONNREFUSED')
    expect(networkError.message).not.toContain('https://')

    const hangingFetch: PixeldrainFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const timeout = await expectErrorCode(
      resolvePixeldrainFile(FILE_LINK, {
        fetch: hangingFetch,
        timeoutMs: 10
      }),
      'PIXELDRAIN_TIMEOUT'
    )
    expect(timeout.message).toBe('The request to Pixeldrain timed out.')
    expect(DEFAULT_PIXELDRAIN_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
