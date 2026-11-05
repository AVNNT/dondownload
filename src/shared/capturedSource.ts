import {
  MAX_CAPTURED_SOURCE_FILENAME_LENGTH,
  type CapturedSourceInput
} from './types'
import { ValidationError, normalizeHttpUrl, sanitizeFilename } from './validation'

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
  const match = /\.([a-z0-9]{2,5})$/i.exec(value.trim())
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

function readFilename(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'filename')) {
    return undefined
  }
  const raw = record.filename
  if (
    typeof raw !== 'string' ||
    raw.trim().length === 0 ||
    raw.length > MAX_CAPTURED_SOURCE_FILENAME_LENGTH * 2 ||
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

/**
 * Parse the loopback body. The URL is normalized exactly like the manual
 * download path, but the path or supplied filename must identify a progressive
 * container. An HLS/DASH manifest cannot be queued as if it were one file.
 */
export function parseCapturedSourceInput(value: unknown): CapturedSourceInput {
  const record = asPlainObject(value)
  exactKeys(record, ['url'], ['filename'])
  const url = normalizeHttpUrl(record.url)
  const filename = readFilename(record)

  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    throw new ValidationError('That does not look like a valid URL.')
  }
  if (
    capturedSourceExtension(pathname) === null &&
    capturedSourceExtension(filename ?? '') === null
  ) {
    throw new ValidationError(
      'The captured source is not a supported progressive media file.'
    )
  }

  return {
    url,
    ...(filename === undefined ? {} : { filename })
  }
}

/** Parse the browser -> native-host envelope. */
export function parseNativeCapturedSourceMessage(
  value: unknown
): CapturedSourceInput & { type: typeof CAPTURED_SOURCE_CHANNEL } {
  const record = asPlainObject(value)
  exactKeys(record, ['type', 'url'], ['filename'])
  if (record.type !== CAPTURED_SOURCE_CHANNEL) {
    throw new ValidationError('Unsupported captured source operation.')
  }
  return {
    type: CAPTURED_SOURCE_CHANNEL,
    ...parseCapturedSourceInput({
      url: record.url,
      ...(record.filename === undefined ? {} : { filename: record.filename })
    })
  }
}
