import { ValidationError } from './errors'

/**
 * Renderer-safe settings and status for the managed media toolchain.
 *
 * This is deliberately separate from `DownloadSettings`: the yt-dlp updater is
 * an independent preference and its last-check timestamp changes without any
 * user action. Keeping it separate avoids re-saving aria2 download settings
 * every time the updater runs.
 */

export const DEFAULT_AUTO_UPDATE_YTDLP = true

export interface MediaToolSettings {
  /** Keep yt-dlp up to date automatically in the background. Default ON. */
  autoUpdateYtdlp: boolean
  /** Epoch milliseconds of the last updater check, or null when never checked. */
  lastYtdlpCheckAt: number | null
}

export function defaultMediaToolSettings(): MediaToolSettings {
  return {
    autoUpdateYtdlp: DEFAULT_AUTO_UPDATE_YTDLP,
    lastYtdlpCheckAt: null
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid media tool settings payload.')
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
        'The media tool settings payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The media tool settings payload is missing required fields.'
      )
    }
  }
}

function lastCheckValue(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ValidationError('Invalid yt-dlp last-check time.')
  }
  return value
}

/** Parse the complete persistent media tool settings with exact keys. */
export function parseMediaToolSettings(value: unknown): MediaToolSettings {
  const record = asPlainObject(value)
  exactKeys(record, ['autoUpdateYtdlp', 'lastYtdlpCheckAt'])
  const autoUpdateYtdlp = record.autoUpdateYtdlp
  if (typeof autoUpdateYtdlp !== 'boolean') {
    throw new ValidationError('Invalid yt-dlp automatic update flag.')
  }
  return {
    autoUpdateYtdlp,
    lastYtdlpCheckAt: lastCheckValue(record.lastYtdlpCheckAt)
  }
}

/** Parse the small renderer update: only the automatic-update toggle. */
export function parseMediaToolSettingsPatch(value: unknown): {
  autoUpdateYtdlp: boolean
} {
  const record = asPlainObject(value)
  exactKeys(record, ['autoUpdateYtdlp'])
  if (typeof record.autoUpdateYtdlp !== 'boolean') {
    throw new ValidationError('Invalid yt-dlp automatic update flag.')
  }
  return { autoUpdateYtdlp: record.autoUpdateYtdlp }
}

export const YTDLP_UPDATE_STATUSES = [
  'idle',
  'checking',
  'up-to-date',
  'updating',
  'updated',
  'deferred',
  'failed',
  'disabled',
  'throttled'
] as const

export type YtdlpUpdateStatus = (typeof YTDLP_UPDATE_STATUSES)[number]

/** Renderer-safe status of the managed yt-dlp updater. */
export interface YtdlpUpdateState {
  status: YtdlpUpdateStatus
  /** Version of the yt-dlp executable the next media job would use. */
  currentVersion: string | null
  /** Newest published release seen during the last successful check. */
  latestVersion: string | null
  /** Safe, user-facing explanation. Never contains a URL or file path. */
  message: string | null
  lastCheckedAt: number | null
}

export function parseYtdlpUpdateState(value: unknown): YtdlpUpdateState {
  const record = asPlainObject(value)
  exactKeys(record, [
    'status',
    'currentVersion',
    'latestVersion',
    'message',
    'lastCheckedAt'
  ])
  const status = record.status
  if (
    typeof status !== 'string' ||
    !(YTDLP_UPDATE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ValidationError('Unknown yt-dlp update status.')
  }
  const text = (key: string, maximum: number): string | null => {
    const field = record[key]
    if (field === null || field === undefined) return null
    if (typeof field !== 'string' || field.length > maximum) {
      throw new ValidationError('Invalid yt-dlp update detail.')
    }
    return field
  }
  return {
    status: status as YtdlpUpdateStatus,
    currentVersion: text('currentVersion', 64),
    latestVersion: text('latestVersion', 64),
    message: text('message', 1000),
    lastCheckedAt: lastCheckValue(record.lastCheckedAt)
  }
}
