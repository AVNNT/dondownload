import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type JSX
} from 'react'
import {
  MAX_BATCH_SOURCES,
  MAX_COLLECTION_SELECTION,
  type Batch,
  type BatchItem,
  type BatchItemStatus,
  type BatchKind,
  type BatchStatus,
  type CollectionPreview
} from '@shared/batches'
import { formatBytes, formatPercent } from '@shared/format'
import type {
  ApiResult,
  AppErrorInfo,
  BatchSnapshot,
  SmartBatchEntryOutcome,
  SmartBatchSubmitEntry,
  SmartBatchSubmitResult
} from '@shared/types'

const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  partial: 'Partial',
  error: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

const BATCH_STATUS_STYLE: Record<BatchStatus, string> = {
  queued: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  running: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  complete: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  partial: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  error: 'border-red-400/30 bg-red-400/10 text-red-300',
  cancelled: 'border-zinc-600 bg-zinc-800/80 text-zinc-300',
  interrupted: 'border-amber-400/30 bg-amber-400/10 text-amber-300'
}

const BATCH_BAR_STYLE: Record<BatchStatus, string> = {
  queued: 'bg-zinc-600',
  running: 'bg-emerald-400',
  complete: 'bg-emerald-400',
  partial: 'bg-amber-400',
  error: 'bg-red-400',
  cancelled: 'bg-zinc-500',
  interrupted: 'bg-amber-400'
}

const ITEM_STATUS_LABEL: Record<BatchItemStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  error: 'Failed',
  unavailable: 'Unavailable',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

const ITEM_STATUS_STYLE: Record<BatchItemStatus, string> = {
  queued: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  running: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  complete: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  error: 'border-red-400/30 bg-red-400/10 text-red-300',
  unavailable: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  skipped: 'border-zinc-600 bg-zinc-800/80 text-zinc-400',
  cancelled: 'border-zinc-600 bg-zinc-800/80 text-zinc-300',
  interrupted: 'border-amber-400/30 bg-amber-400/10 text-amber-300'
}

const OUTCOME_LABEL: Record<SmartBatchEntryOutcome, string> = {
  'batch-item': 'Queued',
  'collection-preview': 'Preview ready',
  unsupported: 'Needs browser',
  invalid: 'Invalid',
  failed: 'Failed'
}

const OUTCOME_STYLE: Record<SmartBatchEntryOutcome, string> = {
  'batch-item': 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200',
  'collection-preview': 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200',
  unsupported: 'border-amber-400/25 bg-amber-400/5 text-amber-200',
  invalid: 'border-red-400/25 bg-red-400/5 text-red-200',
  failed: 'border-red-400/25 bg-red-400/5 text-red-200'
}

/**
 * Desktop-first batch surface. It intentionally owns only renderer state:
 * - the persisted batch list comes from `getBatchSnapshot` and
 *   `onBatchSnapshotChanged`; there is no polling timer;
 * - collection previews are ephemeral and stay local until the user explicitly
 *   selects entries and presses Queue selected;
 * - Gofile browser opens call `openBatchSource` with opaque batch/item IDs only.
 */
