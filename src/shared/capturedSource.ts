import {
  MAX_CAPTURED_SOURCE_FILENAME_LENGTH,
  type CapturedSourceInput,
  type DownloadRequestHeaders
} from './types'
import {
  ValidationError,
  normalizeHttpUrl,
  parseDownloadRequestHeaders,
  sanitizeFilename
} from './validation'

/**
 * Shared contract for a progressive media file detected during real playback.
 *
 * The browser extension observes a media element's `currentSrc` only after it
 * is actually playing. It never reads cookies, request headers, DRM data or
 * MSE segment requests. A blob: URL means the exact representation is not
 * knowable, so the extension reports it as unsupported instead of guessing.
 *
 * This parser is the desktop/native-host defence in depth: the URL is still a
 * public HTTP(S) target, the filename is sanitized, and only obvious
 * progressive containers are accepted. Manifests are deliberately not queued
 * as direct files.
 */

export const CAPTURED_SOURCE_CHANNEL = 'queue-captured-source'

/** Extensionless URLs require one of these exact complete-file media types. */
export const CAPTURED_SOURCE_MEDIA_TYPES = Object.freeze([
  'video/mp4',
  'video/webm'
])

/** The only containers this checkpoint queues directly. */
export const CAPTURED_SOURCE_EXTENSIONS = Object.freeze([
  'mp4',
  'webm',
  'm4v',
  'mov',
  'ogv',
  'mkv'
])

export function capturedSourceExtension(
  value: string | null | undefined
): string | null {
  if (typeof value !== 'string') return null
  // KVS player URLs end in a slash after the file name (`/1.mp4/`).
  const trimmed = value.trim().replace(/\/+$/, '')
  const match = /\.([a-z0-9]{2,5})$/i.exec(trimmed)
  if (!match) return null
  const extension = match[1]?.toLowerCase()
  return extension && CAPTURED_SOURCE_EXTENSIONS.includes(extension)
    ? extension
    : null
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid captured source payload.')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ValidationError(
        'The captured source payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The captured source payload is missing required fields.'
      )
    }
  }
}

function readContentType(
  record: Record<string, unknown>
): 'video/mp4' | 'video/webm' | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'contentType')) {
    return undefined
  }
  const raw = record.contentType
  if (
    typeof raw !== 'string' ||
    !CAPTURED_SOURCE_MEDIA_TYPES.includes(raw.toLowerCase())
  ) {
    throw new ValidationError('The captured source content type is invalid.')
  }
  return raw.toLowerCase() as 'video/mp4' | 'video/webm'
}

function readExpectedBytes(
  record: Record<string, unknown>
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'expectedBytes')) {
    return undefined
  }
  const raw = record.expectedBytes
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw <= 0
  ) {
    throw new ValidationError('The captured source size is invalid.')
  }
  return raw
}

function readFilename(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'filename')) {
    return undefined
  }
  const raw = record.filename
  if (
    typeof raw !== 'string' ||
    raw.trim().length === 0 ||
    raw.length > MAX_CAPTURED_SOURCE_FILENAME_LENGTH * 2 ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new ValidationError('The captured source filename is invalid.')
  }
  if (/[\\/]/.test(raw)) {
    throw new ValidationError('The captured source filename is invalid.')
  }

  const filename = sanitizeFilename(raw)
  if (filename.length > MAX_CAPTURED_SOURCE_FILENAME_LENGTH) {
    throw new ValidationError('The captured source filename is too long.')
  }
  if (capturedSourceExtension(filename) === null) {
    throw new ValidationError(
      'The captured source does not name a supported progressive media file.'
    )
  }
  return filename
}

function readRequestHeaders(
  record: Record<string, unknown>
): DownloadRequestHeaders | undefined {
  const keys = ['referer', 'userAgent'].filter((key) =>
    Object.prototype.hasOwnProperty.call(record, key)
  )
  if (keys.length === 0) return undefined
  const headers = parseDownloadRequestHeaders({
    ...(record.referer === undefined ? {} : { referer: record.referer }),
    ...(record.userAgent === undefined ? {} : { userAgent: record.userAgent })
  })
  return Object.keys(headers).length === 0 ? undefined : headers
}

/**
 * Parse the loopback body. The URL is normalized exactly like the manual
 * download path, but the path or supplied filename must identify a progressive
 * container. An HLS/DASH manifest cannot be queued as if it were one file.
 */
export function parseCapturedSourceInput(value: unknown): CapturedSourceInput {
  const record = asPlainObject(value)
  exactKeys(
    record,
    ['url'],
    ['filename', 'contentType', 'expectedBytes', 'referer', 'userAgent']
  )
  const url = normalizeHttpUrl(record.url)
  const filename = readFilename(record)
  const contentType = readContentType(record)
  const expectedBytes = readExpectedBytes(record)
  const requestHeaders = readRequestHeaders(record)

  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    throw new ValidationError('That does not look like a valid URL.')
  }

  if (capturedSourceExtension(pathname) === null) {
    // The path is extensionless. A filename alone is only a display label and
    // is not evidence. Require the exact observed complete-file media type and
    // total; the bridge additionally probes it anonymously before queueing.
    if (
      contentType === undefined ||
      expectedBytes === undefined
    ) {
      throw new ValidationError(
        'An extensionless captured source requires verified response evidence.'
      )
    }
  } else if (contentType !== undefined && expectedBytes === undefined) {
    throw new ValidationError('The captured source size is invalid.')
  }

  return {
    url,
    ...(filename === undefined ? {} : { filename }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(expectedBytes === undefined ? {} : { expectedBytes }),
    ...(requestHeaders === undefined ? {} : { requestHeaders })
  }
}

/** Parse the browser -> native-host envelope. */
export function parseNativeCapturedSourceMessage(
  value: unknown
): CapturedSourceInput & { type: typeof CAPTURED_SOURCE_CHANNEL } {
  const record = asPlainObject(value)
  exactKeys(
    record,
    ['type', 'url'],
    ['filename', 'contentType', 'expectedBytes', 'referer', 'userAgent']
  )
  if (record.type !== CAPTURED_SOURCE_CHANNEL) {
    throw new ValidationError('Unsupported captured source operation.')
  }
  return {
    type: CAPTURED_SOURCE_CHANNEL,
    ...parseCapturedSourceInput({
      url: record.url,
      ...(record.filename === undefined ? {} : { filename: record.filename }),
      ...(record.contentType === undefined
        ? {}
        : { contentType: record.contentType }),
      ...(record.expectedBytes === undefined
        ? {}
        : { expectedBytes: record.expectedBytes }),
      ...(record.referer === undefined ? {} : { referer: record.referer }),
      ...(record.userAgent === undefined ? {} : { userAgent: record.userAgent })
    })
  }
}
