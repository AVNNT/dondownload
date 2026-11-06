import {
  useCallback,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { SortDirection, SortKey, UnifiedRow } from '../lib/unified'
import { isSelected, type SelectionState, type SelectionMode } from '../lib/selection'
import { CATEGORY_ACCENT, CATEGORY_ICON, Icon } from './Icon'
import { StatusBadge } from './StatusBadge'
import type { ThumbnailFallback } from './Thumbnail'
import { Thumbnail } from './Thumbnail'
import { formatBytes, formatEta, formatSpeed } from '@shared/format'

const GRID_COLUMNS =
  'grid grid-cols-[28px_36px_minmax(0,1fr)_112px_70px_108px] items-center gap-2 min-[901px]:grid-cols-[28px_36px_minmax(0,1fr)_120px_130px_72px_108px] min-[1180px]:grid-cols-[28px_36px_minmax(0,1fr)_140px_88px_146px_76px_68px_116px]'

interface DownloadTableProps {
  rows: readonly UnifiedRow[]
  selection: SelectionState
  focusedKey: string | null
  sortKey: SortKey
  sortDirection: SortDirection
  emptyState: ReactNode
  onSort: (key: SortKey) => void
  onRowClick: (row: UnifiedRow, mode: SelectionMode) => void
  onToggleRow: (row: UnifiedRow) => void
  onSelectAll: () => void
  onFocusRow: (row: UnifiedRow) => void
  onOpenRow: (row: UnifiedRow) => void
  onContextMenu: (row: UnifiedRow, event: MouseEvent) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function DownloadTable({
  rows,
  selection,
  focusedKey,
  sortKey,
  sortDirection,
  emptyState,
  onSort,
  onRowClick,
  onToggleRow,
  onSelectAll,
  onFocusRow,
  onOpenRow,
  onContextMenu,
  onKeyDown
}: DownloadTableProps): JSX.Element {
  const allSelected =
    rows.length > 0 && rows.every((row) => isSelected(selection, row.key))
  const someSelected =
    !allSelected && rows.some((row) => isSelected(selection, row.key))
  const setHeaderCheckbox = useCallback(
    (input: HTMLInputElement | null) => {
      if (input) input.indeterminate = someSelected
    },
    [someSelected]
  )

  return (
    <div
      role="grid"
      aria-label="Downloads and media"
      aria-multiselectable="true"
      aria-rowcount={rows.length}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 surface-card"
    >
      <div
        role="row"
        className={`${GRID_COLUMNS} shrink-0 border-b border-white/10 surface-soft px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500`}
      >
        <div role="columnheader" aria-label="Select all" className="flex items-center">
          <input
            ref={setHeaderCheckbox}
            type="checkbox"
            checked={allSelected}
            onChange={onSelectAll}
            disabled={rows.length === 0}
            aria-label="Select all visible downloads"
            className="h-3.5 w-3.5 rounded border-white/20 surface-input accent-emerald-400 disabled:opacity-30"
          />
        </div>
        <div role="columnheader" aria-label="Type" />
        <SortHeader
          role="columnheader"
          label="Name"
          sortKey="name"
          activeKey={sortKey}
          direction={sortDirection}
          onSort={onSort}
          className="min-w-0"
        />
        <div role="columnheader" className="hidden min-[901px]:block min-w-0">
          Source
        </div>
        <SortHeader
          role="columnheader"
          label="Size"
          sortKey="size"
          activeKey={sortKey}
          direction={sortDirection}
          onSort={onSort}
          align="right"
          className="hidden min-[1180px]:block"
        />
        <SortHeader
          role="columnheader"
          label="Progress"
          sortKey="progress"
          activeKey={sortKey}
          direction={sortDirection}
          onSort={onSort}
        />
        <div role="columnheader" className="text-right">
          Speed
        </div>
        <div role="columnheader" className="hidden text-right min-[1180px]:block">
          ETA
        </div>
        <SortHeader
          role="columnheader"
          label="Status"
          sortKey="status"
          activeKey={sortKey}
          direction={sortDirection}
          onSort={onSort}
          align="right"
        />
      </div>

      <div
        role="rowgroup"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {rows.length === 0 ? (
          emptyState
        ) : (
          <div role="presentation">
            {rows.map((row) => (
              <TableRow
                key={row.key}
                row={row}
                selected={isSelected(selection, row.key)}
                focused={focusedKey === row.key}
                onRowClick={onRowClick}
                onToggleRow={onToggleRow}
                onFocusRow={onFocusRow}
                onOpenRow={onOpenRow}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TableRow({
  row,
  selected,
  focused,
  onRowClick,
  onToggleRow,
  onFocusRow,
  onOpenRow,
  onContextMenu
}: {
  row: UnifiedRow
  selected: boolean
  focused: boolean
  onRowClick: (row: UnifiedRow, mode: SelectionMode) => void
  onToggleRow: (row: UnifiedRow) => void
  onFocusRow: (row: UnifiedRow) => void
  onOpenRow: (row: UnifiedRow) => void
  onContextMenu: (row: UnifiedRow, event: MouseEvent) => void
}): JSX.Element {
  const percent = Math.round(row.progress)
  const sizeLabel = row.sizeBytes !== null ? formatBytes(row.sizeBytes) : 'Unknown'
  const speedLabel =
    row.source === 'media' && row.media?.status === 'merging'
      ? 'Merging'
      : formatSpeed(row.speedBps)

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
      className={`${GRID_COLUMNS} group min-h-[52px] cursor-default border-b border-white/[0.055] px-3 py-1.5 text-xs outline-none transition-colors ${
        selected
          ? 'bg-emerald-400/[0.085] shadow-[inset_2px_0_0_0_rgb(52_211_153_/_0.9)]'
          : 'hover:bg-white/[0.035]'
      } focus-visible:bg-emerald-400/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400/60`}
    >
      <div role="gridcell" className="flex items-center">
        <input
          type="checkbox"
          checked={selected}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggleRow(row)}
          aria-label={`Select ${row.title}`}
          className="h-3.5 w-3.5 rounded border-white/20 surface-input accent-emerald-400"
        />
      </div>

      <div role="gridcell" className="flex items-center">
        <RowArt row={row} />
      </div>

      <div role="gridcell" className="min-w-0">
        <p
          className={`truncate text-[12.5px] font-medium leading-5 ${
            selected ? 'text-zinc-50' : 'text-zinc-100'
          }`}
          title={row.title}
        >
          {row.title}
        </p>
        <p className="truncate text-[11px] leading-4 text-zinc-500" title={row.subtitle}>
          {row.subtitle}
        </p>
      </div>

      <div
        role="gridcell"
        className="hidden min-[901px]:block min-w-0 text-[11px] text-zinc-400"
        title={row.host ?? row.subtitle}
      >
        <span className="block truncate">{row.host ?? 'Media page'}</span>
      </div>

      <div
        role="gridcell"
        className="hidden text-right text-[11px] tabular-nums text-zinc-300 min-[1180px]:block"
        title={
          row.sizeBytes !== null
            ? `${formatBytes(row.completedBytes)} of ${sizeLabel}`
            : `${formatBytes(row.completedBytes)} downloaded`
        }
      >
        {sizeLabel}
      </div>

      <div role="gridcell" className="min-w-0">
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={`Download progress for ${row.title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={row.indeterminate ? undefined : percent}
            aria-valuetext={row.indeterminate ? row.statusLabel : `${percent}%`}
            className={`relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10 ${
              row.indeterminate ? 'media-progress-indeterminate' : ''
            } ${
              row.source === 'media' && row.media?.status === 'merging'
                ? 'media-progress-merging'
                : ''
            }`}
          >
            {row.indeterminate ? null : (
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  row.statusTone === 'failed'
                    ? 'bg-red-400'
                    : row.statusTone === 'warning'
                      ? 'bg-amber-400'
                      : row.statusTone === 'paused'
                        ? 'bg-zinc-500'
                        : row.statusTone === 'queued'
                          ? 'bg-zinc-600'
                          : 'bg-emerald-400'
                }`}
                style={{ width: `${percent}%` }}
              />
            )}
          </div>
          <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-zinc-400">
            {row.indeterminate ? '—' : `${percent}%`}
          </span>
        </div>
      </div>

      <div
        role="gridcell"
        className="text-right text-[11px] tabular-nums text-zinc-300"
      >
        {speedLabel}
      </div>

      <div
        role="gridcell"
        className="hidden text-right text-[11px] tabular-nums text-zinc-400 min-[1180px]:block"
      >
        {row.etaSeconds !== null && row.etaSeconds > 0
          ? formatEta(row.etaSeconds)
          : '—'}
      </div>

      <div role="gridcell" className="flex justify-end">
        <StatusBadge label={row.statusLabel} tone={row.statusTone} />
      </div>
    </div>
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
      />
    )
  }
  return (
    <span
      className={`flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] ${CATEGORY_ACCENT[row.category]}`}
    >
      <Icon name={CATEGORY_ICON[row.category]} size={15} />
    </span>
  )
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align = 'left',
  ...props
}: {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  direction: SortDirection
  onSort: (key: SortKey) => void
  align?: 'left' | 'right'
} & { role?: string; className?: string }): JSX.Element {
  const active = activeKey === sortKey
  return (
    <div
      {...props}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
      className={`${align === 'right' ? 'text-right' : ''} ${props.className ?? ''}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded text-[11px] font-medium uppercase tracking-[0.12em] transition hover:text-zinc-200 ${
          active ? 'text-zinc-200' : 'text-zinc-500'
        }`}
      >
        {label}
        <span aria-hidden="true" className="text-[11px] leading-none">
          {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </div>
  )
}
