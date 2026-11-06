import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { DownloadRequestHeaders } from '@shared/types'
import { AppError } from '../errors'
import {
  resolvePublicTargetAddresses,
  type PublicTargetLookup
} from './publicTarget'

/**
 * Bounded anonymous GET probe used before the desktop accepts an automatic
 * hand-off or an extensionless captured source.
 *
 * This is not a download. It sends `Range: bytes=0-0`, reads response headers,
 * and destroys the response immediately. No cookie jar, Authorization header,
 * referer, proxy credential or browser session is used. Each redirect hop is
 * resolved and revalidated against the public-target policy before it is
 * contacted. A missing, mismatched or ambiguous total fails closed.
 */

export const PREFLIGHT_TIMEOUT_MS = 10_000
export const PREFLIGHT_MAX_REDIRECTS = 5
export const PREFLIGHT_MAX_BODY_BYTES = 64 * 1024

export type PreflightConnectLookup = (
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address:
      | string
      | ReadonlyArray<{ address: string; family: number }>,
    family?: number
  ) => void
) => void

export interface PublicResourcePreflightInput {
  url: string
  /** Browser-reported total bytes. When present it must match exactly. */
  expectedBytes?: number
  /** Browser-reported media type. Generic values are not compared. */
  expectedContentType?: string
  /** For an extensionless captured video: the exact allowed media type. */
  expectedMediaType?: 'video/mp4' | 'video/webm'
  /**
   * Opt-in browser headers for the exact download host. A Cookie is attached
   * only when the hop host still equals the initial input URL host; Referer and
   * User-Agent may follow a same-site redirect. Nothing is persisted.
   */
  requestHeaders?: DownloadRequestHeaders
}

export interface PublicResourcePreflightOptions {
  lookup?: PublicTargetLookup
  connectLookup?: PreflightConnectLookup
  timeoutMs?: number
  maxRedirects?: number
}

export interface PublicResourcePreflightResult {
  finalUrl: string
  status: number
  contentType: string
  totalBytes: number
}

interface HeaderResponse {
  status: number
  contentType: string | null
  contentRange: string | null
  contentLength: string | null
  contentEncoding: string | null
  redirect: string | null
}

const GENERIC_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'application/binary',
  'application/download',
  'application/force-download',
  'binary/octet-stream'
])

function failure(message: string): AppError {
  return new AppError('HANDOFF_PREFLIGHT_FAILED', message)
}

function normalizeContentType(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (
    mediaType.length === 0 ||
    mediaType.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(
      mediaType
    )
  ) {
    return null
  }
  return mediaType
}

function normalizeEncoding(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const encoding = value.split(',')[0]?.trim().toLowerCase() ?? ''
  return encoding.length > 0 ? encoding : null
}

function parseContentRange(
  value: string | string[] | undefined
): { start: number; end: number; total: number | null } | null {
  if (typeof value !== 'string') return null
  const match = /^bytes\s+(\d{1,20})-(\d{1,20})\/(\d{1,20}|\*)$/i.exec(
    value.trim()
  )
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return null
  }
  if (total !== null) {
    if (!Number.isSafeInteger(total) || total <= 0 || end >= total) return null
  }
  return { start, end, total }
}

function parseContentLength(
  value: string | string[] | undefined
): number | null {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value.trim())) return null
  const length = Number(value.trim())
  return Number.isSafeInteger(length) && length > 0 ? length : null
}

function isMediaContentType(contentType: string): boolean {
  return (
    /^(?:video|audio)\//.test(contentType) ||
    contentType === 'application/vnd.apple.mpegurl' ||
    contentType === 'application/x-mpegurl' ||
    contentType === 'application/mpegurl' ||
    contentType === 'application/dash+xml' ||
    contentType === 'text/html'
  )
}

