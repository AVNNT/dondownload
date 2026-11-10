import type { DownloadStatus } from './types'
import { ValidationError, parseDownloadId } from './validation'

/**
 * Additive read-only bridge operations for the in-page DonDownload card.
 *
 * The automatic hand-off receipt already carries the desktop download id. The
 * extension needs exactly two things after that: the progress of that one
 * download, and a way to bring the desktop to that row. Neither operation can
 * queue, cancel or delete anything, and neither response may carry a URL, a
 * filesystem path, a cookie or a request header.
 */

export const DOWNLOAD_STATUS_CHANNEL = 'download-status'
export const DOWNLOAD_STATUS_ROUTE = '/download-status'
export const SHOW_DOWNLOAD_CHANNEL = 'show-download'
export const SHOW_DOWNLOAD_ROUTE = '/show-download'

/** The browser-facing status vocabulary for one taken-over download. */
export type HandoffDownloadStatusName =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'

export const HANDOFF_DOWNLOAD_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'done',
  'error'
] as const)

export const MAX_HANDOFF_STATUS_FILENAME_LENGTH = 180
export const MAX_HANDOFF_STATUS_MESSAGE_LENGTH = 200

export interface HandoffDownloadRequest {
  downloadId: string
}

export interface HandoffDownloadStatus {
  status: HandoffDownloadStatusName
  completedBytes: number
  totalBytes: number
  filename: string
  /** Short, already-safe text for an error. Never a URL or a path. */
  errorMessage?: string
}

/**
 * Map the desktop's own download statuses onto the five values the card
 * understands. `waiting` is a queued row that the schedule or the allowed-hours
 * policy is holding back, and an `interrupted` transfer needs the user, so both
 * are reported as such instead of pretending to progress.
 */
export function mapDownloadStatus(status: DownloadStatus): HandoffDownloadStatusName {
  switch (status) {
    case 'active':
      return 'running'
    case 'paused':
      return 'paused'
    case 'complete':
      return 'done'
    case 'error':
    case 'cancelled':
    case 'interrupted':
      return 'error'
    case 'queued':
    case 'waiting':
    default:
      return 'queued'
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid download status request.')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ValidationError(
        'The download status request contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The download status request is missing required fields.'
      )
    }
  }
}

/** Parse `{ downloadId }` for either new route. */
export function parseHandoffDownloadRequest(value: unknown): HandoffDownloadRequest {
  const record = asPlainObject(value)
  exactKeys(record, ['downloadId'], [])
  return { downloadId: parseDownloadId(record.downloadId) }
}

/**
 * A file name is a display label only. A directory prefix is dropped rather
 * than rejected so the desktop can hand its own record straight to the card.
 */
export function safeDownloadFilename(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  const segment = trimmed.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? ''
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  const cleaned = segment.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned.length === 0) return ''
  return cleaned.length > MAX_HANDOFF_STATUS_FILENAME_LENGTH
    ? cleaned.slice(0, MAX_HANDOFF_STATUS_FILENAME_LENGTH)
    : cleaned
}

/**
 * An error message is optional. Anything that looks like a URL or a Windows
 * path is dropped instead of being forwarded to a web page.
 */
export function safeDownloadErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (text.length === 0 || text.length > MAX_HANDOFF_STATUS_MESSAGE_LENGTH) {
    return undefined
  }
  if (/(?:https?|file):\/\//i.test(text) || /[A-Za-z]:\\/.test(text)) {
    return undefined
  }
  return text
}

function readBytes(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError('The download status byte counts are invalid.')
  }
  return value
}

/**
 * Validate the desktop's answer before it can reach the browser. Exact keys,
 * five known statuses, non-negative safe integers and a display-only file name.
 */
export function parseHandoffDownloadStatus(value: unknown): HandoffDownloadStatus {
  const record = asPlainObject(value)
  exactKeys(
    record,
    ['status', 'completedBytes', 'totalBytes', 'filename'],
    ['errorMessage']
  )
  const status = record.status
  if (
    typeof status !== 'string' ||
    !(HANDOFF_DOWNLOAD_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ValidationError('The download status is not supported.')
  }
  const completedBytes = readBytes(record, 'completedBytes')
  const totalBytes = readBytes(record, 'totalBytes')
  if (
    typeof record.filename !== 'string' ||
    record.filename.length > MAX_HANDOFF_STATUS_FILENAME_LENGTH
  ) {
    throw new ValidationError('The download status file name is invalid.')
  }
  const filename = safeDownloadFilename(record.filename)
  if (filename.length === 0) {
    throw new ValidationError('The download status file name is invalid.')
  }
  const errorMessage = safeDownloadErrorMessage(record.errorMessage)
  return {
    status: status as HandoffDownloadStatusName,
    completedBytes,
    totalBytes,
    filename,
    ...(errorMessage === undefined ? {} : { errorMessage })
  }
}
