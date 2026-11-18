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
import { logDebug } from '../logging'
import {
  CAPTURED_SOURCE_CHANNEL,
  capturedSourceExtension,
  parseCapturedSourceInput
} from '@shared/capturedSource'
import {
  DOWNLOAD_STATUS_CHANNEL,
  DOWNLOAD_STATUS_ROUTE,
  SHOW_DOWNLOAD_CHANNEL,
  SHOW_DOWNLOAD_ROUTE,
  parseHandoffDownloadRequest,
  parseHandoffDownloadStatus
} from '@shared/downloadStatus'
import {
  DURABLE_HANDOFF_CHANNEL,
  DURABLE_HANDOFF_ROUTE,
  parseDurableHandoffInput,
  parseDurableHandoffReceipt
} from '@shared/durableHandoff'
import {
  MEDIA_BRIDGE_ROUTES,
  MEDIA_BRIDGE_ROUTE_OPERATIONS,
  parseMediaAnalyzeRequest,
  parseMediaCancelRequest,
  parseMediaQueueRequest,
  parseMediaStatusRequest,
  type MediaBridgeRoute,
  type MediaBridgeTarget
} from '@shared/mediaBridge'
import {
  SNIFFED_MEDIA_ROUTE,
  parseSniffedMediaInput,
  redactCookieHeader,
  sniffedMediaFilename,
  type SniffedMediaInput
} from '@shared/sniffedMedia'
import {
  parseMediaAnalysis,
  parseMediaJob,
  type AnalyzeMediaInput,
  type MediaAnalysis,
  type MediaJob,
  type MediaQueueInput
} from '@shared/media'
import {
  MAX_BRIDGE_BODY_BYTES,
  NATIVE_BRIDGE_APP,
  NATIVE_BRIDGE_STATE_FILE,
  NATIVE_BRIDGE_VERSION,
  parseNativeBridgeEndpoint,
  parseQueueDownloadRequest,
  type NativeBridgeEndpoint
} from '@shared/nativeBridge'
import {
  MAX_SCAN_GOFILE_BODY_BYTES,
  SCAN_GOFILE_CHANNEL,
  SCAN_GOFILE_ROUTE,
  SCAN_PAGE_CHANNEL,
  SCAN_PAGE_ROUTE,
  parseScanGofileRequest,
  parseScanPageRequest,
  type ScanGofileRequest
} from '@shared/scanBridge'
import {
  MAX_SCAN_IMAGES_BODY_BYTES,
  SCAN_IMAGES_CHANNEL,
  SCAN_IMAGES_ROUTE,
  parseScanImagesRequest,
  type ScanImagesRequest
} from '@shared/scanImages'
import {
  MAX_SCAN_VIDEO_BODY_BYTES,
  SCAN_VIDEO_CHANNEL,
  SCAN_VIDEO_ROUTE,
  parseScanVideoRequest,
  type ScanVideoRequest
} from '@shared/scanVideo'
import type { ScanSession } from '@shared/scanner'
import { ValidationError } from '@shared/validation'
import { AppError, toErrorInfo } from '../errors'
import {
  assertPublicTarget,
  type PublicTargetLookup
} from '../net/publicTarget'
import {
  preflightPublicResource,
  type PublicResourcePreflightInput,
  type PublicResourcePreflightResult
} from '../net/publicPreflight'

const BRIDGE_ROUTE = '/queue-download'
const CAPTURED_SOURCE_ROUTE = '/queue-captured-source'
const LOOPBACK_ADDRESS = '127.0.0.1'

function isMediaRoute(value: string | undefined): value is MediaBridgeRoute {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(MEDIA_BRIDGE_ROUTE_OPERATIONS, value)
  )
}

function mediaErrorStatus(code: string): number {
  if (
    code === 'DUPLICATE_DOWNLOAD' ||
    code === 'MEDIA_DUPLICATE_JOB' ||
    code.endsWith('_DUPLICATE')
  ) {
    return 409
  }
  if (
    code === 'MEDIA_UNAVAILABLE' ||
    code.endsWith('_UNAVAILABLE') ||
    code.endsWith('_FAILED') ||
    code === 'INTERNAL_ERROR'
  ) {
    return 503
  }
  return 400
}

