import type { AddDownloadInput, DownloadRequestHeaders } from './types'
import { ValidationError } from './errors'
import { isDownloadDestinationToken } from './downloadDestination'
import { keepsUrlFragment } from './urlFragment'
import {
  defaultDownloadControls,
  parseDownloadControls
} from './settings'

const MAX_REFERER_LENGTH = 4096
const MAX_USER_AGENT_LENGTH = 512
const MAX_COOKIE_HEADER_LENGTH = 8192

export { ValidationError } from './errors'

const MAX_URL_LENGTH = 4096
const MAX_FILENAME_LENGTH = 180
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\..*$|$)/i
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Accept only ordinary web URLs. Credentials embedded in a URL are rejected so
 * they cannot leak into logs, the UI, or aria2's session state.
 */
export function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('Enter a download URL.')
  }

  const raw = value.trim()
  if (raw.length === 0) {
    throw new ValidationError('Enter a download URL.')
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new ValidationError('The URL is too long (maximum 4096 characters).')
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ValidationError('The URL contains unsupported control characters.')
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError('That does not look like a valid URL.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http:// and https:// URLs are supported.')
  }
  if (!parsed.hostname) {
    throw new ValidationError('The URL must include a host name.')
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError(
      'URLs containing embedded credentials are not supported.'
    )
  }

  // Fragments are not sent to the server and can confuse file name inference.
  // The one exception is a public MEGA link, whose decryption key is the
  // fragment: dropping it would make the link unusable. The full link stays in
  // main-process state and is redacted before it is shown or logged.
  if (!keepsUrlFragment(parsed.hostname)) parsed.hash = ''

  if (parsed.href.length > MAX_URL_LENGTH) {
    throw new ValidationError('The URL is too long (maximum 4096 characters).')
  }

  return parsed.href
}

function splitExtension(filename: string): { base: string; extension: string } {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0 || filename.length - lastDot > 20) {
    return { base: filename, extension: '' }
  }
  return {
    base: filename.slice(0, lastDot),
    extension: filename.slice(lastDot)
  }
}

/**
 * Produce a single, portable file name. Path separators, Windows reserved
 * characters and control characters can never survive this function, so the
 * result cannot escape the configured download directory.
 */
export function sanitizeFilename(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('The file name must be text.')
  }

  let name = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')

  if (name.length === 0 || name === '.' || name === '..') {
    throw new ValidationError('Enter a valid file name.')
  }

  if (WINDOWS_RESERVED_NAME.test(name)) {
    name = `_${name}`
  }

  const split = splitExtension(name)
  let base = split.base
  const extension = split.extension

  if (WINDOWS_RESERVED_NAME.test(base)) {
    base = `_${base}`
  }

  const available = MAX_FILENAME_LENGTH - extension.length
  if (base.length > available) {
    base = base.slice(0, available)
  }

  name = `${base}${extension}`.replace(/[. ]+$/g, '')

  if (name.length === 0) {
    throw new ValidationError('Enter a valid file name.')
  }

  return name
}

function readHeaderText(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ValidationError('The request header value is invalid.')
  }
  return value
}

/**
 * Strict per-download header contract. Only the three browser-observed values
 * are accepted; there is no arbitrary header list and no header can contain a
 * newline.
 */
export function parseDownloadRequestHeaders(
  value: unknown
): DownloadRequestHeaders {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid request header payload.')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['referer', 'userAgent', 'cookie'].includes(key)) {
      throw new ValidationError('The request header payload contains unsupported fields.')
    }
  }

  let referer: string | undefined
  if (record.referer !== undefined) {
    referer = normalizeHttpUrl(record.referer)
    if (referer.length > MAX_REFERER_LENGTH) {
      throw new ValidationError('The request referer is too long.')
    }
  }

  const userAgent = readHeaderText(
    record,
    'userAgent',
    MAX_USER_AGENT_LENGTH
  )
  if (userAgent !== undefined && /[\r\n]/.test(userAgent)) {
    throw new ValidationError('The request user agent is invalid.')
  }

  const cookie = readHeaderText(record, 'cookie', MAX_COOKIE_HEADER_LENGTH)
  if (cookie !== undefined && /[\r\n]/.test(cookie)) {
    throw new ValidationError('The request cookie header is invalid.')
  }

  return {
    ...(referer === undefined ? {} : { referer }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(cookie === undefined ? {} : { cookie })
  }
}

