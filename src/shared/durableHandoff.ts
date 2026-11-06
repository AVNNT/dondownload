import type { DownloadRequestHeaders } from './types'
import {
  ValidationError,
  normalizeHttpUrl,
  parseDownloadRequestHeaders,
  sanitizeFilename
} from './validation'

/**
 * Additive strict durable browser hand-off contract.
 *
 * This is deliberately separate from the interactive `queue-download` and
 * `queue-captured-source` acceptance paths. The desktop may report success for
 * those after `DownloadManager.add` resolved, but add() intentionally retries a
 * failed database write. Automatic browser hand-off must only cancel the
 * browser's own download after the desktop has returned a receipt that was
 * written and verified by SQLite.
 */

export const DURABLE_HANDOFF_CHANNEL = 'handoff-download'
export const DURABLE_HANDOFF_ROUTE = '/handoff-download'

const MAX_FILENAME_LENGTH = 180

/**
 * Automatic hand-off takes over a normal browser download the way a download
 * manager does: the browser already decided the transfer is a download, so the
 * desktop does not require an extension allowlist. HTML pages, HLS/DASH
 * manifests and stream segments are still never accepted, and neither is a
 * blob:/data: URL (it fails URL validation). Direct video/audio files are
 * ordinary downloads and are accepted.
 */
export const HANDOFF_FILE_EXTENSIONS = Object.freeze([
  '7z',
  'apk',
  'bin',
  'bz2',
  'csv',
  'deb',
  'dmg',
  'doc',
  'docx',
  'epub',
  'exe',
  'funscript',
  'gz',
  'img',
  'iso',
  'jar',
  'json',
  'md',
  'msi',
  'odp',
  'ods',
  'odt',
  'pkg',
  'pdf',
  'ppt',
  'pptx',
  'rar',
  'rpm',
  'sqlite',
  'tar',
  'tgz',
  'txt',
  'whl',
  'xls',
  'xlsx',
  'xz',
  'zip',
  'zst'
])

export const MEDIA_FILE_EXTENSIONS = Object.freeze([
  'aac',
  'avi',
  'flac',
  'm3u8',
  'm4a',
  'm4s',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpd',
  'mpeg',
  'mpg',
  'oga',
  'ogg',
  'ogv',
  'opus',
  'ts',
  'wav',
  'webm'
])

/** Playlists and segments: never a downloadable file. */
export const MANIFEST_OR_SEGMENT_EXTENSIONS = Object.freeze([
  'm3u8',
  'mpd',
  'm4s',
  'ts'
])

/** HTML documents are pages, not downloads. */
export const PAGE_EXTENSIONS = Object.freeze(['html', 'htm', 'xhtml', 'shtml'])

const PAGE_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const MANIFEST_CONTENT_TYPES = new Set([
  'application/dash+xml',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
])

export interface DurableHandoffInput {
  url: string
  filename?: string
  /** Browser-reported total bytes, used only to verify the same resource. */
  expectedBytes?: number
  /** Browser-reported response media type, compared when it is specific. */
  expectedContentType?: string
  /**
   * Browser headers for this one job. Cookies are memory-only and must never
   * be written to SQLite, an aria2 session file or a log. An automatic browser
   * download sends the browser's cookies for exactly that URL.
   */
  requestHeaders?: DownloadRequestHeaders
  /**
   * Internal only: the bridge sets this after its own preflight so the manager
   * can reuse the resolved target instead of probing twice. It is never parsed
   * from the wire.
   */
  resolvedUrl?: string
}

export interface DurableHandoffReceipt {
  downloadId: string
  persistedAt: number
}

function extensionOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  // A KVS-style URL may end in a trailing slash (`/1.mp4/`), which still names
  // that container. Strip only trailing path separators, never a file name.
  const trimmed = value.trim().replace(/\/+$/, '')
  const match = /\.([a-z0-9]{1,12})$/i.exec(trimmed)
  return match ? match[1]!.toLowerCase() : null
}

/**
 * The container can be proven by the URL path or an explicitly supplied file
 * name, exactly like the progressive capture contract. The extension is never
 * inferred from a MIME header or the browser download item.
 *
 * Kept for callers that need the allowlist answer; the automatic hand-off
 * accepts any non-page file and does not require this to be non-null.
 */
export function handoffFileExtension(
  pathname: string | null | undefined,
  filename?: string | null
): string | null {
  const fromPath = extensionOf(pathname)
  if (fromPath && HANDOFF_FILE_EXTENSIONS.includes(fromPath)) return fromPath
  const fromName = extensionOf(filename)
  if (fromName && HANDOFF_FILE_EXTENSIONS.includes(fromName)) return fromName
  return null
}

export function isMediaFileExtension(value: string | null | undefined): boolean {
  const extension = extensionOf(value)
  return extension !== null && MEDIA_FILE_EXTENSIONS.includes(extension)
}

/**
 * True when the path or file name names an HTML page, an HLS/DASH manifest or
 * a stream segment. Those are never handed off even though the browser may
 * report them as a download.
 */
export function isPageOrManifestFile(
  pathname: string | null | undefined,
  filename?: string | null
): boolean {
  for (const value of [pathname, filename]) {
    const extension = extensionOf(value)
    if (extension === null) continue
    if (
      PAGE_EXTENSIONS.includes(extension) ||
      MANIFEST_OR_SEGMENT_EXTENSIONS.includes(extension)
    ) {
      return true
    }
  }
  return false
}

