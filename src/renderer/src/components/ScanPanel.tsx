import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  type ScanCategory,
  type ScanItem,
  type ScanSession
} from '@shared/scanner'
import type { AppErrorInfo } from '@shared/types'
import { formatBytes } from '@shared/format'
import { Icon, type IconName } from './Icon'
import { StatusBadge } from './StatusBadge'
import type { StatusTone } from '../lib/unified'
import { Thumbnail } from './Thumbnail'
import { createScanAutoStart, type ScanAutoStart } from '../scanAutoStart'

interface ScanPanelProps {
  initialUrl: string
  initialSession?: ScanSession | null
  disabled?: boolean
}

interface GroupDefinition {
  category: Exclude<ScanCategory, 'page'>
  label: string
  icon: IconName
  accent: string
}

const GROUPS: readonly GroupDefinition[] = [
  { category: 'video', label: 'Videos', icon: 'video', accent: 'text-sky-300' },
  { category: 'audio', label: 'Audio', icon: 'audio', accent: 'text-violet-300' },
  { category: 'image', label: 'Images', icon: 'image', accent: 'text-emerald-300' },
  {
    category: 'document',
    label: 'Documents',
    icon: 'document',
    accent: 'text-amber-300'
  },
  {
    category: 'archive',
    label: 'Archives',
    icon: 'archive',
    accent: 'text-orange-300'
  },
  { category: 'script', label: 'Scripts', icon: 'program', accent: 'text-fuchsia-300' },
  { category: 'other', label: 'Other', icon: 'other', accent: 'text-zinc-300' }
]

type FilterMode = 'all' | 'script-video'

function isQueueable(item: ScanItem): boolean {
  return (
    item.kind === 'file' &&
    item.category !== 'page' &&
    item.status !== 'signin' &&
    item.status !== 'unavailable'
  )
}

function statusTone(status: ScanItem['status']): StatusTone {
  if (status === 'ready') return 'complete'
  if (status === 'probing') return 'active'
  if (status === 'signin') return 'warning'
  if (status === 'unavailable') return 'failed'
  return 'queued'
}

function statusLabel(status: ScanItem['status']): string {
  if (status === 'ready') return 'Verified'
  if (status === 'probing') return 'Checking'
  if (status === 'signin') return 'Sign-in needed'
  if (status === 'unavailable') return 'Unavailable'
  return 'Found'
}

function mergeUpdate(
  current: ScanSession | null,
  update: ScanSession
): ScanSession {
  if (current === null || current.sessionId !== update.sessionId) {
    return update
  }
  const items = new Map(current.items.map((item) => [item.id, item]))
  for (const item of update.items) items.set(item.id, item)
  for (const removed of update.removedItemIds) items.delete(removed)
  return {
    ...update,
    items: [...items.values()]
  }
}

function extensionOf(name: string): string | null {
  const match = /\.([a-z0-9]{1,12})$/i.exec(name.trim())
  return match ? match[1]!.toUpperCase() : null
}

function selectionSize(items: readonly ScanItem[], selected: Set<string>): {
  bytes: number
  unknown: boolean
  count: number
} {
  let bytes = 0
  let unknown = false
  let count = 0
  for (const item of items) {
    if (!selected.has(item.id)) continue
    count += 1
    if (item.sizeBytes === null) unknown = true
    else bytes += item.sizeBytes
  }
  return { bytes, unknown, count }
}

function sizeLabel(items: readonly ScanItem[], selected: Set<string>): string {
  const { bytes, unknown, count } = selectionSize(items, selected)
  if (count === 0) return '0 B'
  if (bytes === 0 && unknown) return 'size unknown'
  return unknown ? `${formatBytes(bytes)}+` : formatBytes(bytes)
}

