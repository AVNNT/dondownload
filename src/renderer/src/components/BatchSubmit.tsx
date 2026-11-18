import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  BATCH_MEDIA_QUALITIES,
  MAX_BATCH_SOURCES,
  MAX_COLLECTION_SELECTION,
  type BatchMediaQuality,
  type CollectionPreview,
  type CollectionSelectionAvailability
} from '@shared/batches'
import { formatMediaSize } from '@shared/format'
import type { DuplicateWarning } from '@shared/duplicates'
import type {
  AppErrorInfo,
  SmartBatchSubmitEntry,
  SmartBatchSubmitResult
} from '@shared/types'
import { filenameFromUrl } from '../lib/addParse'

const OUTCOME_LABEL: Record<SmartBatchSubmitEntry['outcome'], string> = {
  'batch-item': 'Queued',
  'collection-preview': 'Preview ready',
  unsupported: 'Needs browser',
  invalid: 'Invalid',
  failed: 'Failed'
}

const OUTCOME_STYLE: Record<SmartBatchSubmitEntry['outcome'], string> = {
  'batch-item': 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200',
  'collection-preview': 'border-emerald-400/20 bg-emerald-400/5 text-emerald-200',
  unsupported: 'border-amber-400/25 bg-amber-400/5 text-amber-200',
  invalid: 'border-red-400/25 bg-red-400/5 text-red-200',
  failed: 'border-red-400/25 bg-red-400/5 text-red-200'
}

/**
 * Batch submission moved out of the Batches page and into the Add dialog.
 * It reuses the exact IPC methods and renderer state that BatchSection used to
 * own (submitSmartBatch / createCollectionBatch / analyzeCollectionSelection /
 * openBatchSource); only the presentation moved.
 *
 * `urls` is the normalized, deduplicated list parsed from the Add dialog's
 * single field. Submission is explicit: nothing is queued until the user
 * presses the primary action, and collections always render a preview first.
 */
interface BatchSubmitProps {
  urls: string[]
  disabled?: boolean
}

