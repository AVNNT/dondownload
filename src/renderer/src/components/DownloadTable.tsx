import {
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { UnifiedRow } from '../lib/unified'
import {
  isSelected,
  type SelectionMode,
  type SelectionState
} from '../lib/selection'
import { canOpenRow, canShowRow } from '../lib/actions'
import { CATEGORY_ACCENT, CATEGORY_ICON, Icon } from './Icon'
import type { ThumbnailFallback } from './Thumbnail'
import { Thumbnail } from './Thumbnail'
import { formatBytes, formatEta, formatSpeed } from '@shared/format'

/*
 * Row grid matches the mockup list:
 *   wide  → 40px icon · name · progress/state · 84px size · 104px actions
 *   narrow→ 40px icon · name · 190px progress/state · 36px actions
 */
const GRID_COLUMNS =
  'grid grid-cols-[40px_minmax(0,1fr)_190px_36px] items-center gap-4 ' +
  'lg:grid-cols-[40px_minmax(240px,1.1fr)_minmax(220px,1fr)_84px_104px]'

interface DownloadTableProps {
  rows: readonly UnifiedRow[]
  selection: SelectionState
  focusedKey: string | null
  emptyState: ReactNode
  onRowClick: (row: UnifiedRow, mode: SelectionMode) => void
  onToggleRow: (row: UnifiedRow) => void
  onFocusRow: (row: UnifiedRow) => void
  onOpenRow: (row: UnifiedRow) => void
  onShowInFolder: (row: UnifiedRow) => void
  onPauseRow: (row: UnifiedRow) => void
  onResumeRow: (row: UnifiedRow) => void
  onRetryRow: (row: UnifiedRow) => void
  onContextMenu: (row: UnifiedRow, event: MouseEvent) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function DownloadTable({
  rows,
  selection,
  focusedKey,
  emptyState,
  onRowClick,
  onToggleRow,
  onFocusRow,
  onOpenRow,
  onShowInFolder,
  onPauseRow,
  onResumeRow,
  onRetryRow,
  onContextMenu,
  onKeyDown
}: DownloadTableProps): JSX.Element {
  const selectMode = selection.selected.length > 1

  return (
    <div
      role="grid"
      aria-label="Downloads and media"
      aria-multiselectable="true"
      aria-rowcount={rows.length}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
    >
      {rows.length === 0 ? (
        emptyState
      ) : (
        <div role="presentation" className="divide-y divide-white/[0.06]">
          {rows.map((row) => (
            <TableRow
              key={row.key}
              row={row}
              selected={isSelected(selection, row.key)}
              open={selection.selected.length === 1 && isSelected(selection, row.key)}
              selectMode={selectMode}
              focused={focusedKey === row.key}
              onRowClick={onRowClick}
              onToggleRow={onToggleRow}
              onFocusRow={onFocusRow}
              onOpenRow={onOpenRow}
              onShowInFolder={onShowInFolder}
              onPauseRow={onPauseRow}
              onResumeRow={onResumeRow}
              onRetryRow={onRetryRow}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type RowVisual =
  | {
      kind: 'progress'
      percent: number
      /** Text after the percent: speed, "Paused", "Stopped when…". */
      label: string | null
      /** Right-aligned "… left" hint for active transfers. */
      eta: string | null
      paused: boolean
    }
  | { kind: 'merging'; sublabel: string }
  | { kind: 'queued' }
  | { kind: 'done'; when: string }
  | { kind: 'scheduled'; text: string }
  | { kind: 'analyzing' }
  | { kind: 'failed'; text: string }
  | { kind: 'interrupted'; percent: number }

function describeRow(row: UnifiedRow): RowVisual {
  const download = row.download
  if (download !== null) {
    switch (download.status) {
      case 'active':
        return {
          kind: 'progress',
          percent: row.progress,
          label: download.speedBps > 0 ? formatSpeed(download.speedBps) : null,
          eta:
            download.etaSeconds !== null && download.etaSeconds > 0
              ? formatEta(download.etaSeconds)
              : null,
          paused: false
        }
      case 'paused':
        return {
          kind: 'progress',
          percent: row.progress,
          label: 'Paused',
          eta: null,
          paused: true
        }
      case 'queued':
        return { kind: 'queued' }
      case 'waiting':
        return {
          kind: 'scheduled',
          text:
            download.blockReason === 'scheduled'
              ? `Starts at ${formatClock(download.scheduledAt)}`
              : 'Allowed hours'
        }
      case 'complete':
        return { kind: 'done', when: relativeWhen(download.completedAt) }
      case 'error': {
        // A scheduled automatic retry is not a hard failure: show it as a
        // waiting state until the retry runs or the budget runs out.
        const retryAt = download.retryAt ?? null
        const retrySeconds =
          retryAt === null
            ? null
            : Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
        if (retrySeconds !== null) {
          return {
            kind: 'scheduled',
            text: `Retrying in ${retrySeconds}s…`
          }
        }
        return { kind: 'failed', text: download.errorMessage ?? 'Failed' }
      }
      case 'interrupted':
        return { kind: 'interrupted', percent: row.progress }
    }
  }

  const media = row.media
  if (media !== null) {
    switch (media.status) {
      case 'queued':
        return { kind: 'queued' }
      case 'analyzing':
        return { kind: 'analyzing' }
      case 'downloading': {
        const starting = media.completedBytes === 0 && media.speedBps === 0
        return {
          kind: 'progress',
          percent: row.progress,
          label: starting ? null : formatSpeed(media.speedBps),
          eta: null,
          paused: false
        }
      }
      case 'merging':
        return {
          kind: 'merging',
          sublabel: media.kind === 'audio' ? 'audio' : 'video and audio'
        }
      case 'paused':
        return {
          kind: 'progress',
          percent: row.progress,
          label: 'Paused',
          eta: null,
          paused: true
        }
      case 'complete':
        return { kind: 'done', when: relativeWhen(media.completedAt) }
      case 'error':
        return { kind: 'failed', text: media.errorMessage ?? 'Failed' }
      case 'cancelled':
        return { kind: 'failed', text: 'Cancelled' }
      case 'interrupted':
        return { kind: 'interrupted', percent: row.progress }
    }
  }

  return { kind: 'queued' }
}

function TableRow({
  row,
  selected,
  open,
  selectMode,
  focused,
  onRowClick,
  onToggleRow,
  onFocusRow,
  onOpenRow,
  onShowInFolder,
  onPauseRow,
  onResumeRow,
  onRetryRow,
  onContextMenu
}: {
  row: UnifiedRow
  selected: boolean
  open: boolean
  selectMode: boolean
  focused: boolean
  onRowClick: (row: UnifiedRow, mode: SelectionMode) => void
  onToggleRow: (row: UnifiedRow) => void
  onFocusRow: (row: UnifiedRow) => void
  onOpenRow: (row: UnifiedRow) => void
  onShowInFolder: (row: UnifiedRow) => void
  onPauseRow: (row: UnifiedRow) => void
  onResumeRow: (row: UnifiedRow) => void
  onRetryRow: (row: UnifiedRow) => void
  onContextMenu: (row: UnifiedRow, event: MouseEvent) => void
}): JSX.Element {
  const visual = describeRow(row)
  const percent = Math.round(row.progress)
  const sizeLabel =
    row.sizeBytes !== null
      ? `${row.source === 'media' ? '≈ ' : ''}${formatBytes(row.sizeBytes)}`
      : '—'

  const downloading =
    row.source === 'download'
      ? row.download?.status === 'active'
      : row.media?.status === 'downloading'
  const paused = row.statusTone === 'paused'
  const retryable = visual.kind === 'failed'
  const resumable = visual.kind === 'interrupted'
  const openable = canOpenRow(row)
  const showable = canShowRow(row)

  const rowBackground = open
    ? 'bg-accent-400/[0.08] shadow-[inset_0_0_0_1px_rgb(96_165_250_/_0.35)]'
    : selected
      ? 'bg-accent-400/[0.08]'
      : 'hover:bg-white/[0.04]'

  return (
    <div
      role="row"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-row-key={row.key}
      onClick={(event) => {
        const mode: SelectionMode =
          event.ctrlKey || event.metaKey
            ? 'toggle'
            : event.shiftKey
              ? 'range'
              : 'single'
        onRowClick(row, mode)
      }}
      onDoubleClick={() => onOpenRow(row)}
      onFocus={() => onFocusRow(row)}
      onContextMenu={(event) => onContextMenu(row, event)}
      className={`${GRID_COLUMNS} group relative h-[58px] cursor-default rounded-lg px-2 outline-none transition-colors ${rowBackground} focus-visible:bg-accent-400/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-400/60`}
    >
      <div role="gridcell" className="relative">
        <RowArt row={row} />
        {selectMode ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${row.title}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleRow(row)
            }}
            className="absolute inset-0 z-[1] grid place-items-center rounded-lg bg-[rgb(0_0_0_/_0.55)]"
          >
            <span
              className={`grid h-4 w-4 place-items-center rounded border-[1.5px] ${
                selected
                  ? 'border-accent-500 bg-accent-500 text-on-accent'
                  : 'border-zinc-400 text-transparent'
              }`}
            >
              <Icon name="check" size={11} strokeWidth={2.6} />
            </span>
          </button>
        ) : null}
      </div>

      <div role="gridcell" className="min-w-0">
        <p
          className="truncate text-[13px] font-semibold leading-5 text-zinc-100"
          title={row.title}
        >
          {row.title}
        </p>
        <p
          className="truncate text-[12px] leading-4 text-zinc-500"
          title={row.subtitle}
        >
          <span className="lg:hidden">
            {[row.subtitle, sizeLabel].filter(Boolean).join(' · ')}
          </span>
          <span className="hidden lg:inline">{row.subtitle}</span>
        </p>
      </div>

      <div role="gridcell" className="min-w-0">
        <MiddleCell visual={visual} percent={percent} />
      </div>

      <div
        role="gridcell"
        className="hidden text-right text-[12.5px] tabular-nums text-zinc-400 lg:block"
        title={
          row.sizeBytes !== null
            ? `${formatBytes(row.completedBytes)} of ${formatBytes(row.sizeBytes)}`
            : undefined
        }
      >
        {sizeLabel}
      </div>

      <div role="gridcell" className="flex items-center justify-end gap-0.5">
        {downloading ? (
          <RowIconButton
            icon="pause"
            label={`Pause ${row.title}`}
            onClick={() => onPauseRow(row)}
            className="flex lg:group-hover:hidden"
          />
        ) : null}
        {paused && !retryable ? (
          <RowIconButton
            icon="play"
            label={`Resume ${row.title}`}
            onClick={() => onResumeRow(row)}
            className="flex lg:group-hover:hidden"
          />
        ) : null}
        {resumable ? (
          <button
            type="button"
            onClick={() => onResumeRow(row)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 px-2 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/5 lg:group-hover:hidden"
          >
            <Icon name="play" size={13} />
            <span className="hidden lg:inline">Resume</span>
          </button>
        ) : null}
        {retryable ? (
          <button
            type="button"
            onClick={() => onRetryRow(row)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 px-2 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/5 lg:group-hover:hidden"
          >
            <Icon name="retry" size={14} />
            <span className="hidden lg:inline">Retry</span>
          </button>
        ) : null}

        <div className="hidden items-center gap-0.5 lg:group-hover:flex">
          {openable ? (
            <RowIconButton
              icon="external"
              label={`Open ${row.title}`}
              onClick={() => onOpenRow(row)}
              className="flex"
            />
          ) : null}
          {showable ? (
            <RowIconButton
              icon="folder"
              label={`Show ${row.title} in folder`}
              onClick={() => onShowInFolder(row)}
              className="flex"
            />
          ) : null}
          <RowIconButton
            icon="more"
            label={`More actions for ${row.title}`}
            onClick={(event) => {
              event.stopPropagation()
              onContextMenu(row, event)
            }}
            className="flex"
          />
        </div>
      </div>
    </div>
  )
}

function MiddleCell({
  visual,
  percent
}: {
  visual: RowVisual
  percent: number
}): JSX.Element {
  if (visual.kind === 'progress') {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[12px] text-zinc-400">
          <span className="truncate">
            <span className="font-semibold tabular-nums text-zinc-100">
              {percent}%
            </span>
            {visual.label ? (
              <span className="text-zinc-400"> · {visual.label}</span>
            ) : null}
          </span>
          {visual.eta ? (
            <span className="shrink-0 tabular-nums text-zinc-400">
              {visual.eta} left
            </span>
          ) : null}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-700/50">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${
              visual.paused ? 'bg-zinc-500' : 'bg-accent-400'
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    )
  }

  if (visual.kind === 'merging') {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[12px] text-zinc-400">
          <span className="truncate">
            <span className="font-semibold text-zinc-100">Merging</span> ·{' '}
            {visual.sublabel}
          </span>
          <span className="shrink-0 text-zinc-500">almost done</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-700/50">
          <div
            className="h-full w-[35%] rounded-full bg-accent-400"
            style={{ marginLeft: '30%' }}
          />
        </div>
      </div>
    )
  }

  if (visual.kind === 'interrupted') {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[12px] text-zinc-400">
          <span className="truncate">
            <span className="font-semibold tabular-nums text-zinc-100">
              {percent}%
            </span>{' '}
            · Stopped when the app closed
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-700/50">
          <div
            className="h-full rounded-full bg-zinc-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    )
  }

  if (visual.kind === 'queued') {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-zinc-400">
        <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 rounded-full bg-zinc-500" />
        <span className="truncate">Queued</span>
      </div>
    )
  }

  if (visual.kind === 'done') {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-zinc-400">
        <span aria-hidden="true" className="flex shrink-0 text-emerald-400">
          <Icon name="check" size={15} strokeWidth={2.2} />
        </span>
        <span className="truncate">Done · {visual.when}</span>
      </div>
    )
  }

  if (visual.kind === 'scheduled') {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-zinc-400">
        <span aria-hidden="true" className="flex shrink-0 text-amber-400">
          <Icon name="clock" size={15} />
        </span>
        <span className="truncate">{visual.text}</span>
      </div>
    )
  }

  if (visual.kind === 'analyzing') {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-zinc-400">
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-accent-400"
        />
        <span className="truncate">Reading the page · finding qualities</span>
      </div>
    )
  }

  // failed
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-red-400">
      <span aria-hidden="true" className="flex shrink-0">
        <Icon name="alert" size={15} />
      </span>
      <span className="truncate" title={visual.text}>
        {visual.text}
      </span>
    </div>
  )
}

function RowIconButton({
  icon,
  label,
  onClick,
  className
}: {
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  onClick: (event: MouseEvent) => void
  className: string
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick(event)
      }}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-zinc-400 transition hover:border-white/10 hover:bg-white/5 hover:text-zinc-100 ${className}`}
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

function RowArt({ row }: { row: UnifiedRow }): JSX.Element {
  const fallback: ThumbnailFallback = {
    icon: CATEGORY_ICON[row.category],
    accent: CATEGORY_ACCENT[row.category]
  }
  if (row.thumbnailUrl) {
    return (
      <Thumbnail
        src={row.thumbnailUrl}
        title={row.title}
        fallback={fallback}
        size="row"
      />
    )
  }
  return (
    <span
      className={`flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] ${CATEGORY_ACCENT[row.category]}`}
    >
      <Icon name={CATEGORY_ICON[row.category]} size={18} />
    </span>
  )
}

function formatClock(epochMs: number | null | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    return 'later'
  }
  try {
    return new Date(epochMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return 'later'
  }
}

function relativeWhen(epochMs: number | null): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return ''
  const minutes = Math.floor((Date.now() - epochMs) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  try {
    return new Date(epochMs).toLocaleDateString()
  } catch {
    return ''
  }
}
