import { afterEach, describe, expect, it, vi } from 'vitest'
import { Aria2Client } from '../src/main/aria2/client'
import { AppError } from '../src/main/errors'

function respondWith(
  status: number,
  body: string
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status }))
  )
}

async function callError(): Promise<unknown> {
  const client = new Aria2Client(6800, 'secret')
  try {
    await client.call('aria2.tellStatus', ['0123456789abcdef'])
  } catch (error) {
    return error
  }
  throw new Error('The call unexpectedly succeeded.')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Aria2Client error responses', () => {
  it('keeps the aria2 message when the RPC failure arrives as HTTP 400', async () => {
    // aria2 answers JSON-RPC failures with HTTP 400 plus a JSON error body.
    respondWith(
      400,
      JSON.stringify({
        id: '1',
        jsonrpc: '2.0',
        error: { code: 1, message: 'GID 0123456789abcdef is not found' }
      })
    )

    const error = await callError()

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('ARIA2_RPC_ERROR')
    expect((error as AppError).message).toBe(
      'GID 0123456789abcdef is not found'
    )
  })

  it('keeps the aria2 message for an HTTP 200 JSON-RPC error', async () => {
    respondWith(
      200,
      JSON.stringify({
        id: '1',
        jsonrpc: '2.0',
        error: { code: 1, message: 'Unauthorized' }
      })
    )

    const error = await callError()

    expect((error as AppError).message).toBe('Unauthorized')
  })

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    respondWith(500, 'Internal Server Error')

    const error = await callError()

    expect((error as AppError).code).toBe('ARIA2_RPC_ERROR')
    expect((error as AppError).message).toBe('aria2 RPC failed with HTTP 500.')
  })

  it('returns the result for a normal response', async () => {
    respondWith(200, JSON.stringify({ id: '1', jsonrpc: '2.0', result: 'ok' }))

    const client = new Aria2Client(6800, 'secret')

    await expect(client.call('aria2.getVersion')).resolves.toBe('ok')
  })
})
