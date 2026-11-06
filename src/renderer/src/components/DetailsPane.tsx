import type { JSX } from 'react'
import { formatBytes, formatSpeed } from '@shared/format'
import type { UnifiedRow } from '../lib/unified'
import { CATEGORY_LABELS } from '../lib/unified'
import { canOpenRow, canShowRow } from '../lib/actions'
import { CATEGORY_ACCENT, CATEGORY_ICON, Icon } from './Icon'
import { StatusBadge } from './StatusBadge'

function localTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

export function DetailsPane({
  row,
  onClose,
  onOpen,
  onShowInFolder
}: {
  row: UnifiedRow
  onClose: () => void
  onOpen: (row: UnifiedRow) => void
  onShowInFolder: (row: UnifiedRow) => void
}): JSX.Element {
  const openable = canOpenRow(row)
  const showable = canShowRow(row)

  return (
    <section
      aria-label={`Details for ${row.title}`}
      className="mt-3 shrink-0 overflow-hidden rounded-xl border border-white/10 surface-card"
    >
      <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-3 py-2">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] ${CATEGORY_ACCENT[row.category]}`}
        >
          <Icon name={CATEGORY_ICON[row.category]} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-100" title={row.title}>
            {row.title}
          </p>
          <p className="truncate text-[11px] text-zinc-500">
            {row.source === 'media' ? 'Media job' : 'Direct download'} ·{' '}
            {CATEGORY_LABELS[row.category]}
          </p>
        </div>
        <StatusBadge label={row.statusLabel} tone={row.statusTone} />
        {openable ? (
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-emerald-400/25 px-2 text-[11px] font-medium text-emerald-300 transition hover:bg-emerald-400/10"
          >
            <Icon name="external" size={12} />
            Open
          </button>
        ) : null}
        {showable ? (
          <button
            type="button"
            onClick={() => onShowInFolder(row)}
            aria-label={`Show ${row.title} in folder`}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <Icon name="folder" size={13} />
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

      <dl className="grid max-h-36 gap-x-6 gap-y-1.5 overflow-y-auto px-3 py-2.5 text-[11px] leading-5 sm:grid-cols-2 xl:grid-cols-3 min-[901px]:max-h-52">
        {row.url ? (
          <Detail label="Source URL" wide>
            <span className="break-all text-zinc-300" title={row.url}>
              {row.url}
            </span>
          </Detail>
        ) : null}
        {row.download?.filePath ? (
          <Detail label="Saved to" wide>
            <span className="break-all text-zinc-300">
              {row.download.filePath}
            </span>
          </Detail>
        ) : null}
        <Detail label="Size">
          <span className="tabular-nums text-zinc-300">
            {formatBytes(row.completedBytes)}
            {row.sizeBytes !== null ? ` / ${formatBytes(row.sizeBytes)}` : ''}
          </span>
        </Detail>
        {row.connections !== null ? (
          <Detail label="Connections / segments">
            <span className="tabular-nums text-zinc-300">{row.connections}</span>
          </Detail>
        ) : row.source === 'media' ? (
          <Detail label="Format">
            <span className="text-zinc-300">{row.subtitle}</span>
          </Detail>
        ) : null}
        {row.attempts !== null ? (
          <Detail label="Attempts">
            <span className="tabular-nums text-zinc-300">
              {row.attempts} of {row.maxAttempts ?? '—'}
            </span>
          </Detail>
        ) : null}
        {row.scheduledAt !== null ? (
          <Detail label="Scheduled">
            <span className="text-zinc-300">{localTime(row.scheduledAt)}</span>
          </Detail>
        ) : null}
        {row.speedLimitBps !== null ? (
          <Detail label="Speed limit">
            <span className="tabular-nums text-zinc-300">
              {formatSpeed(row.speedLimitBps)}
            </span>
          </Detail>
        ) : null}
        <Detail label="Updated">
          <span className="text-zinc-300">{localTime(row.updatedAt)}</span>
        </Detail>
        {row.completedAt !== null ? (
          <Detail label="Completed">
            <span className="text-zinc-300">{localTime(row.completedAt)}</span>
          </Detail>
        ) : null}
      </dl>

      {row.errorMessage ? (
        <p
          role="alert"
          className="mx-3 mb-2.5 rounded-lg border border-red-400/20 bg-red-400/5 px-2.5 py-1.5 text-[11px] leading-5 text-red-300"
        >
          {row.errorMessage}
        </p>
      ) : null}
    </section>
  )
}

function Detail({
  label,
  wide = false,
  children
}: {
  label: string
  wide?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <div className={`min-w-0 ${wide ? 'sm:col-span-2 xl:col-span-3' : ''}`}>
      <dt className="text-[11px] uppercase tracking-[0.12em] text-zinc-600">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
