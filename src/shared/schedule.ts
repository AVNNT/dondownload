import type { AllowedHours, DownloadSettings } from './settings'
import type { DownloadBlockReason } from './types'

/**
 * Pure local-time policy helpers for scheduled starts and allowed hours.
 *
 * Boundary rules (deliberately documented and tested):
 * - `scheduledAt` is due when `now >= scheduledAt` (inclusive). A schedule in
 *   the past is therefore immediately due; it never expires into "never".
 * - The allowed-hours start is inclusive and the end is exclusive:
 *   `[start, end)` in local wall-clock time.
 * - `start === end` is a full 24-hour window (not a zero-length window).
 * - `start > end` is an overnight window, for example `[22:00, 24:00)` plus
 *   `[00:00, 06:00)`.
 * - `enabled: false` always allows a start regardless of the times.
 *
 * Time is always evaluated against the system local clock. Tests may pass an
 * explicit IANA time zone to `localClockParts`/`isAllowedAt` to exercise DST
 * transitions deterministically; production calls omit it.
 */

export interface LocalClock {
  hour: number
  minute: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
  formatterCache.set(timeZone, formatter)
  return formatter
}

/** Resolve the local wall-clock components for an epoch-millisecond value. */
export function localClockParts(
  epochMs: number,
  timeZone?: string
): LocalClock {
  if (!timeZone) {
    const date = new Date(epochMs)
    return { hour: date.getHours(), minute: date.getMinutes() }
  }

  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs))
  let hour = 0
  let minute = 0
  for (const part of parts) {
    if (part.type === 'hour') hour = Number(part.value)
    else if (part.type === 'minute') minute = Number(part.value)
  }
  return {
    hour: Number.isInteger(hour) ? ((hour % 24) + 24) % 24 : 0,
    minute: Number.isInteger(minute) ? Math.min(59, Math.max(0, minute)) : 0
  }
}

export function localMinutes(clock: LocalClock): number {
  return clock.hour * 60 + clock.minute
}

/** Parse a validated `HH:mm` value into minutes after local midnight. */
export function clockMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
}

export function isClockWithinAllowedHours(
  allowedHours: AllowedHours,
  clock: LocalClock
): boolean {
  if (!allowedHours.enabled) return true

  const start = clockMinutes(allowedHours.start)
  const end = clockMinutes(allowedHours.end)
  const current = localMinutes(clock)

  // Equal boundaries intentionally mean the full day, never a blocked day.
  if (start === end) return true
  if (start < end) return current >= start && current < end
  // Overnight: the window runs through midnight and ends before `end`.
  return current >= start || current < end
}

/** True when `now` is inside the configured local-time allowed window. */
export function isAllowedAt(
  settings: Pick<DownloadSettings, 'allowedHours'>,
  nowMs: number,
  timeZone?: string
): boolean {
  return isClockWithinAllowedHours(
    settings.allowedHours,
    localClockParts(nowMs, timeZone)
  )
}

export interface StartDecision {
  allowed: boolean
  /** Null when allowed; otherwise the policy holding the job back. */
  reason: DownloadBlockReason | null
}

/**
 * Decide whether a download may be handed to aria2 now. A future schedule is
 * checked before allowed hours so the UI can show the more specific reason.
 */
export function evaluateStart(
  settings: Pick<DownloadSettings, 'allowedHours'>,
  scheduledAt: number | null,
  nowMs: number,
  timeZone?: string
): StartDecision {
  if (scheduledAt !== null && nowMs < scheduledAt) {
    return { allowed: false, reason: 'scheduled' }
  }
  if (!isAllowedAt(settings, nowMs, timeZone)) {
    return { allowed: false, reason: 'allowed-hours' }
  }
  return { allowed: true, reason: null }
}
