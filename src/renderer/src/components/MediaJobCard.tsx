import type { JSX } from 'react'
import {
  isActiveMediaJobStatus,
  type MediaJob,
  type MediaJobStatus
} from '@shared/media'
import { formatBytes, formatPercent, formatSpeed } from '@shared/format'

interface MediaJobCardProps {
  job: MediaJob
  busy: boolean
  onCancel: () => void
  onRemove: () => void
  onShowInFolder: () => void
}

const STATUS_LABEL: Record<MediaJobStatus, string> = {
  queued: 'Queued',
  analyzing: 'Analyzing',
  downloading: 'Downloading',
  merging: 'Merging',
  complete: 'Complete',
  error: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

const STATUS_STYLE: Record<MediaJobStatus, string> = {
  queued: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  analyzing: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  downloading: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  merging: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  complete: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  error: 'border-red-400/30 bg-red-400/10 text-red-300',
  cancelled: 'border-zinc-600 bg-zinc-800/80 text-zinc-300',
  interrupted: 'border-amber-400/30 bg-amber-400/10 text-amber-300'
}

const BAR_STYLE: Record<MediaJobStatus, string> = {
  queued: 'bg-zinc-600',
  analyzing: 'bg-amber-400',
  downloading: 'bg-emerald-400',
  merging: 'bg-amber-400',
  complete: 'bg-emerald-400',
  error: 'bg-red-400',
  cancelled: 'bg-zinc-500',
  interrupted: 'bg-amber-400'
}

export function mediaStatusLabel(status: MediaJobStatus): string {
  return STATUS_LABEL[status]
}

export function MediaJobCard({
  job,
  busy,
  onCancel,
  onRemove,
  onShowInFolder
}: MediaJobCardProps): JSX.Element {
  const active = isActiveMediaJobStatus(job.status)
  const indeterminate = job.status === 'analyzing' || job.status === 'merging'
  const percent =
    job.status === 'complete'
      ? 100
      : formatPercent(job.completedBytes, job.totalBytes ?? 0)
  const titleId = `media-job-${job.id}-title`
  const kindLabel = job.kind === 'video' ? 'Video' : 'Audio'

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-xl border border-white/10 surface-card p-3 transition-colors hover:border-white/20"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id={titleId}
            className="truncate text-sm font-medium text-zinc-100"
            title={job.title}
          >
            {job.title}
          </h3>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
            <span className="shrink-0 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
              {kindLabel}
            </span>
            <span className="truncate" title={job.label}>
              {job.label}
            </span>
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[job.status]}`}
        >
          {STATUS_LABEL[job.status]}
        </span>
      </div>

      <div className="mt-3">
        <div
          role="progressbar"
          aria-label={`Media download progress for ${job.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : Math.round(percent)}
          aria-valuetext={
            indeterminate
              ? `${STATUS_LABEL[job.status]}…`
              : `${Math.round(percent)}%`
          }
          className={`relative h-1.5 overflow-hidden rounded-full bg-white/10 ${
            indeterminate ? 'media-progress-indeterminate' : ''
          } ${job.status === 'merging' ? 'media-progress-merging' : ''}`}
        >
          {indeterminate ? null : (
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${BAR_STYLE[job.status]} ${
                job.status === 'downloading' ? 'animate-pulse' : ''
              }`}
              style={{ width: `${percent}%` }}
            />
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-zinc-400">
          <span>
            <span className="tabular-nums text-zinc-300">
              {formatBytes(job.completedBytes)}
            </span>{' '}
            /{' '}
            {job.totalBytes !== null && job.totalBytes > 0
              ? formatBytes(job.totalBytes)
              : 'unknown'}
            <span className="ml-2 tabular-nums text-zinc-500">
              {indeterminate ? STATUS_LABEL[job.status] : `${Math.round(percent)}%`}
            </span>
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            {job.status === 'downloading' ? (
              <span>{formatSpeed(job.speedBps)}</span>
            ) : null}
            {job.status === 'complete' && job.totalBytes !== null ? (
              <span>{formatBytes(job.totalBytes)}</span>
            ) : null}
          </span>
        </div>
      </div>

      {job.errorMessage ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-300"
        >
          {job.errorMessage}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {active ? (
          <CardAction disabled={busy} onClick={onCancel} label="Cancel" danger />
        ) : null}
        {job.status === 'complete' ? (
          <CardAction
            disabled={busy}
            onClick={onShowInFolder}
            label="Show in folder"
          />
        ) : null}
        {active ? null : (
          <CardAction disabled={busy} onClick={onRemove} label="Remove" danger />
        )}
      </div>
    </article>
  )
}

function CardAction({
  label,
  onClick,
  disabled,
  danger = false
}: {
  label: string
  onClick: () => void
  disabled: boolean
  danger?: boolean
}): JSX.Element {
  const tone = danger
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
