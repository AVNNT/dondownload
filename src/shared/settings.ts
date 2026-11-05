import { ValidationError } from './errors'

/**
 * Shared, renderer-safe download-control settings for Milestone 5A.
 *
 * This module intentionally contains the contract and strict parsers only. The
 * settings are persisted by `src/main/db/database.ts`, but nothing in this
 * milestone applies them to aria2, the download manager, IPC/preload or the UI.
 *
 * Time is always the system local clock. `allowedHours.start` and `.end` are
 * zero-padded 24-hour `HH:mm` strings. A window that crosses midnight is
 * supported (`start > end`, for example `22:00` to `06:00`). When
 * `start === end`, the window is a full 24 hours; with `enabled: false` there is
 * no restriction at all, which preserves the previous all-day behavior.
 */

/**
 * Shared desktop appearance themes. `oled` is the default and keeps the
 * existing pure-black surfaces; `dark` is a softer near-black palette and
 * `light` is a readable light palette.
 */
export const APP_THEMES = ['oled', 'dark', 'light'] as const
export type AppTheme = (typeof APP_THEMES)[number]
export const DEFAULT_THEME: AppTheme = 'oled'

export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 3
export const MIN_MAX_CONCURRENT_DOWNLOADS = 1
export const MAX_MAX_CONCURRENT_DOWNLOADS = 16

export const DEFAULT_PER_HOST_CONNECTIONS = 4
export const MIN_PER_HOST_CONNECTIONS = 1
export const MAX_PER_HOST_CONNECTIONS = 16

/** Global speed limit in bytes per second. Zero means unlimited. */
export const DEFAULT_GLOBAL_SPEED_LIMIT_BPS = 0
export const MIN_GLOBAL_SPEED_LIMIT_BPS = 0

/** Shared upper bound for the global and per-download speed limits: 1 GiB/s. */
export const MAX_SPEED_LIMIT_BPS = 1024 * 1024 * 1024

export const DEFAULT_ALLOWED_HOURS_ENABLED = false
export const DEFAULT_ALLOWED_HOURS_START = '00:00'
export const DEFAULT_ALLOWED_HOURS_END = '00:00'

/**
 * Largest timestamp accepted by an ECMAScript Date, used as a practical bound
 * for an optional scheduled start expressed in epoch milliseconds.
 */
export const MAX_EPOCH_MS = 8_640_000_000_000_000

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** Allowed-hours window in system local time. */
export interface AllowedHours {
  enabled: boolean
  /** Zero-padded 24-hour start time (`HH:mm`). */
  start: string
  /** Zero-padded 24-hour end time (`HH:mm`). */
  end: string
}

/** Renderer-safe persistent download-control settings. Contains no secrets. */
export interface DownloadSettings {
  maxConcurrentDownloads: number
  perHostConnections: number
  /** Bytes per second; `0` means unlimited. */
  globalSpeedLimitBps: number
  allowedHours: AllowedHours
  /** Desktop appearance. Defaults to the existing OLED/black look. */
  theme: AppTheme
}

/**
 * Optional per-download control values. `null` means unscheduled for
 * `scheduledAt`, unlimited for `speedLimitBps` and the global per-host value
 * for `connections`.
 */
export interface DownloadControls {
  /** Epoch milliseconds in the system local clock, or null when unscheduled. */
  scheduledAt: number | null
  /** Bytes per second, or null when unlimited. */
  speedLimitBps: number | null
  /**
   * Connections for this download (`split` and
   * `max-connection-per-server`), or null to use the global setting.
   */
  connections: number | null
}

export function defaultDownloadControls(): DownloadControls {
  return {
    scheduledAt: null,
    speedLimitBps: null,
    connections: null
  }
}

export function defaultDownloadSettings(): DownloadSettings {
  return {
    maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    perHostConnections: DEFAULT_PER_HOST_CONNECTIONS,
    globalSpeedLimitBps: DEFAULT_GLOBAL_SPEED_LIMIT_BPS,
    allowedHours: {
      enabled: DEFAULT_ALLOWED_HOURS_ENABLED,
      start: DEFAULT_ALLOWED_HOURS_START,
      end: DEFAULT_ALLOWED_HOURS_END
    },
    theme: DEFAULT_THEME
  }
}

