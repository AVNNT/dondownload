import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { AppError } from '../errors'
import { isCookieHopSafe } from '../net/cookieScope'
import {
  resolvePublicTargetAddresses,
  type PublicTargetLookup
} from '../net/publicTarget'

/**
 * Bounded page fetch used only by the Smart Link Scanner.
 *
 * Every redirect hop is resolved and revalidated against the public-target
 * policy before it is contacted. A Cookie is attached only to the exact host
 * and scheme of the initial URL and is never forwarded to a different host or
 * downgraded from HTTPS to HTTP. No cookie jar and no persistence exists.
 */

export const SCAN_FETCH_TIMEOUT_MS = 15_000
export const SCAN_FETCH_MAX_REDIRECTS = 5
export const SCAN_FETCH_MAX_BYTES = 5 * 1024 * 1024
export const SCAN_FETCH_MAX_JSON_BYTES = 5 * 1024 * 1024

export type ScanFetchConnectLookup = (
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

export interface ScanFetchInput {
  url: string
  /** Exact-host browser Cookie. Memory-only for this one fetch. */
  cookie?: string
  /** `html` requires text/html or application/xhtml+xml; `json` requires JSON. */
  accept?: 'html' | 'json'
  maxBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ScanFetchOptions {
  lookup?: PublicTargetLookup
  connectLookup?: ScanFetchConnectLookup
}

export interface ScanFetchResult {
  finalUrl: string
  status: number
  contentType: string
  contentDisposition: string | null
  body: string
  bytes: number
}

interface RawResponse {
  status: number
  contentType: string
  contentDisposition: string | null
  redirect: string | null
  body: Buffer
}

function failure(code: string, message: string): AppError {
  return new AppError(code, message)
}

export function needsLoginStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404
}

function normalizeContentType(
  value: string | string[] | undefined
): string {
  if (typeof value !== 'string') return ''
  return value.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isHtmlContentType(value: string): boolean {
  return value === 'text/html' || value === 'application/xhtml+xml'
}

function isJsonContentType(value: string): boolean {
  return (
    value === 'application/json' ||
    value === 'application/ld+json' ||
    value.endsWith('+json')
  )
}

function pinResolvedAddresses(
  addresses: readonly { address: string; family: number }[]
): ScanFetchConnectLookup {
  return (_hostname, lookupOptions, callback) => {
    if (addresses.length === 0) {
      callback(
        Object.assign(new Error('No public address is available.'), {
          code: 'ENOTFOUND'
        }),
        '',
        0
      )
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

function requestOnce(
  url: string,
  input: ScanFetchInput,
  options: ScanFetchOptions,
  connectLookup: ScanFetchConnectLookup,
  cookieOrigin: URL,
  maxBytes: number
): Promise<RawResponse> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.reject(failure('SCAN_FETCH_INVALID', 'The scan URL is not valid.'))
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(
      failure('SCAN_FETCH_INVALID', 'Only HTTP(S) pages can be scanned.')
    )
  }
  if (parsed.username || parsed.password) {
    return Promise.reject(
      failure('SCAN_FETCH_INVALID', 'URLs with embedded credentials are not supported.')
    )
  }

  const headers: Record<string, string> = {
    Accept:
      input.accept === 'json'
        ? 'application/json, application/ld+json;q=0.9'
        : 'text/html, application/xhtml+xml;q=0.9',
    'Accept-Encoding': 'identity',
    'User-Agent': 'DonDownload/1.1.0'
  }
  if (input.cookie !== undefined && isCookieHopSafe(cookieOrigin, parsed)) {
    headers.Cookie = input.cookie
  }

  const timeoutMs =
    Number.isSafeInteger(input.timeoutMs) && (input.timeoutMs ?? 0) > 0
      ? Math.min(input.timeoutMs ?? SCAN_FETCH_TIMEOUT_MS, 60_000)
      : SCAN_FETCH_TIMEOUT_MS
  const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: RawResponse): void => {
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
          : failure('SCAN_FETCH_FAILED', 'The page could not be fetched.')
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
          lookup: connectLookup as never
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0
          const location = response.headers.location
          if (status >= 300 && status < 400 && typeof location === 'string') {
            let next: string
            try {
              next = new URL(location, url).href
            } catch {
              response.resume()
              response.destroy()
              fail(failure('SCAN_FETCH_INVALID', 'The redirect target is not valid.'))
              return
            }
            response.resume()
            response.destroy()
            finish({
              status,
              contentType: '',
              contentDisposition: null,
              redirect: next,
              body: Buffer.alloc(0)
            })
            return
          }

          const contentType = normalizeContentType(response.headers['content-type'])
          const contentDisposition =
            typeof response.headers['content-disposition'] === 'string'
              ? response.headers['content-disposition']
              : null
          const chunks: Buffer[] = []
          let received = 0
          let failed = false

          response.on('data', (chunk: Buffer) => {
            if (failed) return
            received += chunk.length
            if (received > maxBytes) {
              failed = true
              response.destroy()
              fail(
                failure(
                  'SCAN_PAGE_TOO_LARGE',
                  'That page is too large to scan safely.'
                )
              )
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            if (failed) return
            finish({
              status,
              contentType,
              contentDisposition,
              redirect: null,
              body: Buffer.concat(chunks)
            })
          })
          response.on('error', (error) => fail(error))
        }
      )
    } catch (error) {
      fail(error)
      return
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        failure('SCAN_FETCH_TIMEOUT', 'The page did not answer in time.')
      )
    })
    request.on('error', (error) => fail(error))

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        request.destroy(failure('SCAN_CANCELLED', 'The scan was cancelled.'))
        return
      }
      input.signal.addEventListener(
        'abort',
        () => {
          request.destroy(failure('SCAN_CANCELLED', 'The scan was cancelled.'))
        },
        { once: true }
      )
    }
    request.end()
  })
}

