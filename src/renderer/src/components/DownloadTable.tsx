import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type UIEvent
} from 'react'
import {
  needsRetryClock,
  retryCountdownText,
  type UnifiedRow
} from '../lib/unified'
import { useNowUntil } from '../lib/useNow'
import {
  isSelected,
  type SelectionMode,
  type SelectionState
} from '../lib/selection'
import {
  ROW_HEIGHT,
  computeWindow,
  rowIndexFor,
  scrollTopForIndex
} from '../lib/virtualList'
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
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  /**
   * True while DOM focus belongs to the list. Rows outside the rendered window
   * unmount, so the table has to know whether it should pull focus back.
   */
  const keyboardFocus = useRef(false)

  // Only tick while a visible row is actually waiting for an automatic retry,
  // so the "Retrying in Ns…" text counts down without a permanent timer.
  const retryDeadlines = useMemo(
    () => rows.map((row) => row.retryAt),
    [rows]
  )
  const now = useNowUntil(1_000, retryDeadlines)

  const rowWindow = useMemo(
    () =>
      computeWindow({
        itemCount: rows.length,
        scrollTop,
        viewportHeight
      }),
    [rows.length, scrollTop, viewportHeight]
  )

  // The viewport height changes on window resize and when the details pane or
  // the selection bar appears, neither of which fires a scroll event.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const measure = (): void => setViewportHeight(scroller.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  // Reveal the focused row before paint, so keyboard navigation and the
  // `revealRow` IPC always land on a row that is actually rendered. Revealing
  // stops as soon as the user scrolls somewhere else, so a new snapshot cannot
  // yank the list back to the focused row.
  const rowsRef = useRef(rows)
  useLayoutEffect(() => {
    rowsRef.current = rows
  })
  const programmaticScroll = useRef(0)
  const userScrolled = useRef(false)

  const revealIndex = useCallback((index: number, itemCount: number): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const next = scrollTopForIndex(index, {
      itemCount,
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight
    })
    if (next === scroller.scrollTop) return
    programmaticScroll.current = next
    scroller.scrollTop = next
    setScrollTop(next)
  }, [])

  useLayoutEffect(() => {
    userScrolled.current = false
    const current = rowsRef.current
    const index = rowIndexFor(current, focusedKey)
    if (index < 0) return
    revealIndex(index, current.length)
  }, [focusedKey, revealIndex])

  // A row can also be revealed by the same key twice (the IPC targets the row
  // that is already focused), so keep it visible after the list changes until
  // the user takes over the scroll position.
  useLayoutEffect(() => {
    if (userScrolled.current) return
    const index = rowIndexFor(rows, focusedKey)
    if (index < 0) return
    revealIndex(index, rows.length)
  }, [rows, focusedKey, revealIndex])

  // Keep DOM focus on the focused row, or on the grid itself while that row is
  // outside the rendered window, so the next key press still reaches onKeyDown.
  useEffect(() => {
    if (!keyboardFocus.current || focusedKey === null) return
    const scroller = scrollerRef.current
    if (scroller === null) return
    const target = findRowElement(scroller, focusedKey)
    if (target !== null) {
      // `preventScroll` keeps a wheel scroll from being undone by the focus.
      if (document.activeElement !== target) target.focus({ preventScroll: true })
      return
    }
    if (document.activeElement !== scroller) {
      scroller.focus({ preventScroll: true })
    }
  }, [focusedKey, rowWindow.start, rowWindow.end])

  // A click outside the list ends the keyboard session, so a later focus change
  // must not pull focus back into it.
  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent): void => {
      const scroller = scrollerRef.current
      if (scroller === null) return
      if (event.target instanceof Node && scroller.contains(event.target)) return
      keyboardFocus.current = false
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const top = event.currentTarget.scrollTop
    if (top !== programmaticScroll.current) userScrolled.current = true
    setScrollTop(top)
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      keyboardFocus.current = true
      onKeyDown(event)
    },
    [onKeyDown]
  )

  const handleFocus = useCallback((): void => {
    keyboardFocus.current = true
  }, [])

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      const next = event.relatedTarget
      if (next instanceof Node && !event.currentTarget.contains(next)) {
        keyboardFocus.current = false
      }
    },
    []
  )

  const windowRows = useMemo(
    () => rows.slice(rowWindow.start, rowWindow.end),
    [rows, rowWindow.start, rowWindow.end]
  )

  return (
    <div
      role="grid"
      aria-label="Downloads and media"
      aria-multiselectable="true"
      aria-rowcount={rows.length}
      tabIndex={-1}
      ref={scrollerRef}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 outline-none"
    >
      {rows.length === 0 ? (
        emptyState
      ) : (
        <div
          role="presentation"
          className="relative"
          style={{ height: rowWindow.totalHeight }}
        >
          <div
            role="presentation"
            className="divide-y divide-white/[0.06]"
            style={{ transform: `translateY(${rowWindow.offsetTop}px)` }}
          >
            {windowRows.map((row, offset) => {
              const index = rowWindow.start + offset
              return (
                <TableRow
                  key={row.key}
                  row={row}
                  index={index}
                  now={needsRetryClock(row) ? now : 0}
                  selected={isSelected(selection, row.key)}
                  open={
                    selection.selected.length === 1 &&
                    isSelected(selection, row.key)
                  }
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
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** The rendered row element for `key`, if it is inside the window. */
function findRowElement(container: HTMLElement, key: string): HTMLElement | null {
  const elements = container.querySelectorAll<HTMLElement>('[data-row-key]')
  for (const element of elements) {
    if (element.dataset.rowKey === key) return element
  }
  return null
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

function describeRow(row: UnifiedRow, now: number): RowVisual {
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
        const retryText = retryCountdownText(download.retryAt ?? null, now)
        if (retryText !== null) {
          return { kind: 'scheduled', text: retryText }
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

interface TableRowProps {
  row: UnifiedRow
  /** Index in the full row list, for `aria-rowindex`. */
  index: number
  /** Clock reading for the retry countdown; 0 for rows that never show it. */
  now: number
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
}

/**
 * A row only re-renders when its own data, selection or focus state changes.
 * The ticking clock is compared solely for rows that render a countdown, so a
 * retry elsewhere in the list cannot re-render every visible row.
 */
function areRowPropsEqual(prev: TableRowProps, next: TableRowProps): boolean {
  if (prev.row !== next.row) return false
  if (prev.index !== next.index) return false
  if (prev.selected !== next.selected || prev.open !== next.open) return false
  if (prev.selectMode !== next.selectMode) return false
  if (prev.focused !== next.focused) return false
  if (
    prev.onRowClick !== next.onRowClick ||
    prev.onToggleRow !== next.onToggleRow ||
    prev.onFocusRow !== next.onFocusRow ||
    prev.onOpenRow !== next.onOpenRow ||
    prev.onShowInFolder !== next.onShowInFolder ||
    prev.onPauseRow !== next.onPauseRow ||
    prev.onResumeRow !== next.onResumeRow ||
    prev.onRetryRow !== next.onRetryRow ||
    prev.onContextMenu !== next.onContextMenu
  ) {
    return false
  }
  return !needsRetryClock(next.row) || prev.now === next.now
}

const TableRow = memo(function TableRow({
  row,
  index,
  now,
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
}: TableRowProps): JSX.Element {
  const visual = describeRow(row, now)
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
      aria-rowindex={index + 1}
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
      className={`${GRID_COLUMNS} group relative cursor-default rounded-lg px-2 outline-none transition-colors ${rowBackground} focus-visible:bg-accent-400/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-400/60`}
      style={{ height: ROW_HEIGHT }}
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
}, areRowPropsEqual)

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

const RowArt = memo(function RowArt({
  row
}: {
  row: UnifiedRow
}): JSX.Element {
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
})

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
