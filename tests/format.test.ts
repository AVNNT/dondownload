import { describe, expect, it } from 'vitest'
import {
  MEDIA_SIZE_UNKNOWN,
  MERGE_PROGRESS_MAX_PERCENT,
  formatBytes,
  formatCompactBytes,
  formatEta,
  formatMediaSize,
  formatMergeProgressLabel,
  formatPercent,
  formatSpeed,
  mergePercent
} from '../src/shared/format'
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

describe('formatMediaSize', () => {
  it('auto-formats exact and estimated media sizes', () => {
    expect(formatMediaSize(5 * 1024 * 1024)).toBe('5.00 MB')
    expect(formatMediaSize(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB')
    expect(formatMediaSize(5 * 1024 * 1024, true)).toBe('~5.00 MB estimated')
  })

  it('uses the exact unknown copy instead of inventing a size', () => {
    expect(formatMediaSize(null)).toBe(MEDIA_SIZE_UNKNOWN)
    expect(formatMediaSize(undefined)).toBe(MEDIA_SIZE_UNKNOWN)
    expect(formatMediaSize(0)).toBe(MEDIA_SIZE_UNKNOWN)
    expect(formatMediaSize(-1, true)).toBe(MEDIA_SIZE_UNKNOWN)
    expect(formatMediaSize(Number.NaN)).toBe(MEDIA_SIZE_UNKNOWN)
    expect(MEDIA_SIZE_UNKNOWN).toBe('Size unknown')
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

describe('merge progress formatting', () => {
  it('clamps the merge percent to 99 until the merge ends', () => {
    expect(mergePercent(0, 1000)).toBe(0)
    expect(mergePercent(410, 1000)).toBe(41)
    expect(mergePercent(999, 1000)).toBe(99)
    // A merge output that already matches the parts is still not finished.
    expect(mergePercent(1000, 1000)).toBe(99)
    expect(mergePercent(1500, 1000)).toBe(MERGE_PROGRESS_MAX_PERCENT)
    expect(mergePercent(-5, 1000)).toBe(0)
    expect(mergePercent(Number.NaN, 1000)).toBe(0)
    expect(mergePercent(500, 0)).toBe(0)
  })

  it('trims trailing zeros so byte pairs read naturally', () => {
    expect(formatCompactBytes(4.1 * 1024 ** 3)).toBe('4.1 GB')
    expect(formatCompactBytes(10.2 * 1024 ** 3)).toBe('10.2 GB')
    expect(formatCompactBytes(268 * 1024 ** 2)).toBe('268 MB')
    expect(formatCompactBytes(0)).toBe('0 B')
  })

  it('drops the repeated unit in the merge detail text', () => {
    expect(
      formatMergeProgressLabel(4.1 * 1024 ** 3, 10.2 * 1024 ** 3)
    ).toBe('4.1 of 10.2 GB')
    // Different units keep both, so the text stays unambiguous.
    expect(formatMergeProgressLabel(512 * 1024 ** 2, 2 * 1024 ** 3)).toBe(
      '512 MB of 2 GB'
    )
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
