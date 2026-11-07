import { formatBytes, formatEta, formatSpeed } from '@shared/format'
import type { UnifiedRow } from './unified'
import { retryCountdownText } from './unified'

/**
 * Pure formatting helpers for a unified row. Kept outside the component module
 * so the Node test project never needs DOM types just to exercise them.
 */
export function shortDateTime(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const time = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
  const today = new Date().toDateString()
  if (date.toDateString() === today) return `Today ${time}`
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${time}`
  }
  return `${date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric'
  })} ${time}`
}

/**
 * Plain-language size/progress summary. Active rows keep their live speed and
 * ETA; finished rows state when they landed; everything else shows bytes only.
 */
export function progressLine(row: UnifiedRow, now: number = Date.now()): string {
  const totalBytes = row.sizeBytes
  const sizeKnown = totalBytes !== null && totalBytes > 0
  // A job that has not received any bytes yet and has no known total has
  // effectively not started; "0 B" would read like a glitch.
  const range = sizeKnown
    ? `${formatBytes(row.completedBytes)} of ${formatBytes(totalBytes)}`
    : row.completedBytes > 0
      ? formatBytes(row.completedBytes)
      : 'Waiting to start'

  // A failed row never "waits to start": say so, and show the retry countdown
  // while an automatic retry is pending.
  if (row.statusGroup === 'failed') {
    const retryText = retryCountdownText(row.retryAt, now)
    if (retryText !== null) return retryText
    const failure = row.errorMessage ?? 'Failed'
    return sizeKnown || row.completedBytes > 0 ? `${failure} · ${range}` : failure
  }

  if (row.statusGroup === 'active') {
    if (row.speedBps > 0 && row.etaSeconds !== null) {
      return `${range} · ${formatSpeed(row.speedBps)} · ${formatEta(row.etaSeconds)} left`
    }
    if (row.speedBps > 0) return `${range} · ${formatSpeed(row.speedBps)}`
    return range
  }
  if (row.completedAt !== null) {
    return `${range} · finished ${shortDateTime(row.completedAt)}`
  }
  if (row.scheduledAt !== null) {
    return `Starts ${shortDateTime(row.scheduledAt)} · ${range}`
  }
  return range
}