export async function fetchScanPage(
  input: ScanFetchInput,
  options: ScanFetchOptions = {}
): Promise<ScanFetchResult> {
  if (!input || typeof input.url !== 'string' || input.url.length === 0) {
    throw failure('SCAN_FETCH_INVALID', 'Enter a page URL to scan.')
  }
  let current: string
  try {
    current = new URL(input.url).href
  } catch {
    throw failure('SCAN_FETCH_INVALID', 'Enter a valid page URL.')
  }
  const cookieOrigin = new URL(current)
  const maximumRedirects = SCAN_FETCH_MAX_REDIRECTS
  const maxBytes = Math.min(
    Number.isSafeInteger(input.maxBytes) && (input.maxBytes ?? 0) > 0
      ? (input.maxBytes as number)
      : input.accept === 'json'
        ? SCAN_FETCH_MAX_JSON_BYTES
        : SCAN_FETCH_MAX_BYTES,
    SCAN_FETCH_MAX_BYTES
  )

  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    if (input.signal?.aborted === true) {
      throw failure('SCAN_CANCELLED', 'The scan was cancelled.')
    }
    let addresses
    try {
      addresses = await resolvePublicTargetAddresses(current, options.lookup)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'MEDIA_TARGET_UNRESOLVED') {
        throw failure(
          'SCAN_TARGET_UNRESOLVED',
          "Couldn't reach that site. Check the address or your internet connection."
        )
      }
      throw failure(
        'SCAN_TARGET_NOT_PUBLIC',
        'Local and private network pages cannot be scanned.'
      )
    }
    const connectLookup =
      options.connectLookup ?? pinResolvedAddresses(addresses)

    const response = await requestOnce(
      current,
      input,
      options,
      connectLookup,
      cookieOrigin,
      maxBytes
    )

    if (response.redirect !== null) {
      if (redirect === maximumRedirects) {
        throw failure('SCAN_FETCH_REDIRECT', 'The page redirected too many times.')
      }
      let next: URL
      try {
        next = new URL(response.redirect)
      } catch {
        throw failure('SCAN_FETCH_INVALID', 'The redirect target is not valid.')
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw failure('SCAN_FETCH_INVALID', 'The redirect target is not HTTP(S).')
      }
      if (next.username || next.password) {
        throw failure('SCAN_FETCH_INVALID', 'The redirect target contains credentials.')
      }
      if (input.cookie !== undefined && !isCookieHopSafe(cookieOrigin, next)) {
        throw failure(
          'SCAN_COOKIE_REDIRECT',
          'The signed-in page redirected to a different host or a less secure scheme, so its cookie was not sent.'
        )
      }
      current = next.href
      continue
    }

    if (needsLoginStatus(response.status)) {
      throw failure(
        'SCAN_NEEDS_LOGIN',
        'That page needs a browser sign-in to scan.'
      )
    }
    if (response.status !== 200) {
      throw failure(
        'SCAN_FETCH_FAILED',
        'The page did not return a successful response.'
      )
    }
    if (input.accept === 'json') {
      if (!isJsonContentType(response.contentType)) {
        throw failure('SCAN_FETCH_TYPE', 'The page did not return JSON.')
      }
    } else if (input.accept === 'html') {
      if (!isHtmlContentType(response.contentType)) {
        throw failure('SCAN_FETCH_TYPE', 'That link is not an HTML page.')
      }
    }

    return {
      finalUrl: current,
      status: response.status,
      contentType: response.contentType,
      contentDisposition: response.contentDisposition,
      body: response.body.toString('utf8'),
      bytes: response.body.length
    }
  }

  throw failure('SCAN_FETCH_REDIRECT', 'The page redirected too many times.')
}
