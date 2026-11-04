import { describe, expect, it } from 'vitest'
import { formatBytes, formatEta, formatPercent, formatSpeed } from '../src/shared/format'
import { MAX_DOWNLOAD_ATTEMPTS, canRetry } from '../src/shared/policy'

describe('formatBytes', () => {
  it('formats zero, bytes and binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
  })
})

describe('formatSpeed', () => {
  it('suffixes bytes per second', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(1536)).toBe('1.50 KB/s')
  })
})

describe('formatEta', () => {
  it('handles unknown, short and multi-part durations', () => {
    expect(formatEta(null)).toBe('--')
    expect(formatEta(0)).toBe('<1s')
    expect(formatEta(42)).toBe('42s')
    expect(formatEta(65)).toBe('1m 05s')
    expect(formatEta(3661)).toBe('1h 01m')
    expect(formatEta(90_000)).toBe('1d 1h')
  })
})

describe('formatPercent', () => {
  it('guards against unknown totals and clamps at 100', () => {
    expect(formatPercent(50, 100)).toBe(50)
    expect(formatPercent(5, 0)).toBe(0)
    expect(formatPercent(200, 100)).toBe(100)
    expect(formatPercent(-1, 100)).toBe(0)
  })
})

describe('retry policy', () => {
  it('allows attempts below the maximum only', () => {
    expect(MAX_DOWNLOAD_ATTEMPTS).toBe(3)
    expect(canRetry(1)).toBe(true)
    expect(canRetry(2)).toBe(true)
    expect(canRetry(3)).toBe(false)
    expect(canRetry(4)).toBe(false)
  })

  it('rejects invalid attempt counts', () => {
    expect(canRetry(0)).toBe(false)
    expect(canRetry(1.5)).toBe(false)
    expect(canRetry(Number.NaN)).toBe(false)
  })

  it('supports a custom maximum', () => {
    expect(canRetry(4, 6)).toBe(true)
    expect(canRetry(6, 6)).toBe(false)
  })
})
