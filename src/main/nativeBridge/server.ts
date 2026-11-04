import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { unlinkSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  MAX_BRIDGE_BODY_BYTES,
  NATIVE_BRIDGE_APP,
  NATIVE_BRIDGE_STATE_FILE,
  NATIVE_BRIDGE_VERSION,
  parseNativeBridgeEndpoint,
  parseQueueDownloadRequest,
  type NativeBridgeEndpoint
} from '@shared/nativeBridge'
import { ValidationError } from '@shared/validation'
import { AppError, toErrorInfo } from '../errors'

const BRIDGE_ROUTE = '/queue-download'
const LOOPBACK_ADDRESS = '127.0.0.1'

/** The only manager capability the bridge is allowed to use. */
export interface BridgeDownloadManager {
  add(input: unknown): Promise<unknown>
}

export interface NativeBridgeOptions {
  manager: BridgeDownloadManager
  /** Electron's per-user userData directory. */
  userDataPath: string
  logger?: (message: string) => void
}

export interface NativeBridge {
  readonly port: number
  readonly statePath: string
  close(): Promise<void>
}

class BodyError extends Error {
  readonly code: 'TOO_LARGE'

  constructor() {
    super('The bridge request body is too large.')
    this.name = 'BodyError'
    this.code = 'TOO_LARGE'
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  if (response.writableEnded) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  })
  response.end(body)
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {}
): void {
  sendJson(response, status, { ok: false, error: { code, message } }, extraHeaders)
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(header)
  const provided = match?.[1]
  if (!provided) return false

  const expected = Buffer.from(token, 'hex')
  const actual = Buffer.from(provided, 'hex')
  return (
    expected.length === actual.length &&
    expected.length > 0 &&
    timingSafeEqual(expected, actual)
  )
}

function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maximum) {
        fail(new BodyError())
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    request.on('error', (error) => fail(error))
    request.on('aborted', () => fail(new Error('The bridge request was aborted.')))
  })
}

async function writeEndpointFile(
  statePath: string,
  endpoint: NativeBridgeEndpoint
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(endpoint), {
    encoding: 'utf8',
    mode: 0o600
  })
  try {
    await fs.rename(temporaryPath, statePath)
  } catch {
    // Windows can refuse a replace-rename when the target exists. Removing the
    // stale file first is safe because this process is the only writer.
    await fs.rm(statePath, { force: true })
    await fs.rename(temporaryPath, statePath)
  }
}

