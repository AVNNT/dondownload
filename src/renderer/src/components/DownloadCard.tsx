import type { JSX } from 'react'
import type { DownloadItem, DownloadStatus } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed } from '@shared/format'

interface DownloadCardProps {
  item: DownloadItem
  busy: boolean
  onPause: () => void
  onResume: () => void
  onRetry: () => void
  onRemove: () => void
  onShowInFolder: () => void
}

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: 'Queued',
  active: 'Downloading',
  waiting: 'Waiting',
  paused: 'Paused',
  complete: 'Complete',
  error: 'Failed',
  interrupted: 'Interrupted'
}

const STATUS_STYLE: Record<DownloadStatus, string> = {
  queued: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  active: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  waiting: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  paused: 'border-zinc-600 bg-zinc-800/80 text-zinc-300',
  complete: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  error: 'border-red-400/30 bg-red-400/10 text-red-300',
  interrupted: 'border-amber-400/30 bg-amber-400/10 text-amber-300'
}

const BAR_STYLE: Record<DownloadStatus, string> = {
  queued: 'bg-zinc-600',
  active: 'bg-emerald-400',
  waiting: 'bg-amber-400',
  paused: 'bg-zinc-500',
  complete: 'bg-emerald-400',
  error: 'bg-red-400',
  interrupted: 'bg-amber-400'
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function DownloadCard({
  item,
  busy,
  onPause,
  onResume,
  onRetry,
  onRemove,
  onShowInFolder
}: DownloadCardProps): JSX.Element {
  const percent = formatPercent(item.completedBytes, item.totalBytes)
  const canPause =
    item.status === 'active' ||
    item.status === 'waiting' ||
    item.status === 'queued'
  const canResume = item.status === 'paused'
  const canRetry =
    item.status === 'interrupted' ||
    (item.status === 'error' && item.attempts < item.maxAttempts)
  const isComplete = item.status === 'complete'

  return (
    <article className="rounded-2xl border border-white/10 bg-[#070707] p-4 transition-colors hover:border-white/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className="truncate text-sm font-medium text-zinc-100"
            title={item.filename}
          >
            {item.filename}
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500" title={item.url}>
            {hostnameOf(item.url)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[item.status]}`}
        >
          {STATUS_LABEL[item.status]}
        </span>
      </div>

      <div className="mt-4">
        <div
          role="progressbar"
          aria-label={`Download progress for ${item.filename}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${BAR_STYLE[item.status]} ${
              item.status === 'active' ? 'animate-pulse' : ''
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span>
            <span className="tabular-nums text-zinc-300">
              {formatBytes(item.completedBytes)}
            </span>{' '}
            / {item.totalBytes > 0 ? formatBytes(item.totalBytes) : 'unknown'}
            <span className="ml-2 tabular-nums text-zinc-600">
              {Math.round(percent)}%
            </span>
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            {item.status === 'active' ? (
              <>
                <span>{formatSpeed(item.speedBps)}</span>
                <span>ETA {formatEta(item.etaSeconds)}</span>
              </>
            ) : null}
            {isComplete ? <span>{formatBytes(item.totalBytes)}</span> : null}
            {item.status === 'error' || item.status === 'interrupted' ? (
              <span>
                Attempt {item.attempts} of {item.maxAttempts}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {item.errorMessage ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-300"
        >
          {item.errorMessage}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {canPause ? (
          <CardAction disabled={busy} onClick={onPause} label="Pause" />
        ) : null}
        {canResume ? (
          <CardAction disabled={busy} onClick={onResume} label="Resume" />
        ) : null}
        {canRetry ? (
          <CardAction disabled={busy} onClick={onRetry} label="Retry" accent />
        ) : null}
        {isComplete ? (
          <CardAction disabled={busy} onClick={onShowInFolder} label="Show in folder" />
        ) : null}
        <CardAction disabled={busy} onClick={onRemove} label="Remove" danger />
      </div>
    </article>
  )
}

function CardAction({
  label,
  onClick,
  disabled,
  accent = false,
  danger = false
}: {
  label: string
  onClick: () => void
  disabled: boolean
  accent?: boolean
  danger?: boolean
}): JSX.Element {
  const tone = accent
    ? 'border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10'
    : danger
      ? 'border-white/10 text-zinc-500 hover:border-red-400/30 hover:text-red-300'
      : 'border-white/10 text-zinc-300 hover:bg-white/5'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {label}
    </button>
  )
}
