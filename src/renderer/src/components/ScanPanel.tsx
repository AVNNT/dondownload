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
  MAX_SCAN_OTHER_LINKS,
  MAX_SCAN_URLS,
  isMarkableAsVideoScanItem,
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
import { createScanAutoStart, type ScanAutoStart } from '../scanAutoStart'

interface ScanPanelProps {
  initialUrl: string
  /** Extension-created sessions shown together in one multi-topic view. */
  initialSessions?: readonly ScanSession[] | null
  disabled?: boolean
  /**
   * Hosted inside the scan sheet, which already renders its own "Scan pages"
   * heading: skip the panel's own card heading and page-level status rows.
   */
  embedded?: boolean
}

interface GroupDefinition {
  category: ScanCategory
  label: string
  icon: IconName
  accent: string
}

const GROUPS: readonly GroupDefinition[] = [
  { category: 'video', label: 'Videos', icon: 'video', accent: 'text-zinc-300' },
  { category: 'audio', label: 'Audio', icon: 'audio', accent: 'text-zinc-300' },
  { category: 'image', label: 'Images', icon: 'image', accent: 'text-zinc-300' },
  {
    category: 'document',
    label: 'Documents',
    icon: 'document',
    accent: 'text-zinc-300'
  },
  {
    category: 'archive',
    label: 'Archives',
    icon: 'archive',
    accent: 'text-zinc-300'
  },
  { category: 'script', label: 'Scripts', icon: 'program', accent: 'text-zinc-300' },
  { category: 'other', label: 'Other', icon: 'other', accent: 'text-zinc-300' },
  {
    category: 'page',
    label: 'Unrecognised links',
    icon: 'link',
    accent: 'text-zinc-300'
  }
]

type FilterMode = 'all' | 'script-video'

