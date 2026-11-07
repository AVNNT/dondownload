import { describe, expect, it } from 'vitest'
import {
  APP_THEMES,
  DEFAULT_ALLOWED_HOURS_END,
  DEFAULT_ALLOWED_HOURS_START,
  DEFAULT_GLOBAL_SPEED_LIMIT_BPS,
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  DEFAULT_PER_HOST_CONNECTIONS,
  DEFAULT_THEME,
  MAX_EPOCH_MS,
  MAX_SPEED_LIMIT_BPS,
  defaultDownloadSettings,
  isAppTheme,
  isClockTime,
  parseAllowedHours,
  parseAppTheme,
  parseClockTime,
  parseDownloadControls,
  parseDownloadSettings,
  parsePerDownloadConnections,
  parsePerDownloadSpeedLimitBps,
  parseScheduledAt,
  type DownloadSettings
} from '../src/shared/settings'

function validSettings(
  overrides: Partial<DownloadSettings> = {}
): DownloadSettings {
  return {
    ...defaultDownloadSettings(),
    ...overrides
  }
}

describe('download settings contract', () => {
  it('exposes the documented defaults', () => {
    const settings = defaultDownloadSettings()
    expect(settings).toEqual({
      maxConcurrentDownloads: 3,
      perHostConnections: 16,
      globalSpeedLimitBps: 0,
      allowedHours: {
        enabled: false,
        start: '00:00',
        end: '00:00'
      },
      theme: 'oled',
      sortDownloadsByType: false
    })
    expect(DEFAULT_MAX_CONCURRENT_DOWNLOADS).toBe(3)
    expect(DEFAULT_PER_HOST_CONNECTIONS).toBe(16)
    expect(DEFAULT_GLOBAL_SPEED_LIMIT_BPS).toBe(0)
    expect(DEFAULT_ALLOWED_HOURS_START).toBe('00:00')
    expect(DEFAULT_ALLOWED_HOURS_END).toBe('00:00')
    expect(DEFAULT_THEME).toBe('oled')
    expect(APP_THEMES).toEqual(['oled', 'dark', 'light'])
    expect(MAX_SPEED_LIMIT_BPS).toBe(1024 * 1024 * 1024)
  })

  it('returns an independent defaults object on every call', () => {
    const first = defaultDownloadSettings()
    const second = defaultDownloadSettings()
    expect(first).not.toBe(second)
    expect(first.allowedHours).not.toBe(second.allowedHours)
    first.allowedHours.start = '08:00'
    expect(second.allowedHours.start).toBe('00:00')
  })

  it('round-trips defaults and custom values through the exact-key parser', () => {
    expect(parseDownloadSettings(defaultDownloadSettings())).toEqual(
      defaultDownloadSettings()
    )

    const custom: DownloadSettings = {
      maxConcurrentDownloads: 16,
      perHostConnections: 12,
      globalSpeedLimitBps: MAX_SPEED_LIMIT_BPS,
      allowedHours: {
        enabled: true,
        start: '22:00',
        end: '06:00'
      },
      theme: 'light',
      sortDownloadsByType: true
    }
    expect(parseDownloadSettings(custom)).toEqual(custom)
    expect(parseDownloadSettings(validSettings())).toEqual(validSettings())
  })

  it('accepts inclusive bounds and all-day start === end windows', () => {
    for (const maxConcurrentDownloads of [1, 16]) {
      for (const perHostConnections of [1, 16]) {
        for (const globalSpeedLimitBps of [0, 1, MAX_SPEED_LIMIT_BPS]) {
          const settings = {
            maxConcurrentDownloads,
            perHostConnections,
            globalSpeedLimitBps,
            allowedHours: {
              enabled: true,
              start: '00:00',
              end: '00:00'
            },
            theme: 'oled' as const,
            sortDownloadsByType: false
          }
          expect(parseDownloadSettings(settings)).toEqual(settings)
        }
      }
    }

    expect(
      parseAllowedHours({ enabled: true, start: '23:59', end: '23:59' })
    ).toEqual({ enabled: true, start: '23:59', end: '23:59' })
    expect(
      parseAllowedHours({ enabled: false, start: '00:00', end: '23:59' })
    ).toEqual({ enabled: false, start: '00:00', end: '23:59' })
  })

  it('rejects missing, unknown, null and wrongly typed settings fields', () => {
    const missing = {
      maxConcurrentDownloads: 3,
      perHostConnections: 4,
      globalSpeedLimitBps: 0
    }
    expect(() => parseDownloadSettings(missing)).toThrow(/missing/)
    expect(() =>
      parseDownloadSettings({ ...validSettings(), extra: true })
    ).toThrow(/unsupported fields/)
    expect(() => parseDownloadSettings(null)).toThrow(/Invalid/)
    expect(() => parseDownloadSettings([])).toThrow(/Invalid/)
    expect(() =>
      parseDownloadSettings(validSettings({ maxConcurrentDownloads: '3' as never }))
    ).toThrow(/invalid number/)
    expect(() =>
      parseDownloadSettings(
        validSettings({ allowedHours: { enabled: 0 as never, start: '00:00', end: '00:00' } })
      )
    ).toThrow(/invalid flag/)
    expect(() =>
      parseDownloadSettings({ ...validSettings(), url: 'https://example.com' })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseDownloadSettings({ ...validSettings(), path: 'C:\\secret' })
    ).toThrow(/unsupported fields/)
  })

  it('rejects every out-of-range integer setting', () => {
    const invalid: Partial<DownloadSettings>[] = [
      { maxConcurrentDownloads: 0 },
      { maxConcurrentDownloads: 17 },
      { maxConcurrentDownloads: 1.5 },
      { maxConcurrentDownloads: Number.NaN },
      { perHostConnections: 0 },
      { perHostConnections: 17 },
      { perHostConnections: 4.5 },
      { globalSpeedLimitBps: -1 },
      { globalSpeedLimitBps: MAX_SPEED_LIMIT_BPS + 1 },
      { globalSpeedLimitBps: 1.5 }
    ]
    for (const overrides of invalid) {
      expect(() => parseDownloadSettings(validSettings(overrides))).toThrow(
        /invalid number/
      )
    }
  })

  it('accepts only exact zero-padded 24-hour clock strings', () => {
    for (const value of ['00:00', '09:05', '12:30', '23:59']) {
      expect(isClockTime(value)).toBe(true)
      expect(parseClockTime(value)).toBe(value)
    }
    for (const value of [
      '24:00',
      '9:05',
      '09:5',
      '09:60',
      '23:59:00',
      ' 09:05',
      '09:05 ',
      'ab:cd',
      ''
    ]) {
      expect(isClockTime(value)).toBe(false)
      expect(() => parseClockTime(value)).toThrow(/HH:mm/)
    }
    expect(isClockTime(905)).toBe(false)
  })

  it('rejects malformed allowed-hours objects and bad clock values', () => {
    expect(() =>
      parseAllowedHours({ enabled: true, start: '08:00' })
    ).toThrow(/missing/)
    expect(() =>
      parseAllowedHours({ enabled: true, start: '08:00', end: '18:00', zone: 'utc' })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseAllowedHours({ enabled: true, start: '8:00', end: '18:00' })
    ).toThrow(/HH:mm/)
    expect(() =>
      parseAllowedHours({ enabled: true, start: '08:00', end: '24:00' })
    ).toThrow(/HH:mm/)
  })

  it('accepts only the shared OLED, dark and light themes', () => {
    for (const theme of APP_THEMES) {
      expect(isAppTheme(theme)).toBe(true)
      expect(parseAppTheme(theme)).toBe(theme)
      expect(parseDownloadSettings(validSettings({ theme })).theme).toBe(theme)
    }
    for (const value of ['system', 'DARK', '', null, undefined, 1]) {
      expect(isAppTheme(value)).toBe(false)
      expect(() => parseAppTheme(value)).toThrow(/Invalid theme/)
    }
    expect(() =>
      parseDownloadSettings(validSettings({ theme: 'system' as never }))
    ).toThrow(/Invalid theme/)
    expect(() =>
      parseDownloadSettings({
        maxConcurrentDownloads: 3,
        perHostConnections: 4,
        globalSpeedLimitBps: 0,
        allowedHours: { enabled: false, start: '00:00', end: '00:00' }
      })
    ).toThrow(/missing/)
  })

  it('accepts only boolean sort-by-type values', () => {
    expect(
      parseDownloadSettings(validSettings({ sortDownloadsByType: true }))
        .sortDownloadsByType
    ).toBe(true)
    for (const value of [0, 1, 'true', null, undefined]) {
      expect(() =>
        parseDownloadSettings(
          validSettings({ sortDownloadsByType: value as never })
        )
      ).toThrow(/invalid flag/)
    }
    expect(() =>
      parseDownloadSettings({
        maxConcurrentDownloads: 3,
        perHostConnections: 16,
        globalSpeedLimitBps: 0,
        allowedHours: { enabled: false, start: '00:00', end: '00:00' },
        theme: 'oled'
      })
    ).toThrow(/missing/)
  })
})

