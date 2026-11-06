import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  type Batch,
  type BatchItem,
  type BatchItemStatus,
  type BatchKind,
  type BatchStatus
} from '@shared/batches'
import { formatBytes, formatPercent } from '@shared/format'
import type { ApiResult, AppErrorInfo, BatchSnapshot } from '@shared/types'
import type { UnifiedRow } from '../lib/unified'
import { Icon, type IconName } from './Icon'

const BATCH_KIND_ICON: Record<BatchKind, IconName> = {
  'media-playlist': 'video',
  'pixeldrain-list': 'layers',
  'direct-urls': 'link'
}

const BATCH_KIND_LABEL: Record<BatchKind, string> = {
  'media-playlist': 'Playlist',
  'pixeldrain-list': 'Pixeldrain list',
  'direct-urls': 'Direct links'
}

const BATCH_BAR_STYLE: Record<BatchStatus, string> = {
  queued: 'bg-zinc-500',
  running: 'bg-accent-400',
  complete: 'bg-emerald-400',
  partial: 'bg-amber-400',
  error: 'bg-red-400',
  cancelled: 'bg-zinc-500',
  interrupted: 'bg-amber-400'
}

const ITEM_STATUS_LABEL: Record<BatchItemStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
  unavailable: 'Unavailable',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

const ITEM_STATUS_STYLE: Record<BatchItemStatus, string> = {
  queued: 'text-zinc-400',
  running: 'text-accent-300',
  complete: 'text-emerald-300',
  error: 'text-red-300',
  unavailable: 'text-amber-300',
  skipped: 'text-zinc-500',
  cancelled: 'text-zinc-400',
  interrupted: 'text-amber-300'
}

type BatchFilter = 'all' | 'running' | 'finished'

const FINISHED_STATUSES: ReadonlySet<BatchStatus> = new Set([
  'complete',
  'partial',
  'error',
  'cancelled'
])

/** Number of item rows shown before the "Show all" affordance takes over. */
const PREVIEW_ITEM_COUNT = 5

/**
 * Batches page, redesigned per the static mockup: a back header with a
 * description and clear-finished affordance, All/Running/Finished chips, and
 * expandable batch cards. Every previous action stays reachable — cancel and
 * remove per group, retry per failed item, and the per-item open-in-browser
 * for links that need the user's browser. Submission itself moved into the
 * Add dialog ( BatchSubmit ), so new batches start there.
 */