function isQueueable(item: ScanItem): boolean {
  return isQueueableScanItem(item)
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

/** Per-topic header status from the existing session state. */
function topicStatus(session: ScanSession): {
  label: string
  dotClass: string
  textClass: string
  pulse: boolean
} {
  if (session.status === 'failed') {
    return {
      label: 'Failed',
      dotClass: 'bg-red-400',
      textClass: 'text-red-300',
      pulse: false
    }
  }
  if (session.signinRequired) {
    return {
      label: 'Needs sign-in',
      dotClass: 'bg-amber-400',
      textClass: 'text-amber-300',
      pulse: false
    }
  }
  if (session.status === 'scanning') {
    return {
      label: 'Scanning…',
      dotClass: 'bg-accent-400',
      textClass: 'text-accent-200',
      pulse: true
    }
  }
  if (session.status === 'cancelled') {
    return {
      label: 'Cancelled',
      dotClass: 'bg-zinc-500',
      textClass: 'text-zinc-400',
      pulse: false
    }
  }
  return {
    label: 'Done',
    dotClass: 'bg-emerald-400',
    textClass: 'text-emerald-300',
    pulse: false
  }
}

export function ScanPanel({
  initialUrl,
  initialSessions = null,
  disabled = false,
  embedded = false
}: ScanPanelProps): JSX.Element {
  const seededSessions = useMemo<readonly ScanSession[]>(
    () => initialSessions ?? [],
    [initialSessions]
  )
  const [urlText, setUrlText] = useState(initialUrl)
  const [sessions, setSessions] = useState<ScanSession[]>([...seededSessions])
  /**
   * Topic URL per session, remembered only for scans this panel started:
   * the session DTO never carries a URL and extension-started topics cannot
   * be reopened from here.
   */
  const [topicUrls, setTopicUrls] = useState<Record<string, string>>({})
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
  const [markingItemId, setMarkingItemId] = useState<string | null>(null)
  const [linksExpanded, setLinksExpanded] = useState(false)
  const [thumbFailures, setThumbFailures] = useState<Map<string, boolean>>(
    new Map()
  )
  const [expandedScriptPanel, setExpandedScriptPanel] = useState<
    Record<string, boolean>
  >({})
  const [filter, setFilter] = useState<FilterMode>('all')
  const controllerRef = useRef<ScanAutoStart | null>(null)
  const sessionsRef = useRef<ScanSession[]>([...seededSessions])
  const knownSessionIdsRef = useRef<Set<string>>(
    new Set(seededSessions.map((session) => session.sessionId))
  )
  const seededSignatureRef = useRef(
    seededSessions.map((session) => session.sessionId).join('|')
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

  /**
   * A multi-link extension batch can add another session after this panel is
   * already open. Adopt only newly named sessions; their own updates are
   * buffered until their ID is known and are replayed here.
   */
  useEffect(() => {
    const signature = seededSessions
      .map((session) => session.sessionId)
      .join('|')
    if (signature === seededSignatureRef.current) return
    seededSignatureRef.current = signature
    adoptSessions(seededSessions)
  }, [adoptSessions, seededSessions])

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
    setTopicUrls({})
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
          setTopicUrls({ [result.value.sessionId]: value })
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
    if (seededSessions.length > 0) return
    // A single URL still auto-starts as before. A multi-line paste waits for
    // the explicit Scan button (and never starts a browser-extension page).
    const parsed = parseScanUrlList(urlText)
    if (parsed.urls.length === 1 && parsed.invalid.length === 0 && !urlText.includes('\n')) {
      controllerRef.current?.update(urlText.trim())
    }
  }, [seededSessions, urlText])

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
        return {
          group,
          items:
            group.category === 'page'
              ? filtered.slice(0, MAX_SCAN_OTHER_LINKS)
              : filtered
        }
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
        // Main returns one session per deduplicated URL, in the same order
        // the URLs were sent, so the pairs match positionally.
        const nextUrls: Record<string, string> = {}
        next.forEach((session, index) => {
          const url = parsedUrls[index]
          if (url !== undefined) nextUrls[session.sessionId] = url
        })
        setTopicUrls(nextUrls)
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

  const markAsVideo = (session: ScanSession, item: ScanItem): void => {
    if (markingItemId !== null) return
    setMarkingItemId(item.id)
    setError(null)
    setNotice(null)
    void window.donDownload
      .markScanItemAsVideo(session.sessionId, item.id)
      .then((result) => {
        setMarkingItemId(null)
        if (!result.ok) {
          setError(result.error)
          return
        }
        applyUpdate(result.value)
        const updated = result.value.items.find(
          (candidate) => candidate.id === item.id
        )
        if (updated?.status === 'browser-only') {
          setNotice(
            'Checked as a video. This one can only be opened in your browser.'
          )
        } else if (updated?.status === 'ready') {
          setNotice('Checked as a video. Choose a quality and click Download.')
        } else if (updated?.status === 'unavailable') {
          setNotice('Checked, but this link could not be resolved as a video.')
        }
      })
      .catch((reason: unknown) => {
        setMarkingItemId(null)
        setError({
          code: 'SCAN_MARK_VIDEO_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The link could not be checked as a video.'
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
  const totalItemCount = items.length
  const videosWithScriptsCount = sessions.reduce((count, session) => {
    const sets = setsBySession.get(session.sessionId) ?? []
    return (
      count +
      session.items.filter(
        (item) =>
          isVideoCardItem(item) &&
          sets.some((set) => set.matchedVideoItemId === item.id)
      ).length
    )
  }, 0)
  const selectedOtherCount = Math.max(
    0,
    selectedItems.length - selectedVideoCount - selectedScriptCount
  )

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
        <li key={`set-${session.sessionId}-${set.id}`} className="px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <button
              type="button"
              onClick={() =>
                setExpandedSets((current) => ({
                  ...current,
                  [set.id]: !expanded
                }))
              }
              aria-expanded={expanded}
              className="flex text-zinc-500 transition hover:text-zinc-200"
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
            </button>
            <span
              className="truncate text-[12.5px] font-semibold text-zinc-100"
              title={set.base}
            >
              {set.base}
            </span>
            <span className="text-[12px] text-zinc-500">
              {set.files.length} file{set.files.length === 1 ? '' : 's'}
            </span>
            {set.axes.map((axis) => (
              <button
                key={axis}
                type="button"
                onClick={() => toggleSetFiles(set, axis)}
                className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200"
              >
                {axis}
              </button>
            ))}
            {set.missingMain ? (
              <span className="rounded-full border border-amber-400/25 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                No main stroke
              </span>
            ) : null}
            {set.ambiguous ? (
              <span className="rounded-full border border-amber-400/25 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                Ambiguous match
              </span>
            ) : null}
            <span className="ml-auto text-[11px] text-zinc-500">
              {matchBucketLabel(set)}
            </span>
            <button
              type="button"
              onClick={() => toggleSetFiles(set)}
              className="text-[12px] font-semibold text-accent-300 transition hover:text-accent-200"
            >
              {allSelected ? 'Clear' : 'Select all'}
            </button>
            <button
              type="button"
              onClick={() =>
                matchToVideoFile(session, `set:${session.sessionId}:${set.id}`, set, null)
              }
              disabled={disabled || matchingKey !== null}
              className="text-[12px] font-semibold text-accent-300 transition hover:text-accent-200 disabled:opacity-50"
            >
              {matchingKey === `set:${session.sessionId}:${set.id}`
                ? 'Choose video…'
                : 'Match to video file…'}
            </button>
          </div>
          {expanded ? (
            <ul className="mt-2 flex flex-col gap-1 pl-6">
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
                      className="h-3 w-3 accent-accent-400 disabled:opacity-40"
                    />
                    <span className="truncate font-mono text-[11.5px] text-zinc-400">
                      {file.filename}
                    </span>
                    <span className="text-[11px] text-zinc-500">
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
                  className="text-[12px] font-semibold text-accent-300 transition hover:text-accent-200 disabled:opacity-50"
                >
                  Download scripts with original names
                </button>
              </li>
            </ul>
          ) : null}
        </li>
      )
    })

  /**
   * Local 16:9 thumbnail at the mock's exact 104x58 (the shared `Thumbnail`
   * component has its own fixed sizes used by other screens).
   */
  const renderThumb = (
    src: string | null,
    title: string,
    fallbackIcon: IconName,
    sizeClass: string,
    iconSize: number
  ): JSX.Element => {
    const failed = thumbFailures.get(src ?? `fallback:${title}`) === true
    if (src === null || src.length === 0 || failed) {
      return (
        <span
          className={`grid shrink-0 place-items-center border border-white/10 bg-white/[0.045] text-zinc-400 ${sizeClass}`}
        >
          <Icon name={fallbackIcon} size={iconSize} />
        </span>
      )
    }
    return (
      <img
        src={src}
        alt=""
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() =>
          setThumbFailures((current) => {
            if (current.get(src) === true) return current
            const next = new Map(current)
            next.set(src, true)
            return next
          })
        }
        className={`shrink-0 border border-white/10 object-cover ${sizeClass}`}
      />
    )
  }

  const renderVideoCard = (
    session: ScanSession,
    item: ScanItem,
    group: GroupDefinition,
    sets: readonly ScanScriptSet[]
  ): JSX.Element => {
    const queueableItem = isQueueable(item)
    const selected = selection.has(item.id)
    const chosen = videoChoices[item.id] ?? defaultVideoOptionId(item) ?? ''
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
    const off = item.status === 'protected'
    const showScripts =
      sets.length > 0 && item.status !== 'probing' && item.status !== 'signin'
    const scriptPanelOpen = expandedScriptPanel[item.id] === true
    const ambiguousSets = sets.filter((set) => set.ambiguous)
    const ambiguousCount = ambiguousSets.length
    const needsChoice = showScripts && pairedSet === null && ambiguousCount > 0
    const otherVideoClaimsCandidate =
      needsChoice &&
      ambiguousSets.some((set) =>
        session.items.some(
          (other) =>
            other.id !== item.id &&
            isVideoCardItem(other) &&
            chosenSetIdFor(session, other.id) === set.id
        )
      )
    const warnScripts =
      pairedSet !== null &&
      (pairedSet.missingMain ||
        pairedSet.ambiguous ||
        pairedSet.conflicts.length > 0)
    const axesSummary = pairedSet
      ? pairedSet.missingMain
        ? `${pairedSet.axes.join(', ')} · no main stroke`
        : pairedSet.axes.length === 1
          ? `main + ${pairedSet.axes[0]}`
          : pairedSet.axes.length > 1
            ? `main + ${pairedSet.axes.length} axes`
            : 'main stroke'
      : ''

    const statusMeta = (() => {
      switch (item.status) {
        case 'probing':
          return (
            <span
              className="inline-flex items-center gap-1.5 font-medium text-zinc-400"
              title={item.unavailableReason ?? undefined}
            >
              <span
                aria-hidden="true"
                className="h-3 w-3 shrink-0 animate-spin rounded-full border border-zinc-500 border-t-transparent"
              />
              Finding qualities…
            </span>
          )
        case 'protected':
          return (
            <span
              className="inline-flex items-center gap-1 font-semibold text-red-300"
              title={item.unavailableReason ?? undefined}
            >
              <Icon name="alert" size={12} />
              Protected
            </span>
          )
        case 'browser-only':
          return (
            <span className="inline-flex items-center gap-1 font-semibold text-amber-300">
              <Icon name="external" size={12} />
              Plays only in the browser
            </span>
          )
        case 'signin':
          return (
            <span
              className="inline-flex items-center gap-1 font-semibold text-amber-300"
              title={item.unavailableReason ?? undefined}
            >
              Needs sign-in
            </span>
          )
        case 'unavailable':
          return (
            <span
              className="font-semibold text-red-300"
              title={item.unavailableReason ?? undefined}
            >
              Unavailable
            </span>
          )
        case 'tool-unavailable':
          return (
            <span
              className="font-semibold text-amber-300"
              title={item.unavailableReason ?? undefined}
            >
              yt-dlp missing
            </span>
          )
        case 'found':
          return <span className="font-medium text-zinc-400">Found</span>
        default:
          return null
      }
    })()

    const side = (() => {
      if (item.status === 'browser-only') {
        return (
          <button
            type="button"
            onClick={() => openInBrowser(session, item)}
            disabled={disabled || openingItemId !== null}
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-50"
          >
            <Icon name="external" size={13} />
            {openingItemId === item.id ? 'Opening…' : 'Open in browser'}
          </button>
        )
      }
      if (item.status === 'probing') {
        return <span className="text-[12px] text-zinc-500">Qualities soon</span>
      }
      if (off) {
        return null
      }
      if (item.status === 'ready' && item.formats && item.formats.length > 0) {
        return (
          <>
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
              className="h-[30px] max-w-[11rem] rounded-lg border border-white/10 surface-input px-2 text-[12px] font-semibold text-zinc-100 outline-none transition focus:border-accent-400/60 disabled:opacity-50"
            >
              {item.formats.map((format: ScanVideoFormat) => (
                <option
                  key={format.optionId}
                  value={format.optionId}
                  title={format.label}
                >
                  {format.label.split(' · ')[0]}
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
              title="Download now"
              aria-label={`Download ${item.name}`}
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-accent-400/40 text-accent-300 opacity-0 transition hover:bg-accent-400/10 hover:text-accent-200 focus-visible:opacity-100 disabled:opacity-40 group-hover:opacity-100"
            >
              <Icon name="download" size={15} />
            </button>
          </>
        )
      }
      if (item.status === 'ready') {
        return (
          <span className="inline-flex h-[30px] shrink-0 items-center gap-2 rounded-lg border border-white/10 surface-input px-2.5 text-[12px] font-semibold text-zinc-100">
            {extensionOf(item.name) ?? item.bestResolution ?? 'Video'}
            <span className="font-normal text-zinc-500">
              {itemSizeLabel(item)}
            </span>
          </span>
        )
      }
      return null
    })()

    const scriptChipBase =
      'mt-1.5 inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12px] transition'

    return (
      <li
        key={item.id}
        className={`group grid grid-cols-[16px_104px_minmax(0,1fr)_auto] items-center gap-x-3.5 border-t border-white/[0.06] px-3.5 py-2.5 transition-colors ${
          selected ? 'bg-accent-400/[0.05]' : ''
        } ${off ? 'opacity-55' : ''} hover:bg-white/[0.03]`}
      >
        <input
          type="checkbox"
          aria-label={`Select ${item.name}`}
          checked={selected}
          disabled={!queueableItem || disabled}
          onChange={() => toggle(item.id)}
          className="h-4 w-4 shrink-0 accent-accent-400 disabled:opacity-40"
        />
        <div className="relative shrink-0">
          {renderThumb(
            item.thumbnailUrl ?? null,
            item.name,
            group.icon,
            'h-[58px] w-[104px] rounded-[7px]',
            18
          )}
          {formatDuration(item.durationSeconds) !== null ? (
            <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10.5px] font-semibold leading-4 text-white">
              {formatDuration(item.durationSeconds)}
            </span>
          ) : null}
        </div>
        <div className="min-w-0">
          <div
            className="truncate text-[12.5px] font-semibold text-zinc-100"
            title={item.name}
          >
            {item.name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-zinc-500">
            {statusMeta ? (
              <>
                {statusMeta}
                <span>·</span>
              </>
            ) : null}
            <span>{item.hostname}</span>
            {item.postNumber !== null ? (
              <>
                <span>·</span>
                <span>post #{item.postNumber}</span>
              </>
            ) : null}
          </div>
          {item.browserMatchPending === true ? (
            <p className="mt-1 text-[11px] leading-4 text-accent-200">
              Waiting for the video from your browser… play it there.
            </p>
          ) : null}
          {needsChoice ? (
            <button
              type="button"
              onClick={() =>
                setExpandedScriptPanel((current) => ({
                  ...current,
                  [item.id]: !scriptPanelOpen
                }))
              }
              aria-expanded={scriptPanelOpen}
              className={`${scriptChipBase} ${
                scriptPanelOpen
                  ? 'border-accent-400/40 bg-accent-400/10 text-zinc-100'
                  : 'border-white/10 bg-white/[0.045] text-zinc-400 hover:bg-white/[0.07]'
              }`}
            >
              <Icon name="alert" size={13} className="shrink-0 text-amber-300" />
              <span className="min-w-0 truncate">
                <span className="font-semibold text-zinc-100">
                  {ambiguousCount} script set{ambiguousCount === 1 ? '' : 's'} could match
                </span>
                {' · '}choose one
              </span>
              <Icon
                name={scriptPanelOpen ? 'chevron-down' : 'chevron-right'}
                size={12}
                className="shrink-0 text-zinc-500"
              />
            </button>
          ) : showScripts && pairedSet ? (
            <button
              type="button"
              onClick={() =>
                setExpandedScriptPanel((current) => ({
                  ...current,
                  [item.id]: !scriptPanelOpen
                }))
              }
              aria-expanded={scriptPanelOpen}
              className={`${scriptChipBase} ${
                scriptPanelOpen
                  ? 'border-accent-400/40 bg-accent-400/10 text-zinc-100'
                  : 'border-white/10 bg-white/[0.045] text-zinc-400 hover:bg-white/[0.07]'
              }`}
            >
              {warnScripts ? (
                <Icon name="alert" size={13} className="shrink-0 text-amber-300" />
              ) : (
                <Icon name="check" size={13} className="shrink-0 text-emerald-300" />
              )}
              <span className="min-w-0 truncate">
                <span className="font-semibold text-zinc-100">
                  {pairingFiles.length} script{pairingFiles.length === 1 ? '' : 's'}
                </span>
                {axesSummary ? ` · ${axesSummary}` : ''}
                {' · renamed to match'}
              </span>
              <Icon
                name={scriptPanelOpen ? 'chevron-down' : 'chevron-right'}
                size={12}
                className="shrink-0 text-zinc-500"
              />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">{side}</div>

        {showScripts && scriptPanelOpen ? (
          <div className="col-start-3 col-span-2 mt-2.5 flex flex-col gap-3 rounded-[10px] border border-white/10 bg-[var(--surface-app)] p-3">
            {pairedSet ? (
              <>
                <div className="flex items-center gap-2.5">
                  <span className="w-[92px] shrink-0 text-[12px] text-zinc-500">
                    Script set
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
                    className="h-[30px] min-w-0 flex-1 rounded-lg border border-white/10 surface-card px-2.5 text-[12.5px] font-semibold text-zinc-100 outline-none transition focus:border-accent-400/60 disabled:opacity-50"
                  >
                    <option value="">No matching scripts</option>
                    {sets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {set.base}
                        {set.postNumber !== null ? ` · post #${set.postNumber}` : ''}
                        {set.axes.length > 0 ? ` · ${set.axes.join(', ')}` : ''}
                        {set.missingMain ? ' · no main' : ''}
                      </option>
                    ))}
                  </select>
                  {pairedSet ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-emerald-300">
                      <Icon name="check" size={13} />
                      {matchBucketLabel(pairedSet)}
                    </span>
                  ) : null}
                </div>

                <div className="flex items-start gap-2.5">
                  <span className="w-[92px] shrink-0 pt-1 text-[12px] text-zinc-500">
                    Axes
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {axisKeysOf(pairedSet).map((axisKey) => {
                      const active = axisSelection(pairedSet).includes(axisKey)
                      return (
                        <button
                          key={axisKey}
                          type="button"
                          onClick={() => toggleAxis(pairedSet, axisKey)}
                          disabled={disabled || queuing}
                          className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition disabled:opacity-50 ${
                            active
                              ? 'border-accent-400/40 bg-accent-400/10 text-zinc-100'
                              : 'border-white/10 text-zinc-400 hover:bg-white/[0.05]'
                          }`}
                        >
                          {active ? (
                            <Icon name="check" size={12} className="text-accent-300" />
                          ) : (
                            <span className="h-3.5 w-3.5 rounded-[4px] border-[1.5px] border-zinc-600" aria-hidden="true" />
                          )}
                          {axisLabel(axisKey)}
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => selectAllAxes(pairedSet)}
                      disabled={disabled || queuing}
                      className="text-[12px] font-semibold text-accent-300 transition hover:text-accent-200 disabled:opacity-50"
                    >
                      Select all axes
                    </button>
                  </div>
                </div>

                {pairedSet.variants.length > 0 ? (
                  <div className="flex items-start gap-2.5">
                    <span className="w-[92px] shrink-0 pt-0.5 text-[12px] text-zinc-500">
                      Versions
                    </span>
                    <fieldset className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1">
                      <label className="inline-flex items-center gap-1.5 text-[12px] text-zinc-300">
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
                          className="h-3.5 w-3.5 accent-accent-400"
                        />
                        Keep versions separate
                      </label>
                      {pairedSet.variants.map((variant) => (
                        <label
                          key={variant}
                          className="inline-flex items-center gap-1.5 text-[12px] text-zinc-300"
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
                            className="h-3.5 w-3.5 accent-accent-400"
                          />
                          {variant}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                ) : null}

                <div className="flex items-center gap-2.5">
                  <span className="w-[92px] shrink-0 text-[12px] text-zinc-500">
                    File names
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={renameForSet(pairedSet)}
                    onClick={() =>
                      setRenameChoice((current) => ({
                        ...current,
                        [pairedSet.id]: !renameForSet(pairedSet)
                      }))
                    }
                    disabled={disabled || queuing}
                    className={`relative h-5 w-[34px] shrink-0 rounded-full transition disabled:opacity-50 ${
                      renameForSet(pairedSet) ? 'bg-accent-500' : 'bg-zinc-800'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full transition ${
                        renameForSet(pairedSet)
                          ? 'left-[16px] bg-white'
                          : 'left-0.5 bg-zinc-500'
                      }`}
                    />
                  </button>
                  <span className="text-[12px] text-zinc-400">
                    Rename to match the video
                  </span>
                </div>

                {pairedSet.missingMain ? (
                  <p className="text-[11.5px] leading-4 text-amber-300">
                    No main stroke script in this set. The other axes will still
                    be downloaded and renamed.
                  </p>
                ) : null}
                {pairedSet.conflicts.length > 0 ? (
                  <p className="flex items-center gap-1.5 text-[11.5px] leading-4 text-amber-300">
                    This set has two files for the same axis. Choose a different
                    set or download the originals below.
                  </p>
                ) : null}

                <div className="rounded-lg border border-white/[0.06] surface-card px-2.5 py-2 font-mono text-[12px] leading-[1.7] text-zinc-400">
                  {preview === null ? (
                    <span className="text-amber-300">
                      The chosen versions produce conflicting names. Pick a
                      different primary version.
                    </span>
                  ) : (
                    pairingFiles.map((file) => {
                      const target = preview.get(file.id) ?? null
                      return (
                        <div
                          key={file.id}
                          className="truncate"
                          title={`${file.filename} → ${target ?? file.filename}`}
                        >
                          {renameForSet(pairedSet)
                            ? target ?? 'name conflict'
                            : file.filename}
                        </div>
                      )
                    })
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
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
                    className="inline-flex h-[30px] items-center gap-1.5 rounded-lg bg-accent-500 px-3 text-[12px] font-semibold text-on-accent transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                  >
                    <Icon name="download" size={13} />
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
                      disabled || matchingKey !== null || pairingFiles.length === 0
                    }
                    className="text-[12px] font-semibold text-accent-300 transition hover:text-accent-200 disabled:opacity-50"
                  >
                    {matchingKey === `video:${session.sessionId}:${item.id}`
                      ? 'Choose video…'
                      : 'Match to a video file on disk…'}
                  </button>
                  <span className="ml-auto text-[12px] text-zinc-500">
                    Saved next to the video
                  </span>
                </div>
              </>
            ) : ambiguousSets.length > 0 ? (
              <>
                <div className="flex items-start gap-2.5">
                  <span className="w-[92px] shrink-0 pt-1 text-[12px] text-zinc-500">
                    Which set?
                  </span>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    {ambiguousSets.map((set) => (
                      <label
                        key={set.id}
                        className="flex min-w-0 items-center gap-2 text-[12.5px]"
                      >
                        <input
                          type="radio"
                          name={`pick-set-${item.id}`}
                          checked={false}
                          onChange={() =>
                            setSetChoiceByVideo((current) => ({
                              ...current,
                              [item.id]: set.id
                            }))
                          }
                          disabled={disabled || queuing}
                          className="h-3.5 w-3.5 shrink-0 accent-accent-400 disabled:opacity-50"
                        />
                        <span className="truncate font-semibold text-zinc-100">
                          {set.base}
                          {set.postNumber !== null
                            ? ` · post #${set.postNumber}`
                            : ''}
                        </span>
                        <span className="truncate text-[12px] text-zinc-500">
                          {set.axes.length > 0 ? set.axes.join(', ') : 'main stroke'}
                          {' · '}
                          {set.files.length} file{set.files.length === 1 ? '' : 's'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                {otherVideoClaimsCandidate ? (
                  <p className="flex items-center gap-1.5 pl-[102px] text-[12px] text-amber-300">
                    <Icon name="alert" size={13} className="shrink-0" />
                    Another video in this topic is using one of these sets. Pick
                    the one that belongs to this video.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-[11.5px] leading-4 text-zinc-500">
                Choose a script set above to download it with this video.
              </p>
            )}
          </div>
        ) : null}
      </li>
    )
  }

  const renderSession = (session: ScanSession): JSX.Element => {
    const sets = setsBySession.get(session.sessionId) ?? []
    const status = topicStatus(session)
    const topicUrl = topicUrls[session.sessionId] ?? null
    const sessionScriptItemIds = new Set(
      sets.flatMap((set) => set.files.map((file) => file.id))
    )
    const groups = visibleGroupsFor(session)
    const collapsed = collapsedSessions[session.sessionId] === true
    const progress = session.progress
    const sessionTotal = session.items.length
    const sessionTicked = session.items.filter(
      (item) => isQueueable(item) && selection.has(item.id)
    ).length
    return (
      <section
        key={session.sessionId}
        aria-label={topicTitle(session)}
        className="surface-card overflow-hidden rounded-xl border border-white/10"
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5">
          <button
            type="button"
            onClick={() =>
              setCollapsedSessions((current) => ({
                ...current,
                [session.sessionId]: !collapsed
              }))
            }
            aria-expanded={!collapsed}
            className="flex min-w-0 items-center gap-2.5 text-left"
          >
            <span className="shrink-0 text-zinc-500">
              <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
            </span>
            <span className="truncate text-[13.5px] font-semibold text-zinc-100">
              {topicTitle(session)}
            </span>
            <span className="shrink-0 text-[12px] text-zinc-500">
              {session.hostname}
            </span>
          </button>
          <span
            className={`flex shrink-0 items-center gap-1.5 text-[12px] font-semibold ${status.textClass}`}
          >
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              {status.pulse ? (
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${status.dotClass}`}
                />
              ) : null}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${status.dotClass}`}
              />
            </span>
            {status.label}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-zinc-400">
            {session.status === 'scanning' ? (
              <>
                <span className="truncate">
                  {session.message ?? 'Scanning…'}
                  {progress.fetchedPages > 0
                    ? ` · ${progress.fetchedPages} page${
                        progress.fetchedPages === 1 ? '' : 's'
                      } read`
                    : ''}
                </span>
                <span
                  aria-hidden="true"
                  className="media-progress-indeterminate relative h-1 w-[120px] shrink-0 overflow-hidden rounded-full bg-white/[0.08]"
                />
              </>
            ) : session.status === 'limited' ? (
              'Item limit reached'
            ) : session.status === 'failed' ? (
              <span className="font-semibold text-red-300">Scan failed</span>
            ) : session.status === 'cancelled' ? (
              'Scan cancelled'
            ) : (
              <span className="tabular-nums">
                <span>{sessionTotal} files</span>
                <span className="text-zinc-600"> · </span>
                <span>{sessionTicked} ticked</span>
              </span>
            )}
            {topicUrl !== null ? (
              <a
                href={topicUrl}
                target="_blank"
                rel="noreferrer"
                title={topicUrl}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[11.5px] font-semibold text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200"
              >
                <Icon name="external" size={13} />
                Open topic
              </a>
            ) : null}
            {session.status === 'scanning' ? (
              <button
                type="button"
                onClick={() => cancelScan(session)}
                className="inline-flex h-7 shrink-0 items-center rounded-lg border border-white/10 px-2.5 text-[11.5px] font-semibold text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200"
              >
                Cancel
              </button>
            ) : null}
          </span>
        </div>
        {!collapsed ? (
          <>
            {session.signinRequired ? (
              <div className="mx-3.5 mb-2.5 flex items-center gap-2.5 rounded-lg border border-amber-400/35 bg-amber-400/[0.07] px-3 py-2 text-[12.5px]">
                <Icon name="alert" size={15} className="shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-zinc-100">
                    This topic is for signed-in members
                  </p>
                  <p className="text-[12px] leading-4 text-zinc-500">
                    Open the tab where you are signed in and choose “Scan this
                    page” in the DonDownload extension.
                  </p>
                </div>
              </div>
            ) : null}
            {session.message && !session.signinRequired && session.status !== 'scanning' ? (
              <p className="px-3.5 pb-2 text-[11.5px] leading-4 text-zinc-500">
                {session.message}
              </p>
            ) : null}
            {groups.length === 0 ? (
              <p className="px-3.5 py-3 text-[12px] leading-5 text-zinc-500">
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
                  const isLinksGroup = group.category === 'page'
                  const showItems = !isLinksGroup || linksExpanded
                  return (
                    <div key={`${session.sessionId}-${group.category}`}>
                      <div className="flex items-center gap-2 border-t border-white/[0.06] px-3.5 pb-1 pt-2.5">
                        {isLinksGroup ? (
                          <button
                            type="button"
                            onClick={() => setLinksExpanded((value) => !value)}
                            aria-expanded={linksExpanded}
                            aria-label={
                              linksExpanded
                                ? 'Collapse other links'
                                : 'Expand other links'
                            }
                            className="flex shrink-0 text-zinc-500 transition hover:text-zinc-200"
                          >
                            <Icon
                              name={linksExpanded ? 'chevron-down' : 'chevron-right'}
                              size={13}
                            />
                          </button>
                        ) : (
                          <span className="flex shrink-0 text-zinc-500">
                            <Icon name={group.icon} size={13} />
                          </span>
                        )}
                        <span className="text-[12px] font-semibold text-zinc-200">
                          {group.label}
                        </span>
                        <span className="text-[12px] tabular-nums text-zinc-500">
                          {groupItems.length}
                        </span>
                        {isLinksGroup ? null : (
                          <button
                            type="button"
                            onClick={() => toggleGroup(groupItems)}
                            disabled={selectable.length === 0}
                            className="ml-auto text-[12px] font-semibold text-accent-300 transition hover:text-accent-200 disabled:text-zinc-700"
                          >
                            {groupSelected ? 'Clear' : 'Select all'}
                          </button>
                        )}
                      </div>
                      {showItems ? (
                      <ul className="divide-y divide-white/[0.06]">
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
                                className={`grid grid-cols-[16px_32px_minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-2 transition-colors ${
                                  selected ? 'bg-accent-400/[0.05]' : ''
                                } hover:bg-white/[0.03]`}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${item.name}`}
                                  checked={selected}
                                  disabled={!queueableItem || disabled}
                                  onChange={() => toggle(item.id)}
                                  className="h-4 w-4 shrink-0 accent-accent-400 disabled:opacity-40"
                                />
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border border-white/10 bg-white/[0.045] text-zinc-400">
                                  <Icon name={group.icon} size={15} />
                                </span>
                                <div className="min-w-0">
                                  <div
                                    className="truncate text-[12.5px] font-semibold text-zinc-100"
                                    title={item.name}
                                  >
                                    {item.name}
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-zinc-500">
                                    <span>{type}</span>
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
                                  {isMarkableAsVideoScanItem(item) ? (
                                    <div className="mt-1.5">
                                      <button
                                        type="button"
                                        onClick={() => markAsVideo(session, item)}
                                        disabled={
                                          disabled || markingItemId !== null
                                        }
                                        className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-white/10 px-3 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        <Icon name="video" size={14} />
                                        {markingItemId === item.id ? (
                                          <span className="inline-flex items-center gap-1.5">
                                            <span
                                              aria-hidden="true"
                                              className="h-3 w-3 animate-spin rounded-full border border-zinc-400 border-t-transparent"
                                            />
                                            Checking…
                                          </span>
                                        ) : (
                                          'Mark as video'
                                        )}
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                                <span className="text-[12.5px] tabular-nums text-zinc-400">
                                  {itemSizeLabel(item)}
                                </span>
                              </li>
                            )
                          })}
                      </ul>
                      ) : null}
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

  const cancelAllScans = (): void => {
    for (const session of sessions) {
      if (session.status === 'scanning') cancelScan(session)
    }
  }

  return (
    <section
      aria-label={embedded ? 'Scan pages' : undefined}
      aria-labelledby={embedded ? undefined : 'scan-heading'}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 border-b border-white/[0.07] px-5 pb-3.5 pt-4">
        {embedded ? null : (
          <h2 id="scan-heading" className="sr-only">
            Scan pages
          </h2>
        )}
        <div className="flex items-start gap-2">
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
            placeholder={`Paste a forum topic or video page — one per line, up to ${MAX_SCAN_URLS}`}
            disabled={disabled}
            className="min-h-[38px] flex-1 resize-y rounded-lg border border-white/10 surface-input px-[11px] py-2 text-[12.5px] leading-5 text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-accent-400/60 focus:ring-2 focus:ring-accent-400/15 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={scanning ? cancelAllScans : rescan}
            disabled={disabled || starting}
            className={`inline-flex h-[38px] shrink-0 items-center gap-2 rounded-lg px-4 text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              scanning || starting
                ? 'border border-white/10 text-zinc-200 hover:bg-white/[0.05]'
                : sessions.length === 0
                  ? 'bg-accent-500 text-on-accent hover:bg-accent-400'
                  : 'border border-white/10 text-zinc-200 hover:bg-white/[0.05]'
            }`}
          >
            {starting ? (
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin rounded-full border border-zinc-400 border-t-transparent"
              />
            ) : scanning ? (
              <Icon name="x" size={14} />
            ) : (
              <Icon name={sessions.length === 0 ? 'search' : 'refresh'} size={14} />
            )}
            {starting
              ? 'Scanning…'
              : scanning
                ? 'Cancel'
                : sessions.length === 0
                  ? 'Scan'
                  : 'Rescan'}
          </button>
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-2.5 rounded-lg border border-red-400/30 bg-red-400/[0.08] px-3 py-2 text-[12px] leading-5 text-red-300"
          >
            {error.message}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="mt-2.5 rounded-lg border border-accent-400/25 bg-accent-400/[0.08] px-3 py-2 text-[12px] leading-5 text-accent-200"
          >
            {notice}
          </p>
        ) : null}
        {preselectNotice ? (
          <p
            role="status"
            className="mt-2.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2 text-[12px] leading-5 text-amber-200"
          >
            {preselectNotice}
          </p>
        ) : null}
      </div>

      {sessions.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <div className="mx-auto mt-8 w-[520px] max-w-full text-center text-[12.5px] leading-5 text-zinc-400">
            <div className="mx-auto mb-3.5 grid h-12 w-12 place-items-center rounded-xl bg-white/[0.06] text-accent-300">
              <Icon name="search" size={22} />
            </div>
            <h3 className="text-[15px] font-semibold text-zinc-100">
              Find everything on a page
            </h3>
            <p className="mt-1.5">
              DonDownload reads the page and the pages it links to, and lists the
              videos, scripts and files it finds.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-2.5 text-left">
              <div className="surface-card rounded-[10px] border border-white/10 p-3 text-[12px] leading-4 text-zinc-500">
                <b className="mb-0.5 block text-[12.5px] font-semibold text-zinc-100">
                  Nothing downloads yet
                </b>
                You pick what you want first.
              </div>
              <div className="surface-card rounded-[10px] border border-white/10 p-3 text-[12px] leading-4 text-zinc-500">
                <b className="mb-0.5 block text-[12.5px] font-semibold text-zinc-100">
                  Scripts are matched
                </b>
                Videos with matching scripts are ticked for you.
              </div>
              <div className="surface-card rounded-[10px] border border-white/10 p-3 text-[12px] leading-4 text-zinc-500">
                <b className="mb-0.5 block text-[12.5px] font-semibold text-zinc-100">
                  Signed-in pages
                </b>
                Use “Scan this page” in the browser extension.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.07] px-5 py-2.5">
            <div
              role="group"
              aria-label="Filter results"
              className="flex rounded-[9px] border border-white/10 bg-white/[0.04] p-0.5"
            >
              <button
                type="button"
                onClick={() => setFilter('all')}
                aria-pressed={filter === 'all'}
                className={`inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12px] font-semibold transition ${
                  filter === 'all'
                    ? 'bg-zinc-800/80 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                All
                <span className="tabular-nums text-zinc-500">
                  {totalItemCount}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setFilter('script-video')}
                aria-pressed={filter === 'script-video'}
                className={`inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12px] font-semibold transition ${
                  filter === 'script-video'
                    ? 'bg-zinc-800/80 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Videos with scripts
                <span className="tabular-nums text-zinc-500">
                  {videosWithScriptsCount}
                </span>
              </button>
            </div>
            <span className="ml-1.5 flex min-w-0 items-center gap-1.5 truncate text-[12.5px] text-zinc-400">
              <Icon name="check" size={14} className="shrink-0 text-accent-300" />
              Videos with matching scripts are ticked
            </span>
            <button
              type="button"
              onClick={toggleAll}
              disabled={queueable.length === 0}
              className="ml-auto text-[12px] font-semibold text-zinc-400 transition hover:text-zinc-200 disabled:text-zinc-700"
            >
              {allVisibleSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2.5">
            <div className="flex flex-col gap-2">
              {sessions.map((session) => renderSession(session))}
            </div>
          </div>

          <div className="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-white/[0.07] bg-[var(--surface-app)] px-5 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                {selectedItems.length === 0 ? (
                  <p className="text-[12px] leading-4 text-zinc-500">
                    Results are pre-selected where a video has matching scripts.
                    Nothing is queued until you click Download.
                  </p>
                ) : overSelectionLimit ? (
                  <p className="text-[12px] leading-4 font-medium text-amber-300">
                    {selectedItems.length} selected — over the{' '}
                    {MAX_SCAN_SELECTION}-item limit. Untick items or scan fewer
                    topics.
                  </p>
                ) : (
                  <>
                    <p className="text-[12.5px] font-semibold leading-5 text-zinc-100">
                      {[
                        selectedVideoCount > 0
                          ? `${selectedVideoCount} video${
                              selectedVideoCount === 1 ? '' : 's'
                            }`
                          : null,
                        selectedScriptCount > 0
                          ? `${selectedScriptCount} script${
                              selectedScriptCount === 1 ? '' : 's'
                            }`
                          : null,
                        selectedOtherCount > 0
                          ? `${selectedOtherCount} other`
                          : null,
                        sessions.length > 1
                          ? `${sessions.length} topics`
                          : null
                      ]
                        .filter((part) => part !== null)
                        .join(' · ') || `${selectedItems.length} items`}
                    </p>
                    <p className="text-[12px] leading-4 text-zinc-500">
                      {selectionLabel} · scripts are saved next to their videos
                    </p>
                  </>
                )}
              </div>
              <span
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-[12.5px] text-zinc-400"
                title="Downloads\DonDownload — the folder downloads are saved to"
              >
                <Icon name="folder" size={14} className="shrink-0" />
                Downloads\DonDownload
              </span>
              <button
                type="button"
                onClick={queueSelected}
                disabled={
                  disabled ||
                  queuing ||
                  selectedItems.length === 0 ||
                  overSelectionLimit
                }
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-accent-500 px-4 text-[12.5px] font-semibold text-on-accent transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                <Icon name="download" size={15} />
                {queuing
                  ? 'Queueing…'
                  : selectedVideoCount > 0
                    ? `Download ${selectedVideoCount} video${
                        selectedVideoCount === 1 ? '' : 's'
                      } + scripts`
                    : `Download ${selectedItems.length} selected`}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
