import { describe, expect, it } from 'vitest'
import {
  clockMinutes,
  evaluateStart,
  isAllowedAt,
  isClockWithinAllowedHours,
  localClockParts
} from '../src/shared/schedule'
import type { AllowedHours } from '../src/shared/settings'

function hours(overrides: Partial<AllowedHours> = {}): AllowedHours {
  return { enabled: true, start: '09:00', end: '17:00', ...overrides }
}

function settings(allowedHours: AllowedHours): { allowedHours: AllowedHours } {
  return { allowedHours }
}

describe('allowed-hours boundaries', () => {
  it('allows every start when disabled, regardless of the stored times', () => {
    expect(
      isClockWithinAllowedHours(hours({ enabled: false }), {
        hour: 3,
        minute: 0
      })
    ).toBe(true)
  })

  it('treats equal start and end as a full day, not a zero-length block', () => {
    expect(
      isClockWithinAllowedHours(hours({ start: '07:30', end: '07:30' }), {
        hour: 7,
        minute: 29
      })
    ).toBe(true)
    expect(
      isClockWithinAllowedHours(hours({ start: '07:30', end: '07:30' }), {
        hour: 7,
        minute: 30
      })
    ).toBe(true)
  })

  it('includes the start minute and excludes the end minute', () => {
    const window = hours({ start: '09:00', end: '17:00' })
    expect(isClockWithinAllowedHours(window, { hour: 8, minute: 59 })).toBe(false)
    expect(isClockWithinAllowedHours(window, { hour: 9, minute: 0 })).toBe(true)
    expect(isClockWithinAllowedHours(window, { hour: 16, minute: 59 })).toBe(true)
    expect(isClockWithinAllowedHours(window, { hour: 17, minute: 0 })).toBe(false)
  })

  it('supports overnight windows across midnight', () => {
    const window = hours({ start: '22:00', end: '06:00' })
    expect(isClockWithinAllowedHours(window, { hour: 21, minute: 59 })).toBe(false)
    expect(isClockWithinAllowedHours(window, { hour: 22, minute: 0 })).toBe(true)
    expect(isClockWithinAllowedHours(window, { hour: 23, minute: 59 })).toBe(true)
    expect(isClockWithinAllowedHours(window, { hour: 0, minute: 0 })).toBe(true)
    expect(isClockWithinAllowedHours(window, { hour: 5, minute: 59 })).toBe(true)
    expect(isClockWithinAllowedHours(window, { hour: 6, minute: 0 })).toBe(false)
    expect(isClockWithinAllowedHours(window, { hour: 12, minute: 0 })).toBe(false)
  })

  it('parses validated clock strings to minutes after midnight', () => {
    expect(clockMinutes('00:00')).toBe(0)
    expect(clockMinutes('23:59')).toBe(1439)
  })
})

describe('scheduled start decisions', () => {
  const allDay = hours({ enabled: false })
  const due = Date.UTC(2026, 10, 4, 12, 0, 0)

  it('is due at the exact scheduled millisecond and after it', () => {
    expect(evaluateStart(settings(allDay), due, due).allowed).toBe(true)
    expect(evaluateStart(settings(allDay), due, due - 1)).toEqual({
      allowed: false,
      reason: 'scheduled'
    })
  })

  it('treats a past schedule as immediately due rather than expired', () => {
    expect(
      evaluateStart(settings(allDay), due - 60_000, due).allowed
    ).toBe(true)
    expect(evaluateStart(settings(allDay), null, due).allowed).toBe(true)
  })

  it('reports the more specific schedule block before allowed hours', () => {
    const blocked = settings(hours({ start: '23:00', end: '23:30' }))
    expect(evaluateStart(blocked, due + 60_000, due)).toEqual({
      allowed: false,
      reason: 'scheduled'
    })
  })

  it('blocks a due job outside the allowed window', () => {
    const blocked = settings(hours({ start: '23:00', end: '23:30' }))
    expect(evaluateStart(blocked, due, due)).toEqual({
      allowed: false,
      reason: 'allowed-hours'
    })
  })
})

describe('time-zone and DST behavior', () => {
  // DST starts in America/New_York at 02:00 local on 2026-03-08 and falls back
  // at 02:00 local on 2026-11-01. `Intl` values below are explicit so the test
  // is deterministic regardless of the machine time zone.
  const zone = 'America/New_York'

  it('uses local wall-clock minutes in the requested zone', () => {
    expect(
      localClockParts(Date.UTC(2026, 10, 4, 17, 30), zone)
    ).toEqual({ hour: 12, minute: 30 })
  })

  it('does not invent a start inside the skipped spring-forward hour', () => {
    const justBefore = Date.UTC(2026, 2, 8, 6, 30) // 01:30 EST
    const justAfter = Date.UTC(2026, 2, 8, 7, 30) // 03:30 EDT
    const window = settings(hours({ start: '02:00', end: '03:00' }))

    expect(localClockParts(justBefore, zone)).toEqual({ hour: 1, minute: 30 })
    expect(localClockParts(justAfter, zone)).toEqual({ hour: 3, minute: 30 })
    expect(isAllowedAt(window, justBefore, zone)).toBe(false)
    // 03:00 is the exclusive end, so 03:30 is outside as well.
    expect(isAllowedAt(window, justAfter, zone)).toBe(false)
  })

  it('evaluates both repeated fall-back 01:30 wall-clock instants', () => {
    const first = Date.UTC(2026, 10, 1, 5, 30) // 01:30 EDT
    const second = Date.UTC(2026, 10, 1, 6, 30) // 01:30 EST
    const window = settings(hours({ start: '01:00', end: '02:00' }))

    expect(localClockParts(first, zone)).toEqual({ hour: 1, minute: 30 })
    expect(localClockParts(second, zone)).toEqual({ hour: 1, minute: 30 })
    expect(isAllowedAt(window, first, zone)).toBe(true)
    expect(isAllowedAt(window, second, zone)).toBe(true)
  })

  it('supports an overnight window across a DST change', () => {
    const beforeMidnight = Date.UTC(2026, 2, 8, 4, 30) // 23:30 EST
    const afterMidnight = Date.UTC(2026, 2, 8, 7, 30) // 03:30 EDT
    const window = settings(hours({ start: '22:00', end: '06:00' }))

    expect(isAllowedAt(window, beforeMidnight, zone)).toBe(true)
    expect(isAllowedAt(window, afterMidnight, zone)).toBe(true)
  })
})
