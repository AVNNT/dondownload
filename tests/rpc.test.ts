import { describe, expect, it } from 'vitest'
import {
  aria2ErrorHint,
  aria2FailureDetail,
  buildRpcRequest,
  describeAria2Failure,
  mapAria2Status,
  parseAria2Status,
  parseRpcResponse
} from '../src/main/aria2/rpc'

describe('buildRpcRequest', () => {
  it('places the token first and stringifies the JSON-RPC id', () => {
    const request = buildRpcRequest(7, 'aria2.addUri', 'secret-token', [
      ['https://example.com/file.zip'],
      { dir: 'C:\\Downloads' }
    ])

    expect(request).toEqual({
      jsonrpc: '2.0',
      id: '7',
      method: 'aria2.addUri',
      params: [
        'token:secret-token',
        ['https://example.com/file.zip'],
        { dir: 'C:\\Downloads' }
      ]
    })
  })
})

describe('parseRpcResponse', () => {
  it('returns a valid result', () => {
    expect(
      parseRpcResponse({ jsonrpc: '2.0', id: '1', result: { gid: '0123456789abcdef' } })
    ).toEqual({ ok: true, result: { gid: '0123456789abcdef' } })
  })

  it('returns aria2 error details', () => {
    expect(
      parseRpcResponse({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 3, message: 'Resource not found' }
      })
    ).toEqual({ ok: false, code: 3, message: 'Resource not found' })
  })

  it.each([
    null,
    [],
    'string',
    { id: '1' },
    { id: '1', error: 'bad error' }
  ])('rejects malformed envelopes: %j', (payload) => {
    const result = parseRpcResponse(payload)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0)
    }
  })
})

describe('parseAria2Status', () => {
  it('normalises numeric strings and file entries', () => {
    const status = parseAria2Status({
      gid: '0123456789abcdef',
      status: 'active',
      dir: 'C:\\Downloads\\DonDownload',
      totalLength: '1000',
      completedLength: '250',
      downloadSpeed: '125',
      errorCode: '0',
      errorMessage: '',
      files: [
        {
          path: 'C:\\Downloads\\DonDownload\\file.zip',
          length: '1000',
          completedLength: '250'
        }
      ]
    })

    expect(status.totalLength).toBe(1000)
    expect(status.completedLength).toBe(250)
    expect(status.downloadSpeed).toBe(125)
    expect(status.files[0]?.path).toBe('C:\\Downloads\\DonDownload\\file.zip')
  })

  it('rejects malformed status payloads', () => {
    expect(() => parseAria2Status(null)).toThrow()
    expect(() => parseAria2Status({ status: 'active' })).toThrow()
    expect(() => parseAria2Status({ gid: 'not-a-gid', status: 'active' })).toThrow()
  })
})

describe('status mapping', () => {
  it.each([
    ['active', 'active'],
    ['waiting', 'waiting'],
    ['paused', 'paused'],
    ['complete', 'complete'],
    ['error', 'error'],
    ['removed', 'error'],
    ['unknown-state', 'queued']
  ])('maps %s to %s', (input, expected) => {
    expect(mapAria2Status(input)).toBe(expected)
  })
})

describe('failure descriptions', () => {
  it('maps known aria2 error codes to plain-language hints', () => {
    expect(aria2ErrorHint(2)).toBe('The server stopped responding.')
    expect(aria2ErrorHint(5)).toBe('The download got too slow and was stopped.')
    expect(aria2ErrorHint(6)).toBe('The connection was interrupted.')
    expect(aria2ErrorHint(22)).toBe('The server sent a broken response.')
    expect(aria2ErrorHint(3)).toBe("The file isn't on the server (anymore).")
    expect(aria2ErrorHint(4)).toBe("The file isn't on the server (anymore).")
    expect(aria2ErrorHint(9)).toBe('Not enough free disk space.')
    expect(aria2ErrorHint(24)).toBe('This file needs a sign-in.')
    expect(aria2ErrorHint(19)).toMatch(/couldn't find that website/i)
    expect(aria2ErrorHint(999)).toBe("The download couldn't finish.")
    expect(aria2ErrorHint(1)).toBe("The download couldn't finish.")
  })

  it('does not leak the raw aria2 message into the user-facing text', () => {
    expect(describeAria2Failure(13, 'File already exists')).toBe(
      'A file with this name already exists. Choose a different name.'
    )
    expect(describeAria2Failure(999, 'Timeout.')).toBe(
      "The download couldn't finish."
    )
    expect(describeAria2Failure(22, 'No URI available.')).toBe(
      'The server sent a broken response.'
    )
  })

  it('maps generic codes to a matching hint from the raw message', () => {
    expect(describeAria2Failure(1, 'Timeout.')).toBe(
      'The server stopped responding.'
    )
    expect(describeAria2Failure(0, 'No URI available.')).toBe(
      'The server sent a broken response.'
    )
    expect(describeAria2Failure(1, 'Some unknown failure')).toBe(
      "The download couldn't finish."
    )
  })

  it('keeps the raw aria2 detail separately', () => {
    expect(aria2FailureDetail(13, 'File already exists')).toBe(
      'aria2 code 13: File already exists'
    )
    expect(aria2FailureDetail(13, '  ')).toBe('aria2 code 13')
  })
})