function asPlainObject(
  value: unknown,
  subject: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`Invalid ${subject} payload.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  subject: string
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key)) {
      throw new ValidationError(
        `The ${subject} payload contains unsupported fields.`
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        `The ${subject} payload is missing required fields.`
      )
    }
  }
}

function integerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  subject: string
): number {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError(
      `The ${subject} payload contains an invalid number.`
    )
  }
  return value
}

function booleanValue(
  record: Record<string, unknown>,
  key: string,
  subject: string
): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new ValidationError(
      `The ${subject} payload contains an invalid flag.`
    )
  }
  return value
}

/** True only for one of the supported desktop themes. */
export function isAppTheme(value: unknown): value is AppTheme {
  return (
    typeof value === 'string' &&
    (APP_THEMES as readonly string[]).includes(value)
  )
}

/** Parse the desktop appearance theme. */
export function parseAppTheme(value: unknown): AppTheme {
  if (!isAppTheme(value)) {
    throw new ValidationError('Invalid theme.')
  }
  return value
}

/** True only for an exact, zero-padded 24-hour `HH:mm` string. */
export function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && CLOCK_TIME.test(value)
}

/** Parse and validate an exact 24-hour `HH:mm` local clock time. */
export function parseClockTime(value: unknown): string {
  if (!isClockTime(value)) {
    throw new ValidationError('Invalid clock time; use HH:mm (00:00-23:59).')
  }
  return value
}

export function parseAllowedHours(value: unknown): AllowedHours {
  const record = asPlainObject(value, 'allowed hours')
  exactKeys(record, ['enabled', 'start', 'end'], 'allowed hours')

  return {
    enabled: booleanValue(record, 'enabled', 'allowed hours'),
    start: parseClockTime(record.start),
    end: parseClockTime(record.end)
  }
}

/** Parse the persistent global download-control settings with exact keys. */
export function parseDownloadSettings(value: unknown): DownloadSettings {
  const record = asPlainObject(value, 'download settings')
  exactKeys(
    record,
    [
      'maxConcurrentDownloads',
      'perHostConnections',
      'globalSpeedLimitBps',
      'allowedHours',
      'theme'
    ],
    'download settings'
  )

  return {
    maxConcurrentDownloads: integerValue(
      record,
      'maxConcurrentDownloads',
      MIN_MAX_CONCURRENT_DOWNLOADS,
      MAX_MAX_CONCURRENT_DOWNLOADS,
      'download settings'
    ),
    perHostConnections: integerValue(
      record,
      'perHostConnections',
      MIN_PER_HOST_CONNECTIONS,
      MAX_PER_HOST_CONNECTIONS,
      'download settings'
    ),
    globalSpeedLimitBps: integerValue(
      record,
      'globalSpeedLimitBps',
      MIN_GLOBAL_SPEED_LIMIT_BPS,
      MAX_SPEED_LIMIT_BPS,
      'download settings'
    ),
    allowedHours: parseAllowedHours(record.allowedHours),
    theme: parseAppTheme(record.theme)
  }
}

/** Parse an optional epoch-milliseconds schedule; null means unscheduled. */
export function parseScheduledAt(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_EPOCH_MS
  ) {
    throw new ValidationError('Invalid scheduled start time.')
  }
  return value
}

/**
 * Parse an optional per-download speed limit; null means unlimited. Zero is
 * deliberately rejected here because the per-download contract uses null, not
 * zero, for "unlimited" (the global setting uses 0 for unlimited).
 */
export function parsePerDownloadSpeedLimitBps(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SPEED_LIMIT_BPS
  ) {
    throw new ValidationError('Invalid download speed limit.')
  }
  return value
}

/**
 * Parse an optional per-download connection count. Null defers to the global
 * `perHostConnections` setting; zero is not a valid connection count.
 */
export function parsePerDownloadConnections(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_PER_HOST_CONNECTIONS ||
    value > MAX_PER_HOST_CONNECTIONS
  ) {
    throw new ValidationError('Invalid download connection count.')
  }
  return value
}

/** Parse the optional per-download controls with exact keys. */
export function parseDownloadControls(value: unknown): DownloadControls {
  const record = asPlainObject(value, 'download controls')
  exactKeys(
    record,
    ['scheduledAt', 'speedLimitBps', 'connections'],
    'download controls'
  )

  return {
    scheduledAt: parseScheduledAt(record.scheduledAt),
    speedLimitBps: parsePerDownloadSpeedLimitBps(record.speedLimitBps),
    connections: parsePerDownloadConnections(record.connections)
  }
}
