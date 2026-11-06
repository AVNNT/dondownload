import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  isQueueableScanItem,
  type ScanBrowserScriptSelection,
  type ScanCategory,
  type ScanItem,
  type ScanQueueVideoOption,
  type ScanScriptFile,
  type ScanScriptPairingInput,
  type ScanScriptSet,
  type ScanSession,
  type ScanVideoFormat
} from '@shared/scanner'
import {
  planRenamesForFiles,
  type ScriptSetFile
} from '@shared/funscriptPairing'
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
  return isQueueableScanItem(item)
}

function statusTone(status: ScanItem['status']): StatusTone {
  if (status === 'ready') return 'complete'
  if (status === 'probing') return 'active'
  if (status === 'signin') return 'warning'
  if (status === 'unavailable' || status === 'protected') return 'failed'
  if (status === 'browser-only') return 'warning'
  if (status === 'tool-unavailable') return 'warning'
  return 'queued'
}

function statusLabel(status: ScanItem['status']): string {
  if (status === 'ready') return 'Ready'
  if (status === 'probing') return 'Resolving'
  if (status === 'signin') return 'Sign-in needed'
  if (status === 'protected') return 'Protected'
  if (status === 'unavailable') return 'Unavailable'
  if (status === 'browser-only') return 'Open in browser'
  if (status === 'tool-unavailable') return 'yt-dlp missing'
  return 'Found'
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`
}

function itemSizeLabel(item: ScanItem): string {
  if (item.sizeBytes === null) return 'Size unknown'
  return `${item.sizeIsEstimate === true ? '≈ ' : ''}${formatBytes(item.sizeBytes)}`
}

function defaultVideoOptionId(item: ScanItem): string | null {
  if (item.bestOptionId !== undefined && item.bestOptionId !== null) {
    return item.bestOptionId
  }
  return item.formats?.[0]?.optionId ?? null
}

function isVideoCardItem(item: ScanItem): boolean {
  return item.category === 'video' && item.kind === 'page-link'
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
  estimated: boolean
  count: number
} {
  let bytes = 0
  let unknown = false
  let estimated = false
  let count = 0
  for (const item of items) {
    if (!selected.has(item.id)) continue
    count += 1
    if (item.sizeBytes === null) unknown = true
    else bytes += item.sizeBytes
    if (item.sizeIsEstimate === true) estimated = true
  }
  return { bytes, unknown, estimated, count }
}

function sizeLabel(items: readonly ScanItem[], selected: Set<string>): string {
  const { bytes, unknown, estimated, count } = selectionSize(items, selected)
  if (count === 0) return '0 B'
  if (bytes === 0 && unknown) return 'size unknown'
  const prefix = estimated ? '≈ ' : ''
  return unknown ? `${prefix}${formatBytes(bytes)}+` : `${prefix}${formatBytes(bytes)}`
}

const MAIN_AXIS_KEY = 'main'

function axisKeyOf(file: Pick<ScanScriptFile, 'axis'>): string {
  return file.axis ?? MAIN_AXIS_KEY
}

function axisLabel(key: string): string {
  return key === MAIN_AXIS_KEY ? 'Main stroke' : key
}

function axisKeysOf(set: ScanScriptSet): string[] {
  const keys: string[] = []
  if (set.files.some((file) => file.isMain)) keys.push(MAIN_AXIS_KEY)
  for (const axis of set.axes) {
    if (!keys.includes(axis)) keys.push(axis)
  }
  // A set without a main file still exposes a disabled "Main stroke" chip only
  // through its missing-main warning, never as a fake file.
  return keys
}

function filesForAxis(
  set: ScanScriptSet,
  axisKey: string
): ScanScriptFile[] {
  return set.files.filter((file) => axisKeyOf(file) === axisKey)
}

function toScriptSetFile(file: ScanScriptFile): ScriptSetFile {
  return {
    fileId: file.id,
    filename: file.filename,
    base: '',
    axis: file.axis,
    axisToken: null,
    variant: file.variant,
    isMain: file.isMain
  }
}

function planPreview(
  videoName: string,
  files: readonly ScanScriptFile[],
  primaryVariant: string | null
): Map<string, string> | null {
  if (files.length === 0) return new Map()
  try {
    const plan = planRenamesForFiles(files.map(toScriptSetFile), videoName, {
      primaryVariant
    })
    return new Map(plan.map((entry) => [entry.fileId, entry.targetName]))
  } catch {
    return null
  }
}

function matchBucketLabel(set: ScanScriptSet): string {
  if (set.ambiguous) return 'Matches several videos'
  if (set.matchBucket === 'strong') return 'Strong match'
  if (set.matchBucket === 'likely') return 'Likely match'
  if (set.matchBucket === 'weak') return 'Possible match'
  return 'Unmatched'
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
  const [videoChoices, setVideoChoices] = useState<Record<string, string>>({})
  const [setChoiceByVideo, setSetChoiceByVideo] = useState<Record<string, string>>(
    {}
  )
  const [axisChoice, setAxisChoice] = useState<Record<string, string[]>>({})
  const [primaryChoice, setPrimaryChoice] = useState<Record<string, string>>({})
  const [renameChoice, setRenameChoice] = useState<Record<string, boolean>>({})
  const [expandedSets, setExpandedSets] = useState<Record<string, boolean>>({})
  const [matchingKey, setMatchingKey] = useState<string | null>(null)
  const [openingItemId, setOpeningItemId] = useState<string | null>(null)
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

  const items = useMemo(() => session?.items ?? [], [session?.items])
  const scriptSets = useMemo(
    () => session?.scriptSets ?? [],
    [session?.scriptSets]
  )
  const setById = useMemo(
    () => new Map(scriptSets.map((set) => [set.id, set])),
    [scriptSets]
  )
  const scriptItemIds = useMemo(
    () => new Set(scriptSets.flatMap((set) => set.files.map((file) => file.id))),
    [scriptSets]
  )

  const axisSelection = useCallback(
    (set: ScanScriptSet): string[] =>
      axisChoice[set.id] ?? axisKeysOf(set),
    [axisChoice]
  )

  const selectedFilesForSet = useCallback(
    (set: ScanScriptSet): ScanScriptFile[] => {
      const chosen = new Set(axisSelection(set))
      return set.files.filter((file) => chosen.has(axisKeyOf(file)))
    },
    [axisSelection]
  )

  const primaryForSet = useCallback(
    (set: ScanScriptSet): string => {
      const explicit = primaryChoice[set.id]
      return explicit === undefined ? '' : explicit
    },
    [primaryChoice]
  )

  const renameForSet = useCallback(
    (set: ScanScriptSet): boolean => renameChoice[set.id] ?? true,
    [renameChoice]
  )

  const chosenSetIdFor = useCallback(
    (videoItemId: string): string => {
      const explicit = setChoiceByVideo[videoItemId]
      if (explicit !== undefined) return explicit
      const claimed = new Set(
        Object.entries(setChoiceByVideo)
          .filter(([id, setId]) => id !== videoItemId && setId.length > 0)
          .map(([, setId]) => setId)
      )
      return (
        scriptSets.find(
          (set) =>
            set.matchedVideoItemId === videoItemId &&
            !set.ambiguous &&
            !claimed.has(set.id)
        )?.id ?? ''
      )
    },
    [scriptSets, setChoiceByVideo]
  )

  const toggleAxis = (set: ScanScriptSet, axisKey: string): void => {
    const current = new Set(axisSelection(set))
    if (current.has(axisKey)) current.delete(axisKey)
    else current.add(axisKey)
    setAxisChoice((values) => ({ ...values, [set.id]: [...current] }))
  }

  const selectAllAxes = (set: ScanScriptSet): void => {
    setAxisChoice((values) => ({ ...values, [set.id]: axisKeysOf(set) }))
  }

  const selectableFileIds = (files: readonly ScanScriptFile[]): string[] =>
    files.flatMap((file) => {
      const item = items.find((candidate) => candidate.id === file.id)
      return item && isQueueable(item) ? [file.id] : []
    })

  const toggleSetFiles = (set: ScanScriptSet, axisKey?: string): void => {
    const files =
      axisKey === undefined ? set.files : filesForAxis(set, axisKey)
    const ids = selectableFileIds(files)
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

  const queueItems = (
    ids: readonly string[],
    pairings: readonly ScanScriptPairingInput[] = []
  ): void => {
    if (session === null || ids.length === 0 || queuing) return
    const selectedIds = new Set(ids)
    const videoOptions: ScanQueueVideoOption[] = []
    for (const item of items) {
      if (!selectedIds.has(item.id) || !isVideoCardItem(item)) continue
      const optionId =
        videoChoices[item.id] ?? defaultVideoOptionId(item) ?? undefined
      videoOptions.push({
        itemId: item.id,
        ...(optionId === undefined ? {} : { optionId })
      })
    }
    setQueuing(true)
    setError(null)
    setNotice(null)
    void window.donDownload
      .queueScanSelection(
        session.sessionId,
        [...ids],
        videoOptions.length > 0 ? videoOptions : undefined,
        pairings.length > 0 ? [...pairings] : undefined
      )
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
          `Queued ${result.value.queuedItemIds.length} item(s) in one batch.${skipped}`
        )
      })
      .catch((reason: unknown) => {
        setQueuing(false)
        setError({
          code: 'SCAN_QUEUE_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The selected items could not be queued.'
        })
      })
  }

  const pairingsForIds = (ids: readonly string[]): ScanScriptPairingInput[] => {
    const idSet = new Set(ids)
    const pairings: ScanScriptPairingInput[] = []
    for (const item of items) {
      if (!idSet.has(item.id) || !isVideoCardItem(item) || item.status !== 'ready') {
        continue
      }
      const setId = chosenSetIdFor(item.id)
      const set = setById.get(setId)
      if (!set) continue
      const scriptIds = selectableFileIds(selectedFilesForSet(set)).filter(
        (id) => idSet.has(id)
      )
      if (scriptIds.length === 0) continue
      const primary = primaryForSet(set)
      pairings.push({
        videoItemId: item.id,
        setId: set.id,
        scriptItemIds: scriptIds,
        primaryVariant: primary.length > 0 ? primary : null,
        rename: renameForSet(set)
      })
    }
    return pairings
  }

  const queueSelected = (): void => {
    const ids = selectedItems.map((item) => item.id)
    queueItems(ids, pairingsForIds(ids))
  }

  const downloadVideoWithScripts = (videoItem: ScanItem): void => {
    const setId = chosenSetIdFor(videoItem.id)
    const set = setById.get(setId)
    if (!set) return
    const scriptIds = selectableFileIds(selectedFilesForSet(set))
    if (scriptIds.length === 0) return
    const primary = primaryForSet(set)
    queueItems([videoItem.id, ...scriptIds], [
      {
        videoItemId: videoItem.id,
        setId: set.id,
        scriptItemIds: scriptIds,
        primaryVariant: primary.length > 0 ? primary : null,
        rename: renameForSet(set)
      }
    ])
  }

  const downloadScriptsWithOriginalNames = (set: ScanScriptSet): void => {
    const ids = selectableFileIds(set.files)
    if (ids.length === 0) return
    queueItems(ids)
  }

  const browserPairingForSet = (
    set: ScanScriptSet
  ): ScanBrowserScriptSelection | undefined => {
    const scriptItemIds = selectableFileIds(selectedFilesForSet(set))
    if (scriptItemIds.length === 0) return undefined
    const primary = primaryForSet(set)
    return {
      setId: set.id,
      scriptItemIds,
      primaryVariant: primary.length > 0 ? primary : null,
      rename: renameForSet(set)
    }
  }

  const openInBrowser = (item: ScanItem): void => {
    if (session === null || openingItemId !== null) return
    const pairedSet = setById.get(chosenSetIdFor(item.id)) ?? null
    const pairing = pairedSet ? browserPairingForSet(pairedSet) : undefined
    setOpeningItemId(item.id)
    setError(null)
    setNotice(null)
    void window.donDownload
      .openScanInBrowser(session.sessionId, item.id, pairing)
      .then((result) => {
        setOpeningItemId(null)
        if (!result.ok) {
          setError(result.error)
          return
        }
        setNotice(
          pairing
            ? 'Opened in your browser. Waiting for the video from the browser… play it there.'
            : 'Opened in your browser.'
        )
      })
      .catch((reason: unknown) => {
        setOpeningItemId(null)
        setError({
          code: 'SCAN_OPEN_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The link could not be opened in the browser.'
        })
      })
  }

  const matchToVideoFile = (
    key: string,
    set: ScanScriptSet,
    videoItemId: string | null
  ): void => {
    if (session === null || matchingKey !== null) return
    const scriptItemIds = selectableFileIds(selectedFilesForSet(set))
    if (scriptItemIds.length === 0) return
    const primary = primaryForSet(set)
    setMatchingKey(key)
    setError(null)
    setNotice(null)
    void window.donDownload
      .pickScanMatchVideo({
        sessionId: session.sessionId,
        videoItemId,
        setId: set.id,
        scriptItemIds,
        primaryVariant: primary.length > 0 ? primary : null,
        rename: renameForSet(set)
      })
      .then((result) => {
        setMatchingKey(null)
        if (!result.ok) {
          setError(result.error)
          return
        }
        if (result.value === null) return
        setNotice(
          `Matched ${result.value.filename}: the chosen scripts are downloading next to it and will be renamed when they finish.`
        )
      })
      .catch((reason: unknown) => {
        setMatchingKey(null)
        setError({
          code: 'SCAN_MATCH_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The script set could not be matched to that video.'
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
                        {group.category === 'script'
                          ? scriptSets.map((set) => {
                              const expanded = expandedSets[set.id] === true
                              const selectableIds = set.files.flatMap((file) => {
                                const item = items.find(
                                  (candidate) => candidate.id === file.id
                                )
                                return item && isQueueable(item) ? [item.id] : []
                              })
                              const allSelected =
                                selectableIds.length > 0 &&
                                selectableIds.every((id) => selection.has(id))
                              return (
                                <li key={`set-${set.id}`} className="px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedSets((current) => ({
                                          ...current,
                                          [set.id]: !expanded
                                        }))
                                      }
                                      aria-expanded={expanded}
                                      className="text-[11px] text-zinc-400 transition hover:text-zinc-200"
                                    >
                                      {expanded ? '▾' : '▸'}
                                    </button>
                                    <span
                                      className="truncate text-[12px] font-medium text-zinc-200"
                                      title={set.base}
                                    >
                                      {set.base}
                                    </span>
                                    <span className="text-[10.5px] text-zinc-500">
                                      {set.files.length} file
                                      {set.files.length === 1 ? '' : 's'}
                                    </span>
                                    {set.axes.map((axis) => (
                                      <button
                                        key={axis}
                                        type="button"
                                        onClick={() => toggleSetFiles(set, axis)}
                                        className="rounded-full border border-white/10 px-1.5 py-0.5 text-[10px] text-fuchsia-200/80 transition hover:bg-fuchsia-400/10"
                                      >
                                        {axis}
                                      </button>
                                    ))}
                                    {set.missingMain ? (
                                      <span className="rounded-full border border-amber-400/25 px-1.5 py-0.5 text-[10px] text-amber-200">
                                        No main stroke
                                      </span>
                                    ) : null}
                                    {set.ambiguous ? (
                                      <span className="rounded-full border border-amber-400/25 px-1.5 py-0.5 text-[10px] text-amber-200">
                                        Ambiguous match
                                      </span>
                                    ) : null}
                                    <span className="ml-auto text-[10px] text-zinc-500">
                                      {matchBucketLabel(set)}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => toggleSetFiles(set)}
                                      className="text-[10.5px] text-emerald-300 transition hover:text-emerald-200"
                                    >
                                      {allSelected ? 'Clear' : 'Select all axes'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        matchToVideoFile(
                                          `set:${set.id}`,
                                          set,
                                          null
                                        )
                                      }
                                      disabled={disabled || matchingKey !== null}
                                      className="text-[10.5px] text-sky-300 transition hover:text-sky-200 disabled:opacity-50"
                                    >
                                      {matchingKey === `set:${set.id}`
                                        ? 'Choose video…'
                                        : 'Match to video file…'}
                                    </button>
                                  </div>
                                  {expanded ? (
                                    <ul className="mt-1.5 flex flex-col gap-1 pl-5">
                                      {set.files.map((file) => {
                                        const item = items.find(
                                          (candidate) => candidate.id === file.id
                                        )
                                        return (
                                          <li
                                            key={file.id}
                                            className="flex items-center gap-2"
                                          >
                                            <input
                                              type="checkbox"
                                              aria-label={`Select ${file.filename}`}
                                              checked={selection.has(file.id)}
                                              disabled={
                                                disabled ||
                                                item === undefined ||
                                                !isQueueable(item)
                                              }
                                              onChange={() => toggle(file.id)}
                                              className="h-3 w-3 accent-fuchsia-400 disabled:opacity-40"
                                            />
                                            <span className="truncate font-mono text-[10.5px] text-zinc-400">
                                              {file.filename}
                                            </span>
                                            <span className="text-[10px] text-zinc-600">
                                              {file.isMain
                                                ? 'main'
                                                : file.axis ?? ''}
                                              {file.variant !== null
                                                ? ` · ${file.variant}`
                                                : ''}
                                            </span>
                                          </li>
                                        )
                                      })}
                                      <li>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            downloadScriptsWithOriginalNames(set)
                                          }
                                          disabled={disabled || queuing}
                                          className="mt-0.5 text-[10.5px] text-emerald-300 transition hover:text-emerald-200 disabled:opacity-50"
                                        >
                                          Download scripts with original names
                                        </button>
                                      </li>
                                    </ul>
                                  ) : null}
                                </li>
                              )
                            })
                          : null}
                        {groupItems
                          .filter(
                            (item) =>
                              group.category !== 'script' ||
                              !scriptItemIds.has(item.id)
                          )
                          .map((item) => {
                          const queueableItem = isQueueable(item)
                          const selected = selection.has(item.id)
                          const type =
                            extensionOf(item.name) ?? group.label.slice(0, -1)

                          if (isVideoCardItem(item)) {
                            const chosen =
                              videoChoices[item.id] ??
                              defaultVideoOptionId(item) ??
                              ''
                            const reason =
                              item.status === 'probing'
                                ? 'Resolving formats…'
                                : item.unavailableReason
                            const pairedSetId = chosenSetIdFor(item.id)
                            const pairedSet =
                              setById.get(pairedSetId) ?? null
                            const pairingFiles = pairedSet
                              ? selectedFilesForSet(pairedSet)
                              : []
                            const primaryVariant = pairedSet
                              ? primaryForSet(pairedSet)
                              : ''
                            const preview = pairedSet
                              ? planPreview(
                                  item.name,
                                  pairingFiles,
                                  primaryVariant.length > 0
                                    ? primaryVariant
                                    : null
                                )
                              : null
                            return (
                              <li
                                key={item.id}
                                className={`px-3 py-2.5 ${
                                  selected ? 'bg-emerald-400/[0.04]' : ''
                                }`}
                              >
                                <div className="flex items-start gap-2.5">
                                  <input
                                    type="checkbox"
                                    aria-label={`Select ${item.name}`}
                                    checked={selected}
                                    disabled={!queueableItem || disabled}
                                    onChange={() => toggle(item.id)}
                                    className="mt-2 h-3.5 w-3.5 shrink-0 accent-emerald-400 disabled:opacity-40"
                                  />
                                  <Thumbnail
                                    size="card"
                                    src={item.thumbnailUrl ?? undefined}
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
                                      {item.status === 'probing' ? (
                                        <span
                                          aria-hidden="true"
                                          className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-500 border-t-transparent"
                                        />
                                      ) : null}
                                      <StatusBadge
                                        label={statusLabel(item.status)}
                                        tone={statusTone(item.status)}
                                      />
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                                      {formatDuration(item.durationSeconds) !==
                                      null ? (
                                        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                                          {formatDuration(item.durationSeconds)}
                                        </span>
                                      ) : null}
                                      {item.bestResolution ? (
                                        <span className="font-medium text-zinc-300">
                                          {item.bestResolution}
                                        </span>
                                      ) : null}
                                      <span>{itemSizeLabel(item)}</span>
                                      <span>·</span>
                                      <span>{item.hostname}</span>
                                      {item.postNumber !== null ? (
                                        <>
                                          <span>·</span>
                                          <span>post #{item.postNumber}</span>
                                        </>
                                      ) : null}
                                      {item.author !== null ? (
                                        <>
                                          <span>·</span>
                                          <span className="truncate">
                                            {item.author}
                                          </span>
                                        </>
                                      ) : null}
                                    </div>
                                    {item.status === 'ready' &&
                                    item.formats &&
                                    item.formats.length > 0 ? (
                                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                        <label className="sr-only" htmlFor={`quality-${item.id}`}>
                                          Quality for {item.name}
                                        </label>
                                        <select
                                          id={`quality-${item.id}`}
                                          value={chosen}
                                          onChange={(event) =>
                                            setVideoChoices((current) => ({
                                              ...current,
                                              [item.id]: event.target.value
                                            }))
                                          }
                                          disabled={disabled || queuing}
                                          className="h-7 max-w-[16rem] rounded-md border border-white/10 surface-input px-1.5 text-[11px] text-zinc-200 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                                        >
                                          {item.formats.map(
                                            (format: ScanVideoFormat) => (
                                              <option
                                                key={format.optionId}
                                                value={format.optionId}
                                              >
                                                {format.label}
                                                {format.sizeBytes !== null
                                                  ? ` · ${
                                                      format.sizeIsEstimate
                                                        ? '≈ '
                                                        : ''
                                                    }${formatBytes(format.sizeBytes)}`
                                                  : ''}
                                              </option>
                                            )
                                          )}
                                        </select>
                                        <button
                                          type="button"
                                          onClick={() => queueItems([item.id])}
                                          disabled={disabled || queuing}
                                          className="h-7 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          Download
                                        </button>
                                      </div>
                                    ) : reason ? (
                                      <p className="mt-1 text-[10.5px] leading-4 text-zinc-500">
                                        {reason}
                                      </p>
                                    ) : null}
                                    {item.status === 'browser-only' ? (
                                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() => openInBrowser(item)}
                                          disabled={disabled || openingItemId !== null}
                                          className="h-7 rounded-md border border-sky-400/30 bg-sky-400/10 px-2.5 text-[11px] font-medium text-sky-100 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          {openingItemId === item.id
                                            ? 'Opening…'
                                            : 'Open in browser'}
                                        </button>
                                        <span className="text-[10px] text-zinc-500">
                                          Can&apos;t be read automatically — open it in your browser.
                                        </span>
                                      </div>
                                    ) : null}
                                    {item.browserMatchPending === true ? (
                                      <p className="mt-1 text-[10.5px] leading-4 text-sky-200">
                                        Waiting for the video from your browser… play it there.
                                        The chosen scripts download with it.
                                      </p>
                                    ) : null}
                                    {scriptSets.length > 0 &&
                                    item.status !== 'probing' &&
                                    item.status !== 'signin' ? (
                                      <div className="mt-2 rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/[0.04] px-2 py-1.5">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fuchsia-200/80">
                                            Matching scripts
                                          </span>
                                          <label
                                            className="sr-only"
                                            htmlFor={`script-set-${item.id}`}
                                          >
                                            Script set for {item.name}
                                          </label>
                                          <select
                                            id={`script-set-${item.id}`}
                                            value={pairedSetId}
                                            onChange={(event) =>
                                              setSetChoiceByVideo((current) => ({
                                                ...current,
                                                [item.id]: event.target.value
                                              }))
                                            }
                                            disabled={disabled || queuing}
                                            className="h-7 max-w-[18rem] flex-1 rounded-md border border-white/10 surface-input px-1.5 text-[11px] text-zinc-200 outline-none focus:border-fuchsia-400/60 disabled:opacity-50"
                                          >
                                            <option value="">
                                              No matching scripts
                                            </option>
                                            {scriptSets.map((set) => (
                                              <option key={set.id} value={set.id}>
                                                {set.base}
                                                {set.postNumber !== null
                                                  ? ` · #${set.postNumber}`
                                                  : ''}
                                                {set.axes.length > 0
                                                  ? ` · ${set.axes.join(', ')}`
                                                  : ''}
                                                {set.missingMain
                                                  ? ' · no main'
                                                  : ''}
                                              </option>
                                            ))}
                                          </select>
                                        </div>
                                        {pairedSet ? (
                                          <>
                                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                              {axisKeysOf(pairedSet).map((axisKey) => {
                                                const active =
                                                  axisSelection(pairedSet).includes(
                                                    axisKey
                                                  )
                                                return (
                                                  <label
                                                    key={axisKey}
                                                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] ${
                                                      active
                                                        ? 'border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-100'
                                                        : 'border-white/10 text-zinc-400'
                                                    }`}
                                                  >
                                                    <input
                                                      type="checkbox"
                                                      checked={active}
                                                      onChange={() =>
                                                        toggleAxis(pairedSet, axisKey)
                                                      }
                                                      disabled={disabled || queuing}
                                                      className="h-3 w-3 accent-fuchsia-400"
                                                    />
                                                    {axisLabel(axisKey)}
                                                  </label>
                                                )
                                              })}
                                              <button
                                                type="button"
                                                onClick={() => selectAllAxes(pairedSet)}
                                                disabled={disabled || queuing}
                                                className="text-[10.5px] text-fuchsia-200 transition hover:text-fuchsia-100 disabled:opacity-50"
                                              >
                                                Select all axes
                                              </button>
                                              <span className="ml-auto text-[10px] text-zinc-500">
                                                {matchBucketLabel(pairedSet)}
                                              </span>
                                            </div>
                                            {pairedSet.variants.length > 0 ? (
                                              <fieldset className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <legend className="text-[10px] uppercase tracking-wide text-zinc-500">
                                                  Primary version
                                                </legend>
                                                <label className="inline-flex items-center gap-1 text-[10.5px] text-zinc-300">
                                                  <input
                                                    type="radio"
                                                    name={`primary-${item.id}`}
                                                    checked={primaryVariant.length === 0}
                                                    onChange={() =>
                                                      setPrimaryChoice((current) => ({
                                                        ...current,
                                                        [pairedSet.id]: ''
                                                      }))
                                                    }
                                                    disabled={disabled || queuing}
                                                    className="h-3 w-3 accent-fuchsia-400"
                                                  />
                                                  Keep versions separate
                                                </label>
                                                {pairedSet.variants.map((variant) => (
                                                  <label
                                                    key={variant}
                                                    className="inline-flex items-center gap-1 text-[10.5px] text-zinc-300"
                                                  >
                                                    <input
                                                      type="radio"
                                                      name={`primary-${item.id}`}
                                                      checked={
                                                        primaryVariant === variant
                                                      }
                                                      onChange={() =>
                                                        setPrimaryChoice((current) => ({
                                                          ...current,
                                                          [pairedSet.id]: variant
                                                        }))
                                                      }
                                                      disabled={disabled || queuing}
                                                      className="h-3 w-3 accent-fuchsia-400"
                                                    />
                                                    {variant}
                                                  </label>
                                                ))}
                                              </fieldset>
                                            ) : null}
                                            <label className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] text-zinc-300">
                                              <input
                                                type="checkbox"
                                                checked={renameForSet(pairedSet)}
                                                onChange={(event) =>
                                                  setRenameChoice((current) => ({
                                                    ...current,
                                                    [pairedSet.id]: event.target.checked
                                                  }))
                                                }
                                                disabled={disabled || queuing}
                                                className="h-3 w-3 accent-fuchsia-400"
                                              />
                                              Rename scripts to match this video
                                            </label>
                                            {pairedSet.missingMain ? (
                                              <p className="mt-1 text-[10.5px] leading-4 text-amber-200">
                                                No main stroke script in this set.
                                                The other axes will still be
                                                downloaded and renamed.
                                              </p>
                                            ) : null}
                                            {pairedSet.conflicts.length > 0 ? (
                                              <p className="mt-1 text-[10.5px] leading-4 text-amber-200">
                                                This set has two files for the same
                                                axis. Choose a different set or
                                                download the originals below.
                                              </p>
                                            ) : null}
                                            {preview === null ? (
                                              <p className="mt-1 text-[10.5px] leading-4 text-amber-200">
                                                The chosen versions produce
                                                conflicting names. Pick a different
                                                primary version.
                                              </p>
                                            ) : (
                                              <div className="mt-1.5">
                                                <p className="text-[10.5px] text-zinc-400">
                                                  {renameForSet(pairedSet)
                                                    ? `→ saved as ${item.name}.*`
                                                    : 'Original names will be kept.'}
                                                </p>
                                                <ul className="mt-0.5 flex flex-col gap-0.5">
                                                  {pairingFiles.map((file) => {
                                                    const target =
                                                      preview.get(file.id) ?? null
                                                    return (
                                                      <li
                                                        key={file.id}
                                                        className="truncate font-mono text-[10px] text-zinc-500"
                                                        title={`${file.filename} → ${
                                                          target ?? file.filename
                                                        }`}
                                                      >
                                                        {file.filename} →{' '}
                                                        {renameForSet(pairedSet)
                                                          ? target ?? 'name conflict'
                                                          : file.filename}
                                                      </li>
                                                    )
                                                  })}
                                                </ul>
                                              </div>
                                            )}
                                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  downloadVideoWithScripts(item)
                                                }
                                                disabled={
                                                  disabled ||
                                                  queuing ||
                                                  !queueableItem ||
                                                  item.status !== 'ready' ||
                                                  pairingFiles.length === 0
                                                }
                                                className="h-7 rounded-md border border-fuchsia-400/30 bg-fuchsia-400/10 px-2.5 text-[11px] font-medium text-fuchsia-100 transition hover:bg-fuchsia-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                                              >
                                                Download video + scripts
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  matchToVideoFile(
                                                    `video:${item.id}`,
                                                    pairedSet,
                                                    item.id
                                                  )
                                                }
                                                disabled={
                                                  disabled ||
                                                  matchingKey !== null ||
                                                  pairingFiles.length === 0
                                                }
                                                className="h-7 rounded-md border border-white/15 px-2.5 text-[11px] font-medium text-zinc-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                                              >
                                                {matchingKey === `video:${item.id}`
                                                  ? 'Choose video…'
                                                  : 'Match to video file…'}
                                              </button>
                                              <span className="text-[10px] text-zinc-500">
                                                {pairingFiles.length} script
                                                {pairingFiles.length === 1 ? '' : 's'} next to the video
                                              </span>
                                            </div>
                                          </>
                                        ) : (
                                          <p className="mt-1 text-[10.5px] leading-4 text-zinc-500">
                                            {scriptSets.some((set) => set.ambiguous)
                                              ? 'Some script sets match more than one video. Choose the set that belongs to this video above.'
                                              : 'Choose a script set above to download it with this video.'}
                                          </p>
                                        )}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </li>
                            )
                          }

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
                                  <span>{itemSizeLabel(item)}</span>
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
                ? 'Select files or videos to download. Nothing is queued until you choose it.'
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