export function BatchSubmit({ urls, disabled = false }: BatchSubmitProps): JSX.Element {
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
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<AppErrorInfo | null>(null)
  const [duplicateByUrl, setDuplicateByUrl] = useState<
    Record<string, DuplicateWarning | null>
  >({})
  const [skippedUrls, setSkippedUrls] = useState<Set<string>>(new Set())
  const submittedSignature = useRef<string>('')

  const signature = urls.join('\n')
  const urlList = useMemo(
    () => (signature.length === 0 ? [] : signature.split('\n')),
    [signature]
  )
  const selectedUrls = urlList.filter((url) => !skippedUrls.has(url))
  const selectedSignature = selectedUrls.join('\n')
  const duplicateCount = urlList.filter(
    (url) => duplicateByUrl[url] != null
  ).length

  const handleSubmit = useCallback(async (): Promise<void> => {
    const targets =
      selectedSignature.length === 0 ? [] : selectedSignature.split('\n')
    if (submitting || targets.length === 0) return
    if (targets.length > MAX_BATCH_SOURCES) {
      setSubmitError({
        code: 'BATCH_TOO_MANY_URLS',
        message: `Submit at most ${MAX_BATCH_SOURCES} URLs at a time.`
      })
      return
    }
    setSubmitError(null)
    setPreviewNotice(null)
    setSubmitting(true)
    setSubmitResult(null)
    try {
      const result = await window.donDownload.submitSmartBatch({
        urls: targets
      })
      if (!result.ok) {
        setSubmitError(result.error)
        return
      }
      submittedSignature.current = signature
      setSubmitResult(result.value)
      setPreviews((current) => mergePreviews(current, result.value.previews))
      setSelections((current) => {
        const next = { ...current }
        for (const preview of result.value.previews) {
          next[preview.id] = []
        }
        return next
      })
    } catch (error) {
      setSubmitError(rejectedToError(error))
    } finally {
      setSubmitting(false)
    }
  }, [submitting, selectedSignature, signature])

  // Reset the result when the input changes so stale outcomes are never shown
  // against a different URL list.
  useEffect(() => {
    if (submittedSignature.current !== '' && submittedSignature.current !== signature) {
      setSubmitResult(null)
      setPreviews([])
      setSelections({})
      setPreviewErrors({})
      setPreviewNotice(null)
    }
  }, [signature])

  // Advisory duplicate marks for the whole selection. Every URL is checked
  // once per membership change; main answers from its indexed history lookup.
  useEffect(() => {
    let cancelled = false
    if (urlList.length === 0) {
      setDuplicateByUrl({})
      setSkippedUrls(new Set())
      return
    }
    void (async () => {
      const entries = await Promise.all(
        urlList.map(async (url) => {
          try {
            const result = await window.donDownload.checkDuplicate(url)
            return [url, result.ok ? result.value : null] as const
          } catch {
            return [url, null] as const
          }
        })
      )
      if (cancelled) return
      const next: Record<string, DuplicateWarning | null> = {}
      for (const [url, warning] of entries) next[url] = warning
      setDuplicateByUrl(next)
      // Duplicates start unchecked; everything else stays selected. A manual
      // tick still wins until the membership changes again.
      setSkippedUrls(
        new Set(
          urlList.filter((url) => next[url] !== null && next[url] !== undefined)
        )
      )
    })()
    return () => {
      cancelled = true
    }
  }, [urlList])

  const toggleDuplicateSelection = useCallback((url: string): void => {
    setSkippedUrls((current) => {
      const next = new Set(current)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }, [])

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
    async (preview: CollectionPreview & { quality: BatchMediaQuality; maxBytes: number | null }): Promise<void> => {
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
          selectedEntryIds,
          ...(preview.kind === 'playlist'
            ? {
                mediaQuality: preview.quality,
                maxBytesPerItem: preview.maxBytes
              }
            : {})
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

  const interactionBusy = actionPending || queueingPreviewId !== null

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 surface-card p-3">
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-zinc-200">
            {selectedUrls.length} {selectedUrls.length === 1 ? 'link' : 'links'}{' '}
            to add
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-zinc-500">
            {duplicateCount > 0
              ? `${duplicateCount} ${duplicateCount === 1 ? 'link is' : 'links are'} already in your history and start unchecked.`
              : 'Direct links queue immediately; playlists and Pixeldrain lists show a preview first.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void handleSubmit()
          }}
          disabled={disabled || submitting || selectedUrls.length === 0}
          className="h-9 shrink-0 rounded-lg bg-accent-500 px-4 text-xs font-semibold text-on-accent transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {submitting
            ? 'Adding…'
            : `Add ${selectedUrls.length} ${selectedUrls.length === 1 ? 'link' : 'links'}`}
        </button>
      </div>

      <ul className="space-y-1.5 rounded-xl border border-white/10 surface-card p-3">
        {urlList.map((url) => {
          const duplicate = duplicateByUrl[url] ?? null
          const checked = !skippedUrls.has(url)
          return (
            <li key={url}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/5 surface-soft px-2.5 py-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || submitting}
                  onChange={() => toggleDuplicateSelection(url)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 surface-input accent-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-200">
                    <span className="break-words">{filenameFromUrl(url)}</span>
                    {duplicate !== null ? (
                      <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300">
                        {duplicate.state === 'active'
                          ? 'already in your list'
                          : 'already downloaded'}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                    {url}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      {submitError ? (
        <InlineError
          error={submitError}
          onDismiss={() => setSubmitError(null)}
        />
      ) : null}

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
          className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-2.5 text-[11px] leading-5 text-emerald-200"
        >
          {previewNotice}
        </p>
      ) : null}

      {previews.length > 0 ? (
        <div className="space-y-2.5">
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
              onQueue={(quality, maxBytes) => {
                void handleQueueSelected({ ...preview, quality, maxBytes })
              }}
              onDismiss={() => handleDismissPreview(preview.id)}
            />
          ))}
        </div>
      ) : null}

      {actionError ? (
        <InlineError error={actionError} onDismiss={() => setActionError(null)} />
      ) : null}
    </div>
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
    <div className="rounded-xl border border-white/10 surface-card p-3">
      <h3 className="px-1 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
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
  onQueue: (quality: BatchMediaQuality, maxBytes: number | null) => void
  onDismiss: () => void
}): JSX.Element {
  const titleId = `batch-preview-${preview.id}-title`
  const selectedCount = selectedIds.length
  const selectedKey = selectedIds.join('|')
  const atLimit = selectedCount >= MAX_COLLECTION_SELECTION
  const [availability, setAvailability] =
    useState<CollectionSelectionAvailability | null>(null)
  const [checkingFormats, setCheckingFormats] = useState(false)
  const [quality, setQuality] = useState<BatchMediaQuality>('best')
  const [maxMiB, setMaxMiB] = useState('')
  const [qualityError, setQualityError] = useState<string | null>(null)
  /* eslint-disable react-hooks/set-state-in-effect -- stale availability/errors must be cleared when the selection changes */
  useEffect(() => {
    setAvailability(null)
    setQualityError(null)
  }, [selectedKey])
  /* eslint-enable react-hooks/set-state-in-effect */

  const analyzeSelected = async (): Promise<void> => {
    if (!selectedCount || checkingFormats) return
    setCheckingFormats(true)
    setQualityError(null)
    try {
      const result = await window.donDownload.analyzeCollectionSelection({
        previewId: preview.id,
        selectedEntryIds: selectedIds
      })
      if (!result.ok) setQualityError(result.error.message)
      else setAvailability(result.value)
    } catch {
      setQualityError('Selected entries could not be analyzed for available formats.')
    } finally {
      setCheckingFormats(false)
    }
  }

  const qualityCounts = new Map<BatchMediaQuality, number>()
  const qualitySizes = new Map<
    BatchMediaQuality,
    { count: number; bytes: number | null; isEstimate: boolean }
  >()
  for (const entry of availability?.entries ?? []) {
    for (const option of entry.qualities) {
      qualityCounts.set(
        option.quality,
        (qualityCounts.get(option.quality) ?? 0) + 1
      )
      const summary = qualitySizes.get(option.quality) ?? {
        count: 0,
        bytes: 0,
        isEstimate: false
      }
      summary.count += 1
      if (summary.bytes !== null) {
        summary.bytes =
          option.estimatedBytes === null
            ? null
            : summary.bytes + option.estimatedBytes
      }
      summary.isEstimate = summary.isEstimate || option.sizeIsEstimate === true
      qualitySizes.set(option.quality, summary)
    }
  }
  const matchingCount = qualityCounts.get(quality) ?? 0
  const maxBytes = maxMiB.trim() === '' ? null : Math.round(Number(maxMiB) * 1024 * 1024)
  const validMaxBytes = maxBytes === null || (Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 100 * 1024 ** 3)
  const selectAllLabel =
    preview.availableCount > MAX_COLLECTION_SELECTION
      ? `Select first ${MAX_COLLECTION_SELECTION} available`
      : 'Select all available'

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-xl border border-white/10 surface-card p-3"
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
          className="h-8 shrink-0 rounded-lg border border-white/10 px-2.5 text-[11px] font-medium text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
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
                    ? 'border-white/5 surface-soft'
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
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 surface-input accent-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed"
                />
                <label
                  htmlFor={checkboxId}
                  className={`min-w-0 flex-1 ${
                    available ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-200">
                    <span className="text-[11px] tabular-nums text-zinc-500">
                      {index + 1}.
                    </span>
                    <span className="break-words">{entry.title}</span>
                    {!available ? (
                      <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                        Unavailable
                      </span>
                    ) : null}
                  </span>
                  {preview.kind === 'playlist' && checked && availability ? (
                    <span className="mt-1 block text-[11px] leading-4 text-zinc-500">
                      {availability.entries.find((result) => result.entryId === entry.id)?.qualities.length
                        ? `Verified: ${availability.entries.find((result) => result.entryId === entry.id)!.qualities.map((option) => `${qualityLabel(option.quality)} · ${formatMediaSize(option.estimatedBytes, option.sizeIsEstimate === true)}`).join(', ')}`
                        : 'No verified media formats available'}
                    </span>
                  ) : null}
                  {!available ? (
                    <span
                      id={reasonId}
                      className="mt-0.5 block text-[11px] leading-4 text-amber-200/70"
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
        <p className="mt-2 text-[11px] leading-4 text-zinc-500">
          Selection is limited to {MAX_COLLECTION_SELECTION} items per batch.
        </p>
      ) : null}
      {atLimit ? (
        <p className="mt-1 text-[11px] leading-4 text-amber-200/70">
          Selection limit reached. Uncheck or clear items to choose others.
        </p>
      ) : null}

      {preview.kind === 'playlist' ? (
        <div className="mt-3 rounded-lg border border-white/5 surface-soft p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-medium text-zinc-200">
                Playlist quality
              </p>
              <p className="text-[11px] text-zinc-500">
                Analyze selected entries first; unavailable qualities are
                skipped, never substituted.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void analyzeSelected()}
              disabled={busy || selectedCount === 0 || checkingFormats}
              className="h-8 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-zinc-200 disabled:opacity-40"
            >
              {checkingFormats ? 'Checking formats…' : 'Check selected formats'}
            </button>
          </div>
          {availability ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] font-medium text-zinc-400">
                Quality
                <select
                  value={quality}
                  onChange={(event) => setQuality(event.target.value as BatchMediaQuality)}
                  className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2 text-xs text-zinc-100"
                >
                  {BATCH_MEDIA_QUALITIES.filter((option) => qualityCounts.has(option)).map((option) => {
                    const summary = qualitySizes.get(option)
                    return (
                      <option key={option} value={option}>
                        {qualityLabel(option)} · {summary?.count ?? 0}/{selectedCount} ·{' '}
                        {formatMediaSize(summary?.bytes ?? null, summary?.isEstimate === true)}
                      </option>
                    )
                  })}
                </select>
              </label>
              <label className="text-[11px] font-medium text-zinc-400">
                Optional max per-job size (MiB)
                <input
                  type="number"
                  min="0.01"
                  max="102400"
                  step="0.01"
                  value={maxMiB}
                  onChange={(event) => setMaxMiB(event.target.value)}
                  placeholder="No limit"
                  className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2 text-xs text-zinc-100 placeholder:text-zinc-600"
                />
              </label>
              <p className="text-[11px] leading-4 text-zinc-500 sm:col-span-2">
                {matchingCount < selectedCount
                  ? `${selectedCount - matchingCount} selected ${selectedCount - matchingCount === 1 ? 'entry has' : 'entries have'} no ${qualityLabel(quality)} option and will be marked Skipped.`
                  : `${matchingCount} selected ${matchingCount === 1 ? 'entry has' : 'entries have'} this verified quality.`}{' '}
                Unknown-size and merged jobs are stopped at the cap during
                transfer; final output is checked before completion. Progress
                granularity may allow a small network overrun.
              </p>
            </div>
          ) : null}
          {!validMaxBytes ? (
            <p role="alert" className="mt-2 text-[11px] text-red-300">
              Enter a per-job limit up to 102400 MiB.
            </p>
          ) : null}
          {qualityError ? (
            <p role="alert" className="mt-2 text-[11px] text-red-300">
              {qualityError}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-300"
        >
          <p>{error.message}</p>
          {error.hint ? (
            <p className="mt-0.5 break-words text-[11px] text-red-300/70">
              {error.hint}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
        <p className="max-w-sm text-[11px] leading-4 text-zinc-500">
          Only available entries can be queued. Unavailable entries stay
          unselected and do not block the rest of the collection.
        </p>
        <button
          type="button"
          onClick={() => onQueue(quality, maxBytes)}
          disabled={busy || selectedCount === 0 || (preview.kind === 'playlist' && (!availability || matchingCount === 0 || !validMaxBytes))}
          className="h-10 shrink-0 rounded-xl bg-accent-500 px-4 text-sm font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {queueing
            ? 'Queueing…'
            : `Queue selected${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
        </button>
      </div>
    </article>
  )
}

function InlineError({
  error,
  onDismiss
}: {
  error: AppErrorInfo
  onDismiss: () => void
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
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg border border-red-300/20 px-2 py-0.5 text-[11px] text-red-200 transition hover:bg-red-300/10"
      >
        Dismiss
      </button>
    </div>
  )
}

function mergePreviews(
  current: readonly CollectionPreview[],
  incoming: readonly CollectionPreview[]
): CollectionPreview[] {
  const byId = new Map(current.map((preview) => [preview.id, preview]))
  for (const preview of incoming) byId.set(preview.id, preview)
  return [...byId.values()]
}

function previewKindLabel(kind: CollectionPreview['kind']): string {
  return kind === 'playlist' ? 'Playlist' : 'Pixeldrain list'
}

function qualityLabel(quality: BatchMediaQuality): string {
  return quality === 'audio-only' ? 'Audio only' : quality === 'best' ? 'Best available' : quality
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