/** True when a browser-reported media type names a page or a manifest. */
export function isPageOrManifestContentType(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return PAGE_CONTENT_TYPES.has(mediaType) || MANIFEST_CONTENT_TYPES.has(mediaType)
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid durable hand-off payload.')
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
        'The durable hand-off payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The durable hand-off payload is missing required fields.'
      )
    }
  }
}

function readExpectedBytes(
  record: Record<string, unknown>
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'expectedBytes')) {
    return undefined
  }
  const value = record.expectedBytes
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new ValidationError('The hand-off expected size is invalid.')
  }
  return value
}

function readExpectedContentType(
  record: Record<string, unknown>
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'expectedContentType')) {
    return undefined
  }
  const raw = record.expectedContentType
  if (typeof raw !== 'string') {
    throw new ValidationError('The hand-off expected content type is invalid.')
  }
  const mediaType = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  if (
    mediaType.length === 0 ||
    mediaType.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(
      mediaType
    )
  ) {
    throw new ValidationError('The hand-off expected content type is invalid.')
  }
  return mediaType
}

function readFilename(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'filename')) {
    return undefined
  }
  const raw = record.filename
  if (
    typeof raw !== 'string' ||
    raw.trim().length === 0 ||
    raw.length > MAX_FILENAME_LENGTH * 2 ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    /[\u0000-\u001f\u007f]/.test(raw) ||
    /[\\/]/.test(raw)
  ) {
    throw new ValidationError('The hand-off filename is invalid.')
  }
  const filename = sanitizeFilename(raw)
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new ValidationError('The hand-off filename is too long.')
  }
  return filename
}

function readRequestHeaders(
  record: Record<string, unknown>
): DownloadRequestHeaders | undefined {
  const keys = ['referer', 'userAgent', 'cookie'].filter((key) =>
    Object.prototype.hasOwnProperty.call(record, key)
  )
  if (keys.length === 0) return undefined
  const headers = parseDownloadRequestHeaders({
    ...(record.referer === undefined ? {} : { referer: record.referer }),
    ...(record.userAgent === undefined ? {} : { userAgent: record.userAgent }),
    ...(record.cookie === undefined ? {} : { cookie: record.cookie })
  })
  return Object.keys(headers).length === 0 ? undefined : headers
}

/** Parse the loopback/native-host body for the strict hand-off route. */
export function parseDurableHandoffInput(value: unknown): DurableHandoffInput {
  const record = asPlainObject(value)
  exactKeys(
    record,
    ['url'],
    [
      'filename',
      'expectedBytes',
      'expectedContentType',
      'referer',
      'userAgent',
      'cookie'
    ]
  )
  const url = normalizeHttpUrl(record.url)
  const filename = readFilename(record)
  const expectedBytes = readExpectedBytes(record)
  const expectedContentType = readExpectedContentType(record)
  const requestHeaders = readRequestHeaders(record)

  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    throw new ValidationError('That does not look like a valid URL.')
  }

  if (
    isPageOrManifestFile(pathname, filename) ||
    isPageOrManifestContentType(expectedContentType)
  ) {
    throw new ValidationError(
      'HTML pages, playlists and stream segments stay in the browser.'
    )
  }

  return {
    url,
    ...(filename === undefined ? {} : { filename }),
    ...(expectedBytes === undefined ? {} : { expectedBytes }),
    ...(expectedContentType === undefined ? {} : { expectedContentType }),
    ...(requestHeaders === undefined ? {} : { requestHeaders })
  }
}

/** Parse the browser -> native-host envelope. */
export function parseNativeDurableHandoffMessage(
  value: unknown
): DurableHandoffInput & { type: typeof DURABLE_HANDOFF_CHANNEL } {
  const record = asPlainObject(value)
  exactKeys(
    record,
    ['type', 'url'],
    [
      'filename',
      'expectedBytes',
      'expectedContentType',
      'referer',
      'userAgent',
      'cookie'
    ]
  )
  if (record.type !== DURABLE_HANDOFF_CHANNEL) {
    throw new ValidationError('Unsupported durable hand-off operation.')
  }
  return {
    type: DURABLE_HANDOFF_CHANNEL,
    ...parseDurableHandoffInput({
      url: record.url,
      ...(record.filename === undefined ? {} : { filename: record.filename }),
      ...(record.expectedBytes === undefined
        ? {}
        : { expectedBytes: record.expectedBytes }),
      ...(record.expectedContentType === undefined
        ? {}
        : { expectedContentType: record.expectedContentType }),
      ...(record.referer === undefined ? {} : { referer: record.referer }),
      ...(record.userAgent === undefined ? {} : { userAgent: record.userAgent }),
      ...(record.cookie === undefined ? {} : { cookie: record.cookie })
    })
  }
}

export function parseDurableHandoffReceipt(value: unknown): DurableHandoffReceipt {
  const record = asPlainObject(value)
  exactKeys(record, ['downloadId', 'persistedAt'])
  if (
    typeof record.downloadId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.downloadId
    )
  ) {
    throw new ValidationError('The durable hand-off receipt is invalid.')
  }
  if (
    typeof record.persistedAt !== 'number' ||
    !Number.isSafeInteger(record.persistedAt) ||
    record.persistedAt < 1
  ) {
    throw new ValidationError('The durable hand-off receipt is invalid.')
  }
  return {
    downloadId: record.downloadId,
    persistedAt: record.persistedAt
  }
}