export function ScanPanel({
  initialUrl,
  initialSession = null,
  disabled = false
}: ScanPanelProps): JSX.Element {
  const [url, setUrl] = useState(initialUrl)
  const [session, setSession] = useState<ScanSession | null>(initialSession)
  const [error, setError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [queuing, setQueuing] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<FilterMode>('all')
  const controllerRef = useRef<ScanAutoStart | null>(null)
  const sessionIdRef = useRef<string | null>(initialSession?.sessionId ?? null)
  const pendingUpdatesRef = useRef<Map<string, ScanSession[]>>(new Map())

  const applySession = useCallback((next: ScanSession): void => {
    sessionIdRef.current = next.sessionId
    setSession((current) => mergeUpdate(current, next))
  }, [])

  useEffect(() => {
    const unsubscribe = window.donDownload.onScanUpdated((update) => {
      if (sessionIdRef.current === update.sessionId) {
        applySession(update)
        return
      }
      // A very fast scan can publish before `scan:start` resolves. Buffer those
      // deltas and replay them once the new session ID is known.
      const buffered = pendingUpdatesRef.current.get(update.sessionId) ?? []
      if (buffered.length < 200) buffered.push(update)
      pendingUpdatesRef.current.set(update.sessionId, buffered)
    })
    return unsubscribe
  }, [applySession])

  const adoptSession = useCallback(
    (next: ScanSession): void => {
      applySession(next)
      const buffered = pendingUpdatesRef.current.get(next.sessionId) ?? []
      pendingUpdatesRef.current.delete(next.sessionId)
      for (const update of buffered) applySession(update)
    },
    [applySession]
  )

  useEffect(() => {
    const controller = createScanAutoStart({
      start: async (value) => {
        setStarting(true)
        setError(null)
        setNotice(null)
        const result = await window.donDownload.startScan({ url: value })
        setStarting(false)
        return result
      },
      cancel: (sessionId) => window.donDownload.cancelScan(sessionId),
      onResult: (result, value) => {
        setStarting(false)
        if (result.ok) {
          setUrl(value)
          setSelection(new Set())
          adoptSession(result.value)
        } else {
          setError(result.error)
        }
      },
      onRejected: (reason) => {
        setStarting(false)
        setError({
          code: 'SCAN_REQUEST_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The page scan could not be started.'
        })
      }
    })
    controllerRef.current = controller
    return () => {
      controller.cancel()
      controllerRef.current = null
    }
  }, [adoptSession])

  useEffect(() => {
    if (initialSession !== null) return
    controllerRef.current?.update(url)
  }, [initialSession, url])

  const items = session?.items ?? []
  const visibleGroups = useMemo(() => {
    return GROUPS.map((group) => {
      const groupItems = items.filter((item) => item.category === group.category)
      const filtered =
        filter === 'script-video'
          ? groupItems.filter(
              (item) => item.category === 'script' || item.category === 'video'
            )
          : groupItems
      return { group, items: filtered }
    }).filter((entry) => entry.items.length > 0)
  }, [filter, items])

  const queueable = items.filter(isQueueable)
  const selectedItems = queueable.filter((item) => selection.has(item.id))
  const allVisibleSelected =
    queueable.length > 0 && queueable.every((item) => selection.has(item.id))

  const toggle = (itemId: string): void => {
    setSelection((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const toggleGroup = (groupItems: readonly ScanItem[]): void => {
    const ids = groupItems.filter(isQueueable).map((item) => item.id)
    const allSelected = ids.length > 0 && ids.every((id) => selection.has(id))
    setSelection((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const toggleAll = (): void => {
    setSelection(
      allVisibleSelected ? new Set() : new Set(queueable.map((item) => item.id))
    )
  }

  const rescan = (): void => {
    if (session === null) return
    controllerRef.current?.cancel()
    const target = url.trim().length > 0 ? url : initialUrl
    void (async () => {
      setStarting(true)
      setError(null)
      setNotice(null)
      const result = await window.donDownload.startScan({ url: target })
      setStarting(false)
      if (result.ok) {
        setSelection(new Set())
        adoptSession(result.value)
      } else {
        setError(result.error)
      }
    })()
  }

  const cancelScan = (): void => {
    if (session === null) return
    void window.donDownload.cancelScan(session.sessionId).then((result) => {
      if (result.ok) applySession(result.value)
      else setError(result.error)
    })
  }

  const queueSelected = (): void => {
    if (session === null || selectedItems.length === 0 || queuing) return
    const ids = selectedItems.map((item) => item.id)
    setQueuing(true)
    setError(null)
    setNotice(null)
    void window.donDownload
      .queueScanSelection(session.sessionId, ids)
      .then((result) => {
        setQueuing(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        setSelection(new Set())
        const skipped =
          result.value.skipped.length > 0
            ? ` ${result.value.skipped.length} item(s) were skipped.`
            : ''
        setNotice(
          `Queued ${result.value.queuedItemIds.length} file(s) in one batch.${skipped}`
        )
      })
      .catch((reason: unknown) => {
        setQueuing(false)
        setError({
          code: 'SCAN_QUEUE_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The selected files could not be queued.'
        })
      })
  }

  const scanning = session?.status === 'scanning'
  const progress = session?.progress
  const counters = session?.counters
  const selectionLabel = sizeLabel(queueable, selection)

  return (
    <section aria-labelledby="scan-heading" className="flex h-full flex-col gap-3">
      <div className="rounded-xl border border-white/10 surface-card p-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2
            id="scan-heading"
            className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
          >
            Scan page
          </h2>
          <span className="text-[11px] text-zinc-400">
            Nothing downloads until you choose it
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="scan-url">
            Page URL to scan
          </label>
          <input
            id="scan-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setNotice(null)
              setError(null)
            }}
            placeholder="Paste a forum topic or media page URL"
            disabled={disabled}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 surface-input px-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => {
              if (session !== null) rescan()
              else controllerRef.current?.update(url)
            }}
            disabled={disabled || starting || url.trim().length === 0}
            className="h-10 shrink-0 rounded-lg border border-white/10 px-4 text-sm font-semibold text-zinc-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? 'Scanning…' : session === null ? 'Scan' : 'Rescan'}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-zinc-500">
          Anonymous pages are scanned directly. For a signed-in page, use “Scan
          this page” in the DonDownload browser extension after allowing cookies
          for that site.
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-300">
          {error.message}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-3 py-2 text-[11px] leading-5 text-emerald-200">
          {notice}
        </p>
      ) : null}
      {session?.signinRequired ? (
        <p role="status" className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200">
          This page needs your browser sign-in. Open the tab where you are signed
          in, choose “Scan this page” in the DonDownload extension, and allow
          cookies for that exact site first.
        </p>
      ) : null}

      {session === null ? (
        <p className="rounded-xl border border-white/10 surface-card p-4 text-[11px] leading-5 text-zinc-500">
          Paste a page URL above. DonDownload lists videos, audio, images,
          documents, archives, scripts and other files it can see, grouped by
          type. A scan never starts a download.
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 surface-card p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="truncate text-sm font-semibold text-zinc-100">
                {session.hostname || 'Scanned page'}
              </span>
              <span className="text-[11px] text-zinc-400">
                {session.status === 'scanning'
                  ? `${progress?.queueableItems ?? 0} found · scanning${
                      progress?.fetchedPages ? ` · ${progress.fetchedPages} page(s) read` : ''
                    }`
                  : session.status === 'limited'
                    ? 'Item limit reached'
                    : session.status === 'failed'
                      ? 'Scan failed'
                      : session.status === 'cancelled'
                        ? 'Scan cancelled'
                        : `${progress?.queueableItems ?? 0} downloadable · ${progress?.totalItems ?? 0} total`}
              </span>
              <span className="ml-auto flex items-center gap-2">
                {session.status === 'scanning' ? (
                  <button
                    type="button"
                    onClick={cancelScan}
                    className="h-7 rounded-lg border border-white/10 px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/5"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={rescan}
                    disabled={disabled || starting}
                    className="h-7 rounded-lg border border-white/10 px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/5 disabled:opacity-50"
                  >
                    Rescan
                  </button>
                )}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400">
              <span>{counters?.ready ?? 0} verified</span>
              <span>{counters?.probing ?? 0} checking</span>
              <span>{counters?.found ?? 0} found</span>
              <span>{counters?.signin ?? 0} need sign-in</span>
              {session.signinRequired ? (
                <span className="text-amber-300">Sign-in required</span>
              ) : null}
            </div>
            {session.message && !session.signinRequired ? (
              <p className="mt-1.5 text-[11px] leading-4 text-zinc-500">
                {session.message}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`h-7 rounded-lg px-2.5 text-[11px] transition ${
                  filter === 'all'
                    ? 'bg-emerald-400/10 text-emerald-200 ring-1 ring-inset ring-emerald-400/25'
                    : 'text-zinc-400 hover:bg-white/5'
                }`}
              >
                All types
              </button>
              <button
                type="button"
                onClick={() => setFilter('script-video')}
                className={`h-7 rounded-lg px-2.5 text-[11px] transition ${
                  filter === 'script-video'
                    ? 'bg-emerald-400/10 text-emerald-200 ring-1 ring-inset ring-emerald-400/25'
                    : 'text-zinc-400 hover:bg-white/5'
                }`}
              >
                Scripts + videos
              </button>
              <button
                type="button"
                onClick={toggleAll}
                disabled={queueable.length === 0}
                className="ml-auto h-7 rounded-lg border border-white/10 px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/5 disabled:opacity-50"
              >
                {allVisibleSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
            {visibleGroups.length === 0 ? (
              <p className="rounded-xl border border-white/10 surface-card p-4 text-[11px] leading-5 text-zinc-500">
                {scanning
                  ? 'Looking for downloadable content…'
                  : 'No items match this filter.'}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {visibleGroups.map(({ group, items: groupItems }) => {
                  const selectable = groupItems.filter(isQueueable)
                  const groupSelected =
                    selectable.length > 0 &&
                    selectable.every((item) => selection.has(item.id))
                  return (
                    <div
                      key={group.category}
                      className="overflow-hidden rounded-xl border border-white/10 surface-card"
                    >
                      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
                        <Icon name={group.icon} size={14} />
                        <span className="text-[11px] font-semibold text-zinc-200">
                          {group.label}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {groupItems.length}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleGroup(groupItems)}
                          disabled={selectable.length === 0}
                          className="ml-auto text-[11px] text-emerald-300 transition hover:text-emerald-200 disabled:text-zinc-600"
                        >
                          {groupSelected ? 'Clear' : 'Select all'}
                        </button>
                      </div>
                      <ul className="divide-y divide-white/[0.05]">
                        {groupItems.map((item) => {
                          const queueableItem = isQueueable(item)
                          const selected = selection.has(item.id)
                          const type = extensionOf(item.name) ?? group.label.slice(0, -1)
                          return (
                            <li
                              key={item.id}
                              className="flex items-start gap-2.5 px-3 py-2"
                            >
                              <input
                                type="checkbox"
                                aria-label={`Select ${item.name}`}
                                checked={selected}
                                disabled={!queueableItem || disabled}
                                onChange={() => toggle(item.id)}
                                className="mt-1.5 h-3.5 w-3.5 shrink-0 accent-emerald-400 disabled:opacity-40"
                              />
                              <Thumbnail
                                title={item.name}
                                fallback={{
                                  icon: group.icon,
                                  accent: group.accent
                                }}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span
                                    className="truncate text-[12px] font-medium text-zinc-200"
                                    title={item.name}
                                  >
                                    {item.name}
                                  </span>
                                  <StatusBadge
                                    label={statusLabel(item.status)}
                                    tone={statusTone(item.status)}
                                  />
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                                  <span>{type}</span>
                                  <span>·</span>
                                  <span>{item.hostname}</span>
                                  <span>·</span>
                                  <span>
                                    {item.sizeBytes === null
                                      ? 'Size unknown'
                                      : formatBytes(item.sizeBytes)}
                                  </span>
                                  {item.postNumber !== null ? (
                                    <>
                                      <span>·</span>
                                      <span>post #{item.postNumber}</span>
                                    </>
                                  ) : null}
                                  {item.author !== null ? (
                                    <>
                                      <span>·</span>
                                      <span className="truncate">{item.author}</span>
                                    </>
                                  ) : null}
                                </div>
                                {item.kind === 'page-link' &&
                                item.category === 'video' ? (
                                  <p className="mt-0.5 text-[10.5px] text-zinc-500">
                                    Page link · formats resolve in a later update
                                  </p>
                                ) : null}
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="sticky bottom-0 -mx-3 flex flex-wrap items-center gap-2 border-t border-white/[0.07] bg-[var(--surface-app)] px-3 py-2">
            <p className="min-w-0 flex-1 text-[11px] leading-4 text-zinc-400">
              {selectedItems.length === 0
                ? 'Select files to download. Videos on external pages are resolved later.'
                : `${selectedItems.length} selected · ${selectionLabel}`}
            </p>
            <button
              type="button"
              onClick={queueSelected}
              disabled={
                disabled ||
                queuing ||
                selectedItems.length === 0 ||
                session.status === 'scanning'
              }
              className="h-9 shrink-0 rounded-lg bg-emerald-400 px-3.5 text-[12px] font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {queuing
                ? 'Queueing…'
                : `Download ${selectedItems.length} selected (${selectionLabel})`}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