describe('per-download controls contract', () => {
  it('accepts null for unscheduled, unlimited and global connections', () => {
    expect(
      parseDownloadControls({
        scheduledAt: null,
        speedLimitBps: null,
        connections: null
      })
    ).toEqual({
      scheduledAt: null,
      speedLimitBps: null,
      connections: null
    })
  })

  it('round-trips bounded epoch milliseconds, speed limits and connections', () => {
    const controls = {
      scheduledAt: Date.UTC(2026, 10, 4, 12, 30),
      speedLimitBps: 8 * 1024 * 1024,
      connections: 6
    }
    expect(parseDownloadControls(controls)).toEqual(controls)
    expect(parseScheduledAt(0)).toBe(0)
    expect(parseScheduledAt(MAX_EPOCH_MS)).toBe(MAX_EPOCH_MS)
    expect(parsePerDownloadSpeedLimitBps(1)).toBe(1)
    expect(parsePerDownloadSpeedLimitBps(MAX_SPEED_LIMIT_BPS)).toBe(
      MAX_SPEED_LIMIT_BPS
    )
    expect(parsePerDownloadConnections(null)).toBeNull()
    expect(parsePerDownloadConnections(1)).toBe(1)
    expect(parsePerDownloadConnections(16)).toBe(16)
  })

  it('rejects unsafe, negative or out-of-range control values', () => {
    for (const scheduledAt of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, MAX_EPOCH_MS + 1]) {
      expect(() => parseScheduledAt(scheduledAt)).toThrow(/Invalid/)
    }
    expect(() => parseScheduledAt(undefined)).toThrow(/Invalid/)
    expect(() => parseScheduledAt('1700000000000')).toThrow(/Invalid/)

    for (const speedLimitBps of [0, -1, 1.5, Number.NaN, MAX_SPEED_LIMIT_BPS + 1]) {
      expect(() => parsePerDownloadSpeedLimitBps(speedLimitBps)).toThrow(
        /Invalid/
      )
    }
    expect(() => parsePerDownloadSpeedLimitBps(undefined)).toThrow(/Invalid/)
    expect(() => parsePerDownloadSpeedLimitBps('1024')).toThrow(/Invalid/)

    for (const connections of [0, -1, 1.5, 17, Number.NaN]) {
      expect(() => parsePerDownloadConnections(connections)).toThrow(/Invalid/)
    }
    expect(() => parsePerDownloadConnections(undefined)).toThrow(/Invalid/)
    expect(() => parsePerDownloadConnections('4')).toThrow(/Invalid/)
  })

  it('uses exact keys and rejects URL or path additions', () => {
    expect(() =>
      parseDownloadControls({
        scheduledAt: null,
        speedLimitBps: null,
        connections: null,
        url: 'x'
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseDownloadControls({
        scheduledAt: null,
        speedLimitBps: null,
        connections: null,
        path: 'x'
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseDownloadControls({ scheduledAt: null, speedLimitBps: null })
    ).toThrow(/missing/)
  })
})
