import { ValidationError, normalizeHttpUrl, sanitizeFilename } from './validation'

/**
 * Shared contract for NDM-style media detected by the browser extension.
 *
 * The extension has already observed the response type/size and, for HLS, the
 * master playlist variants. The desktop bridge still treats everything as
 * untrusted: it validates the exact field set, both URLs, every header value
 * and the size before any network client runs.
 *
 * Cookies are intentionally outside persistence. They exist only in the
 * validated request object for one aria2/yt-dlp job.
 */

export const SNIFFED_MEDIA_CHANNEL = 'queue-sniffed-media'
export const SNIFFED_MEDIA_ROUTE = '/queue-sniffed-media'

export const MAX_SNIFFED_TITLE_LENGTH = 500
export const MAX_SNIFFED_FILENAME_LENGTH = 180
export const MAX_SNIFFED_USER_AGENT_LENGTH = 512
export const MAX_SNIFFED_REFERER_LENGTH = 4096
export const MAX_SNIFFED_COOKIE_LENGTH = 8192
export const MAX_SNIFFED_VARIANT_LABEL_LENGTH = 80
export const MAX_SNIFFED_BYTES = 100 * 1024 ** 3

export type SniffedMediaKind = 'file' | 'hls' | 'dash'

export interface SniffedMediaVariant {
  url: string
  label?: string
  width?: number
  height?: number
  bandwidth?: number
}

export interface SniffedMediaInput {
  url: string
  pageUrl: string
  referer: string
  userAgent: string
  kind: SniffedMediaKind
  title: string
  filename?: string
  variant?: SniffedMediaVariant
  /** One-job only. Never persisted, logged or echoed. */
  cookie?: string
  expectedBytes?: number
}

// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MEDIA_EXTENSIONS = [
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'wav'
]

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid detected media payload.')
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
        'The detected media payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The detected media payload is missing required fields.'
      )
    }
  }
}

function readText(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError(
      `The detected media ${key} is invalid.`
    )
  }
  return value
}

function readOptionalText(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined
  return readText(record, key, maximum)
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function readVariant(value: unknown): SniffedMediaVariant | undefined {
  if (value === undefined) return undefined
  const record = asPlainObject(value)
  exactKeys(record, ['url'], ['label', 'width', 'height', 'bandwidth'])
  const variant: SniffedMediaVariant = {
    url: normalizeHttpUrl(record.url)
  }
  if (variant.url.length > MAX_SNIFFED_REFERER_LENGTH) {
    throw new ValidationError('The detected media variant URL is too long.')
  }
  const label = readOptionalText(
    record,
    'label',
    MAX_SNIFFED_VARIANT_LABEL_LENGTH
  )
  if (label !== undefined) variant.label = label
  for (const key of ['width', 'height', 'bandwidth'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    const candidate = record[key]
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate <= 0 ||
      candidate > 1_000_000_000
    ) {
      throw new ValidationError('The detected media variant metadata is invalid.')
    }
    variant[key] = candidate
  }
  return variant
}

function readCookie(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'cookie')) return undefined
  const value = readText(record, 'cookie', MAX_SNIFFED_COOKIE_LENGTH)
  if (/[\r\n]/.test(value)) {
    throw new ValidationError('The browser cookie header is invalid.')
  }
  return value
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
    raw <= 0 ||
    raw > MAX_SNIFFED_BYTES
  ) {
    throw new ValidationError('The detected media size is invalid.')
  }
  return raw
}

