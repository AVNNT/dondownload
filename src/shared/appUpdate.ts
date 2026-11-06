import { ValidationError } from './errors'

/**
 * Renderer-safe contract for the application updater.
 *
 * Values in this module never contain a download URL, asset name or filesystem
 * path. The main process owns the verified installer; the renderer only sees a
 * state, a safe message and optional plain-text release notes.
 */

export const DEFAULT_AUTO_CHECK_APP_UPDATES = true

/** At most one automatic app-update check per 24 hours. */
export const APP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Hard cap for the NSIS installer downloaded into `<userData>/updates`. */
export const MAX_APP_UPDATE_BYTES = 600 * 1024 * 1024

/** Release notes are plain text and never rendered as HTML. */
export const MAX_RELEASE_NOTES_BYTES = 4 * 1024

export const APP_UPDATE_SUMS_NAME = 'SHA256SUMS.txt'

export interface AppUpdateSettings {
  /** Check for app updates automatically. Default ON. */
  autoCheck: boolean
  /** Epoch milliseconds of the last check, or null when never checked. */
  lastCheckedAt: number | null
}

export function defaultAppUpdateSettings(): AppUpdateSettings {
  return {
    autoCheck: DEFAULT_AUTO_CHECK_APP_UPDATES,
    lastCheckedAt: null
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid app update settings payload.')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[]
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key)) {
      throw new ValidationError(
        'The app update settings payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The app update settings payload is missing required fields.'
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
    throw new ValidationError('Invalid app update last-check time.')
  }
  return value
}

/** Parse the complete persistent app-update settings with exact keys. */
export function parseAppUpdateSettings(value: unknown): AppUpdateSettings {
  const record = asPlainObject(value)
  exactKeys(record, ['autoCheck', 'lastCheckedAt'])
  if (typeof record.autoCheck !== 'boolean') {
    throw new ValidationError('Invalid app update automatic-check flag.')
  }
  return {
    autoCheck: record.autoCheck,
    lastCheckedAt: lastCheckValue(record.lastCheckedAt)
  }
}

/** Parse the small renderer request: only the automatic-check toggle. */
export function parseAppUpdateSettingsPatch(value: unknown): {
  autoCheck: boolean
} {
  const record = asPlainObject(value)
  exactKeys(record, ['autoCheck'])
  if (typeof record.autoCheck !== 'boolean') {
    throw new ValidationError('Invalid app update automatic-check flag.')
  }
  return { autoCheck: record.autoCheck }
}

export const APP_UPDATE_STATUSES = [
  'not-configured',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'ready',
  'installing',
  'failed',
  'disabled',
  'throttled'
] as const

export type AppUpdateStatus = (typeof APP_UPDATE_STATUSES)[number]

/** Renderer-safe status of the application updater. */
export interface AppUpdateState {
  status: AppUpdateStatus
  /** False when `UPDATE_REPO` is null; every action reports not-configured. */
  configured: boolean
  /** Running application version. */
  currentVersion: string
  /** Newest published release seen during the last successful check. */
  latestVersion: string | null
  /** 0-100 while downloading, otherwise null. */
  progressPercent: number | null
  /** Safe, user-facing explanation. Never contains a URL or file path. */
  message: string | null
  /** Plain text only; already truncated to `MAX_RELEASE_NOTES_BYTES`. */
  releaseNotes: string | null
  lastCheckedAt: number | null
  autoCheck: boolean
  /** True only when a verified installer is available to launch. */
  canInstall: boolean
}

const encoder = new TextEncoder()

/**
 * Keep only the body as plain text and cap it at 4 KiB of UTF-8. The renderer
 * renders the result as text, so HTML or Markdown is never interpreted.
 */
export function truncateReleaseNotes(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const plain = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const bytes = encoder.encode(plain)
  if (bytes.byteLength <= MAX_RELEASE_NOTES_BYTES) return plain
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, MAX_RELEASE_NOTES_BYTES)
  )
  return decoded.replace(/\uFFFD$/, '')
}