export function parseAddDownloadInput(value: unknown): AddDownloadInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid download request.')
  }

  const record = value as Record<string, unknown>
  const url = normalizeHttpUrl(record.url)

  let filename: string | undefined
  if (record.filename !== undefined && record.filename !== null) {
    if (typeof record.filename !== 'string') {
      throw new ValidationError('The file name must be text.')
    }
    if (record.filename.trim().length > 0) {
      filename = sanitizeFilename(record.filename)
    }
  }

  let sortFilename: string | undefined
  if (record.sortFilename !== undefined && record.sortFilename !== null) {
    if (typeof record.sortFilename !== 'string') {
      throw new ValidationError('The sort file name must be text.')
    }
    if (record.sortFilename.trim().length > 0) {
      sortFilename = sanitizeFilename(record.sortFilename)
    }
  }

  let force = false
  if (record.force !== undefined && record.force !== null) {
    if (typeof record.force !== 'boolean') {
      throw new ValidationError('The force option must be true or false.')
    }
    force = record.force
  }

  let controls = defaultDownloadControls()
  if (record.controls !== undefined && record.controls !== null) {
    // parseDownloadControls is the single exact-key contract for per-download
    // controls; unknown/missing fields are rejected rather than ignored.
    controls = parseDownloadControls(record.controls)
  }

  let requestHeaders: DownloadRequestHeaders | undefined
  if (record.requestHeaders !== undefined && record.requestHeaders !== null) {
    requestHeaders = parseDownloadRequestHeaders(record.requestHeaders)
  }

  let resolvedUrl: string | undefined
  if (record.resolvedUrl !== undefined && record.resolvedUrl !== null) {
    resolvedUrl = normalizeHttpUrl(record.resolvedUrl)
  }

  let destinationToken: string | undefined
  if (record.destinationToken !== undefined && record.destinationToken !== null) {
    if (!isDownloadDestinationToken(record.destinationToken)) {
      throw new ValidationError('The chosen download folder is invalid.')
    }
    destinationToken = record.destinationToken
  }

  return {
    url,
    ...(filename === undefined ? {} : { filename }),
    ...(sortFilename === undefined ? {} : { sortFilename }),
    ...(force ? { force: true } : {}),
    ...(record.controls === undefined || record.controls === null
      ? {}
      : { controls }),
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
    ...(destinationToken === undefined ? {} : { destinationToken })
  }
}

export function parseDownloadId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new ValidationError('Invalid download identifier.')
  }
  return value
}

/** Upper bound for one bulk removal so a hostile payload cannot stall main. */
const MAX_BULK_DOWNLOAD_IDS = 10_000

/**
 * Many download ids from one bulk call. Duplicates collapse so a repeated id
 * cannot make the caller report more removals than it performed.
 */
export function parseDownloadIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('Invalid download identifiers.')
  }
  if (value.length > MAX_BULK_DOWNLOAD_IDS) {
    throw new ValidationError('Too many downloads in one request.')
  }
  const ids = new Set<string>()
  for (const entry of value) ids.add(parseDownloadId(entry))
  return [...ids]
}

export function isAria2Gid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value)
}

export function parseAria2Gid(value: unknown): string {
  if (!isAria2Gid(value)) {
    throw new ValidationError('aria2 returned an invalid download identifier.')
  }
  return value
}

export function guessFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const segment = pathname.split('/').filter(Boolean).pop() ?? ''
    const decoded = decodeURIComponent(segment)
    return sanitizeFilename(decoded)
  } catch {
    return 'download'
  }
}