/** Strict parser for the loopback body (and for the shared focused tests). */
export function parseSniffedMediaInput(value: unknown): SniffedMediaInput {
  const record = asPlainObject(value)
  exactKeys(
    record,
    ['url', 'pageUrl', 'referer', 'userAgent', 'kind', 'title'],
    ['filename', 'variant', 'cookie', 'expectedBytes']
  )

  const url = normalizeHttpUrl(record.url)
  const pageUrl = normalizeHttpUrl(record.pageUrl)
  const referer = normalizeHttpUrl(record.referer)
  if (referer.length > MAX_SNIFFED_REFERER_LENGTH) {
    throw new ValidationError('The detected media referer is too long.')
  }
  if (!sameOrigin(referer, pageUrl)) {
    throw new ValidationError(
      'The detected media referer must belong to the page origin.'
    )
  }
  if (!sameOrigin(pageUrl, url) && !sameOrigin(referer, pageUrl)) {
    // Unreachable with the check above, kept explicit for defence in depth.
    throw new ValidationError('The detected media target is invalid.')
  }

  const kind = record.kind
  if (kind !== 'file' && kind !== 'hls' && kind !== 'dash') {
    throw new ValidationError('The detected media kind is unsupported.')
  }

  const userAgent = readText(
    record,
    'userAgent',
    MAX_SNIFFED_USER_AGENT_LENGTH
  )
  if (/[\r\n]/.test(userAgent)) {
    throw new ValidationError('The detected media user agent is invalid.')
  }

  const title = readText(record, 'title', MAX_SNIFFED_TITLE_LENGTH)
  const filename = readOptionalText(
    record,
    'filename',
    MAX_SNIFFED_FILENAME_LENGTH
  )
  if (filename !== undefined && /[\\/]/.test(filename)) {
    throw new ValidationError('The detected media filename is invalid.')
  }

  const variant = readVariant(record.variant)
  if (variant !== undefined && kind !== 'hls') {
    throw new ValidationError('Only an HLS entry may pin a variant.')
  }
  const cookie = readCookie(record)
  const expectedBytes = readExpectedBytes(record)

  return {
    url,
    pageUrl,
    referer,
    userAgent,
    kind,
    title,
    ...(filename === undefined ? {} : { filename }),
    ...(variant === undefined ? {} : { variant }),
    ...(cookie === undefined ? {} : { cookie }),
    ...(expectedBytes === undefined ? {} : { expectedBytes })
  }
}

function allowedExtension(value: string): string | null {
  const match = /\.([a-z0-9]{2,5})$/i.exec(value)
  if (!match) return null
  const extension = match[1]?.toLowerCase() ?? ''
  return MEDIA_EXTENSIONS.includes(extension) ? extension : null
}

function extensionFromUrl(url: string): string | null {
  try {
    return allowedExtension(new URL(url).pathname)
  } catch {
    return null
  }
}

/**
 * Visible filename: sanitized tab/video title plus the real extension. No URL
 * id, query value, opaque key or job id is used. aria2/yt-dlp collision handling
 * adds " (2)" and later suffixes when the name already exists.
 */
export function sniffedMediaFilename(input: SniffedMediaInput): string {
  const sourceUrl = input.variant?.url ?? input.url
  const hint = input.filename ?? ''
  const extension =
    extensionFromUrl(sourceUrl) ??
    allowedExtension(hint) ??
    'mp4'
  const hintBase = hint.replace(/\.[a-z0-9]{2,5}$/i, '')
  const baseSource =
    input.title.trim().length > 0
      ? input.title
      : hintBase.trim().length > 0
        ? hintBase
        : 'media'
  let base: string
  try {
    base = sanitizeFilename(baseSource)
  } catch {
    base = 'media'
  }
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[. ]+$/g, '')
  const available = MAX_SNIFFED_FILENAME_LENGTH - extension.length - 1
  if (base.length > available) base = base.slice(0, available)
  return `${base || 'media'}.${extension}`
}

/**
 * Redact a Cookie header from any diagnostic string. The app never logs the
 * request body, but this helper is used by focused tests and is available to
 * any future diagnostics path.
 */
export function redactCookieHeader(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(
    /((?:^|[\r\n])\s*cookie\s*:\s*)[^\r\n]*/gi,
    '$1[REDACTED]'
  )
}

/** Redact a bare cookie header value for a safe one-line diagnostic. */
export function redactCookieValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (value.trim().length === 0) return value
  return '[REDACTED]'
}
