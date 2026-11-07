import { describe, expect, it } from 'vitest'
import {
  MAX_SPEED_LIMIT_BPS,
  defaultDownloadSettings,
  parseDownloadSettings,
  type AllowedHours
} from '../src/shared/settings'
import {
  DEFAULT_HOURS_END,
  DEFAULT_HOURS_START,
  HOURS_EQUAL_HINT,
  MAX_SPEED_MB,
  SAVED_HINT_MS,
  SPEED_INVALID_HINT,
  SPEED_TOO_HIGH_HINT,
  TEXT_SAVE_DEBOUNCE_MS,
  applyHoursEdit,
  hoursConflict,
  parseSpeedLimitMb,
  settingsPayload,
  shouldApplyExternalSpeed,
  speedInputDirty,
  speedInputValue,
  speedLimitHelper,
  toggleAllowedHours
} from '../src/renderer/src/settingsAutoSave'

const OFF_HOURS: AllowedHours = { enabled: false, start: '00:00', end: '00:00' }

describe('settings auto-save rules', () => {
  it('keeps the debounce and saved-hint timings the UI promises', () => {
    expect(TEXT_SAVE_DEBOUNCE_MS).toBe(600)
    expect(SAVED_HINT_MS).toBe(1_500)
  })

  it('round-trips a stored speed limit through the input text', () => {
    expect(speedInputValue(0)).toBe('')
    expect(speedInputValue(-1)).toBe('')
    expect(speedInputValue(Number.NaN)).toBe('')
    expect(speedInputValue(5 * 1_000_000)).toBe('5')
    expect(speedInputValue(1_500_000)).toBe('1.5')
  })

  it('treats an empty speed field as "no limit" and rejects bad text', () => {
    expect(parseSpeedLimitMb('')).toEqual({ ok: true, bps: 0 })
    expect(parseSpeedLimitMb('   ')).toEqual({ ok: true, bps: 0 })
    expect(parseSpeedLimitMb('2.5')).toEqual({ ok: true, bps: 2_500_000 })

    for (const invalid of ['abc', '-', '-3', '1e999']) {
      expect(parseSpeedLimitMb(invalid)).toEqual({
        ok: false,
        hint: SPEED_INVALID_HINT
      })
    }
    expect(parseSpeedLimitMb(String(MAX_SPEED_MB + 1))).toEqual({
      ok: false,
      hint: SPEED_TOO_HIGH_HINT
    })
    expect(parseSpeedLimitMb(String(MAX_SPEED_MB))).toEqual({
      ok: true,
      bps: MAX_SPEED_LIMIT_BPS
    })
  })

  it('accepts every parsed speed as a valid download-settings payload', () => {
    for (const text of ['', '0', '0.5', '12', String(MAX_SPEED_MB)]) {
      const parsed = parseSpeedLimitMb(text)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(() =>
        parseDownloadSettings({
          ...defaultDownloadSettings(),
          globalSpeedLimitBps: parsed.bps
        })
      ).not.toThrow()
    }
  })

  it('shows the hourly helper only when a limit is set', () => {
    expect(speedLimitHelper(0)).toBeNull()
    expect(speedLimitHelper(-5)).toBeNull()
    expect(speedLimitHelper(Number.NaN)).toBeNull()
    // 3.6 GB/h per MB/s.
    expect(speedLimitHelper(1_000_000)).toBe('≈ 3.6 GB per hour')
    expect(speedLimitHelper(10_000_000)).toBe('≈ 36 GB per hour')
  })

  it('ignores an incomplete time edit instead of saving it', () => {
    const hours: AllowedHours = { enabled: true, start: '01:00', end: '07:00' }
    expect(applyHoursEdit(hours, { start: '' })).toBeNull()
    expect(applyHoursEdit(hours, { end: '' })).toBeNull()
    expect(applyHoursEdit(hours, { start: '02:00' })).toEqual({
      enabled: true,
      start: '02:00',
      end: '07:00'
    })
    expect(applyHoursEdit(hours, { end: '09:30' })).toEqual({
      enabled: true,
      start: '01:00',
      end: '09:30'
    })
  })

  it('prefills 01:00 - 07:00 the first time the window is enabled', () => {
    const enabled = toggleAllowedHours(OFF_HOURS, true)
    expect(enabled).toEqual({
      enabled: true,
      start: DEFAULT_HOURS_START,
      end: DEFAULT_HOURS_END
    })
    expect(DEFAULT_HOURS_START).toBe('01:00')
    expect(DEFAULT_HOURS_END).toBe('07:00')
    expect(() =>
      parseDownloadSettings({
        ...defaultDownloadSettings(),
        allowedHours: enabled
      })
    ).not.toThrow()
  })

  it('keeps an existing window and only flips the flag', () => {
    const configured: AllowedHours = {
      enabled: false,
      start: '22:00',
      end: '06:00'
    }
    expect(toggleAllowedHours(configured, true)).toEqual({
      enabled: true,
      start: '22:00',
      end: '06:00'
    })
    expect(
      toggleAllowedHours({ enabled: true, start: '01:00', end: '07:00' }, false)
    ).toEqual({ enabled: false, start: '01:00', end: '07:00' })
  })

  it('flags an enabled window whose start equals its end', () => {
    expect(hoursConflict({ enabled: true, start: '05:00', end: '05:00' })).toBe(
      true
    )
    expect(hoursConflict({ enabled: false, start: '05:00', end: '05:00' })).toBe(
      false
    )
    expect(hoursConflict({ enabled: true, start: '01:00', end: '07:00' })).toBe(
      false
    )
    expect(HOURS_EQUAL_HINT).toBe("Start and end can't be the same")
  })

  it('detects an unsaved speed edit from the input text, not the debounced draft', () => {
    const saved = defaultDownloadSettings()
    expect(speedInputDirty('', saved)).toBe(false)
    expect(speedInputDirty('2.5', saved)).toBe(true)
    expect(
      speedInputDirty('5', { ...saved, globalSpeedLimitBps: 5_000_000 })
    ).toBe(false)
  })

  it('lets an explicit external speed change win over a pending edit', () => {
    const saved = defaultDownloadSettings()
    const trayChoice = { ...saved, globalSpeedLimitBps: 5_000_000 }

    // Typed 2.5 MB/s is still waiting for its debounce when the tray picks 5.
    expect(shouldApplyExternalSpeed('2.5', saved, trayChoice)).toBe(true)
    // A non-speed external change must not clobber the text being edited.
    expect(
      shouldApplyExternalSpeed('2.5', saved, {
        ...saved,
        maxConcurrentDownloads: 7
      })
    ).toBe(false)
  })

  it('always sends the last saved theme with a draft payload', () => {
    const saved = { ...defaultDownloadSettings(), theme: 'light' as const }
    const draft = {
      ...saved,
      theme: 'oled' as const,
      maxConcurrentDownloads: 7
    }
    expect(settingsPayload(draft, saved)).toEqual({
      ...draft,
      theme: 'light'
    })
    expect(settingsPayload(draft, null)).toEqual(draft)
  })
})
