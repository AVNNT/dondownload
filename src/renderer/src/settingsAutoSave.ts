import {
  MAX_SPEED_LIMIT_BPS,
  type AllowedHours,
  type DownloadSettings
} from '@shared/settings'

/**
 * Pure rules behind the Settings page's auto-save.
 *
 * The component owns timers, focus and IPC; everything that decides *what*
 * gets saved lives here so it can be tested without a DOM. Nothing in this
 * module touches `window` or the main process.
 */

export const BYTES_PER_MB = 1_000_000
export const MAX_SPEED_MB = MAX_SPEED_LIMIT_BPS / BYTES_PER_MB
/** Bytes that pass in an hour at 1 GB/h — converts bytes/sec to GB/hour. */
const BYTES_PER_GB_PER_HOUR = 1_000_000_000 / 3_600

/** Text fields wait this long after the last keystroke before they save. */
export const TEXT_SAVE_DEBOUNCE_MS = 600
/** How long the "Saved" hint stays visible before it fades away. */
export const SAVED_HINT_MS = 1_500

/** First-use window when "only during set hours" is switched on. */
export const DEFAULT_HOURS_START = '01:00'
export const DEFAULT_HOURS_END = '07:00'

export const SPEED_INVALID_HINT =
  'Enter a number of MB/s, or leave it empty for no limit.'
export const SPEED_TOO_HIGH_HINT = `The most you can set is ${MAX_SPEED_MB} MB/s.`
export const HOURS_EQUAL_HINT = "Start and end can't be the same"

/**
 * Render the stored bytes/sec value in MB/s for humans without ever writing
 * this rounded text back unless the user actually edits the field.
 */
export function speedInputValue(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  const mb = bytesPerSecond / BYTES_PER_MB
  const rounded = Number(mb.toFixed(mb >= 1 ? 3 : 6))
  return String(rounded)
}

export type SpeedLimitParse =
  | { ok: true; bps: number }
  | { ok: false; hint: string }

/**
 * Parse the speed-limit text field. An empty field means "no limit" (`0`).
 * Out-of-range or non-numeric text is rejected with the inline hint to show,
 * so the last valid value stays saved.
 */
export function parseSpeedLimitMb(value: string): SpeedLimitParse {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, bps: 0 }
  if (trimmed === '-') return { ok: false, hint: SPEED_INVALID_HINT }
  const mb = Number(trimmed)
  if (!Number.isFinite(mb) || mb < 0) {
    return { ok: false, hint: SPEED_INVALID_HINT }
  }
  if (mb > MAX_SPEED_MB) return { ok: false, hint: SPEED_TOO_HIGH_HINT }
  return { ok: true, bps: Math.round(mb * BYTES_PER_MB) }
}

/** Unobtrusive helper under the speed field; nothing when there is no limit. */
export function speedLimitHelper(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null
  const gigabytes = bytesPerSecond / BYTES_PER_GB_PER_HOUR
  const rounded = gigabytes >= 10 ? gigabytes.toFixed(0) : gigabytes.toFixed(1)
  return `≈ ${rounded} GB per hour`
}

/**
 * Apply a time-field edit. A time input reports `''` while the user is
 * mid-edit; that edit is ignored so an incomplete value is never saved.
 */
export function applyHoursEdit(
  current: AllowedHours,
  patch: { start?: string; end?: string }
): AllowedHours | null {
  const start = patch.start ?? current.start
  const end = patch.end ?? current.end
  if (start.length === 0 || end.length === 0) return null
  return { ...current, start, end }
}

/**
 * Flip the "only during set hours" switch. A first-time enable with a
 * zero-length window (start === end means "all day") prefills 01:00 – 07:00.
 */
export function toggleAllowedHours(
  current: AllowedHours,
  enabled: boolean
): AllowedHours {
  if (enabled && current.start === current.end) {
    return { enabled, start: DEFAULT_HOURS_START, end: DEFAULT_HOURS_END }
  }
  return { ...current, enabled }
}

/** True when the enabled window would show the "same start and end" hint. */
export function hoursConflict(hours: AllowedHours): boolean {
  return hours.enabled && hours.start === hours.end
}

/**
 * True when the speed INPUT text differs from the last saved value rendered in
 * that same text form. The draft only changes after the debounce, so comparing
 * the draft would miss an edit that is still waiting to be saved.
 */
export function speedInputDirty(
  speedInput: string,
  previous: DownloadSettings | null
): boolean {
  if (previous === null) return false
  return speedInput !== speedInputValue(previous.globalSpeedLimitBps)
}

/**
 * Whether an external settings update should replace the speed field. A speed
 * change from the tray/toolbar is an explicit newer choice and always wins; a
 * non-speed change never clobbers text the user is still editing.
 */
export function shouldApplyExternalSpeed(
  speedInput: string,
  previous: DownloadSettings | null,
  next: DownloadSettings
): boolean {
  if (previous === null) return true
  if (previous.globalSpeedLimitBps !== next.globalSpeedLimitBps) return true
  return !speedInputDirty(speedInput, previous)
}

/**
 * The exact payload sent to `updateSettings`: the newest draft, with the
 * theme taken from the last *saved* theme so an in-flight draft can never
 * roll back an appearance change made in the meantime.
 */
export function settingsPayload(
  draft: DownloadSettings,
  saved: DownloadSettings | null
): DownloadSettings {
  return saved ? { ...draft, theme: saved.theme } : draft
}
