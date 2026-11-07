const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Exact user-facing copy for a media size without usable metadata. */
export const MEDIA_SIZE_UNKNOWN = 'Size unknown'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

/**
 * Render a media size from existing yt-dlp metadata. Only values already
 * reported by the analysis are formatted; a missing value never gains a
 * made-up estimate. Approximate and merged sizes are explicitly marked.
 */
export function formatMediaSize(
  bytes: number | null | undefined,
  estimate = false
): string {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes <= 0
  ) {
    return MEDIA_SIZE_UNKNOWN
  }

  const formatted = formatBytes(bytes)
  return estimate ? `~${formatted} estimated` : formatted
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '0 B/s'
  }
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '--'
  }
  if (seconds < 1) {
    return '<1s'
  }

  const total = Math.floor(seconds)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secs = total % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`
  return `${secs}s`
}

export function formatPercent(completedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(completedBytes) || totalBytes <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, (completedBytes / totalBytes) * 100))
}

/**
 * A merge never reports 100%: the last percent belongs to the rename that
 * follows ffmpeg, so the bar must not claim the job is finished early.
 */
export const MERGE_PROGRESS_MAX_PERCENT = 99

/** Integer merge percent, clamped to 99 until the merge actually ends. */
export function mergePercent(
  completedBytes: number,
  totalBytes: number
): number {
  if (!Number.isFinite(completedBytes) || !Number.isFinite(totalBytes)) {
    return 0
  }
  if (totalBytes <= 0 || completedBytes <= 0) {
    return 0
  }
  const percent = Math.floor((completedBytes / totalBytes) * 100)
  return Math.min(MERGE_PROGRESS_MAX_PERCENT, Math.max(0, percent))
}

/** `formatBytes` with trailing zeros trimmed: "4.10 GB" reads as "4.1 GB". */
export function formatCompactBytes(bytes: number): string {
  const [value = '0', unit = 'B'] = formatBytes(bytes).split(' ')
  if (!value.includes('.')) return `${value} ${unit}`
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '')
  return `${trimmed} ${unit}`
}

/**
 * Merge detail text: `4.1 of 10.2 GB`. The unit is dropped from the first
 * number only when both values share it, which is the normal case.
 */
export function formatMergeProgressLabel(
  completedBytes: number,
  totalBytes: number
): string {
  const completed = formatCompactBytes(completedBytes)
  const total = formatCompactBytes(totalBytes)
  const [completedValue, completedUnit] = completed.split(' ')
  const totalUnit = total.split(' ')[1]
  const left = completedUnit === totalUnit ? completedValue : completed
  return `${left} of ${total}`
}