function closeServer(server: Server): Promise<void> {
  const withConnections = server as Server & {
    closeAllConnections?: () => void
  }
  try {
    withConnections.closeAllConnections?.()
  } catch {
    // Best effort; server.close below still settles.
  }
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/**
 * Start the desktop side of the browser bridge. It listens only on loopback,
 * requires a per-launch random bearer token, and can do exactly one thing:
 * hand a validated HTTP(S) URL to DownloadManager.add. It never shows or
 * focuses the desktop window, never starts aria2 directly, and returns success
 * only after the manager has accepted the download.
 */
export async function startNativeBridge(
  options: NativeBridgeOptions
): Promise<NativeBridge> {
  const logger = options.logger ?? ((message: string) => console.error(message))
  const statePath = path.join(options.userDataPath, NATIVE_BRIDGE_STATE_FILE)
  const token = randomBytes(32).toString('hex')
  let closed = false

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const code =
        error instanceof AppError || error instanceof ValidationError
          ? error.code
          : 'INTERNAL_ERROR'
      // Never include the request payload or URL in diagnostics.
      logger(`Native bridge request failed (${code}).`)
      sendError(response, 500, 'INTERNAL_ERROR', 'The bridge request failed.')
    })
  })

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST') {
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Use POST.', {
        Allow: 'POST'
      })
      return
    }
    if (request.url !== BRIDGE_ROUTE) {
      sendError(response, 404, 'NOT_FOUND', 'Unknown bridge endpoint.')
      return
    }
    // Native messaging hosts are not web pages. Reject browser-originated
    // requests so a random web page cannot use loopback CSRF even if it learns
    // the port. The random token remains the primary authentication factor.
    if (
      request.headers.origin !== undefined ||
      request.headers['sec-fetch-site'] !== undefined
    ) {
      sendError(response, 403, 'ORIGIN_REJECTED', 'Browser origins are not accepted.')
      return
    }
    if (!bearerMatches(request.headers.authorization, token)) {
      sendError(response, 401, 'UNAUTHORIZED', 'The bridge token is invalid.')
      return
    }

    const contentType = request.headers['content-type']
    if (
      typeof contentType !== 'string' ||
      !/^application\/json\s*(?:;|$)/i.test(contentType)
    ) {
      sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.')
      return
    }

    const declaredLength = request.headers['content-length']
    if (declaredLength !== undefined) {
      const length = Number(declaredLength)
      if (!Number.isInteger(length) || length < 0) {
        sendError(response, 400, 'INVALID_LENGTH', 'Invalid content length.')
        return
      }
      if (length > MAX_BRIDGE_BODY_BYTES) {
        request.resume()
        sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'The bridge request is too large.')
        return
      }
    }

    let raw: Buffer
    try {
      raw = await readBody(request, MAX_BRIDGE_BODY_BYTES)
    } catch (error) {
      request.resume()
      if (error instanceof BodyError) {
        sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'The bridge request is too large.')
        return
      }
      sendError(response, 400, 'BAD_REQUEST', 'The bridge request could not be read.')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      sendError(response, 400, 'INVALID_JSON', 'The bridge request is not valid JSON.')
      return
    }

    let input: { url: string }
    try {
      input = parseQueueDownloadRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    try {
      // The existing manager path performs its own URL/input validation,
      // aria2 add, SQLite persistence and snapshot publication.
      await options.manager.add(input)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not queue a download (${info.code}).`)
      // A duplicate is an expected policy outcome, not an aria2 outage. The
      // response still carries no accepted flag, so the extension never claims
      // success and can offer its explicit Download again action.
      const status = info.code === 'DUPLICATE_DOWNLOAD' ? 409 : 503
      sendError(response, status, info.code, info.message)
      return
    }

    // Success is reported only after add() resolved.
    sendJson(response, 200, { ok: true, accepted: true })
  }

  server.requestTimeout = 5_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 1_000
  server.maxHeadersCount = 20
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LOOPBACK_ADDRESS, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    if (server.listening) {
      try {
        server.close()
      } catch {
        // The listener may already be gone.
      }
    }
    throw new AppError(
      'BRIDGE_START_FAILED',
      'The browser bridge port could not be opened.',
      'Another local service may be blocking loopback ports.'
    )
  }

  const address = server.address() as AddressInfo | null
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new AppError('BRIDGE_START_FAILED', 'The browser bridge port is invalid.')
  }

  const endpoint: NativeBridgeEndpoint = {
    app: NATIVE_BRIDGE_APP,
    version: NATIVE_BRIDGE_VERSION,
    port: address.port,
    token,
    pid: process.pid,
    startedAt: Date.now()
  }

  try {
    await writeEndpointFile(statePath, endpoint)
  } catch (error) {
    await closeServer(server)
    throw new AppError(
      'BRIDGE_STATE_UNAVAILABLE',
      'The browser bridge endpoint file could not be written.',
      'Check that the per-user application data folder is writable.'
    )
  }

  // Defence in depth for an abrupt normal process exit: remove the endpoint
  // file so the native host fails fast instead of dialing a stale port.
  const cleanupOnExit = (): void => {
    try {
      unlinkSync(statePath)
    } catch {
      // The file may already be gone.
    }
  }
  process.once('exit', cleanupOnExit)

  return {
    port: address.port,
    statePath,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      process.removeListener('exit', cleanupOnExit)
      await closeServer(server)
      try {
        await fs.unlink(statePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger('Native bridge endpoint file could not be removed.')
        }
      }
    }
  }
}

/** Exported for focused tests without starting a server. */
export const nativeBridgeInternals = {
  bearerMatches,
  statePathFor: (userDataPath: string): string =>
    path.join(userDataPath, NATIVE_BRIDGE_STATE_FILE),
  parseNativeBridgeEndpoint
}
