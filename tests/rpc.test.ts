import { describe, expect, it } from 'vitest'
import {
  aria2ErrorHint,
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
  it('maps known aria2 error codes to actionable hints', () => {
    expect(aria2ErrorHint(3)).toMatch(/could not find/i)
    expect(aria2ErrorHint(9)).toMatch(/disk space/i)
    expect(aria2ErrorHint(19)).toMatch(/host name/i)
    expect(aria2ErrorHint(999)).toMatch(/could not complete/i)
  })

  it('includes aria2 detail alongside the hint', () => {
    expect(describeAria2Failure(13, 'File already exists')).toContain(
      'already exists'
    )
    expect(describeAria2Failure(13, '')).toContain('aria2 code 13')
  })
})
