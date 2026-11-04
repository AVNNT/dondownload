import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_BRIDGE_BODY_BYTES,
  parseNativeBridgeEndpoint,
  parseNativeQueueMessage,
  parseQueueDownloadRequest
} from '../src/shared/nativeBridge'
import { ValidationError } from '../src/shared/validation'
import { AppError } from '../src/main/errors'
import {
  startNativeBridge,
  type BridgeDownloadManager,
  type NativeBridge
} from '../src/main/nativeBridge/server'

interface FakeManager extends BridgeDownloadManager {
  calls: unknown[]
  failWith: Error | null
  seen: Set<string>
}

function createManager(): FakeManager {
  const calls: unknown[] = []
  const seen = new Set<string>()
  return {
    calls,
    failWith: null,
    seen,
    async add(input: unknown): Promise<unknown> {
      calls.push(input)
      if (this.failWith) throw this.failWith
      const record = input as { url?: unknown; force?: unknown }
      const url = typeof record.url === 'string' ? record.url : ''
      if (record.force !== true && this.seen.has(url)) {
        throw new AppError(
          'DUPLICATE_DOWNLOAD',
          'This URL is already queued or downloading in DonDownload.'
        )
      }
      this.seen.add(url)
      return { accepted: true }
    }
  }
}

let tempDir = ''
let bridge: NativeBridge | null = null
let manager: FakeManager
let token = ''

async function start(): Promise<void> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-bridge-'))
  manager = createManager()
  bridge = await startNativeBridge({
    manager,
    userDataPath: tempDir,
    logger: () => undefined
  })
  const state = parseNativeBridgeEndpoint(
    JSON.parse(await readFile(bridge.statePath, 'utf8'))
  )
  token = state.token
}

afterEach(async () => {
  await bridge?.close()
  bridge = null
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

async function post(
  body: string,
  options: {
    authorization?: string | null
    contentType?: string | null
    origin?: string
    path?: string
    method?: string
  } = {}
): Promise<Response> {
  if (!bridge) throw new Error('Bridge is not started.')
  const headers: Record<string, string> = {}
  const authorization =
    options.authorization === undefined
      ? `Bearer ${token}`
      : options.authorization
  if (authorization !== null) headers.Authorization = authorization
  const contentType =
    options.contentType === undefined
      ? 'application/json'
      : options.contentType
  if (contentType !== null) headers['Content-Type'] = contentType
  if (options.origin) headers.Origin = options.origin

  return fetch(`http://127.0.0.1:${bridge.port}${options.path ?? '/queue-download'}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' ? undefined : body
  })
}

describe('native bridge endpoint state', () => {
  beforeEach(start)

  it('writes a per-user state file with a random token and removes it on close', async () => {
    expect(bridge).not.toBeNull()
    if (!bridge) return

    const state = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )
    expect(state.app).toBe('DonDownload')
    expect(state.version).toBe(1)
    expect(state.port).toBe(bridge.port)
    expect(state.port).toBeGreaterThan(0)
    expect(state.port).toBeLessThanOrEqual(65535)
    expect(state.token).toMatch(/^[0-9a-f]{64}$/)
    expect(state.pid).toBe(process.pid)

    await bridge.close()
    bridge = null
    await expect(readFile(path.join(tempDir, 'native-bridge.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('stops listening after close, so a stale host fails fast', async () => {
    if (!bridge) throw new Error('Bridge is not started.')
    const port = bridge.port
    await bridge.close()
    bridge = null

    await expect(fetch(`http://127.0.0.1:${port}/queue-download`, { method: 'POST' })).rejects.toThrow()
  })
})

