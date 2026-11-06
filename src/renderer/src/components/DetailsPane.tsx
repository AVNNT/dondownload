import { formatBytes, formatEta, formatSpeed } from '@shared/format'
import type { JSX } from 'react'
import type { StatusTone, UnifiedRow } from '../lib/unified'
import { CATEGORY_LABELS, retryCountdownText } from '../lib/unified'
import { useNowUntil } from '../lib/useNow'
import { canOpenRow, canShowRow } from '../lib/actions'
import { CATEGORY_ACCENT, CATEGORY_ICON, Icon, type IconName } from './Icon'

const PILL_TONE: Record<StatusTone, string> = {
  active: 'border-accent-400/30 bg-accent-400/10 text-accent-300',
  queued: 'border-white/10 bg-white/[0.04] text-zinc-300',
  paused: 'border-zinc-600/70 bg-zinc-800/60 text-zinc-300',
  complete: 'border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300',
  warning: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  failed: 'border-red-400/30 bg-red-400/10 text-red-300'
}

const PILL_DOT: Record<StatusTone, string> = {
  active: 'bg-accent-400',
  queued: 'bg-zinc-500',
  paused: 'bg-zinc-400',
  complete: 'bg-emerald-400',
  warning: 'bg-amber-400',
  failed: 'bg-red-400'
}

function shortDateTime(value: number): string {
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

export function DetailsPane({
  row,
  onClose,
  onOpen,
  onShowInFolder,
  onCopyLink
}: {
  row: UnifiedRow
  onClose: () => void
  onOpen: (row: UnifiedRow) => void
  onShowInFolder: (row: UnifiedRow) => void
  onCopyLink: (row: UnifiedRow) => void
}): JSX.Element {
  const openable = canOpenRow(row)
  const showable = canShowRow(row)
  // Keep the retry countdown live, and only run a timer while one is pending.
  const now = useNowUntil(1_000, [row.retryAt])

  return (
    <section
      aria-label={`Details for ${row.title}`}
      className="mt-3 shrink-0 overflow-hidden rounded-xl border border-white/10 surface-card"
    >
      <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-3 py-2.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] ${CATEGORY_ACCENT[row.category]}`}
        >
          <Icon name={CATEGORY_ICON[row.category]} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] font-semibold text-zinc-100"
            title={row.title}
          >
            {row.title}
          </p>
          <p className="truncate text-[11px] text-zinc-500">
            {row.source === 'media' ? 'Media job' : 'Direct download'} ·{' '}
            {CATEGORY_LABELS[row.category]}
          </p>
        </div>
        <StatusPill label={row.statusLabel} tone={row.statusTone} />
        {openable ? (
          <button
            type="button"
            onClick={() => onOpen(row)}
            aria-label={`Open ${row.title}`}
            title="Open file"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <Icon name="external" size={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2.5 text-[11.5px] text-zinc-400">
        <p className="tabular-nums">{progressLine(row, now)}</p>
        {row.media ? (
          <p className="truncate" title={row.media.label}>
            {row.media.label}
          </p>
        ) : null}
        {row.url ? (
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="link" size={13} className="shrink-0 text-zinc-600" />
            <span className="truncate" title={row.url}>
              {row.url}
            </span>
            <IconAction
              icon="copy"
              label="Copy link"
              onClick={() => onCopyLink(row)}
            />
          </div>
        ) : null}
        {row.filePath ? (
          <div className="flex min-w-0 items-center gap-2">
            {showable ? (
              <Icon
                name="folder"
                size={13}
                className="shrink-0 text-zinc-600"
              />
            ) : null}
            <span className="truncate" title={row.filePath}>
              {row.filePath}
            </span>
            {showable ? (
              <IconAction
                icon="folder"
                label="Show in folder"
                onClick={() => onShowInFolder(row)}
              />
            ) : null}
          </div>
        ) : null}
        {row.attempts !== null && row.attempts > 1 ? (
          <p>
            Retried {row.attempts - 1} {row.attempts - 1 === 1 ? 'time' : 'times'}
          </p>
        ) : null}
      </div>

      {row.errorMessage ? (
        <div className="mx-3 mb-2.5">
          <p
            role="alert"
            className="rounded-lg border border-red-400/20 bg-red-400/5 px-2.5 py-1.5 text-[11px] leading-5 text-red-300"
          >
            {row.errorMessage}
          </p>
          {row.errorDetail ? (
            <p className="mt-1 px-1 text-[10.5px] leading-4 text-zinc-500">
              <span className="font-semibold uppercase tracking-wide">
                Technical details
              </span>
              {': '}
              <span className="select-text" title={row.errorDetail}>
                {row.errorDetail}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function StatusPill({
  label,
  tone
}: {
  label: string
  tone: StatusTone
}): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PILL_TONE[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${PILL_DOT[tone]} ${tone === 'active' ? 'animate-pulse' : ''}`}
      />
      {label}
    </span>
  )
}

function IconAction({
  icon,
  label,
  onClick
}: {
  icon: IconName
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
    >
      <Icon name={icon} size={13} />
    </button>
  )
}