function requestHeaders(
  url: string,
  options: PublicResourcePreflightOptions,
  input: PublicResourcePreflightInput,
  cookieHost: string
): Promise<HeaderResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(failure('Only HTTP(S) resources can be verified.'))
  }
  if (parsed.username || parsed.password) {
    return Promise.reject(failure('Credentials are not accepted in a preflight URL.'))
  }
  const headers: Record<string, string> = {
    Range: 'bytes=0-0',
    'Accept-Encoding': 'identity'
  }
  const requestHeaders = input.requestHeaders
  if (requestHeaders) {
    // A Cookie is host-scoped: never send it to a redirect on another host.
    // Referer and User-Agent are ordinary browser context for the same job.
    if (requestHeaders.referer !== undefined) {
      headers.Referer = requestHeaders.referer
    }
    if (requestHeaders.userAgent !== undefined) {
      headers['User-Agent'] = requestHeaders.userAgent
    }
    if (requestHeaders.cookie !== undefined && parsed.host === cookieHost) {
      headers.Cookie = requestHeaders.cookie
    }
  }
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS, 60_000)
      : PREFLIGHT_TIMEOUT_MS
  const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: HeaderResponse): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(
        error instanceof AppError
          ? error
          : failure('The public resource could not be verified.')
      )
    }

    let request
    try {
      request = client(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers,
          agent: false,
          ...(options.connectLookup
            ? { lookup: options.connectLookup as never }
            : {})
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0
          const location = response.headers.location
          if (status >= 300 && status < 400 && typeof location === 'string') {
            response.resume()
            response.destroy()
            let next: string
            try {
              next = new URL(location, url).href
            } catch {
              fail(failure('The redirect target is not valid.'))
              return
            }
            finish({
              status,
              contentType: null,
              contentRange: null,
              contentLength: null,
              contentEncoding: null,
              redirect: next
            })
            return
          }

          const result: HeaderResponse = {
            status,
            contentType: normalizeContentType(response.headers['content-type']),
            contentRange:
              typeof response.headers['content-range'] === 'string'
                ? response.headers['content-range']
                : null,
            contentLength:
              typeof response.headers['content-length'] === 'string'
                ? response.headers['content-length']
                : null,
            contentEncoding: normalizeEncoding(
              response.headers['content-encoding']
            ),
            redirect: null
          }
          // Do not download the body. The data listener is a defensive cap for
          // servers that ignore Range and begin streaming before we destroy.
          let received = 0
          response.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received > PREFLIGHT_MAX_BODY_BYTES) response.destroy()
          })
          response.on('error', () => undefined)
          finish(result)
          response.destroy()
        }
      )
    } catch (error) {
      fail(error)
      return
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(failure('The public resource did not answer in time.'))
    })
    request.on('error', (error) => fail(error))
    request.end()
  })
}

function pinResolvedAddresses(
  addresses: readonly { address: string; family: number }[]
): PreflightConnectLookup {
  return (_hostname, lookupOptions, callback) => {
    if (addresses.length === 0) {
      callback(Object.assign(new Error('No public address is available.'), { code: 'ENOTFOUND' }), '', 0)
      return
    }
    if (lookupOptions && lookupOptions.all === true) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })))
      return
    }
    const first = addresses[0]!
    callback(null, first.address, first.family)
  }
}