describe('native bridge request handling', () => {
  beforeEach(start)

  it('accepts a validated URL through DownloadManager.add and strips the fragment', async () => {
    const response = await post(
      JSON.stringify({ url: '  https://example.com/files/app.zip#section  ' })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, accepted: true })
    expect(manager.calls).toEqual([{ url: 'https://example.com/files/app.zip' }])
  })

  it('reports a duplicate as non-success without accepted:true', async () => {
    const body = JSON.stringify({ url: 'https://example.com/same.zip' })
    const first = await post(body)
    const second = await post(body)

    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, accepted: true })

    expect(second.status).toBe(409)
    const duplicate = (await second.json()) as {
      ok: boolean
      accepted?: boolean
      error: { code: string }
    }
    expect(duplicate.ok).toBe(false)
    expect(duplicate.accepted).toBeUndefined()
    expect(duplicate.error.code).toBe('DUPLICATE_DOWNLOAD')
    expect(manager.calls).toHaveLength(2)
  })

  it('accepts the narrow force opt-in as an explicit second copy', async () => {
    const first = await post(
      JSON.stringify({ url: 'https://example.com/again.zip' })
    )
    const second = await post(
      JSON.stringify({ url: 'https://example.com/again.zip', force: true })
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, accepted: true })
    expect(manager.calls).toEqual([
      { url: 'https://example.com/again.zip' },
      { url: 'https://example.com/again.zip', force: true }
    ])
  })

  it('rejects concurrent identical requests without two accepted jobs', async () => {
    const body = JSON.stringify({ url: 'https://example.com/concurrent.zip' })
    const [first, second] = await Promise.all([post(body), post(body)])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    expect(manager.calls).toHaveLength(2)
  })

  it('rejects malformed JSON and invalid schemas without calling the manager', async () => {
    const malformed = await post('{not json')
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_JSON' }
    })

    for (const body of [
      JSON.stringify({ type: 'queue-download', url: 'https://example.com/a' }),
      JSON.stringify({ url: 7 }),
      JSON.stringify({ url: 'https://example.com/a', extra: true }),
      JSON.stringify({}),
      JSON.stringify([])
    ]) {
      const response = await post(body)
      expect(response.status).toBe(400)
      const result = (await response.json()) as { ok: boolean }
      expect(result.ok).toBe(false)
    }

    expect(manager.calls).toHaveLength(0)
  })

  it.each([
    'ftp://example.com/file.zip',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'https://user:password@example.com/file.zip',
    'not a url'
  ])('rejects unsupported URL %s', async (url) => {
    const response = await post(JSON.stringify({ url }))
    expect(response.status).toBe(400)
    const result = (await response.json()) as { ok: boolean; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('INVALID_INPUT')
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects missing and wrong bearer tokens', async () => {
    const missing = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      authorization: null
    })
    expect(missing.status).toBe(401)

    const wrong = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      authorization: `Bearer ${'0'.repeat(64)}`
    })
    expect(wrong.status).toBe(401)

    expect(manager.calls).toHaveLength(0)
  })

  it('rejects browser-originated requests', async () => {
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      origin: 'https://attacker.example'
    })
    expect(response.status).toBe(403)
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects non-JSON content types', async () => {
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      contentType: 'text/plain'
    })
    expect(response.status).toBe(415)
    expect(manager.calls).toHaveLength(0)
  })

  it('rejects an oversized payload safely', async () => {
    const oversized = JSON.stringify({
      url: `https://example.com/${'a'.repeat(MAX_BRIDGE_BODY_BYTES)}`
    })
    const response = await post(oversized)
    expect(response.status).toBe(413)
    expect(manager.calls).toHaveLength(0)
  })

  it('reports failure and not acceptance when the app cannot queue the download', async () => {
    manager.failWith = new AppError(
      'ARIA2_START_FAILED',
      'aria2 could not be started for this test.'
    )
    const response = await post(JSON.stringify({ url: 'https://example.com/a' }))
    expect(response.status).toBe(503)
    const result = (await response.json()) as {
      ok: boolean
      accepted?: boolean
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.accepted).toBeUndefined()
    expect(result.error.code).toBe('ARIA2_START_FAILED')
  })

  it('rejects unsupported methods and unknown routes', async () => {
    const wrongMethod = await post('', { method: 'GET' })
    expect(wrongMethod.status).toBe(405)

    const unknown = await post(JSON.stringify({ url: 'https://example.com/a' }), {
      path: '/other'
    })
    expect(unknown.status).toBe(404)
    expect(manager.calls).toHaveLength(0)
  })
})

describe('shared native bridge schemas', () => {
  it('accepts only the single queue-download operation with exactly type and url', () => {
    expect(
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com/file.zip#x'
      })
    ).toEqual({ type: 'queue-download', url: 'https://example.com/file.zip' })

    expect(() =>
      parseNativeQueueMessage({ type: 'open-window', url: 'https://example.com' })
    ).toThrow(ValidationError)
    expect(() =>
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com',
        command: 'calc.exe'
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseNativeQueueMessage({ type: 'queue-download', url: 'file:///C:/x' })
    ).toThrow(ValidationError)
  })

  it('accepts only an optional boolean force flag beyond the URL', () => {
    expect(
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com/a',
        force: true
      })
    ).toEqual({
      type: 'queue-download',
      url: 'https://example.com/a',
      force: true
    })
    expect(() =>
      parseNativeQueueMessage({
        type: 'queue-download',
        url: 'https://example.com/a',
        force: 'yes'
      })
    ).toThrow(ValidationError)
  })

  it('accepts only a url body and optional force flag for the loopback request', () => {
    expect(parseQueueDownloadRequest({ url: 'http://example.com/a' })).toEqual({
      url: 'http://example.com/a'
    })
    expect(
      parseQueueDownloadRequest({ url: 'https://example.com/a', force: true })
    ).toEqual({ url: 'https://example.com/a', force: true })
    expect(() =>
      parseQueueDownloadRequest({ url: 'https://example.com/a', filename: 'x.exe' })
    ).toThrow(ValidationError)
    expect(() => parseQueueDownloadRequest({ url: 'https://example.com', dir: 'C:\\' })).toThrow(
      ValidationError
    )
    expect(() =>
      parseQueueDownloadRequest({ url: 'https://example.com/a', force: 'yes' })
    ).toThrow(ValidationError)
  })
})
