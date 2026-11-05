import {
  ValidationError,
  normalizeHttpUrl,
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
 * Automatic hand-off only accepts ordinary files. Playback media, manifests,
 * segments and extension-internal downloads stay with the explicit manual
 * path; the browser's own download must keep running unless the desktop can
 * prove it owns a supported non-media file.
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

export interface DurableHandoffInput {
  url: string
  filename?: string
}

export interface DurableHandoffReceipt {
  downloadId: string
  persistedAt: number
}

function extensionOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = /\.([a-z0-9]{1,8})$/i.exec(value.trim())
  return match ? match[1]!.toLowerCase() : null
}

/**
 * The container can be proven by the URL path or an explicitly supplied file
 * name, exactly like the progressive capture contract. The extension is never
 * inferred from a MIME header or the browser download item.
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

function readFilename(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'filename')) {
    return undefined
  }
  const raw = record.filename
  if (
    typeof raw !== 'string' ||
    raw.trim().length === 0 ||
    raw.length > MAX_FILENAME_LENGTH * 2 ||
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

/** Parse the loopback/native-host body for the strict hand-off route. */
export function parseDurableHandoffInput(value: unknown): DurableHandoffInput {
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
    isMediaFileExtension(pathname) ||
    isMediaFileExtension(filename) ||
    handoffFileExtension(pathname, filename) === null
  ) {
    throw new ValidationError(
      'Automatic hand-off only accepts a supported non-media file.'
    )
  }

  return {
    url,
    ...(filename === undefined ? {} : { filename })
  }
}

/** Parse the browser -> native-host envelope. */
export function parseNativeDurableHandoffMessage(
  value: unknown
): DurableHandoffInput & { type: typeof DURABLE_HANDOFF_CHANNEL } {
  const record = asPlainObject(value)
  exactKeys(record, ['type', 'url'], ['filename'])
  if (record.type !== DURABLE_HANDOFF_CHANNEL) {
    throw new ValidationError('Unsupported durable hand-off operation.')
  }
  return {
    type: DURABLE_HANDOFF_CHANNEL,
    ...parseDurableHandoffInput({
      url: record.url,
      ...(record.filename === undefined ? {} : { filename: record.filename })
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