/**
 * Defence in depth: media errors must never echo a URL, path or credential.
 * Worker B already returns sanitized errors, but the bridge is the last place
 * before the value reaches the native host.
 */
function safeErrorMessage(message: string): string {
  const text = redactCookieHeader(message)
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  if (
    text.length === 0 ||
    text.length > 2000 ||
    /(?:https?|file):\/\//i.test(text) ||
    /[A-Za-z]:\\/.test(text)
  ) {
    return 'The media operation failed.'
  }
  return text
}

/** The only manager capability the bridge is allowed to use. */
export interface BridgeDownloadManager {
  add(input: unknown): Promise<unknown>
  /**
   * Additive strict hand-off capability. When absent, automatic hand-off is
   * reported unavailable so the browser keeps its own download.
   */
  addDurable?(input: unknown): Promise<{
    downloadId: string
    persistedAt: number
  }>
}

export interface NativeBridgeOptions {
  manager: BridgeDownloadManager
  /** Electron's per-user userData directory. */
  userDataPath: string
  logger?: (message: string) => void
  /**
   * Additive Smart Link Scanner capability. The bridge starts a discovery-only
   * session; it can never queue an item.
   */
  scanner?: {
    start(
      url: string,
      options: { origin: 'extension'; cookie?: string }
    ): ScanSession
    /**
     * Queue-capable start. Extension batches send one URL per message, so a
     * third scan must wait for a slot instead of failing with SCAN_LIMIT.
     */
    startMany?(
      urls: string[],
      options: { origin: 'extension'; cookie?: string }
    ): ScanSession[]
    /**
     * Fill a session from the image list the extension collected on the live
     * page. Nothing is fetched: the desktop only opens the picker.
     */
    startImages?(input: ScanImagesRequest): ScanSession
    /**
     * Fill a session from the rows the user's own signed-in Gofile tab
     * rendered. Nothing is fetched from Gofile: the desktop only turns the
     * reported files into cards.
     */
    startGofile?(input: ScanGofileRequest): ScanSession
    /**
     * Fill (or create) a video card from the media URLs the user's own browser
     * tab rendered. Nothing is fetched: the desktop only validates the reported
     * URLs and turns them into quality options.
     */
    startVideoMedia?(input: ScanVideoRequest): Promise<ScanSession>
  }
  /** Focus the desktop and open the scanner view after an extension request. */
  onScanRequested?: (session: ScanSession) => void
  /**
   * Additive read-only progress for one download the extension took over. It
   * is called with an already validated id and must answer with the strict
   * `HandoffDownloadStatus` shape, or null when that id is unknown. The bridge
   * re-validates the answer, so no URL, path or header can reach the browser.
   */
  downloadStatus?: (
    downloadId: string
  ) => Promise<unknown> | unknown
  /**
   * Focus the desktop and reveal that download row. Wired like
   * `onScanRequested` so smoke and focused tests can stub it.
   */
  onShowDownload?: (downloadId: string) => void
  /**
   * Additive media capability. Worker B wires this; when it is absent the
   * media routes stay authenticated but report a safe unavailable error.
   */
  mediaBridge?: MediaBridgeTarget
  /** Injectable DNS lookup for focused tests; production uses node:dns. */
  publicTargetLookup?: PublicTargetLookup
  /**
   * Additive browser-only auto-match. Returns true when a pending pairing was
   * consumed and the detected media was queued in a scanner batch; false keeps
   * every existing sniffed-media behaviour unchanged.
   */
  browserMatch?: (input: SniffedMediaInput) => Promise<boolean>
  /**
   * Additive bounded anonymous GET probe. Injectable for focused tests; the
   * production default never sends cookies, credentials or browser headers.
   */
  publicResourcePreflight?: (
    input: PublicResourcePreflightInput,
    options?: { lookup?: PublicTargetLookup }
  ) => Promise<PublicResourcePreflightResult>
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
  const logger = options.logger ?? ((message: string) => logDebug(message))
  const statePath = path.join(options.userDataPath, NATIVE_BRIDGE_STATE_FILE)
  const token = randomBytes(32).toString('hex')
  let closed = false
  const runPublicPreflight =
    options.publicResourcePreflight ??
    ((input: PublicResourcePreflightInput) =>
      preflightPublicResource(input, {
        lookup: options.publicTargetLookup
      }))

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
    const route = request.url
    if (
      route !== BRIDGE_ROUTE &&
      route !== CAPTURED_SOURCE_ROUTE &&
      route !== DURABLE_HANDOFF_ROUTE &&
      route !== SNIFFED_MEDIA_ROUTE &&
      route !== SCAN_PAGE_ROUTE &&
      route !== SCAN_IMAGES_ROUTE &&
      route !== SCAN_GOFILE_ROUTE &&
      route !== SCAN_VIDEO_ROUTE &&
      route !== DOWNLOAD_STATUS_ROUTE &&
      route !== SHOW_DOWNLOAD_ROUTE &&
      !isMediaRoute(route)
    ) {
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

    if (
      route !== BRIDGE_ROUTE &&
      route !== CAPTURED_SOURCE_ROUTE &&
      route !== DURABLE_HANDOFF_ROUTE &&
      route !== SNIFFED_MEDIA_ROUTE &&
      route !== SCAN_PAGE_ROUTE &&
      route !== SCAN_IMAGES_ROUTE &&
      route !== SCAN_GOFILE_ROUTE &&
      route !== SCAN_VIDEO_ROUTE &&
      route !== DOWNLOAD_STATUS_ROUTE &&
      route !== SHOW_DOWNLOAD_ROUTE &&
      options.mediaBridge === undefined
    ) {
      request.resume()
      sendError(response, 503, 'MEDIA_UNAVAILABLE', 'Media operations are not available.')
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

    // One route carries a whole page walk of images, the Gofile route can carry
    // up to 500 rendered rows, and the video route up to 24 media URLs, so all
    // three need a much larger body than every other (single URL or small
    // status) request. The limit is chosen from the already validated route,
    // before any byte is read.
    const bodyLimit =
      route === SCAN_IMAGES_ROUTE
        ? MAX_SCAN_IMAGES_BODY_BYTES
        : route === SCAN_GOFILE_ROUTE
          ? MAX_SCAN_GOFILE_BODY_BYTES
          : route === SCAN_VIDEO_ROUTE
            ? MAX_SCAN_VIDEO_BODY_BYTES
            : MAX_BRIDGE_BODY_BYTES

    const declaredLength = request.headers['content-length']
    if (declaredLength !== undefined) {
      const length = Number(declaredLength)
      if (!Number.isInteger(length) || length < 0) {
        sendError(response, 400, 'INVALID_LENGTH', 'Invalid content length.')
        return
      }
      if (length > bodyLimit) {
        request.resume()
        sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'The bridge request is too large.')
        return
      }
    }

    let raw: Buffer
    try {
      raw = await readBody(request, bodyLimit)
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

    if (route === DURABLE_HANDOFF_ROUTE) {
      await handleDurableHandoffRequest(parsed, response)
      return
    }

    if (route === DOWNLOAD_STATUS_ROUTE) {
      await handleDownloadStatusRequest(parsed, response)
      return
    }

    if (route === SHOW_DOWNLOAD_ROUTE) {
      await handleShowDownloadRequest(parsed, response)
      return
    }

    if (route === CAPTURED_SOURCE_ROUTE) {
      await handleCapturedSourceRequest(parsed, response)
      return
    }

    if (route === SNIFFED_MEDIA_ROUTE) {
      await handleSniffedMediaRequest(parsed, response)
      return
    }

    if (route === SCAN_PAGE_ROUTE) {
      await handleScanPageRequest(parsed, response)
      return
    }

    if (route === SCAN_IMAGES_ROUTE) {
      await handleScanImagesRequest(parsed, response)
      return
    }

    if (route === SCAN_GOFILE_ROUTE) {
      await handleScanGofileRequest(parsed, response)
      return
    }

    if (route === SCAN_VIDEO_ROUTE) {
      await handleScanVideoRequest(parsed, response)
      return
    }

    if (route !== BRIDGE_ROUTE) {
      if (!isMediaRoute(route)) {
        sendError(response, 404, 'NOT_FOUND', 'Unknown bridge endpoint.')
        return
      }
      await handleMediaRequest(route, parsed, response)
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

  /**
   * Queue one progressive source observed during real playback. The extension
   * already observed the exact media element and URL; this route re-validates
   * the public target and hands it to the same DownloadManager/aria2 path as a
   * manual Quick Add. It never opens or focuses the desktop window.
   */
  async function handleCapturedSourceRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    let input
    try {
      input = parseCapturedSourceInput(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    try {
      await assertPublicTarget(input.url, options.publicTargetLookup)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Captured source target rejected (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    let pathname: string
    try {
      pathname = new URL(input.url).pathname
    } catch {
      sendError(response, 400, 'MALFORMED_URL', 'That does not look like a valid URL.')
      return
    }

    let resolvedUrl: string | undefined
    if (capturedSourceExtension(pathname) === null || input.requestHeaders) {
      // An extensionless URL is not proven by a filename. A player URL that
      // carries one-job headers (KVS) is also preflighted so the same bounded
      // 302 redirect and exact response are verified before acceptance.
      if (input.contentType === undefined || input.expectedBytes === undefined) {
        if (capturedSourceExtension(pathname) === null) {
          sendError(
            response,
            400,
            'CAPTURED_SOURCE_UNVERIFIED',
            'The extensionless captured source has no verified response evidence.'
          )
          return
        }
      }
      const expectedMediaType =
        input.contentType ??
        (capturedSourceExtension(pathname) === 'webm' ? 'video/webm' : 'video/mp4')
      try {
        const preflight = await runPublicPreflight({
          url: input.url,
          ...(input.contentType === undefined
            ? {}
            : { expectedContentType: input.contentType }),
          ...(input.expectedBytes === undefined
            ? {}
            : { expectedBytes: input.expectedBytes }),
          expectedMediaType,
          ...(input.requestHeaders === undefined
            ? {}
            : { requestHeaders: input.requestHeaders })
        })
        resolvedUrl = preflight.finalUrl
      } catch (error) {
        const info = toErrorInfo(error)
        logger(`Captured source preflight rejected (${info.code}).`)
        sendError(
          response,
          400,
          'CAPTURED_SOURCE_UNVERIFIED',
          'The captured source could not be verified before it was queued.'
        )
        return
      }
    }

    const addDurable = options.manager.addDurable
    if (typeof addDurable !== 'function') {
      sendError(
        response,
        503,
        'CAPTURED_SOURCE_DURABILITY_UNAVAILABLE',
        'DonDownload cannot durably accept this captured source right now.'
      )
      return
    }

    let receipt: { downloadId: string; persistedAt: number }
    try {
      // Playback one-click success has the same strict persistence requirement
      // as automatic hand-off; the dimensions/source URL are not enough to
      // claim acceptance when the SQLite receipt cannot be verified.
      const raw = await addDurable.call(options.manager, {
        url: input.url,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(input.requestHeaders === undefined
          ? {}
          : { requestHeaders: input.requestHeaders }),
        ...(resolvedUrl === undefined ? {} : { resolvedUrl })
      })
      receipt = parseDurableHandoffReceipt(raw)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not durably queue a captured source (${info.code}).`)
      const status = info.code === 'DUPLICATE_DOWNLOAD' ? 409 : 503
      sendError(response, status, info.code, safeErrorMessage(info.message))
      return
    }

    sendJson(response, 200, {
      ok: true,
      accepted: true,
      operation: CAPTURED_SOURCE_CHANNEL,
      durable: true,
      receipt
    })
  }

  /**
   * NDM-style detected media. A direct file becomes a normal aria2 download
   * with the page Referer/User-Agent (and an opted-in Cookie header) for this
   * one job. HLS/DASH is delegated to the media engine, which runs yt-dlp's
   * generic extractor with the same headers and produces a normal media job.
   *
   * Public-target validation is applied to both the selected URL and (when
   * present) the pinned HLS variant; nothing private or loopback is reachable.
   */
  async function handleSniffedMediaRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    let input: SniffedMediaInput
    try {
      input = parseSniffedMediaInput(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    try {
      await assertPublicTarget(input.url, options.publicTargetLookup)
      if (input.variant !== undefined) {
        await assertPublicTarget(
          input.variant.url,
          options.publicTargetLookup
        )
      }
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Detected media target rejected (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    if (options.browserMatch !== undefined) {
      let matched: boolean
      try {
        matched = await options.browserMatch(input)
      } catch (error) {
        const info = toErrorInfo(error)
        logger(`Browser match hand-off failed (${info.code}).`)
        sendError(response, 503, info.code, safeErrorMessage(info.message))
        return
      }
      if (matched) {
        sendJson(response, 200, { ok: true, accepted: true })
        return
      }
    }

    if (input.kind === 'file') {
      try {
        await options.manager.add({
          url: input.url,
          filename: sniffedMediaFilename(input),
          requestHeaders: {
            referer: input.referer,
            userAgent: input.userAgent,
            ...(input.cookie === undefined ? {} : { cookie: input.cookie })
          }
        })
      } catch (error) {
        const info = toErrorInfo(error)
        logger(`Native bridge could not queue detected media (${info.code}).`)
        const status =
          info.code === 'DUPLICATE_DOWNLOAD' || info.code.endsWith('_DUPLICATE')
            ? 409
            : 503
        sendError(response, status, info.code, safeErrorMessage(info.message))
        return
      }
      sendJson(response, 200, { ok: true, accepted: true })
      return
    }

    const target = options.mediaBridge
    if (target === undefined || typeof target.queueSniffedMedia !== 'function') {
      sendError(
        response,
        503,
        'MEDIA_UNAVAILABLE',
        'Stream downloads are not available in this DonDownload build.'
      )
      return
    }

    let job: unknown
    try {
      job = await target.queueSniffedMedia(input)
    } catch (error) {
      sendMediaFailure(response, SNIFFED_MEDIA_ROUTE, error)
      return
    }
    try {
      parseMediaJob(job)
    } catch {
      logger(`Native bridge detected media returned an invalid job.`)
      sendError(
        response,
        500,
        'MEDIA_RESPONSE_INVALID',
        'The media operation returned an invalid response.'
      )
      return
    }
    sendJson(response, 200, { ok: true, accepted: true })
  }

  /**
   * Additive strict durability route for automatic browser hand-off. It is not
   * the manual/captured acceptance path: success includes a receipt that was
   * written and read back by SQLite. Any failure leaves the browser's own
   * transfer running because this route never touches the downloads API.
   *
   * A normal browser download (files, installers and direct video/audio) is
   * taken over; HTML pages, manifests and segments are rejected by the parser.
   * Browser cookies for the exact URL stay in memory for this job only.
   */
  async function handleDurableHandoffRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    let input
    try {
      input = parseDurableHandoffInput(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    const addDurable = options.manager.addDurable
    if (typeof addDurable !== 'function') {
      sendError(
        response,
        503,
        'HANDOFF_UNAVAILABLE',
        'Strict durable hand-off is not available in this DonDownload build.'
      )
      return
    }

    try {
      await assertPublicTarget(input.url, options.publicTargetLookup)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Durable hand-off target rejected (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    // The browser's own download may have used its cookies. Prove that the
    // same public resource is retrievable with one bounded range GET, using
    // the browser headers for this exact job when the extension sent them. If
    // that cannot be established, fail closed and leave the browser's own
    // download running rather than cancel an authenticated/POST transfer.
    let preflight: PublicResourcePreflightResult
    try {
      preflight = await runPublicPreflight({
        url: input.url,
        // A normal browser download of a direct video/audio file is taken over
        // like any other download; pages and manifests are still rejected.
        allowMedia: true,
        ...(input.expectedBytes === undefined
          ? {}
          : { expectedBytes: input.expectedBytes }),
        ...(input.expectedContentType === undefined
          ? {}
          : { expectedContentType: input.expectedContentType }),
        ...(input.requestHeaders === undefined
          ? {}
          : { requestHeaders: input.requestHeaders })
      })
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Durable hand-off preflight rejected (${info.code}).`)
      sendError(
        response,
        400,
        info.code === 'HANDOFF_NEEDS_LOGIN'
          ? 'HANDOFF_NEEDS_LOGIN'
          : 'HANDOFF_PREFLIGHT_FAILED',
        info.code === 'HANDOFF_NEEDS_LOGIN'
          ? 'This download needs your browser login. It was left running in the browser.'
          : 'The browser download could not be verified as the same anonymous public resource. It was left running.'
      )
      return
    }

    let acceptance: { downloadId: string; persistedAt: number }
    try {
      // Reuse the verified final URL so DownloadManager does not probe twice.
      // The manager still enforces host/scheme scope before any Cookie header
      // reaches aria2.
      const raw = await addDurable.call(options.manager, {
        ...input,
        resolvedUrl: preflight.finalUrl
      })
      if (!raw || typeof raw !== 'object') {
        throw new AppError('HANDOFF_RESPONSE_INVALID', 'The hand-off receipt is invalid.')
      }
      const receipt = parseDurableHandoffReceipt(raw)
      acceptance = receipt
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not durably hand off a download (${info.code}).`)
      const status =
        info.code === 'DUPLICATE_DOWNLOAD' || info.code.endsWith('_DUPLICATE')
          ? 409
          : 503
      sendError(response, status, info.code, safeErrorMessage(info.message))
      return
    }

    sendJson(response, 200, {
      ok: true,
      accepted: true,
      operation: DURABLE_HANDOFF_CHANNEL,
      durable: true,
      receipt: acceptance
    })
  }

  /**
   * Read-only progress for the one download the extension took over. The card
   * in the page polls this every second while it is visible. Only the five
   * browser-facing statuses, two byte counts, a display-only file name and an
   * optional short safe message leave the desktop.
   */
  async function handleDownloadStatusRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    let input
    try {
      input = parseHandoffDownloadRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    const readStatus = options.downloadStatus
    if (typeof readStatus !== 'function') {
      sendError(
        response,
        503,
        'DOWNLOAD_STATUS_UNAVAILABLE',
        'Download progress is not available in this DonDownload build.'
      )
      return
    }

    let raw: unknown
    try {
      raw = await readStatus(input.downloadId)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not read a download status (${info.code}).`)
      sendError(response, 503, info.code, safeErrorMessage(info.message))
      return
    }

    if (raw === null || raw === undefined) {
      sendError(
        response,
        404,
        'NOT_FOUND',
        'DonDownload does not have that download.'
      )
      return
    }

    let status
    try {
      status = parseHandoffDownloadStatus(raw)
    } catch {
      logger('Native bridge download status was invalid.')
      sendError(
        response,
        500,
        'DOWNLOAD_STATUS_INVALID',
        'The download status could not be read.'
      )
      return
    }

    sendJson(response, 200, {
      ok: true,
      operation: DOWNLOAD_STATUS_CHANNEL,
      ...status
    })
  }

  /**
   * Bring the desktop forward and reveal that download row. Focus is best
   * effort: the extension has already taken the browser download over, so a
   * window that cannot be focused is not an error for the card.
   */
  async function handleShowDownloadRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    let input
    try {
      input = parseHandoffDownloadRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    const show = options.onShowDownload
    if (typeof show !== 'function') {
      sendError(
        response,
        503,
        'SHOW_DOWNLOAD_UNAVAILABLE',
        'Showing a download is not available in this DonDownload build.'
      )
      return
    }

    try {
      show(input.downloadId)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not show a download (${info.code}).`)
      sendError(response, 503, info.code, safeErrorMessage(info.message))
      return
    }

    sendJson(response, 200, {
      ok: true,
      operation: SHOW_DOWNLOAD_CHANNEL,
      shown: true
    })
  }

  /**
   * Explicit "Scan this page" from the extension. The desktop starts an
   * ephemeral scan session, brings its window forward and shows the results.
   * The session only discovers; nothing is queued and the Cookie stays in the
   * scanner session memory for exact-host page/attachment probes.
   */
  async function handleScanPageRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    if (options.scanner === undefined) {
      sendError(
        response,
        503,
        'SCAN_UNAVAILABLE',
        'Page scanning is not available in this DonDownload build.'
      )
      return
    }
    let input
    try {
      input = parseScanPageRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    let session: ScanSession
    try {
      const scanOptions = {
        origin: 'extension' as const,
        ...(input.cookie === undefined ? {} : { cookie: input.cookie })
      }
      // Prefer the queue-capable start so a multi-link extension batch beyond
      // MAX_ACTIVE_SCANS waits for a slot instead of being rejected.
      if (typeof options.scanner.startMany === 'function') {
        const [queued] = options.scanner.startMany([input.url], scanOptions)
        if (queued === undefined) {
          throw new AppError(
            'SCAN_UNAVAILABLE',
            'The page scan could not be started.'
          )
        }
        session = queued
      } else {
        session = options.scanner.start(input.url, scanOptions)
      }
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not start a page scan (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    try {
      options.onScanRequested?.(session)
    } catch {
      // Focus is best effort; the scan itself already started.
    }

    sendJson(response, 200, {
      ok: true,
      accepted: true,
      operation: SCAN_PAGE_CHANNEL
    })
  }

  /**
   * Explicit "Download images on this page" from the extension. The list was
   * collected on the live DOM, so no page is fetched: every URL is validated,
   * checked against the public-target policy and turned into an image session
   * that the desktop shows as a picker. Nothing is queued here.
   */
  async function handleScanImagesRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    if (options.scanner === undefined || options.scanner.startImages === undefined) {
      sendError(
        response,
        503,
        'SCAN_UNAVAILABLE',
        'Image scanning is not available in this DonDownload build.'
      )
      return
    }
    let input: ScanImagesRequest
    try {
      input = parseScanImagesRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    // SSRF guard before anything reaches aria2. Every distinct host is resolved
    // once, so a 1000-image board costs one lookup per CDN instead of one per
    // image; both the primary and the fallback URL contribute their host.
    const hosts = new Map<string, string>()
    for (const image of input.images) {
      for (const candidate of [image.url, image.fallbackUrl]) {
        if (candidate === undefined) continue
        let hostname: string
        try {
          hostname = new URL(candidate).hostname
        } catch {
          sendError(response, 400, 'INVALID_URL', 'An image URL is invalid.')
          return
        }
        if (!hosts.has(hostname)) hosts.set(hostname, candidate)
      }
    }
    for (const candidate of hosts.values()) {
      try {
        await assertPublicTarget(candidate, options.publicTargetLookup)
      } catch {
        sendError(
          response,
          400,
          'SCAN_TARGET_NOT_PUBLIC',
          'Only public image URLs can be downloaded.'
        )
        return
      }
    }

    let session: ScanSession
    try {
      session = options.scanner.startImages(input)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not start an image session (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    try {
      options.onScanRequested?.(session)
    } catch {
      // Focus is best effort; the session already holds the images.
    }

    sendJson(response, 200, {
      ok: true,
      accepted: true,
      operation: SCAN_IMAGES_CHANNEL
    })
  }

  /**
   * Explicit "Scan this Gofile share" from the extension. The user's own
   * signed-in tab rendered the rows, so no page is fetched and `api.gofile.io`
   * is never called. Every download URL was validated against Gofile's own
   * hosts, and the optional `accountToken` Cookie stays in the scanner session
   * memory for the Gofile download requests only. Nothing is queued here.
   */
  async function handleScanGofileRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    if (options.scanner === undefined || options.scanner.startGofile === undefined) {
      sendError(
        response,
        503,
        'SCAN_UNAVAILABLE',
        'Gofile scanning is not available in this DonDownload build.'
      )
      return
    }
    let input: ScanGofileRequest
    try {
      input = parseScanGofileRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    let session: ScanSession
    try {
      session = options.scanner.startGofile(input)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not start a Gofile session (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    try {
      options.onScanRequested?.(session)
    } catch {
      // Focus is best effort; the session already holds the files.
    }

    sendJson(response, 200, {
      ok: true,
      accepted: true,
      operation: SCAN_GOFILE_CHANNEL
    })
  }

  /**
   * Explicit "scan this video page" from the extension. The user's own tab
   * rendered the media, so the desktop never fetches the page and never tries
   * to solve a challenge or an age gate. Every URL is re-validated and checked
   * against the public-target policy by the scanner, and the optional Cookie is
   * the same one-shot exact-origin value the other browser scans use. Nothing
   * is queued here.
   */
  async function handleScanVideoRequest(
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    if (options.scanner === undefined || options.scanner.startVideoMedia === undefined) {
      sendError(
        response,
        503,
        'SCAN_UNAVAILABLE',
        'Video page scanning is not available in this DonDownload build.'
      )
      return
    }
    let input: ScanVideoRequest
    try {
      input = parseScanVideoRequest(parsed)
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    let session: ScanSession
    try {
      session = await options.scanner.startVideoMedia(input)
    } catch (error) {
      const info = toErrorInfo(error)
      logger(`Native bridge could not start a video session (${info.code}).`)
      sendError(response, 400, info.code, safeErrorMessage(info.message))
      return
    }

    try {
      options.onScanRequested?.(session)
    } catch {
      // Focus is best effort; the session already holds the card.
    }

    sendJson(response, 200, {
      ok: true,
      accepted: true,
      operation: SCAN_VIDEO_CHANNEL
    })
  }

  function sendMediaFailure(
    response: ServerResponse,
    operation: string,
    error: unknown
  ): void {
    const info = toErrorInfo(error)
    logger(`Native bridge media operation failed (${operation}, ${info.code}).`)
    sendError(
      response,
      mediaErrorStatus(info.code),
      info.code,
      safeErrorMessage(info.message)
    )
  }

  async function handleMediaRequest(
    route: MediaBridgeRoute,
    parsed: unknown,
    response: ServerResponse
  ): Promise<void> {
    const target = options.mediaBridge
    if (target === undefined) {
      sendError(response, 503, 'MEDIA_UNAVAILABLE', 'Media operations are not available.')
      return
    }

    const operation = MEDIA_BRIDGE_ROUTE_OPERATIONS[route]

    if (route === MEDIA_BRIDGE_ROUTES.analyze) {
      let input: AnalyzeMediaInput
      try {
        input = parseMediaAnalyzeRequest(parsed)
      } catch (error) {
        if (error instanceof ValidationError) {
          sendError(response, 400, error.code, error.message)
          return
        }
        throw error
      }

      let rawAnalysis: unknown
      try {
        rawAnalysis = await target.analyzeMedia(input)
      } catch (error) {
        sendMediaFailure(response, operation, error)
        return
      }

      let analysis: MediaAnalysis
      try {
        analysis = parseMediaAnalysis(rawAnalysis)
      } catch {
        logger(`Native bridge media operation returned an invalid response (${operation}).`)
        sendError(
          response,
          500,
          'MEDIA_RESPONSE_INVALID',
          'The media operation returned an invalid response.'
        )
        return
      }
      sendJson(response, 200, { ok: true, operation, analysis })
      return
    }

    if (route === MEDIA_BRIDGE_ROUTES.queue) {
      let input: MediaQueueInput
      try {
        input = parseMediaQueueRequest(parsed)
      } catch (error) {
        if (error instanceof ValidationError) {
          sendError(response, 400, error.code, error.message)
          return
        }
        throw error
      }

      let rawJob: unknown
      try {
        rawJob = await target.queueMedia(input)
      } catch (error) {
        sendMediaFailure(response, operation, error)
        return
      }

      let job: MediaJob
      try {
        job = parseMediaJob(rawJob)
      } catch {
        logger(`Native bridge media operation returned an invalid response (${operation}).`)
        sendError(
          response,
          500,
          'MEDIA_RESPONSE_INVALID',
          'The media operation returned an invalid response.'
        )
        return
      }
      sendJson(response, 200, { ok: true, operation, job })
      return
    }

    let jobId: string
    try {
      jobId =
        route === MEDIA_BRIDGE_ROUTES.status
          ? parseMediaStatusRequest(parsed).jobId
          : parseMediaCancelRequest(parsed).jobId
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(response, 400, error.code, error.message)
        return
      }
      throw error
    }

    let rawJob: unknown
    try {
      rawJob =
        route === MEDIA_BRIDGE_ROUTES.status
          ? await target.getMediaStatus(jobId)
          : await target.cancelMedia(jobId)
    } catch (error) {
      sendMediaFailure(response, operation, error)
      return
    }

    let job: MediaJob
    try {
      job = parseMediaJob(rawJob)
    } catch {
      logger(`Native bridge media operation returned an invalid response (${operation}).`)
      sendError(
        response,
        500,
        'MEDIA_RESPONSE_INVALID',
        'The media operation returned an invalid response.'
      )
      return
    }
    sendJson(response, 200, { ok: true, operation, job })
  }

  server.requestTimeout = 5_000
  server.headersTimeout = 5_000
  // The native host now keeps one pooled loopback connection open, so the
  // server must not close it after a second of idleness.
  server.keepAliveTimeout = 30_000
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