export function BatchSection(): JSX.Element {
  const [snapshot, setSnapshot] = useState<BatchSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [snapshotError, setSnapshotError] = useState<AppErrorInfo | null>(null)

  const [urlsText, setUrlsText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<AppErrorInfo | null>(null)
  const [submitResult, setSubmitResult] =
    useState<SmartBatchSubmitResult | null>(null)
  const [previews, setPreviews] = useState<CollectionPreview[]>([])
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [previewErrors, setPreviewErrors] = useState<
    Record<string, AppErrorInfo>
  >({})
  const [previewNotice, setPreviewNotice] = useState<string | null>(null)
  const [queueingPreviewId, setQueueingPreviewId] = useState<string | null>(
    null
  )

  const [expandedBatches, setExpandedBatches] = useState<
    Record<string, boolean>
  >({})
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null)

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

  const refreshSnapshot = useCallback(async (): Promise<void> => {
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
  }, [])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (submitting) return

      const urls = parseBatchUrls(urlsText)
      setSubmitError(null)
      setPreviewNotice(null)

      if (urls.length === 0) {
        setSubmitError({
          code: 'BATCH_NO_URLS',
          message: 'Enter at least one HTTP(S) URL, one per line.'
        })
        return
      }
      if (urls.length > MAX_BATCH_SOURCES) {
        setSubmitError({
          code: 'BATCH_TOO_MANY_URLS',
          message: `Submit at most ${MAX_BATCH_SOURCES} URLs at a time.`
        })
        return
      }

      setSubmitting(true)
      setSubmitResult(null)
      try {
        const result = await window.donDownload.submitSmartBatch({ urls })
        if (!result.ok) {
          setSubmitError(result.error)
          return
        }

        setSubmitResult(result.value)
        setPreviews((current) => mergePreviews(current, result.value.previews))
        setSelections((current) => {
          const next = { ...current }
          for (const preview of result.value.previews) {
            // A fresh preview always starts with no selection.
            next[preview.id] = []
          }
          return next
        })
        if (result.value.batch !== null) {
          setExpandedBatches((current) => ({
            ...current,
            [result.value.batch!.id]: true
          }))
        }
      } catch (error) {
        setSubmitError(rejectedToError(error))
      } finally {
        setSubmitting(false)
      }
    },
    [submitting, urlsText]
  )

  const handleToggleEntry = useCallback(
    (previewId: string, entryId: string): void => {
      setSelections((current) => {
        const selected = current[previewId] ?? []
        const next = selected.includes(entryId)
          ? selected.filter((id) => id !== entryId)
          : [...selected, entryId]
        return { ...current, [previewId]: next }
      })
      setPreviewErrors((current) => {
        if (!(previewId in current)) return current
        const next = { ...current }
        delete next[previewId]
        return next
      })
    },
    []
  )

  const handleSelectAll = useCallback((preview: CollectionPreview): void => {
    const available = preview.entries
      .filter((entry) => entry.availability === 'available')
      .map((entry) => entry.id)
    setSelections((current) => ({
      ...current,
      [preview.id]: available.slice(0, MAX_COLLECTION_SELECTION)
    }))
    setPreviewErrors((current) => {
      if (!(preview.id in current)) return current
      const next = { ...current }
      delete next[preview.id]
      return next
    })
  }, [])

  const handleClearSelection = useCallback((previewId: string): void => {
    setSelections((current) => ({ ...current, [previewId]: [] }))
  }, [])

  const handleDismissPreview = useCallback((previewId: string): void => {
    setPreviews((current) => current.filter((preview) => preview.id !== previewId))
    setSelections((current) => {
      const next = { ...current }
      delete next[previewId]
      return next
    })
    setPreviewErrors((current) => {
      const next = { ...current }
      delete next[previewId]
      return next
    })
    setSubmitResult((current) =>
      current === null
        ? null
        : {
            ...current,
            entries: current.entries.filter(
              (entry) => entry.previewId !== previewId
            )
          }
    )
  }, [])

  const handleQueueSelected = useCallback(
    async (preview: CollectionPreview): Promise<void> => {
      const selectedEntryIds = selections[preview.id] ?? []
      if (selectedEntryIds.length === 0 || queueingPreviewId !== null) return

      setQueueingPreviewId(preview.id)
      setPreviewNotice(null)
      setPreviewErrors((current) => {
        if (!(preview.id in current)) return current
        const next = { ...current }
        delete next[preview.id]
        return next
      })

      try {
        const result = await window.donDownload.createCollectionBatch({
          previewId: preview.id,
          selectedEntryIds
        })
        if (!result.ok) {
          setPreviewErrors((current) => ({
            ...current,
            [preview.id]: result.error
          }))
          return
        }

        const queuedCount = selectedEntryIds.length
        setPreviews((current) =>
          current.filter((entry) => entry.id !== preview.id)
        )
        setSelections((current) => {
          const next = { ...current }
          delete next[preview.id]
          return next
        })
        setPreviewErrors((current) => {
          const next = { ...current }
          delete next[preview.id]
          return next
        })
        setSubmitResult((current) =>
          current === null
            ? null
            : {
                ...current,
                entries: current.entries.map((entry) =>
                  entry.previewId === preview.id
                    ? {
                        ...entry,
                        outcome: 'batch-item' as const,
                        batchId: result.value.id,
                        itemId: null,
                        previewId: null,
                        code: null,
                        message: `Queued ${queuedCount} selected ${
                          queuedCount === 1 ? 'item' : 'items'
                        } into a new batch.`
                      }
                    : entry
                )
              }
        )
        setExpandedBatches((current) => ({
          ...current,
          [result.value.id]: true
        }))
        setPreviewNotice(
          `Queued ${queuedCount} selected ${
            queuedCount === 1 ? 'item' : 'items'
          } from "${preview.title}".`
        )
      } catch (error) {
        setPreviewErrors((current) => ({
          ...current,
          [preview.id]: rejectedToError(error)
        }))
      } finally {
        setQueueingPreviewId(null)
      }
    },
    [queueingPreviewId, selections]
  )

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

  const batches = snapshot?.batches ?? []
  const parsedUrlCount = parseBatchUrls(urlsText).length
  const interactionBusy = actionPending || queueingPreviewId !== null

  return (
    <section aria-labelledby="batches-heading">
      <div className="mb-2 flex items-baseline justify-between">
        <h2
          id="batches-heading"
          className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
        >
          Batch downloads
        </h2>
        {batches.length > 0 ? (
          <span className="text-[11px] tabular-nums text-zinc-500">
            {batches.length} {batches.length === 1 ? 'batch' : 'batches'}
          </span>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          void handleSubmit(event)
        }}
        className="rounded-xl border border-white/10 bg-[#080808] p-3"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3 px-1">
            <label
              htmlFor="batch-urls"
              className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400"
            >
              Batch URLs
            </label>
            <span className="text-[10px] tabular-nums text-zinc-500">
              {parsedUrlCount > 0
                ? `${parsedUrlCount} ${
                    parsedUrlCount === 1 ? 'URL' : 'URLs'
                  }`
                : 'One per line'}
            </span>
          </div>
          <textarea
            id="batch-urls"
            rows={3}
            autoComplete="off"
            spellCheck={false}
            value={urlsText}
            onChange={(event) => {
              setUrlsText(event.target.value)
              setSubmitError(null)
            }}
            placeholder={
              'https://example.com/file-a.zip\nhttps://example.com/file-b.zip\nhttps://www.youtube.com/playlist?list=...'
            }
            disabled={submitting}
            aria-describedby="batch-urls-help"
            className="min-h-[80px] w-full resize-y rounded-lg border border-white/10 bg-black px-3 py-2.5 text-sm leading-6 text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
          />
          <p
            id="batch-urls-help"
            className="px-1 text-[11px] leading-5 text-zinc-400"
          >
            One HTTP(S) URL per line. Direct links and Pixeldrain files are
            queued immediately. Playlists and Pixeldrain lists return a preview
            first:{' '}
            <span className="text-zinc-300">
              nothing from a collection is queued until you select items and
              choose Queue selected.
            </span>
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setUrlsText('')
                setSubmitError(null)
                setSubmitResult(null)
              }}
              disabled={submitting || urlsText.length === 0}
              className="h-9 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear input
            </button>
            <button
              type="submit"
              disabled={submitting || parsedUrlCount === 0}
              className="h-10 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {submitting ? 'Submitting…' : 'Submit batch'}
            </button>
          </div>
        </div>

        {submitError ? (
          <InlineError
            error={submitError}
            onDismiss={() => setSubmitError(null)}
          />
        ) : null}
      </form>

      {submitResult ? (
        <SubmitOutcomes
          result={submitResult}
          busy={interactionBusy}
          onOpenSource={(batchId, itemId) => {
            void handleOpenSource(batchId, itemId)
          }}
        />
      ) : null}

      {previewNotice ? (
        <p
          role="status"
          className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-2.5 text-[11px] leading-5 text-emerald-200"
        >
          {previewNotice}
        </p>
      ) : null}

      {previews.length > 0 ? (
        <div className="mt-3 space-y-2.5">
          {previews.map((preview) => (
            <PreviewCard
              key={preview.id}
              preview={preview}
              selectedIds={selections[preview.id] ?? []}
              busy={interactionBusy}
              queueing={queueingPreviewId === preview.id}
              error={previewErrors[preview.id] ?? null}
              onToggleEntry={(entryId) => {
                handleToggleEntry(preview.id, entryId)
              }}
              onSelectAll={() => handleSelectAll(preview)}
              onClearSelection={() => handleClearSelection(preview.id)}
              onQueue={() => {
                void handleQueueSelected(preview)
              }}
              onDismiss={() => handleDismissPreview(preview.id)}
            />
          ))}
        </div>
      ) : null}

      {actionError ? (
        <InlineError error={actionError} onDismiss={() => setActionError(null)} />
      ) : null}

      {snapshotError && snapshot !== null ? (
        <InlineError
          error={snapshotError}
          onDismiss={() => setSnapshotError(null)}
          onRetry={() => {
            void refreshSnapshot()
          }}
        />
      ) : null}

      {loading && snapshot === null ? (
        <LoadingState />
      ) : snapshot === null ? (
        <SnapshotErrorState
          error={snapshotError}
          onRetry={() => {
            void refreshSnapshot()
          }}
        />
      ) : batches.length === 0 ? (
        <BatchEmptyState />
      ) : (
        <div className="mt-3 space-y-2.5">
          {batches.map((batch) => (
            <BatchCard
              key={batch.id}
              batch={batch}
              expanded={expandedBatches[batch.id] ?? false}
              busy={interactionBusy}
              onToggle={() => {
                setExpandedBatches((current) => ({
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
              onCancelItem={(item) => {
                void runSnapshotAction(() =>
                  window.donDownload.cancelBatchItem({
                    batchId: batch.id,
                    itemId: item.id
                  })
                )
              }}
              onRetryItem={(item) => {
                void runSnapshotAction(() =>
                  window.donDownload.retryBatchItem({
                    batchId: batch.id,
                    itemId: item.id
                  })
                )
              }}
              onOpenSource={(item) => {
                void handleOpenSource(batch.id, item.id)
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SubmitOutcomes({
  result,
  busy,
  onOpenSource
}: {
  result: SmartBatchSubmitResult
  busy: boolean
  onOpenSource: (batchId: string, itemId: string) => void
}): JSX.Element {
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-[#080808] p-3">
      <h3 className="px-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
        Submit results
      </h3>
      <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1">
        {result.entries.map((entry) => {
          const canOpen =
            entry.outcome === 'unsupported' &&
            entry.code === 'GOFILE_BROWSER_REQUIRED' &&
            entry.batchId !== null &&
            entry.itemId !== null

          return (
            <li
              key={entry.index}
              className={`rounded-xl border px-3 py-2 text-[11px] leading-5 ${
                OUTCOME_STYLE[entry.outcome]
              }`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">
                    URL {entry.index + 1} · {OUTCOME_LABEL[entry.outcome]}
                  </p>
                  <p className="mt-0.5 break-words opacity-80">
                    {entry.message ?? defaultOutcomeMessage(entry)}
                  </p>
                </div>
                {canOpen ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (entry.batchId !== null && entry.itemId !== null) {
                        onOpenSource(entry.batchId, entry.itemId)
                      }
                    }}
                    disabled={busy}
                    aria-label={`Open Gofile link from URL ${entry.index + 1} in your browser`}
                    className="h-8 shrink-0 rounded-lg border border-amber-300/30 px-3 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Open in browser
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function PreviewCard({
  preview,
  selectedIds,
  busy,
  queueing,
  error,
  onToggleEntry,
  onSelectAll,
  onClearSelection,
  onQueue,
  onDismiss
}: {
  preview: CollectionPreview
  selectedIds: string[]
  busy: boolean
  queueing: boolean
  error: AppErrorInfo | null
  onToggleEntry: (entryId: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onQueue: () => void
  onDismiss: () => void
}): JSX.Element {
  const titleId = `batch-preview-${preview.id}-title`
  const selectedCount = selectedIds.length
  const atLimit = selectedCount >= MAX_COLLECTION_SELECTION
  const selectAllLabel =
    preview.availableCount > MAX_COLLECTION_SELECTION
      ? `Select first ${MAX_COLLECTION_SELECTION} available`
      : 'Select all available'

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-xl border border-white/10 bg-[#080808] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id={titleId}
            className="truncate text-sm font-medium text-zinc-100"
            title={preview.title}
          >
            {preview.title}
          </h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {previewKindLabel(preview.kind)} ·{' '}
            <span className="tabular-nums">{preview.entryCount}</span>{' '}
            {preview.entryCount === 1 ? 'item' : 'items'} ·{' '}
            <span className="tabular-nums">{preview.availableCount}</span>{' '}
            available
            {preview.unavailableCount > 0 ? (
              <>
                {' '}
                ·{' '}
                <span className="tabular-nums text-amber-300/80">
                  {preview.unavailableCount}
                </span>{' '}
                unavailable
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          aria-label={`Dismiss preview for ${preview.title}`}
          className="h-8 shrink-0 rounded-lg border border-white/10 px-2.5 text-[10px] font-medium text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Dismiss
        </button>
      </div>

      <p className="mt-2 rounded-lg border border-amber-400/15 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200/90">
        Nothing is queued automatically. Select the items you want, then choose
        Queue selected.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          disabled={busy || preview.availableCount === 0}
          className="h-8 rounded-lg border border-white/10 px-2.5 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {selectAllLabel}
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          disabled={busy || selectedCount === 0}
          className="h-8 rounded-lg border border-white/10 px-2.5 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear selection
        </button>
        <span
          className="text-[11px] tabular-nums text-zinc-500"
          aria-live="polite"
        >
          {selectedCount} selected
        </span>
      </div>

      <ul className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {preview.entries.map((entry, index) => {
          const available = entry.availability === 'available'
          const checked = selectedIds.includes(entry.id)
          const checkboxId = `batch-preview-${preview.id}-entry-${entry.id}`
          const reasonId = available ? undefined : `${checkboxId}-reason`
          const disabled = busy || !available || (atLimit && !checked)

          return (
            <li key={entry.id}>
              <div
                className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 ${
                  available
                    ? 'border-white/5 bg-black/30'
                    : 'border-white/5 bg-white/[0.015] opacity-70'
                }`}
              >
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggleEntry(entry.id)}
                  aria-describedby={reasonId}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 bg-black accent-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed"
                />
                <label
                  htmlFor={checkboxId}
                  className={`min-w-0 flex-1 ${
                    available ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-200">
                    <span className="text-[10px] tabular-nums text-zinc-500">
                      {index + 1}.
                    </span>
                    <span className="break-words">{entry.title}</span>
                    {!available ? (
                      <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                        Unavailable
                      </span>
                    ) : null}
                  </span>
                  {!available ? (
                    <span
                      id={reasonId}
                      className="mt-0.5 block text-[10px] leading-4 text-amber-200/70"
                    >
                      {entry.errorReason ?? entry.errorCode ?? 'Not available'}
                    </span>
                  ) : null}
                </label>
              </div>
            </li>
          )
        })}
      </ul>

      {preview.availableCount > MAX_COLLECTION_SELECTION ? (
        <p className="mt-2 text-[10px] leading-4 text-zinc-500">
          Selection is limited to {MAX_COLLECTION_SELECTION} items per batch.
        </p>
      ) : null}
      {atLimit ? (
        <p className="mt-1 text-[10px] leading-4 text-amber-200/70">
          Selection limit reached. Uncheck or clear items to choose others.
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-300"
        >
          <p>{error.message}</p>
          {error.hint ? (
            <p className="mt-0.5 break-words text-[10px] text-red-300/70">
              {error.hint}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
        <p className="max-w-sm text-[10px] leading-4 text-zinc-500">
          Only available entries can be queued. Unavailable entries stay
          unselected and do not block the rest of the collection.
        </p>
        <button
          type="button"
          onClick={onQueue}
          disabled={busy || selectedCount === 0}
          className="h-10 shrink-0 rounded-xl bg-emerald-400 px-4 text-sm font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {queueing
            ? 'Queueing…'
            : `Queue selected${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
        </button>
      </div>
    </article>
  )
}

function BatchCard({
  batch,
  expanded,
  busy,
  onToggle,
  onCancelBatch,
  onRemoveBatch,
  onCancelItem,
  onRetryItem,
  onOpenSource
}: {
  batch: Batch
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onCancelBatch: () => void
  onRemoveBatch: () => void
  onCancelItem: (item: BatchItem) => void
  onRetryItem: (item: BatchItem) => void
  onOpenSource: (item: BatchItem) => void
}): JSX.Element {
  const titleId = `batch-${batch.id}-title`
  const itemsId = `batch-${batch.id}-items`
  const active = batch.status === 'queued' || batch.status === 'running'
  const percent = batchPercent(batch)
  const progressText = `${batch.progress.completedItems} of ${
    batch.progress.totalItems
  } ${batch.progress.totalItems === 1 ? 'item' : 'items'} finished`

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-xl border border-white/10 bg-[#080808] p-3 transition-colors hover:border-white/20"
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={expanded ? itemsId : undefined}
          className="group flex min-w-0 flex-1 items-start gap-2 rounded-lg text-left"
        >
          <span
            aria-hidden="true"
            className={`mt-0.5 inline-block text-[10px] text-zinc-500 transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          >
            ▶
          </span>
          <span className="min-w-0">
            <span
              id={titleId}
              className="block truncate text-sm font-medium text-zinc-100"
              title={batch.title}
            >
              {batch.title}
            </span>
            <span className="mt-0.5 block text-[11px] text-zinc-500">
              {batchKindLabel(batch.kind)} ·{' '}
              <span className="tabular-nums">{batch.progress.totalItems}</span>{' '}
              {batch.progress.totalItems === 1 ? 'item' : 'items'}
            </span>
          </span>
        </button>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            BATCH_STATUS_STYLE[batch.status]
          }`}
        >
          {BATCH_STATUS_LABEL[batch.status]}
        </span>
      </div>

      <div className="mt-3">
        <div
          role="progressbar"
          aria-label={`Batch progress for ${batch.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={`${Math.round(percent)}%. ${progressText}.`}
          className="h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${
              BATCH_BAR_STYLE[batch.status]
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span className="tabular-nums">
            <span className="text-zinc-300">
              {batch.progress.completedItems}
            </span>{' '}
            / {batch.progress.totalItems} complete
            {batch.progress.failedItems > 0 ? (
              <span className="ml-2 text-red-300/80">
                {batch.progress.failedItems} failed
              </span>
            ) : null}
            {batch.progress.skippedItems > 0 ? (
              <span className="ml-2 text-amber-300/80">
                {batch.progress.skippedItems} skipped
              </span>
            ) : null}
          </span>
          {batch.progress.completedBytes > 0 ||
          batch.progress.totalBytes !== null ? (
            <span className="tabular-nums">
              {formatBytes(batch.progress.completedBytes)} /{' '}
              {batch.progress.totalBytes !== null
                ? formatBytes(batch.progress.totalBytes)
                : 'unknown'}
            </span>
          ) : null}
        </div>
      </div>

      {batch.errorMessage ? (
        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200">
          {batch.errorMessage}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {active ? (
          <CardAction
            label="Cancel group"
            ariaLabel={`Cancel batch ${batch.title}`}
            disabled={busy}
            onClick={onCancelBatch}
            danger
          />
        ) : null}
        <CardAction
          label="Remove group card"
          ariaLabel={`Remove batch card ${batch.title}`}
          disabled={busy}
          onClick={onRemoveBatch}
          danger
        />
      </div>
      <p className="mt-2 text-[10px] leading-4 text-zinc-500">
        Removing this group card clears only the batch history. Child downloads,
        media jobs and files on disk are kept.
      </p>

      {expanded ? (
        <div id={itemsId} className="mt-3 border-t border-white/5 pt-3">
          {batch.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 bg-black/30 px-3 py-4 text-center text-[11px] text-zinc-500">
              No child items.
            </p>
          ) : (
            <ul className="space-y-2">
              {batch.items.map((item, index) => (
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

  return (
    <li className="rounded-xl border border-white/5 bg-black/40 px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-200">
            <span className="text-[10px] tabular-nums text-zinc-500">
              {index + 1}.
            </span>
            <span className="break-words" title={item.title}>
              {item.title}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                ITEM_STATUS_STYLE[item.status]
              }`}
            >
              {ITEM_STATUS_LABEL[item.status]}
            </span>
          </p>
          <p className="mt-0.5 truncate text-[10px] text-zinc-400" title={item.label}>
            {item.label}
          </p>
          {item.completedBytes > 0 || item.totalBytes !== null ? (
            <p className="mt-1 text-[10px] tabular-nums text-zinc-500">
              {formatBytes(item.completedBytes)} /{' '}
              {item.totalBytes !== null
                ? formatBytes(item.totalBytes)
                : 'unknown'}
            </p>
          ) : null}
          {item.errorMessage ? (
            <p
              className={`mt-1 break-words text-[11px] leading-5 ${
                item.status === 'unavailable' || item.status === 'skipped'
                  ? 'text-amber-200/80'
                  : 'text-red-300'
              }`}
            >
              {item.errorMessage}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {retryable ? (
            <CardAction
              label="Retry"
              ariaLabel={`Retry ${item.title}`}
              disabled={busy}
              onClick={onRetry}
              accent
            />
          ) : null}
          {active ? (
            <CardAction
              label="Cancel"
              ariaLabel={`Cancel ${item.title}`}
              disabled={busy}
              onClick={onCancel}
              danger
            />
          ) : null}
          {browserRequired ? (
            <CardAction
              label="Open in browser"
              ariaLabel={`Open ${item.title} in your browser`}
              disabled={busy}
              onClick={onOpenSource}
              accent
            />
          ) : null}
        </div>
      </div>
    </li>
  )
}

function CardAction({
  label,
  ariaLabel,
  onClick,
  disabled,
  accent = false,
  danger = false
}: {
  label: string
  ariaLabel: string
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
      aria-label={ariaLabel}
      className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {label}
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
      className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/5 px-4 py-3 text-xs leading-5 text-red-200"
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
      className="mt-3 rounded-xl border border-white/10 bg-[#050505] px-6 py-8 text-center"
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
    <div className="mt-3 rounded-xl border border-red-400/25 bg-red-400/5 px-6 py-8 text-center">
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

function BatchEmptyState(): JSX.Element {
  return (
    <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-[#050505] px-6 py-8 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-base text-zinc-400"
      >
        ≡
      </div>
      <p className="mt-2.5 text-sm font-medium text-zinc-300">No batches yet</p>
      <p className="mt-1 text-xs text-zinc-400">
        Submit one or more URLs above. Collections appear as previews until you
        select items.
      </p>
    </div>
  )
}

function parseBatchUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function mergePreviews(
  current: readonly CollectionPreview[],
  incoming: readonly CollectionPreview[]
): CollectionPreview[] {
  const byId = new Map(current.map((preview) => [preview.id, preview]))
  for (const preview of incoming) byId.set(preview.id, preview)
  return [...byId.values()]
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

function batchKindLabel(kind: BatchKind): string {
  switch (kind) {
    case 'media-playlist':
      return 'Playlist'
    case 'pixeldrain-list':
      return 'Pixeldrain list'
    case 'direct-urls':
      return 'Direct URLs'
  }
}

function previewKindLabel(kind: CollectionPreview['kind']): string {
  return kind === 'playlist' ? 'Playlist' : 'Pixeldrain list'
}

function defaultOutcomeMessage(entry: SmartBatchSubmitEntry): string {
  switch (entry.outcome) {
    case 'batch-item':
      return 'Added to the batch below.'
    case 'collection-preview':
      return 'Preview ready below. Select items before queueing anything.'
    case 'unsupported':
      return 'This link cannot be queued here.'
    case 'invalid':
      return 'This URL is not valid.'
    case 'failed':
      return 'This URL could not be added.'
  }
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