export function BatchSection({
  onBack,
  onAddLinks,
  findFolderRow,
  onShowRowInFolder
}: {
  onBack?: () => void
  onAddLinks?: () => void
  /** Resolves the child row whose folder a batch "Open folder" action reveals. */
  findFolderRow?: (batch: Batch) => UnifiedRow | undefined
  onShowRowInFolder?: (row: UnifiedRow) => void
} = {}): JSX.Element {
  const [snapshot, setSnapshot] = useState<BatchSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [snapshotError, setSnapshotError] = useState<AppErrorInfo | null>(null)
  const [filter, setFilter] = useState<BatchFilter>('all')
  const [expandedBatches, setExpandedBatches] = useState<
    Record<string, boolean>
  >({})
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null)
  const [showAllItems, setShowAllItems] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const result = await window.donDownload.getBatchSnapshot()
        if (cancelled) return
        if (result.ok) {
          setSnapshot(result.value)
          setSnapshotError(null)
        } else {
          setSnapshotError(result.error)
        }
      } catch (error) {
        if (!cancelled) setSnapshotError(rejectedToError(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const unsubscribe = window.donDownload.onBatchSnapshotChanged((next) => {
      if (cancelled) return
      setSnapshot(next)
      setSnapshotError(null)
      setLoading(false)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const runSnapshotAction = useCallback(
    async (
      action: () => Promise<ApiResult<BatchSnapshot>>
    ): Promise<void> => {
      setActionPending(true)
      setActionError(null)
      try {
        const result = await action()
        if (result.ok) {
          setSnapshot(result.value)
          setSnapshotError(null)
        } else {
          setActionError(result.error)
        }
      } catch (error) {
        setActionError(rejectedToError(error))
      } finally {
        setActionPending(false)
      }
    },
    []
  )

  const handleOpenSource = useCallback(
    async (batchId: string, itemId: string): Promise<void> => {
      setActionPending(true)
      setActionError(null)
      try {
        const result = await window.donDownload.openBatchSource({
          batchId,
          itemId
        })
        if (!result.ok) setActionError(result.error)
      } catch (error) {
        setActionError(rejectedToError(error))
      } finally {
        setActionPending(false)
      }
    },
    []
  )

  const retryItems = useCallback(
    async (batch: Batch, items: readonly BatchItem[]): Promise<void> => {
      for (const item of items) {
        // Sequential on purpose: retry results arrive as full snapshots that
        // must not race each other.
        await runSnapshotAction(() =>
          window.donDownload.retryBatchItem({
            batchId: batch.id,
            itemId: item.id
          })
        )
      }
    },
    [runSnapshotAction]
  )

  const clearFinished = useCallback((): void => {
    if (snapshot === null) return
    const finished = snapshot.batches.filter((batch) =>
      FINISHED_STATUSES.has(batch.status)
    )
    if (finished.length === 0) return
    void (async () => {
      for (const batch of finished) {
        await runSnapshotAction(() =>
          window.donDownload.removeBatch({ batchId: batch.id })
        )
      }
    })()
  }, [runSnapshotAction, snapshot])

  const batches = snapshot?.batches ?? []
  const counts = useMemo(
    () => ({
      all: batches.length,
      running: batches.filter(
        (batch) => batch.status === 'queued' || batch.status === 'running'
      ).length,
      finished: batches.filter((batch) => FINISHED_STATUSES.has(batch.status))
        .length
    }),
    [batches]
  )
  const filteredBatches =
    filter === 'all'
      ? batches
      : batches.filter((batch) =>
          filter === 'running'
            ? batch.status === 'queued' || batch.status === 'running'
            : FINISHED_STATUSES.has(batch.status)
        )
  const interactionBusy = actionPending

  return (
    <section aria-labelledby="batches-page-heading">
      <header className="flex items-center gap-2.5 pb-4 pt-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to downloads"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <div className="min-w-0">
          <h1
            id="batches-page-heading"
            className="text-[15px] font-semibold text-zinc-100"
          >
            Batches
          </h1>
          <p className="text-[12px] text-zinc-500">
            Groups of downloads from one scan, playlist or list
          </p>
        </div>
        <button
          type="button"
          onClick={clearFinished}
          disabled={interactionBusy || counts.finished === 0}
          className="ml-auto h-8 shrink-0 rounded-lg px-3 text-[12px] font-semibold text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
        >
          Clear finished
        </button>
      </header>

      <div className="flex flex-col gap-2.5">
        {batches.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', 'All'],
                ['running', 'Running'],
                ['finished', 'Finished']
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition ${
                  filter === id
                    ? 'border border-white/10 bg-white/[0.06] text-zinc-100'
                    : 'border border-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                }`}
              >
                {label}{' '}
                <span className="font-medium tabular-nums text-zinc-500">
                  {counts[id]}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {actionError ? <InlineError error={actionError} onDismiss={() => setActionError(null)} /> : null}

        {snapshotError && snapshot !== null ? (
          <InlineError
            error={snapshotError}
            onDismiss={() => setSnapshotError(null)}
            onRetry={() => {
              void (async () => {
                setLoading(true)
                try {
                  const result = await window.donDownload.getBatchSnapshot()
                  if (result.ok) {
                    setSnapshot(result.value)
                    setSnapshotError(null)
                  } else {
                    setSnapshotError(result.error)
                  }
                } catch (error) {
                  setSnapshotError(rejectedToError(error))
                } finally {
                  setLoading(false)
                }
              })()
            }}
          />
        ) : null}

        {loading && snapshot === null ? (
          <LoadingState />
        ) : snapshot === null ? (
          <SnapshotErrorState
            error={snapshotError}
            onRetry={() => {
              void (async () => {
                setLoading(true)
                try {
                  const result = await window.donDownload.getBatchSnapshot()
                  if (result.ok) {
                    setSnapshot(result.value)
                    setSnapshotError(null)
                  } else {
                    setSnapshotError(result.error)
                  }
                } catch (error) {
                  setSnapshotError(rejectedToError(error))
                } finally {
                  setLoading(false)
                }
              })()
            }}
          />
        ) : filteredBatches.length === 0 ? (
          <BatchEmptyState onAddLinks={onAddLinks} filtered={batches.length > 0} />
        ) : (
          filteredBatches.map((batch) => {
            const folderRow = findFolderRow?.(batch)
            return (
            <BatchCard
              key={batch.id}
              batch={batch}
              expanded={expandedBatches[batch.id] ?? false}
              showAll={showAllItems[batch.id] ?? false}
              busy={interactionBusy}
              onOpenFolder={
                folderRow !== undefined && onShowRowInFolder
                  ? () => onShowRowInFolder(folderRow)
                  : undefined
              }
              onToggle={() => {
                setExpandedBatches((current) => ({
                  ...current,
                  [batch.id]: !(current[batch.id] ?? false)
                }))
              }}
              onShowAll={() => {
                setShowAllItems((current) => ({
                  ...current,
                  [batch.id]: !(current[batch.id] ?? false)
                }))
              }}
              onCancelBatch={() => {
                void runSnapshotAction(() =>
                  window.donDownload.cancelBatch({ batchId: batch.id })
                )
              }}
              onRemoveBatch={() => {
                void runSnapshotAction(() =>
                  window.donDownload.removeBatch({ batchId: batch.id })
                )
              }}
              onRetryFailed={() => {
                void retryItems(
                  batch,
                  batch.items.filter(
                    (item) =>
                      item.status === 'error' || item.status === 'interrupted'
                  )
                )
              }}
              onCancelItem={(item) => {
                void runSnapshotAction(() =>
                  window.donDownload.cancelBatchItem({
                    batchId: batch.id,
                    itemId: item.id
                  })
                )
              }}
              onRetryItem={(item) => {
                void retryItems(batch, [item])
              }}
              onOpenSource={(item) => {
                void handleOpenSource(batch.id, item.id)
              }}
            />
            )
          })
        )}
      </div>
    </section>
  )
}

function BatchCard({
  batch,
  expanded,
  showAll,
  busy,
  onOpenFolder,
  onToggle,
  onShowAll,
  onCancelBatch,
  onRemoveBatch,
  onRetryFailed,
  onCancelItem,
  onRetryItem,
  onOpenSource
}: {
  batch: Batch
  expanded: boolean
  showAll: boolean
  busy: boolean
  onOpenFolder?: () => void
  onToggle: () => void
  onShowAll: () => void
  onCancelBatch: () => void
  onRemoveBatch: () => void
  onRetryFailed: () => void
  onCancelItem: (item: BatchItem) => void
  onRetryItem: (item: BatchItem) => void
  onOpenSource: (item: BatchItem) => void
}): JSX.Element {
  const itemsId = `batch-${batch.id}-items`
  const active = batch.status === 'queued' || batch.status === 'running'
  const percent = batchPercent(batch)
  const retryableCount = batch.items.filter(
    (item) => item.status === 'error' || item.status === 'interrupted'
  ).length
  const downloadingCount = batch.items.filter(
    (item) => item.status === 'running'
  ).length
  const bytesLeft =
    batch.progress.totalBytes !== null
      ? Math.max(0, batch.progress.totalBytes - batch.progress.completedBytes)
      : null

  const visibleItems = showAll
    ? batch.items
    : batch.items.slice(0, PREVIEW_ITEM_COUNT)

  return (
    <article
      aria-labelledby={`batch-${batch.id}-title`}
      className="overflow-hidden rounded-xl border border-white/10 surface-card"
    >
      <div className="grid grid-cols-[16px_36px_minmax(0,1fr)_minmax(150px,220px)_auto] items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={expanded ? itemsId : undefined}
          aria-label={expanded ? 'Collapse batch' : 'Expand batch'}
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
        >
          <span
            aria-hidden="true"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <Icon name="chevron-right" size={14} />
          </span>
        </button>

        <span
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-white/[0.05] text-zinc-400"
        >
          <Icon name={BATCH_KIND_ICON[batch.kind]} size={17} />
        </span>

        <div className="min-w-0">
          <p
            id={`batch-${batch.id}-title`}
            className="truncate text-[13.5px] font-semibold text-zinc-100"
            title={batch.title}
          >
            {batch.title}
          </p>
          <p className="truncate text-[12px] text-zinc-500">
            {BATCH_KIND_LABEL[batch.kind]} ·{' '}
            <span className="tabular-nums">{batch.progress.totalItems}</span>{' '}
            {batch.progress.totalItems === 1 ? 'item' : 'items'} ·{' '}
            {formatBatchDate(batch.createdAt)}
          </p>
        </div>

        <div className="min-w-0">
          <div className="flex items-center justify-between text-[12px] text-zinc-400">
            <span className="tabular-nums">
              <span className="font-semibold text-zinc-100">
                {batch.progress.completedItems} of{' '}
                {batch.progress.totalItems}
              </span>
              {downloadingCount > 0 ? ` · ${downloadingCount} downloading` : ''}
            </span>
            {bytesLeft !== null && active ? (
              <span className="tabular-nums">{formatBytes(bytesLeft)} left</span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={`Batch progress for ${batch.title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${BATCH_BAR_STYLE[batch.status]}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-1">
          {retryableCount > 0 && !active && batch.status !== 'interrupted' ? (
            <button
              type="button"
              onClick={onRetryFailed}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="retry" size={14} />
              Retry {retryableCount}
            </button>
          ) : null}
          <BatchMenu
            ariaLabel={`More actions for ${batch.title}`}
            disabled={busy}
            items={
              (
                [
                  onOpenFolder
                    ? {
                        id: 'open-folder',
                        label: 'Open folder',
                        icon: 'folder' as const,
                        onSelect: onOpenFolder
                      }
                    : null,
                  retryableCount > 0 && !active
                    ? batch.status === 'interrupted'
                      ? {
                          id: 'resume',
                          label: 'Resume',
                          icon: 'play' as const,
                          onSelect: onRetryFailed
                        }
                      : {
                          id: 'retry-failed',
                          label: 'Retry failed',
                          icon: 'retry' as const,
                          onSelect: onRetryFailed
                        }
                    : null,
                  active
                    ? {
                        id: 'pause',
                        label: 'Pause',
                        icon: 'pause' as const,
                        onSelect: onCancelBatch
                      }
                    : null,
                  {
                    id: 'remove',
                    label: 'Remove from list',
                    danger: true,
                    onSelect: onRemoveBatch
                  }
                ] as Array<BatchMenuEntry | null>
              ).filter((item): item is BatchMenuEntry => item !== null)
            }
          />
        </div>
      </div>

      {batch.errorMessage ? (
        <p
          role="alert"
          className="mx-4 mb-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200"
        >
          {batch.errorMessage}
        </p>
      ) : null}

      {expanded ? (
        <div id={itemsId} className="border-t border-white/[0.07]">
          {batch.items.length === 0 ? (
            <p className="px-4 py-5 text-center text-[12px] text-zinc-500">
              No child items.
            </p>
          ) : (
            <ul>
              {visibleItems.map((item, index) => (
                <BatchItemRow
                  key={item.id}
                  item={item}
                  index={index}
                  busy={busy}
                  onCancel={() => onCancelItem(item)}
                  onRetry={() => onRetryItem(item)}
                  onOpenSource={() => onOpenSource(item)}
                />
              ))}
            </ul>
          )}
          {batch.items.length > PREVIEW_ITEM_COUNT ? (
            <button
              type="button"
              onClick={onShowAll}
              disabled={busy}
              className="w-full border-t border-white/[0.07] px-4 py-2.5 text-center text-[12px] font-semibold text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
            >
              {showAll
                ? 'Show less'
                : `Show all ${batch.items.length}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function BatchItemRow({
  item,
  index,
  busy,
  onCancel,
  onRetry,
  onOpenSource
}: {
  item: BatchItem
  index: number
  busy: boolean
  onCancel: () => void
  onRetry: () => void
  onOpenSource: () => void
}): JSX.Element {
  const active = item.status === 'queued' || item.status === 'running'
  const retryable = item.status === 'error' || item.status === 'interrupted'
  const browserRequired =
    item.status === 'unavailable' &&
    item.childId === null &&
    item.label === 'Browser required'
  const percent =
    item.totalBytes !== null && item.totalBytes > 0
      ? formatPercent(item.completedBytes, item.totalBytes)
      : null

  return (
    <li
      className={`grid grid-cols-[16px_36px_minmax(0,1fr)_minmax(150px,220px)_auto] items-center gap-3 px-4 py-2.5 ${
        index > 0 ? 'border-t border-white/[0.05]' : ''
      }`}
    >
      <span aria-hidden="true" />
      <span
        aria-hidden="true"
        className="mx-auto flex h-6 w-9 items-center justify-center rounded bg-white/[0.05] text-zinc-500"
      >
        <Icon name="document" size={13} />
      </span>
      <p
        className="truncate text-[12.5px] font-medium text-zinc-200"
        title={item.title}
      >
        {item.title}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        {percent !== null && percent < 100 ? (
          <>
            <span
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
              role="progressbar"
              aria-valuenow={Math.round(percent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                className="block h-full rounded-full bg-accent-400"
                style={{ width: `${percent}%` }}
              />
            </span>
            <span className="tabular-nums text-[12px] text-zinc-500">
              {Math.round(percent)}%
            </span>
          </>
        ) : (
          <span
            className={`flex items-center gap-1.5 truncate text-[12px] font-medium ${ITEM_STATUS_STYLE[item.status]}`}
          >
            {item.status === 'complete' ? (
              <Icon name="check" size={13} />
            ) : null}
            {(item.status === 'error' || item.status === 'unavailable') ? (
              <Icon name="alert" size={13} />
            ) : null}
            {ITEM_STATUS_LABEL[item.status]}
          </span>
        )}
      </div>
      <div className="flex items-center justify-end gap-1">
        {retryable ? (
          <IconAction
            icon="retry"
            ariaLabel={`Retry ${item.title}`}
            title="Retry"
            disabled={busy}
            onClick={onRetry}
          />
        ) : null}
        {active ? (
          <IconAction
            icon="x"
            ariaLabel={`Cancel ${item.title}`}
            title="Cancel"
            disabled={busy}
            onClick={onCancel}
          />
        ) : null}
        {browserRequired ? (
          <IconAction
            icon="external"
            ariaLabel={`Open ${item.title} in your browser`}
            title="Open in browser"
            disabled={busy}
            onClick={onOpenSource}
          />
        ) : null}
      </div>
    </li>
  )
}

interface BatchMenuEntry {
  id: string
  label: string
  icon?: IconName
  danger?: boolean
  onSelect: () => void
}

/**
 * The batch card's "more" (⋯) menu: keeps the card header calm while every
 * group action — open folder, retry/resume, pause, remove — stays reachable.
 * Closes on outside click and Escape; items are regular buttons so Tab/Enter
 * keyboard flows keep working in all themes.
 */
function BatchMenu({
  ariaLabel,
  items,
  disabled
}: {
  ariaLabel: string
  items: BatchMenuEntry[]
  disabled: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        containerRef.current !== null &&
        event.target instanceof Node &&
        containerRef.current.contains(event.target)
      ) {
        return
      }
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title="More actions"
        disabled={disabled}
        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Icon name="more" size={15} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-white/10 bg-[var(--surface-card)] p-1 shadow-xl shadow-black/40"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium transition ${
                item.danger
                  ? 'text-red-300 hover:bg-red-400/10'
                  : 'text-zinc-200 hover:bg-white/5'
              }`}
            >
              {item.icon ? <Icon name={item.icon} size={13} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function IconAction({
  icon,
  ariaLabel,
  title,
  disabled,
  onClick
}: {
  icon: IconName
  ariaLabel: string
  title: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon name={icon} size={15} />
    </button>
  )
}

function InlineError({
  error,
  onDismiss,
  onRetry
}: {
  error: AppErrorInfo
  onDismiss: () => void
  onRetry?: () => void
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/5 px-4 py-3 text-xs leading-5 text-red-200"
    >
      <div className="min-w-0">
        <p>{error.message}</p>
        {error.hint ? (
          <p className="mt-1 break-words text-[11px] text-red-300/70">
            {error.hint}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-red-300/20 px-2 py-0.5 text-[11px] text-red-200 transition hover:bg-red-300/10"
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-red-300/20 px-2 py-0.5 text-[11px] text-red-200 transition hover:bg-red-300/10"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

function LoadingState(): JSX.Element {
  return (
    <div
      role="status"
      className="rounded-xl border border-white/10 surface-inset px-6 py-8 text-center"
    >
      <div
        aria-hidden="true"
        className="mx-auto flex h-9 w-9 animate-pulse items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-base text-zinc-400"
      >
        ↓
      </div>
      <p className="mt-2.5 text-sm font-medium text-zinc-300">Loading batches…</p>
      <p className="mt-1 text-xs text-zinc-500">
        Reading local batch history and progress.
      </p>
    </div>
  )
}

function SnapshotErrorState({
  error,
  onRetry
}: {
  error: AppErrorInfo | null
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="rounded-xl border border-red-400/25 bg-red-400/5 px-6 py-8 text-center">
      <p className="text-sm font-medium text-red-200">
        Batch history could not be loaded
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-red-300/70">
        {error?.message ?? 'The batch service did not respond.'}
      </p>
      {error?.hint ? (
        <p className="mx-auto mt-1 max-w-md break-words text-[11px] leading-5 text-red-300/60">
          {error.hint}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 h-9 rounded-lg border border-red-300/25 px-3 text-[11px] font-medium text-red-100 transition hover:bg-red-300/10"
      >
        Retry
      </button>
    </div>
  )
}

function BatchEmptyState({
  onAddLinks,
  filtered
}: {
  onAddLinks?: () => void
  filtered: boolean
}): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-white/10 surface-inset px-6 py-8 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-base text-zinc-400"
      >
        ≡
      </div>
      {filtered ? (
        <>
          <p className="mt-2.5 text-sm font-medium text-zinc-300">
            Nothing in this filter
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Switch back to All to see every batch.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2.5 text-sm font-medium text-zinc-300">
            No batches yet
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Paste several links, or a playlist or list link, in the Add dialog.
          </p>
          {onAddLinks ? (
            <button
              type="button"
              onClick={onAddLinks}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-500 px-3 text-[12px] font-semibold text-on-accent transition hover:bg-accent-400"
            >
              <Icon name="plus" size={14} strokeWidth={2.2} />
              Add links
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

function batchPercent(batch: Batch): number {
  const { totalBytes, completedBytes } = batch.progress
  if (totalBytes !== null && totalBytes > 0) {
    return formatPercent(completedBytes, totalBytes)
  }
  if (batch.progress.totalItems > 0) {
    const finished =
      batch.progress.completedItems +
      batch.progress.failedItems +
      batch.progress.skippedItems
    return Math.min(100, (finished / batch.progress.totalItems) * 100)
  }
  return 0
}

function formatBatchDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return `started ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function rejectedToError(error: unknown): AppErrorInfo {
  const message = error instanceof Error ? error.message : ''
  if (/No handler registered/i.test(message)) {
    return {
      code: 'BATCH_UNAVAILABLE',
      message: 'Batch downloads are not available in this build.',
      hint: 'The batch service is not connected yet.'
    }
  }

  return {
    code: 'BATCH_REQUEST_FAILED',
    message: 'The batch request could not be completed.',
    hint: 'Try again in a moment.'
  }
}
