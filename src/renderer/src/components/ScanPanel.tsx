import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  MAX_SCAN_SELECTION,
  MAX_SCAN_URLS,
  isQueueableScanItem,
  parseScanUrlList,
  type ScanBrowserScriptSelection,
  type ScanCategory,
  type ScanItem,
  type ScanQueueResult,
  type ScanQueueSelectionInput,
  type ScanQueueSelectionsResult,
  type ScanQueueVideoOption,
  type ScanScriptFile,
  type ScanScriptPairingInput,
  type ScanScriptSet,
  type ScanSession,
  type ScanVideoFormat
} from '@shared/scanner'
import {
  buildScanBulkSelection,
  buildScanPreSelection,
  bulkSelectionItemCount
} from '@shared/scanSelection'
import {
  planRenamesForFiles,
  type ScriptSetFile
} from '@shared/funscriptPairing'
import type { ApiResult, AppErrorInfo } from '@shared/types'
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

function chosenFormat(
  item: ScanItem,
  chosenOptionId: string | undefined
): ScanVideoFormat | null {
  if (!item.formats || item.formats.length === 0) return null
  const optionId = chosenOptionId ?? defaultVideoOptionId(item)
  return item.formats.find((format) => format.optionId === optionId) ?? null
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

function topicTitle(session: ScanSession): string {
  if (typeof session.title === 'string' && session.title.trim().length > 0) {
    return session.title
  }
  return session.hostname || 'Scanned page'
}

export function ScanPanel({
  initialUrl,
  initialSession = null,
  disabled = false
}: ScanPanelProps): JSX.Element {
  const [urlText, setUrlText] = useState(initialUrl)
  const [sessions, setSessions] = useState<ScanSession[]>(
    initialSession === null ? [] : [initialSession]
  )
  const [error, setError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preselectNotice, setPreselectNotice] = useState<string | null>(null)
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
  const [collapsedSessions, setCollapsedSessions] = useState<Record<string, boolean>>(
    {}
  )
  const [matchingKey, setMatchingKey] = useState<string | null>(null)
  const [openingItemId, setOpeningItemId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterMode>('all')
  const controllerRef = useRef<ScanAutoStart | null>(null)
  const sessionsRef = useRef<ScanSession[]>(
    initialSession === null ? [] : [initialSession]
  )
  const knownSessionIdsRef = useRef<Set<string>>(
    new Set(initialSession === null ? [] : [initialSession.sessionId])
  )
  const preselectedRef = useRef<Set<string>>(new Set())
  const pendingUpdatesRef = useRef<Map<string, ScanSession[]>>(new Map())

  /** Apply the automatic selection once per finished topic. */
  const preselectIfReady = useCallback((session: ScanSession): void => {
    if (session.status !== 'done' && session.status !== 'limited') return
    if (preselectedRef.current.has(session.sessionId)) return
    preselectedRef.current.add(session.sessionId)
    const pre = buildScanPreSelection(session)
    if (pre.itemIds.length === 0) return
    setSelection((current) => {
      const next = new Set(current)
      for (const id of pre.itemIds) next.add(id)
      return next
    })
    if (pre.overLimit) {
      setPreselectNotice(
        `The automatic selection exceeded ${MAX_SCAN_SELECTION} items, so only the first ${MAX_SCAN_SELECTION} were ticked.`
      )
    } else if (pre.videoCount > 0) {
      setNotice(
        `${pre.videoCount} video${
          pre.videoCount === 1 ? '' : 's'
        } with matching scripts were pre-selected. Untick anything you do not want, then download in one click.`
      )
    }
  }, [])

  const replaceSessions = useCallback((next: ScanSession[]): void => {
    sessionsRef.current = next
    setSessions(next)
  }, [])

  const applyUpdate = useCallback(
    (update: ScanSession): void => {
      const current = sessionsRef.current
      const existing = current.find(
        (session) => session.sessionId === update.sessionId
      )
      const merged =
        existing === undefined ? update : mergeUpdate(existing, update)
      const next =
        existing === undefined
          ? [...current, merged]
          : current.map((session) =>
              session.sessionId === update.sessionId ? merged : session
            )
      sessionsRef.current = next
      setSessions(next)
      preselectIfReady(merged)
    },
    [preselectIfReady]
  )

  useEffect(() => {
    const unsubscribe = window.donDownload.onScanUpdated((update) => {
      const visible = sessionsRef.current.some(
        (session) => session.sessionId === update.sessionId
      )
      if (visible) {
        applyUpdate(update)
        return
      }
      // A scan removed by a rescan is stale; ignore its late updates.
      if (knownSessionIdsRef.current.has(update.sessionId)) return
      // A very fast scan can publish before the start response arrives. Buffer
      // the delta and replay it once the session ID is known.
      const buffered = pendingUpdatesRef.current.get(update.sessionId) ?? []
      if (buffered.length < 200) buffered.push(update)
      pendingUpdatesRef.current.set(update.sessionId, buffered)
    })
    return unsubscribe
  }, [applyUpdate])

  const adoptSessions = useCallback(
    (next: readonly ScanSession[]): void => {
      const current = sessionsRef.current
      const byId = new Map(current.map((session) => [session.sessionId, session]))
      const order = current.map((session) => session.sessionId)
      const adopted: ScanSession[] = []
      for (const session of next) {
        let combined = session
        for (const update of pendingUpdatesRef.current.get(session.sessionId) ?? []) {
          combined = mergeUpdate(combined, update)
        }
        pendingUpdatesRef.current.delete(session.sessionId)
        knownSessionIdsRef.current.add(session.sessionId)
        const existing = byId.get(session.sessionId)
        const merged =
          existing === undefined ? combined : mergeUpdate(existing, combined)
        byId.set(session.sessionId, merged)
        if (!order.includes(session.sessionId)) order.push(session.sessionId)
        adopted.push(merged)
      }
      const nextSessions = order.flatMap((id) => {
        const session = byId.get(id)
        return session === undefined ? [] : [session]
      })
      replaceSessions(nextSessions)
      for (const session of adopted) preselectIfReady(session)
    },
    [preselectIfReady, replaceSessions]
  )

  /** Reset all per-scan state before a new scan request. */
  const resetScanState = useCallback((): void => {
    preselectedRef.current.clear()
    setSelection(new Set())
    setVideoChoices({})
    setSetChoiceByVideo({})
    setAxisChoice({})
    setPrimaryChoice({})
    setRenameChoice({})
    setPreselectNotice(null)
  }, [])

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
          setUrlText(value)
          resetScanState()
          replaceSessions([])
          adoptSessions([result.value])
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
  }, [adoptSessions, replaceSessions, resetScanState])

  useEffect(() => {
    if (initialSession !== null) return
    // A single URL still auto-starts as before. A multi-line paste waits for
    // the explicit Scan button (and never starts a browser-extension page).
    const parsed = parseScanUrlList(urlText)
    if (parsed.urls.length === 1 && parsed.invalid.length === 0 && !urlText.includes('\n')) {
      controllerRef.current?.update(urlText.trim())
    }
  }, [initialSession, urlText])

  // Pre-selection is applied from the update/adopt callbacks above, so a
  // finished topic never needs a state-setting effect.

  const items = useMemo(
    () => sessions.flatMap((session) => session.items),
    [sessions]
  )
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  )
  const setsBySession = useMemo(
    () =>
      new Map(
        sessions.map((session) => [
          session.sessionId,
          session.scriptSets ?? []
        ])
      ),
    [sessions]
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
    (set: ScanScriptSet): string => primaryChoice[set.id] ?? '',
    [primaryChoice]
  )

  const renameForSet = useCallback(
    (set: ScanScriptSet): boolean => renameChoice[set.id] ?? true,
    [renameChoice]
  )

  const chosenSetIdFor = useCallback(
    (session: ScanSession, videoItemId: string): string => {
      const explicit = setChoiceByVideo[videoItemId]
      if (explicit !== undefined) return explicit
      const sets = setsBySession.get(session.sessionId) ?? []
      const claimed = new Set(
        Object.entries(setChoiceByVideo)
          .filter(([id, setId]) => id !== videoItemId && setId.length > 0)
          .map(([, setId]) => setId)
      )
      return (
        sets.find(
          (set) =>
            set.matchedVideoItemId === videoItemId &&
            !set.ambiguous &&
            !claimed.has(set.id)
        )?.id ?? ''
      )
    },
    [setChoiceByVideo, setsBySession]
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
      const item = itemById.get(file.id)
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

  const visibleGroupsFor = useCallback(
    (session: ScanSession) => {
      const sessionItems = session.items
      return GROUPS.map((group) => {
        const groupItems = sessionItems.filter(
          (item) => item.category === group.category
        )
        const filtered =
          filter === 'script-video'
            ? groupItems.filter(
                (item) => item.category === 'script' || item.category === 'video'
              )
            : groupItems
        return { group, items: filtered }
      }).filter((entry) => entry.items.length > 0)
    },
    [filter]
  )

  const queueable = items.filter(isQueueable)
  const selectedItems = queueable.filter((item) => selection.has(item.id))
  const allVisibleSelected =
    queueable.length > 0 && queueable.every((item) => selection.has(item.id))
  const overSelectionLimit = selectedItems.length > MAX_SCAN_SELECTION
  const selectedVideoCount = selectedItems.filter(
    (item) => isVideoCardItem(item) && item.status === 'ready'
  ).length
  const selectedScriptCount = selectedItems.filter(
    (item) => item.category === 'script'
  ).length

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

  const startScanRequest = useCallback(
    (parsedUrls: readonly string[]): void => {
      if (parsedUrls.length === 0) return
      void (async () => {
        setStarting(true)
        setError(null)
        setNotice(null)
        setPreselectNotice(null)
        const result =
          parsedUrls.length === 1
            ? await window.donDownload.startScan({ url: parsedUrls[0]! })
            : await window.donDownload.startScans([...parsedUrls])
        setStarting(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        const next = Array.isArray(result.value) ? result.value : [result.value]
        resetScanState()
        replaceSessions([])
        adoptSessions(next)
      })().catch((reason: unknown) => {
        setStarting(false)
        setError({
          code: 'SCAN_REQUEST_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The page scan could not be started.'
        })
      })
    },
    [adoptSessions, replaceSessions, resetScanState]
  )

  const scanFromText = (): void => {
    controllerRef.current?.cancel()
    const parsed = parseScanUrlList(urlText)
    if (parsed.invalid.length > 0) {
      setError({
        code: 'SCAN_URL_INVALID',
        message: `Not a valid HTTP(S) URL: ${parsed.invalid[0]}${
          parsed.invalid.length > 1 ? ` (+${parsed.invalid.length - 1} more)` : ''
        }`
      })
    }
    if (parsed.overLimit > 0) {
      setNotice(
        `Only the first ${MAX_SCAN_URLS} URLs are scanned; ${parsed.overLimit} extra URL${
          parsed.overLimit === 1 ? '' : 's'
        } ignored.`
      )
    }
    startScanRequest(parsed.urls)
  }

  const rescan = (): void => scanFromText()

  const cancelScan = (session: ScanSession): void => {
    void window.donDownload.cancelScan(session.sessionId).then((result) => {
      if (result.ok) applyUpdate(result.value)
      else setError(result.error)
    })
  }

  const queueItems = (
    sessionId: string,
    ids: readonly string[],
    pairings: readonly ScanScriptPairingInput[] = []
  ): void => {
    if (ids.length === 0 || queuing) return
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
        sessionId,
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

  const queueSelected = (): void => {
    if (sessions.length === 0 || queuing || overSelectionLimit) return
    const scriptFileIdsBySet: Record<string, string[]> = {}
    for (const session of sessions) {
      for (const set of setsBySession.get(session.sessionId) ?? []) {
        scriptFileIdsBySet[set.id] = selectableFileIds(selectedFilesForSet(set))
      }
    }
    const payload = buildScanBulkSelection(sessions, {
      selectedItemIds: selection,
      videoOptionIds: videoChoices,
      setChoiceByVideo,
      scriptFileIdsBySet,
      primaryVariantBySet: primaryChoice,
      renameBySet: renameChoice
    })
    const total = bulkSelectionItemCount(payload)
    if (total === 0) {
      setError({
        code: 'SCAN_SELECTION_EMPTY',
        message: 'Select at least one downloadable item.'
      })
      return
    }
    if (total > MAX_SCAN_SELECTION) {
      setError({
        code: 'SCAN_SELECTION_TOO_LARGE',
        message: `The selection has ${total} items; the limit is ${MAX_SCAN_SELECTION}. Untick items first.`
      })
      return
    }

    setQueuing(true)
    setError(null)
    setNotice(null)
    const request: Promise<
      ApiResult<ScanQueueResult | ScanQueueSelectionsResult>
    > =
      payload.length === 1
        ? window.donDownload.queueScanSelection(
            payload[0]!.sessionId,
            payload[0]!.itemIds,
            payload[0]!.videoOptions.length > 0
              ? payload[0]!.videoOptions
              : undefined,
            payload[0]!.pairings.length > 0 ? payload[0]!.pairings : undefined
          )
        : window.donDownload.queueScanSelections(
            payload as ScanQueueSelectionInput[]
          )

    void request
      .then((result) => {
        setQueuing(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        const outcomes =
          'results' in result.value
            ? result.value.results
            : [
                {
                  sessionId: payload[0]!.sessionId,
                  ok: true as const,
                  value: result.value
                }
              ]
        const queuedSessionIds = new Set<string>()
        const failures: Array<{ code: string; message: string }> = []
        let queued = 0
        let skipped = 0
        for (const outcome of outcomes) {
          if (outcome.ok) {
            queuedSessionIds.add(outcome.sessionId)
            queued += outcome.value.queuedItemIds.length
            skipped += outcome.value.skipped.length
          } else {
            failures.push(outcome.error)
          }
        }

        // Only topics that actually queued are cleared; a failed topic keeps
        // its selection so the user can retry it.
        setSelection((previous) => {
          const next = new Set(previous)
          for (const selection of payload) {
            if (!queuedSessionIds.has(selection.sessionId)) continue
            for (const itemId of selection.itemIds) next.delete(itemId)
          }
          return next
        })

        if (queuedSessionIds.size === 0) {
          const first = failures[0]
          if (first !== undefined) setError(first)
          return
        }
        const skippedText =
          skipped > 0 ? ` ${skipped} item(s) were skipped.` : ''
        if (failures.length === 0) {
          setNotice(
            outcomes.length === 1
              ? `Queued ${queued} item(s) in one batch.${skippedText}`
              : `Queued ${outcomes.length} topics (${queued} item(s)) in one click (one batch per topic).${skippedText}`
          )
          return
        }
        setNotice(
          `Queued ${queuedSessionIds.size} of ${outcomes.length} topics (${queued} item(s)); ${
            failures.length
          } failed: ${failures[0]!.message}${skippedText}`
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

  const downloadVideoWithScripts = (
    session: ScanSession,
    videoItem: ScanItem
  ): void => {
    const sets = setsBySession.get(session.sessionId) ?? []
    const setId = chosenSetIdFor(session, videoItem.id)
    const set = sets.find((candidate) => candidate.id === setId)
    if (!set) return
    const scriptIds = selectableFileIds(selectedFilesForSet(set))
    if (scriptIds.length === 0) return
    const primary = primaryForSet(set)
    queueItems(session.sessionId, [videoItem.id, ...scriptIds], [
      {
        videoItemId: videoItem.id,
        setId: set.id,
        scriptItemIds: scriptIds,
        primaryVariant: primary.length > 0 ? primary : null,
        rename: renameForSet(set)
      }
    ])
  }

  const downloadScriptsWithOriginalNames = (
    session: ScanSession,
    set: ScanScriptSet
  ): void => {
    const ids = selectableFileIds(set.files)
    if (ids.length === 0) return
    queueItems(session.sessionId, ids)
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

  const openInBrowser = (session: ScanSession, item: ScanItem): void => {
    if (openingItemId !== null) return
    const sets = setsBySession.get(session.sessionId) ?? []
    const pairedSet =
      sets.find((set) => set.id === chosenSetIdFor(session, item.id)) ?? null
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
    session: ScanSession,
    key: string,
    set: ScanScriptSet,
    videoItemId: string | null
  ): void => {
    if (matchingKey !== null) return
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

  const scanning = sessions.some((session) => session.status === 'scanning')
  const selectionLabel = sizeLabel(queueable, selection)

  const renderScriptSets = (
    session: ScanSession,
    sets: readonly ScanScriptSet[]
  ): JSX.Element[] =>
    sets.map((set) => {
      const expanded = expandedSets[set.id] === true
      const selectableIds = selectableFileIds(set.files)
      const allSelected =
        selectableIds.length > 0 &&
        selectableIds.every((id) => selection.has(id))
      return (
        <li key={`set-${session.sessionId}-${set.id}`} className="px-3 py-2">
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
              {set.files.length} file{set.files.length === 1 ? '' : 's'}
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
                matchToVideoFile(session, `set:${session.sessionId}:${set.id}`, set, null)
              }
              disabled={disabled || matchingKey !== null}
              className="text-[10.5px] text-sky-300 transition hover:text-sky-200 disabled:opacity-50"
            >
              {matchingKey === `set:${session.sessionId}:${set.id}`
                ? 'Choose video…'
                : 'Match to video file…'}
            </button>
          </div>
          {expanded ? (
            <ul className="mt-1.5 flex flex-col gap-1 pl-5">
              {set.files.map((file) => {
                const item = itemById.get(file.id)
                return (
                  <li key={file.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${file.filename}`}
                      checked={selection.has(file.id)}
                      disabled={disabled || item === undefined || !isQueueable(item)}
                      onChange={() => toggle(file.id)}
                      className="h-3 w-3 accent-fuchsia-400 disabled:opacity-40"
                    />
                    <span className="truncate font-mono text-[10.5px] text-zinc-400">
                      {file.filename}
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      {file.isMain ? 'main' : file.axis ?? ''}
                      {file.variant !== null ? ` · ${file.variant}` : ''}
                    </span>
                  </li>
                )
              })}
              <li>
                <button
                  type="button"
                  onClick={() => downloadScriptsWithOriginalNames(session, set)}
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

  const renderVideoCard = (
    session: ScanSession,
    item: ScanItem,
    group: GroupDefinition,
    sets: readonly ScanScriptSet[]
  ): JSX.Element => {
    const queueableItem = isQueueable(item)
    const selected = selection.has(item.id)
    const chosen = videoChoices[item.id] ?? defaultVideoOptionId(item) ?? ''
    const selectedFormat = chosenFormat(item, videoChoices[item.id])
    const reason =
      item.status === 'probing' ? 'Resolving formats…' : item.unavailableReason
    const pairedSetId = chosenSetIdFor(session, item.id)
    const pairedSet = sets.find((set) => set.id === pairedSetId) ?? null
    const pairingFiles = pairedSet ? selectedFilesForSet(pairedSet) : []
    const primaryVariant = pairedSet ? primaryForSet(pairedSet) : ''
    const preview = pairedSet
      ? planPreview(
          item.name,
          pairingFiles,
          primaryVariant.length > 0 ? primaryVariant : null
        )
      : null
    return (
      <li
        key={item.id}
        className={`px-3 py-2.5 ${selected ? 'bg-emerald-400/[0.04]' : ''}`}
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
            fallback={{ icon: group.icon, accent: group.accent }}
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
              {formatDuration(item.durationSeconds) !== null ? (
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  {formatDuration(item.durationSeconds)}
                </span>
              ) : null}
              {selectedFormat ? (
                <span className="font-medium text-zinc-300">
                  {selectedFormat.label}
                </span>
              ) : item.bestResolution ? (
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
                  <span className="truncate">{item.author}</span>
                </>
              ) : null}
            </div>
            {item.status === 'ready' && item.formats && item.formats.length > 0 ? (
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
                  className="h-7 max-w-[18rem] rounded-md border border-white/10 surface-input px-1.5 text-[11px] text-zinc-200 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                >
                  {item.formats.map((format: ScanVideoFormat) => (
                    <option key={format.optionId} value={format.optionId}>
                      {format.label}
                      {format.sizeBytes !== null
                        ? ` · ${format.sizeIsEstimate ? '≈ ' : ''}${formatBytes(
                            format.sizeBytes
                          )}`
                        : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => queueItems(session.sessionId, [item.id])}
                  disabled={disabled || queuing}
                  className="h-7 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Download
                </button>
              </div>
            ) : reason ? (
              <p className="mt-1 text-[10.5px] leading-4 text-zinc-500">{reason}</p>
            ) : null}
            {item.status === 'browser-only' ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openInBrowser(session, item)}
                  disabled={disabled || openingItemId !== null}
                  className="h-7 rounded-md border border-sky-400/30 bg-sky-400/10 px-2.5 text-[11px] font-medium text-sky-100 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {openingItemId === item.id ? 'Opening…' : 'Open in browser'}
                </button>
                <span className="text-[10px] text-zinc-500">
                  Can&apos;t be read automatically — open it in your browser.
                </span>
              </div>
            ) : null}
            {item.browserMatchPending === true ? (
              <p className="mt-1 text-[10.5px] leading-4 text-sky-200">
                Waiting for the video from your browser… play it there. The
                chosen scripts download with it.
              </p>
            ) : null}
            {sets.length > 0 &&
            item.status !== 'probing' &&
            item.status !== 'signin' ? (
              <div className="mt-2 rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/[0.04] px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fuchsia-200/80">
                    Matching scripts
                  </span>
                  <label className="sr-only" htmlFor={`script-set-${item.id}`}>
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
                    <option value="">No matching scripts</option>
                    {sets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {set.base}
                        {set.postNumber !== null ? ` · #${set.postNumber}` : ''}
                        {set.axes.length > 0 ? ` · ${set.axes.join(', ')}` : ''}
                        {set.missingMain ? ' · no main' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {pairedSet ? (
                  <>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {axisKeysOf(pairedSet).map((axisKey) => {
                        const active = axisSelection(pairedSet).includes(axisKey)
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
                              onChange={() => toggleAxis(pairedSet, axisKey)}
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
                              checked={primaryVariant === variant}
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
                        No main stroke script in this set. The other axes will
                        still be downloaded and renamed.
                      </p>
                    ) : null}
                    {pairedSet.conflicts.length > 0 ? (
                      <p className="mt-1 text-[10.5px] leading-4 text-amber-200">
                        This set has two files for the same axis. Choose a
                        different set or download the originals below.
                      </p>
                    ) : null}
                    {preview === null ? (
                      <p className="mt-1 text-[10.5px] leading-4 text-amber-200">
                        The chosen versions produce conflicting names. Pick a
                        different primary version.
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
                            const target = preview.get(file.id) ?? null
                            return (
                              <li
                                key={file.id}
                                className="truncate font-mono text-[10px] text-zinc-500"
                                title={`${file.filename} → ${target ?? file.filename}`}
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
                        onClick={() => downloadVideoWithScripts(session, item)}
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
                            session,
                            `video:${session.sessionId}:${item.id}`,
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
                        {matchingKey === `video:${session.sessionId}:${item.id}`
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
                    {sets.some((set) => set.ambiguous)
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

  const renderSession = (session: ScanSession): JSX.Element => {
    const sets = setsBySession.get(session.sessionId) ?? []
    const sessionScriptItemIds = new Set(
      sets.flatMap((set) => set.files.map((file) => file.id))
    )
    const groups = visibleGroupsFor(session)
    const collapsed = collapsedSessions[session.sessionId] === true
    const progress = session.progress
    const counters = session.counters
    return (
      <section
        key={session.sessionId}
        aria-label={topicTitle(session)}
        className="overflow-hidden rounded-xl border border-white/10 surface-card"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] px-3 py-2">
          <button
            type="button"
            onClick={() =>
              setCollapsedSessions((current) => ({
                ...current,
                [session.sessionId]: !collapsed
              }))
            }
            aria-expanded={!collapsed}
            className="flex min-w-0 items-center gap-1.5 text-left"
          >
            <span className="text-[11px] text-zinc-500">
              {collapsed ? '▸' : '▾'}
            </span>
            <span className="truncate text-sm font-semibold text-zinc-100">
              {topicTitle(session)}
            </span>
          </button>
          <span className="text-[11px] text-zinc-400">
            {session.status === 'scanning'
              ? `${progress?.queueableItems ?? 0} found · ${
                  session.message ?? 'scanning'
                }${
                  progress?.fetchedPages
                    ? ` · ${progress.fetchedPages} page(s) read`
                    : ''
                }`
              : session.status === 'limited'
                ? 'Item/time limit reached'
                : session.status === 'failed'
                  ? 'Scan failed'
                  : session.status === 'cancelled'
                    ? 'Scan cancelled'
                    : `${progress?.queueableItems ?? 0} downloadable · ${
                        progress?.totalItems ?? 0
                      } total`}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {session.status === 'scanning' ? (
              <button
                type="button"
                onClick={() => cancelScan(session)}
                className="h-7 rounded-lg border border-white/10 px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/5"
              >
                Cancel
              </button>
            ) : null}
          </span>
        </div>
        {!collapsed ? (
          <>
            <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-zinc-400">
              <span>{counters?.ready ?? 0} verified</span>
              <span>{counters?.probing ?? 0} checking</span>
              <span>{counters?.found ?? 0} found</span>
              <span>{counters?.signin ?? 0} need sign-in</span>
              <span className="truncate">{session.hostname}</span>
            </div>
            {session.message && !session.signinRequired ? (
              <p className="px-3 pb-1.5 text-[11px] leading-4 text-zinc-500">
                {session.message}
              </p>
            ) : null}
            {groups.length === 0 ? (
              <p className="px-3 py-3 text-[11px] leading-5 text-zinc-500">
                {session.status === 'scanning'
                  ? 'Looking for downloadable content…'
                  : 'No items match this filter on this topic.'}
              </p>
            ) : (
              <div className="flex flex-col">
                {groups.map(({ group, items: groupItems }) => {
                  const selectable = groupItems.filter(isQueueable)
                  const groupSelected =
                    selectable.length > 0 &&
                    selectable.every((item) => selection.has(item.id))
                  return (
                    <div key={`${session.sessionId}-${group.category}`}>
                      <div className="flex items-center gap-2 border-y border-white/[0.04] bg-white/[0.02] px-3 py-1.5">
                        <Icon name={group.icon} size={13} />
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
                        {group.category === 'script' ? renderScriptSets(session, sets) : null}
                        {groupItems
                          .filter(
                            (item) =>
                              group.category !== 'script' ||
                              !sessionScriptItemIds.has(item.id)
                          )
                          .map((item) => {
                            if (isVideoCardItem(item)) {
                              return renderVideoCard(session, item, group, sets)
                            }
                            const queueableItem = isQueueable(item)
                            const selected = selection.has(item.id)
                            const type =
                              extensionOf(item.name) ??
                              group.label.slice(0, -1)
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
                                        <span className="truncate">
                                          {item.author}
                                        </span>
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
          </>
        ) : null}
      </section>
    )
  }

  return (
    <section aria-labelledby="scan-heading" className="flex h-full flex-col gap-3">
      <div className="rounded-xl border border-white/10 surface-card p-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2
            id="scan-heading"
            className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
          >
            Scan pages
          </h2>
          <span className="text-[11px] text-zinc-400">
            Nothing downloads until you click Download
          </span>
        </div>
        <label className="sr-only" htmlFor="scan-url">
          Page URLs to scan, one per line
        </label>
        <textarea
          id="scan-url"
          rows={2}
          autoComplete="off"
          spellCheck={false}
          value={urlText}
          onChange={(event) => {
            setUrlText(event.target.value)
            setNotice(null)
            setError(null)
            setPreselectNotice(null)
          }}
          placeholder="Paste a forum topic or media page URL — one per line (up to 10)"
          disabled={disabled}
          className="min-h-[4.5rem] w-full resize-y rounded-lg border border-white/10 surface-input px-3 py-2 text-sm leading-5 text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={rescan}
            disabled={
              disabled ||
              starting ||
              parseScanUrlList(urlText).urls.length === 0
            }
            className="h-9 shrink-0 rounded-lg border border-white/10 px-4 text-sm font-semibold text-zinc-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? 'Scanning…' : sessions.length === 0 ? 'Scan' : 'Rescan'}
          </button>
          {scanning ? (
            <button
              type="button"
              onClick={() => {
                for (const session of sessions) {
                  if (session.status === 'scanning') cancelScan(session)
                }
              }}
              className="h-9 rounded-lg border border-white/10 px-3 text-[12px] text-zinc-300 transition hover:bg-white/5"
            >
              Cancel all
            </button>
          ) : null}
          <span className="text-[11px] text-zinc-500">
            One URL per line · duplicates removed · up to {MAX_SCAN_URLS} topics
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-zinc-500">
          Each topic is scanned on its own. Only its posts and the pages linked
          from them are read (one level deep). Signed-in pages still need “Scan
          this page” in the DonDownload browser extension.
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
      {preselectNotice ? (
        <p role="status" className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200">
          {preselectNotice}
        </p>
      ) : null}
      {sessions.some((session) => session.signinRequired) ? (
        <p role="status" className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200">
          A topic needs your browser sign-in. Open the tab where you are signed
          in, choose “Scan this page” in the DonDownload extension, and allow
          cookies for that exact site first.
        </p>
      ) : null}

      {sessions.length === 0 ? (
        <p className="rounded-xl border border-white/10 surface-card p-4 text-[11px] leading-5 text-zinc-500">
          Paste one or more page URLs above. DonDownload lists videos, audio,
          images, documents, archives, scripts and other files it can see, and
          pre-ticks the videos with matching scripts. A scan never starts a
          download.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 surface-card p-2.5">
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

          <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
            <div className="flex flex-col gap-2">
              {sessions.map((session) => renderSession(session))}
            </div>
          </div>

          <div className="sticky bottom-0 -mx-3 flex flex-wrap items-center gap-2 border-t border-white/[0.07] bg-[var(--surface-app)] px-3 py-2">
            <p className="min-w-0 flex-1 text-[11px] leading-4 text-zinc-400">
              {selectedItems.length === 0
                ? 'Results are pre-selected where a video has matching scripts. Nothing is queued until you click Download.'
                : overSelectionLimit
                  ? `${selectedItems.length} selected — over the ${MAX_SCAN_SELECTION}-item limit. Untick items or scan fewer topics.`
                  : `${selectedItems.length} selected · ${selectionLabel}${
                      selectedVideoCount > 0
                        ? ` · ${selectedVideoCount} video${
                            selectedVideoCount === 1 ? '' : 's'
                          }`
                        : ''
                    }${
                      selectedScriptCount > 0
                        ? ` · ${selectedScriptCount} script${
                            selectedScriptCount === 1 ? '' : 's'
                          }`
                        : ''
                    }`}
            </p>
            <button
              type="button"
              onClick={queueSelected}
              disabled={
                disabled ||
                queuing ||
                selectedItems.length === 0 ||
                overSelectionLimit
              }
              className="h-10 shrink-0 rounded-lg bg-emerald-400 px-4 text-[12px] font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {queuing
                ? 'Queueing…'
                : selectedVideoCount > 0
                  ? `Download ${selectedVideoCount} video${
                      selectedVideoCount === 1 ? '' : 's'
                    } + scripts (${selectionLabel})`
                  : `Download ${selectedItems.length} selected (${selectionLabel})`}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
