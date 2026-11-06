import { useState, type JSX } from 'react'
import type { DownloadItem, DownloadStatus } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed } from '@shared/format'

interface DownloadCardProps {
  item: DownloadItem
  busy: boolean
  onPause: () => void
  onResume: () => void
  onStartNow: () => void
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

function statusLabel(item: DownloadItem): string {
  if (item.blockReason === 'scheduled') return 'Scheduled'
  if (item.blockReason === 'allowed-hours') return 'Allowed hours'
  return STATUS_LABEL[item.status]
}

function formatLocalTime(epochMs: number | null | undefined): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null
  try {
    return new Date(epochMs).toLocaleString()
  } catch {
    return null
  }
}

export function DownloadCard({
  item,
  busy,
  onPause,
  onResume,
  onStartNow,
  onRetry,
  onRemove,
  onShowInFolder
}: DownloadCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isComplete = item.status === 'complete'
  const percent = isComplete
    ? 100
    : formatPercent(item.completedBytes, item.totalBytes)
  const canPause =
    item.status === 'active' ||
    item.status === 'waiting' ||
    item.status === 'queued'
  const canResume = item.status === 'paused'
  const canStartNow =
    item.status === 'waiting' &&
    (item.blockReason === 'scheduled' || item.blockReason === 'allowed-hours')
  const canRetry =
    item.status === 'interrupted' ||
    (item.status === 'error' && item.attempts < item.maxAttempts)
  const scheduledLabel = formatLocalTime(item.scheduledAt)
  const updatedLabel = formatLocalTime(item.updatedAt)
  const detailsId = `download-${item.id}-details`

  return (
    <article
      aria-busy={busy}
      className="overflow-hidden rounded-xl border border-white/10 surface-card transition-colors hover:border-white/20"
    >
      <div className="flex items-start gap-2.5 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3
              className="truncate text-[13px] font-medium leading-5 text-zinc-100"
              title={item.filename}
            >
              {item.filename}
            </h3>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLE[item.status]}`}
            >
              {statusLabel(item)}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
            <span className="tabular-nums">
              <span className="text-zinc-300">
                {formatBytes(item.completedBytes)}
              </span>{' '}
              / {item.totalBytes > 0 ? formatBytes(item.totalBytes) : 'unknown'}
            </span>
            <span aria-hidden="true" className="text-zinc-600">
              ·
            </span>
            <span className="tabular-nums text-zinc-300">
              {Math.round(percent)}%
            </span>
            {item.status === 'active' ? (
              <>
                <span aria-hidden="true" className="text-zinc-600">
                  ·
                </span>
                <span className="tabular-nums text-zinc-300">
                  {formatSpeed(item.speedBps)}
                </span>
                <span aria-hidden="true" className="text-zinc-600">
                  ·
                </span>
                <span className="tabular-nums">
                  ETA {formatEta(item.etaSeconds)}
                </span>
              </>
            ) : null}
            {item.status === 'error' || item.status === 'interrupted' ? (
              <>
                <span aria-hidden="true" className="text-zinc-600">
                  ·
                </span>
                <span className="tabular-nums">
                  Attempt {item.attempts} of {item.maxAttempts}
                </span>
              </>
            ) : null}
          </div>

          <div
            role="progressbar"
            aria-label={`Download progress for ${item.filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${BAR_STYLE[item.status]}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-label={`${expanded ? 'Hide' : 'Show'} details for ${item.filename}`}
          title={expanded ? 'Hide details' : 'Show details'}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
        >
          <span
            aria-hidden="true"
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            ▾
          </span>
        </button>
      </div>

      {item.errorMessage ? (
        <p
          role="alert"
          title={item.errorMessage}
          className="mx-3 mb-2 line-clamp-2 rounded-lg border border-red-400/20 bg-red-400/5 px-2.5 py-1.5 text-[11px] leading-5 text-red-300"
        >
          {item.errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-white/5 px-3 py-2">
        {canStartNow ? (
          <CardAction
            disabled={busy}
            onClick={onStartNow}
            label="Start now"
            accent
          />
        ) : null}
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
          <CardAction
            disabled={busy}
            onClick={onShowInFolder}
            label="Show in folder"
          />
        ) : null}
        <CardAction disabled={busy} onClick={onRemove} label="Remove" danger />
      </div>

      {expanded ? (
        <dl
          id={detailsId}
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-white/5 surface-soft px-3 py-2 text-[11px] leading-5"
        >
          <dt className="text-zinc-400">Source</dt>
          <dd
            className="truncate text-right text-zinc-300"
            title={item.url}
          >
            {hostnameOf(item.url)}
          </dd>
          {scheduledLabel ? (
            <>
              <dt className="text-zinc-400">Scheduled</dt>
              <dd className="text-right text-zinc-300">{scheduledLabel}</dd>
            </>
          ) : null}
          {typeof item.speedLimitBps === 'number' ? (
            <>
              <dt className="text-zinc-400">Speed limit</dt>
              <dd className="text-right text-zinc-300">
                {formatSpeed(item.speedLimitBps)}
              </dd>
            </>
          ) : null}
          {typeof item.connections === 'number' ? (
            <>
              <dt className="text-zinc-400">Connections</dt>
              <dd className="text-right text-zinc-300">
                {item.connections}
              </dd>
            </>
          ) : null}
          {item.status === 'error' || item.status === 'interrupted' ? (
            <>
              <dt className="text-zinc-400">Attempts</dt>
              <dd className="text-right text-zinc-300">
                {item.attempts} of {item.maxAttempts}
              </dd>
            </>
          ) : null}
          {updatedLabel ? (
            <>
              <dt className="text-zinc-400">Updated</dt>
              <dd className="text-right text-zinc-300">{updatedLabel}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
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
      ? 'border-white/10 text-zinc-400 hover:border-red-400/30 hover:text-red-300'
      : 'border-white/10 text-zinc-300 hover:bg-white/5'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-8 rounded-lg border px-2.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {label}
    </button>
  )
}