function validateResponse(
  input: PublicResourcePreflightInput,
  response: HeaderResponse
): PublicResourcePreflightResult {
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    // These statuses usually mean the browser session is required. The caller
    // reports a distinct code so the extension can offer the per-site login
    // opt-in instead of silently leaving the file in the browser.
    throw new AppError(
      'HANDOFF_NEEDS_LOGIN',
      'The resource needs the browser login to be downloaded.'
    )
  }
  if (response.status !== 200 && response.status !== 206) {
    throw failure('The public resource did not return HTTP success.')
  }
  if (response.contentType === null) {
    throw failure('The public resource did not report a content type.')
  }
  if (input.expectedMediaType !== undefined) {
    if (response.contentType !== input.expectedMediaType) {
      throw failure('The public resource is not the expected media type.')
    }
  } else if (isMediaContentType(response.contentType)) {
    throw failure('Automatic hand-off only accepts non-media resources.')
  }

  if (input.expectedContentType !== undefined) {
    const expected = normalizeContentType(input.expectedContentType)
    if (
      expected !== null &&
      !GENERIC_CONTENT_TYPES.has(expected) &&
      expected !== response.contentType
    ) {
      throw failure('The public resource type does not match the browser.')
    }
  }

  const encoded =
    response.contentEncoding !== null && response.contentEncoding !== 'identity'
  if (encoded) {
    // Content-Length and Content-Range describe the encoded representation, so
    // they are not trustworthy as the file's exact size.
    throw failure('A compressed response cannot prove the same file size.')
  }

  let totalBytes: number | null = null
  if (response.status === 206) {
    const range = parseContentRange(response.contentRange ?? undefined)
    // We sent Range: bytes=0-0. Refuse servers that return a different byte
    // range; merely reporting a total is not proof that this probe was honored.
    if (
      range === null ||
      range.total === null ||
      range.start !== 0 ||
      range.end !== 0
    ) {
      throw failure('The range response did not match the requested first byte.')
    }
    totalBytes = range.total
  } else {
    // A 200 means the server ignored Range. Do not risk consuming an unbounded
    // response or infer anonymous replayability from an unsolicited body.
    throw failure('The public resource did not honor the bounded range request.')
  }

  if (
    input.expectedBytes !== undefined &&
    (!Number.isSafeInteger(input.expectedBytes) ||
      input.expectedBytes <= 0 ||
      totalBytes !== input.expectedBytes)
  ) {
    throw failure('The public resource size does not match the browser.')
  }

  return {
    finalUrl: input.url,
    status: response.status,
    contentType: response.contentType,
    totalBytes
  }
}

export async function preflightPublicResource(
  input: PublicResourcePreflightInput,
  options: PublicResourcePreflightOptions = {}
): Promise<PublicResourcePreflightResult> {
  if (
    !input ||
    typeof input.url !== 'string' ||
    input.url.length === 0
  ) {
    throw failure('The public resource URL is not valid.')
  }
  let current: string
  try {
    current = new URL(input.url).href
  } catch {
    throw failure('The public resource URL is not valid.')
  }

  const lookup = options.lookup
  const cookieHost = new URL(current).host
  const maximumRedirects =
    Number.isSafeInteger(options.maxRedirects) && (options.maxRedirects ?? 0) >= 0
      ? Math.min(options.maxRedirects ?? PREFLIGHT_MAX_REDIRECTS, 10)
      : PREFLIGHT_MAX_REDIRECTS

  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    try {
      const addresses = await resolvePublicTargetAddresses(current, lookup)
      const connectLookup = options.connectLookup ?? pinResolvedAddresses(addresses)
      const response = await requestHeaders(
        current,
        { ...options, connectLookup },
        input,
        cookieHost
      )
      if (response.redirect !== null) {
        if (redirect === maximumRedirects) {
          throw failure('The public resource redirected too many times.')
        }
        let next: URL
        try {
          next = new URL(response.redirect)
        } catch {
          throw failure('The redirect target is not valid.')
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw failure('The redirect target is not HTTP(S).')
        }
        if (next.username || next.password) {
          throw failure('The redirect target contains credentials.')
        }
        // aria2 sends one per-job header set across redirects. A Cookie is only
        // safe when every hop stays on the exact original host.
        if (
          input.requestHeaders &&
          input.requestHeaders.cookie !== undefined &&
          next.host !== cookieHost
        ) {
          throw failure(
            'An authenticated download redirected to a different host, so its cookie cannot be sent safely.'
          )
        }
        current = next.href
        continue
      }

      const validated = validateResponse({ ...input, url: current }, response)
      return { ...validated, finalUrl: current }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw failure('The public resource target is not public.')
    }
  }

  throw failure('The public resource redirected too many times.')
}

export const publicPreflightInternals = {
  parseContentRange,
  parseContentLength,
  normalizeContentType,
  validateResponse
}
