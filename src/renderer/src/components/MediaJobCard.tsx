import type { JSX } from 'react'
import {
  isActiveMediaJobStatus,
  type MediaJob,
  type MediaJobStatus
} from '@shared/media'
import { formatBytes, formatSpeed } from '@shared/format'

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
  const complete = job.status === 'complete'
  const queued = job.status === 'queued'
  const analyzing = job.status === 'analyzing'
  const merging = job.status === 'merging'
  const totalKnown = job.totalBytes !== null && job.totalBytes > 0
  const hasProgress = job.completedBytes > 0 || job.speedBps > 0
  // Before the first progress record arrives yt-dlp is still extracting and
  // resolving formats. Showing a static "0 B / 1.32 GB 0%" there made a 4K
  // download look frozen.
  const starting = job.status === 'downloading' && !hasProgress
  const sizeUnknown = job.status === 'downloading' && !totalKnown
  const indeterminate = queued || analyzing || merging || starting || sizeUnknown
  const percent = complete
    ? 100
    : totalKnown
      ? Math.min(
          100,
          Math.max(0, (job.completedBytes / (job.totalBytes ?? 1)) * 100)
        )
      : 0
  const roundedPercent = Math.round(percent)
  const phaseText = queued
    ? 'Queued'
    : analyzing
      ? 'Analyzing…'
      : merging
        ? 'Merging…'
        : starting
          ? 'Starting…'
          : sizeUnknown
            ? job.completedBytes > 0
              ? `Downloading (size unknown) · ${formatBytes(job.completedBytes)}`
              : 'Downloading (size unknown)'
            : `${roundedPercent}%`
  const statusLabel = queued
    ? 'Queued'
    : starting
      ? 'Starting…'
      : merging
        ? 'Merging…'
        : STATUS_LABEL[job.status]
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
          {statusLabel}
        </span>
      </div>

      <div className="mt-3">
        <div
          role="progressbar"
          aria-label={`Media download progress for ${job.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : roundedPercent}
          aria-valuetext={indeterminate ? phaseText : `${roundedPercent}%`}
          className={`relative h-1.5 overflow-hidden rounded-full bg-white/10 ${
            indeterminate ? 'media-progress-indeterminate' : ''
          } ${merging ? 'media-progress-merging' : ''}`}
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
          {indeterminate ? (
            <span className="truncate text-zinc-400" title={phaseText}>
              {phaseText}
            </span>
          ) : (
            <span>
              <span className="tabular-nums text-zinc-300">
                {formatBytes(job.completedBytes)}
              </span>{' '}
              /{' '}
              {totalKnown ? formatBytes(job.totalBytes ?? 0) : 'unknown'}
              <span className="ml-2 tabular-nums text-zinc-500">
                {`${roundedPercent}%`}
              </span>
            </span>
          )}
          <span className="flex items-center gap-3 tabular-nums">
            {job.status === 'downloading' && !starting ? (
              <span>{formatSpeed(job.speedBps)}</span>
            ) : null}
            {complete && job.totalBytes !== null ? (
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
