import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import type {
  AddDownloadInput,
  ApiResult,
  AppErrorInfo,
  AppSnapshot
} from '@shared/types'
import type {
  MediaAnalysis,
  MediaJobDetails,
  MediaOutputFormat,
  MediaSnapshot
} from '@shared/media'
import type { AppUpdateState } from '@shared/appUpdate'
import type { ScanSession } from '@shared/scanner'
import { formatBytes, formatSpeed } from '@shared/format'
import type { Batch } from '@shared/batches'
import { DEFAULT_PER_HOST_CONNECTIONS, type DownloadSettings } from '@shared/settings'
import { RuntimeNotice } from './components/RuntimeNotice'
import { Toolbar } from './components/Toolbar'
import { DownloadTable } from './components/DownloadTable'
import type { AddDialogTab } from './components/AddDialog'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { UndoToast } from './components/UndoToast'
import { ContextMenu } from './components/ContextMenu'
import { DetailsPane } from './components/DetailsPane'
import { Icon, type IconName } from './components/Icon'
import {
  buildUnifiedRows,
  filterRows,
  runningCount,
  sortRows,
  statusCounts as buildStatusCounts,
  totalSpeed,
  type SortDirection,
  type SortKey,
  type StatusFilterId,
  type UnifiedRow
} from './lib/unified'
import {
  EMPTY_SELECTION,
  jumpFocus,
  moveFocus,
  pruneSelection,
  selectAllRows,
  selectSingle,
  selectedRows as pickSelectedRows,
  updateSelection,
  type SelectionMode,
  type SelectionState
} from './lib/selection'
import {
  buildContextActions,
  canCopyLink,
  canPauseRow,
  canResumeRow,
  canShowRow,
  clearCompletedConfirmation,
  clearListConfirmation,
  deleteFileConfirmation,
  executeActionPlan,
  executeBulkRemoval,
  planBulkAction,
  planRowAction,
  type ActionPlanEntry,
  type RowActionId
} from './lib/actions'
import {
  groupExtensionScan,
  type ExtensionScanBatchState
} from './lib/extensionScanBatch'
import {
  IDLE_DRAG_ORIGIN,
  extractDroppedUrl,
  reduceDragOrigin,
  routeDroppedUrl,
  type DragOriginState
} from './lib/dnd'
import { applyRendererTheme } from './theme'
import {
  EMPTY_PENDING_REMOVAL,
  addPendingRemoval,
  expirePendingRemoval,
  failPendingRemoval,
  pendingRemovalLabel,
  reconcilePendingRemoval,
  settlePendingRemoval,
  undoPendingRemoval,
  type PendingRemovalState
} from './lib/pendingRemoval'
import {
  firstHttpUrl,
  isTypingTarget,
  matchShortcut,
  type ShortcutId
} from './lib/shortcuts'

type AppPage = 'library' | 'batches' | 'settings'

/*
 * Everything outside the downloads library — the Batches and Settings pages and
 * the Add/Scan overlays — is split into its own chunk and fetched on demand, so
 * the first paint only pays for the library.
 */
const BatchSection = lazy(() =>
  import('./components/BatchSection').then((module) => ({
    default: module.BatchSection
  }))
)
const SettingsSection = lazy(() =>
  import('./components/SettingsSection').then((module) => ({
    default: module.SettingsSection
  }))
)
const BrowserExtensionSection = lazy(() =>
  import('./components/BrowserExtensionSection').then((module) => ({
    default: module.BrowserExtensionSection
  }))
)
const AddDialog = lazy(() =>
  import('./components/AddDialog').then((module) => ({
    default: module.AddDialog
  }))
)
const ScanSheet = lazy(() =>
  import('./components/ScanSheet').then((module) => ({
    default: module.ScanSheet
  }))
)

/** Small placeholder shown while a lazily loaded page or overlay arrives. */
function LazyFallback({ label }: { label: string }): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[120px] items-center justify-center gap-2 px-4 py-6 text-[12px] text-zinc-500"
    >
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-700 border-t-accent-400"
      />
      {label}
    </div>
  )
}

/** How long a removed row can be brought back with Undo. */
export const UNDO_REMOVE_MS = 6_000

interface AddRequest {
  tab: AddDialogTab
  url: string
  nonce: number
  /** Extension-created scan sessions to seed the Scan page view together. */
  scanSessionIds?: string[]
}

interface MenuState {
  x: number
  y: number
  rows: UnifiedRow[]
}

function mergeScanSession(
  current: ScanSession | null,
  update: ScanSession
): ScanSession {
  if (current === null || current.sessionId !== update.sessionId) return update
  const items = new Map(current.items.map((item) => [item.id, item]))
  for (const item of update.items) items.set(item.id, item)
  for (const removed of update.removedItemIds) items.delete(removed)
  return { ...update, items: [...items.values()] }
}

function mergeScanSessionList(
  current: readonly ScanSession[],
  update: ScanSession
): ScanSession[] {
  const existing = current.find(
    (session) => session.sessionId === update.sessionId
  )
  if (existing === undefined) return [...current, update]
  return current.map((session) =>
    session.sessionId === update.sessionId
      ? mergeScanSession(session, update)
      : session
  )
}

export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [mediaSnapshot, setMediaSnapshot] = useState<MediaSnapshot | null>(null)
  const [banner, setBanner] = useState<AppErrorInfo | null>(null)
  const [page, setPage] = useState<AppPage>('library')
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>('all')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [detailsClosedFor, setDetailsClosedFor] = useState<string | null>(null)
  /**
   * Display-only details for media jobs, fetched on demand for the details
   * pane: job id → { at: job updatedAt when fetched, details }.
   * Bulk media snapshots never carry a source URL or path (see shared/media),
   * so the pane recovers them through the scoped `getMediaJobDetails` call.
   */
  const [mediaDetails, setMediaDetails] = useState<
    Record<string, { at: number; details: MediaJobDetails }>
  >({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [addRequest, setAddRequest] = useState<AddRequest | null>(null)
  const [scanSessions, setScanSessions] = useState<ScanSession[]>([])
  const [batchCount, setBatchCount] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const [appUpdate, setAppUpdate] = useState<AppUpdateState | null>(null)
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [showReleaseNotes, setShowReleaseNotes] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /** Rows hidden by a pending (undoable) removal, plus that removal's plan. */
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemovalState>(
    EMPTY_PENDING_REMOVAL
  )
  const dragDepth = useRef(0)
  const dragOrigin = useRef<DragOriginState>(IDLE_DRAG_ORIGIN)
  const addSequence = useRef(0)
  const extensionScanBatch = useRef<ExtensionScanBatchState | null>(null)

  // Track drags that start inside the window (logo, selected text, table rows).
  // Their payload is internal UI data and must never open the Add dialog, while
  // drops dragged in from a browser or another app still work.
  useEffect(() => {
    const onDragStart = (): void => {
      dragOrigin.current = reduceDragOrigin(dragOrigin.current, 'dragstart')
    }
    const onDragEnd = (): void => {
      dragOrigin.current = reduceDragOrigin(dragOrigin.current, 'dragend')
      dragDepth.current = 0
      setDragActive(false)
    }
    window.addEventListener('dragstart', onDragStart)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('dragstart', onDragStart)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.donDownload.getSettings().then((result) => {
      if (!cancelled && result.ok) {
        setSettings(result.value)
        applyRendererTheme(result.value.theme)
      }
    })
    void window.donDownload.getAppUpdateState().then((result) => {
      if (!cancelled && result.ok) setAppUpdate(result.value)
    })
    const unsubscribe = window.donDownload.onAppUpdateStateChanged((state) => {
      if (!cancelled) setAppUpdate(state)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // A lightweight batch-count subscription only for the header badge. The
  // Batches view itself owns its snapshot; this read never mutates anything.
  useEffect(() => {
    let cancelled = false
    void window.donDownload.getBatchSnapshot().then((result) => {
      if (!cancelled && result.ok) setBatchCount(result.value.batches.length)
    })
    const unsubscribe = window.donDownload.onBatchSnapshotChanged((snapshot) => {
      if (!cancelled) setBatchCount(snapshot.batches.length)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    const [downloadResult, mediaResult] = await Promise.all([
      window.donDownload.getSnapshot(),
      window.donDownload.getMediaSnapshot()
    ])
    if (downloadResult.ok) setSnapshot(downloadResult.value)
    else setBanner(downloadResult.error)
    if (mediaResult.ok) setMediaSnapshot(mediaResult.value)
    else if (downloadResult.ok) setBanner(mediaResult.error)
  }, [])

  useEffect(() => {
    const unsubscribe = window.donDownload.onScanUpdated((session) => {
      setScanSessions((current) => mergeScanSessionList(current, session))
      if (session.origin !== 'extension') return
      const decision = groupExtensionScan(
        extensionScanBatch.current,
        session.sessionId,
        Date.now()
      )
      extensionScanBatch.current = decision.batch
      const sessionIds = decision.batch.sessionIds
      // The extension explicitly asked the desktop to show this scan. Focus is
      // handled in the main process; this opens one view per batch and keeps
      // adding later sessions from the same click instead of opening a dialog
      // for every URL.
      setAddRequest((current) => {
        if (decision.isContinuation) {
          if (
            current === null ||
            current.tab !== 'scan' ||
            current.scanSessionIds === undefined
          ) {
            return current
          }
          return { ...current, scanSessionIds: sessionIds }
        }
        return {
          tab: 'scan',
          url: '',
          nonce: ++addSequence.current,
          scanSessionIds: sessionIds
        }
      })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribeClipboard = window.donDownload.onClipboardLink((url) => {
      setClipboardUrl(url)
    })
    return () => {
      unsubscribeClipboard()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.donDownload.onRevealRow((key) => {
      setPage('library')
      setStatusFilter('all')
      setQuery('')
      setDetailsClosedFor(null)
      setSelection({ selected: [key], anchor: key })
      setFocusedKey(key)
      void refreshAll()
    })
    return () => {
      unsubscribe()
    }
  }, [refreshAll])

  useEffect(() => {
    let cancelled = false

    const refresh = async (): Promise<void> => {
      const [downloadResult, mediaResult] = await Promise.all([
        window.donDownload.getSnapshot(),
        window.donDownload.getMediaSnapshot()
      ])
      if (cancelled) return
      if (downloadResult.ok) setSnapshot(downloadResult.value)
      else setBanner(downloadResult.error)
      if (mediaResult.ok) setMediaSnapshot(mediaResult.value)
      else setBanner((current) => current ?? mediaResult.error)
    }

    void refresh()
    const unsubscribeDownloads = window.donDownload.onSnapshotChanged((next) => {
      if (!cancelled) setSnapshot(next)
    })
    const unsubscribeMedia = window.donDownload.onMediaSnapshotChanged((next) => {
      if (!cancelled) setMediaSnapshot(next)
    })
    const timer = window.setInterval(() => {
      void refresh()
    }, 5_000)

    return () => {
      cancelled = true
      unsubscribeDownloads()
      unsubscribeMedia()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const downloads = snapshot?.downloads ?? []
  const mediaJobs = mediaSnapshot?.jobs ?? []
  const aria2 = snapshot?.aria2 ?? null
  const isReady = aria2?.status === 'ready'

  const allRows = useMemo(
    () => buildUnifiedRows(downloads, mediaJobs),
    [downloads, mediaJobs]
  )
  /** Rows the backend still lists, minus the ones hidden by a pending undo. */
  const listedRows = useMemo(() => {
    if (pendingRemoval.hidden.size === 0) return allRows
    return allRows.filter((row) => !pendingRemoval.hidden.has(row.key))
  }, [allRows, pendingRemoval.hidden])
  // A committed removal may already be gone from the snapshot; the hidden
  // keys then need no further bookkeeping. Reconcile against the backend
  // snapshot, not the filtered list: hidden rows are absent from `listedRows`
  // by definition, so using it would drop every pending key immediately.
  const snapshotKeys = useMemo(
    () => new Set(allRows.map((row) => row.key)),
    [allRows]
  )
  /* eslint-disable react-hooks/set-state-in-effect -- the hidden set is reconciled against the latest snapshot after it changes */
  useEffect(() => {
    setPendingRemoval((current) =>
      reconcilePendingRemoval(current, snapshotKeys)
    )
  }, [snapshotKeys])
  /* eslint-enable react-hooks/set-state-in-effect */
  const statusCounts = useMemo(
    () => buildStatusCounts(listedRows, 'all', query),
    [listedRows, query]
  )
  const filteredRows = useMemo(
    () => filterRows(listedRows, { category: 'all', status: statusFilter, query }),
    [listedRows, statusFilter, query]
  )
  const visibleRows = useMemo(
    () => sortRows(filteredRows, sortKey, sortDirection),
    [filteredRows, sortKey, sortDirection]
  )
  const visibleSelection = useMemo(
    () =>
      pickSelectedRows(visibleRows, selection).filter((row) =>
        selection.selected.includes(row.key)
      ),
    [visibleRows, selection]
  )
  const singleSelected = useMemo(() => {
    if (selection.selected.length !== 1) return null
    return visibleRows.find((row) => row.key === selection.selected[0]) ?? null
  }, [visibleRows, selection])

  /* eslint-disable react-hooks/set-state-in-effect -- focus and selection are derived from the filtered rows and must be reconciled after a filter change */
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (focusedKey !== null) setFocusedKey(null)
      return
    }
    if (!focusedKey || !visibleRows.some((row) => row.key === focusedKey)) {
      setFocusedKey(visibleRows[0]?.key ?? null)
    }
  }, [visibleRows, focusedKey])

  useEffect(() => {
    setSelection((current) => pruneSelection(visibleRows, current))
  }, [visibleRows])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- a filter change must close the row menu */
  useEffect(() => {
    setMenu(null)
  }, [page, statusFilter, query, sortKey, sortDirection])
  /* eslint-enable react-hooks/set-state-in-effect */

  const showDetails =
    singleSelected !== null && detailsClosedFor !== singleSelected.key

  // Refresh the selected media job's display details whenever its snapshot
  // row changed (a path can become known once the job completes).
  useEffect(() => {
    const media = singleSelected?.media
    if (!showDetails || media === null || media === undefined) return
    const cached = mediaDetails[media.id]
    if (cached !== undefined && cached.at >= media.updatedAt) return
    let cancelled = false
    void window.donDownload.getMediaJobDetails(media.id).then((result) => {
      if (cancelled) return
      setMediaDetails((current) => ({
        ...current,
        [media.id]: {
          at: media.updatedAt,
          details: result.ok
            ? result.value
            : { sourceUrl: null, filePath: null }
        }
      }))
    })
    return () => {
      cancelled = true
    }
  }, [singleSelected, showDetails, mediaDetails])

  const detailsPaneRow = useMemo(() => {
    const media = singleSelected?.media
    if (singleSelected === null || media === null || media === undefined) {
      return singleSelected
    }
    const cached = mediaDetails[media.id]
    if (cached === undefined) return singleSelected
    return {
      ...singleSelected,
      url: singleSelected.url ?? cached.details.sourceUrl,
      filePath: singleSelected.filePath ?? cached.details.filePath
    }
  }, [singleSelected, mediaDetails])

  const applyDownloadResult = useCallback(
    (result: ApiResult<AppSnapshot>): boolean => {
      if (!result.ok) {
        setBanner(result.error)
        return false
      }
      setBanner(null)
      setSnapshot(result.value)
      return true
    },
    []
  )

  const handleAdd = useCallback(
    async (input: AddDownloadInput): Promise<ApiResult<AppSnapshot>> => {
      setAdding(true)
      try {
        const result = await window.donDownload.addDownload(input)
        applyDownloadResult(result)
        return result
      } finally {
        setAdding(false)
      }
    },
    [applyDownloadResult]
  )

  const handleAnalyzeMedia = useCallback(
    (url: string): Promise<ApiResult<MediaAnalysis>> =>
      window.donDownload.analyzeMedia({ url }),
    []
  )

  const handleQueueMedia = useCallback(
    async (input: {
      analysisId: string
      optionId: string
      outputFormat: MediaOutputFormat
      maxBytes: number | null
    }): Promise<ApiResult<MediaSnapshot>> => {
      const result = await window.donDownload.queueMedia({
        analysisId: input.analysisId,
        optionId: input.optionId,
        outputFormat: input.outputFormat,
        ...(input.maxBytes === null ? {} : { maxBytes: input.maxBytes })
      })
      if (result.ok) {
        setMediaSnapshot(result.value)
        setBanner(null)
      }
      return result
    },
    []
  )

  const copyText = useCallback(async (text: string): Promise<void> => {
    try {
      // The main process writes the clipboard and records it as app-originated
      // so the clipboard watcher never offers the same link back to the user.
      const result = await window.donDownload.copyText(text)
      setToast(
        result.ok
          ? text.includes('\n')
            ? 'Links copied'
            : 'Link copied'
          : 'Could not copy the link'
      )
    } catch {
      setToast('Could not copy the link')
    }
  }, [])

  const runPlan = useCallback(
    async (plan: readonly ActionPlanEntry[]): Promise<void> => {
      if (plan.length === 0) return
      const result = await executeActionPlan(plan, window.donDownload)
      if (result.errors.length > 0) {
        setBanner(result.errors[0] ?? null)
      }
      if (result.copyUrls.length > 0) {
        await copyText(result.copyUrls.join('\n'))
      }
      if (result.analyzeAgain.length > 0) {
        setAddRequest({
          tab: 'media',
          url: '',
          nonce: ++addSequence.current
        })
      }
      if (
        plan.some(
          (entry) =>
            entry.action !== 'copy' && entry.action !== 'analyze-again'
        )
      ) {
        await refreshAll()
      }
    },
    [copyText, refreshAll]
  )

  /**
   * Commits a deferred removal: runs the stored plan through the bulk removal
   * channels (one call per source, never one per row), then drops the keys from
   * the hidden set. On failure the rows come back and the error banner shows.
   */
  const commitRemoval = useCallback(
    async (keys: readonly string[], plan: readonly ActionPlanEntry[]): Promise<void> => {
      setPendingRemoval((current) => expirePendingRemoval(current))
      const result = await executeBulkRemoval(plan, window.donDownload)
      await refreshAll()
      if (result.errors.length > 0) {
        setBanner(result.errors[0] ?? null)
        setPendingRemoval((current) => failPendingRemoval(current, keys))
        return
      }
      setPendingRemoval((current) => settlePendingRemoval(current, keys))
    },
    [refreshAll]
  )

  const requestRemove = useCallback(
    (rows: readonly UnifiedRow[]): void => {
      if (rows.length === 0) return
      const plan = planRowAction('remove', rows)
      if (plan.length === 0) return
      const keys = rows.map((row) => row.key)
      const keySet = new Set(keys)
      // Another removal replaces the undo window: commit the previous one first.
      const previous = pendingRemoval.pending
      if (previous !== null) {
        void commitRemoval(
          previous.keys,
          planRowAction('remove', previous.rows as UnifiedRow[])
        )
      }
      setPendingRemoval((current) =>
        addPendingRemoval(
          current,
          keys,
          rows.map((row) => row.title),
          rows
        )
      )
      setMenu(null)
      setSelection((current) => pruneSelection(
        visibleRows.filter((row) => !keySet.has(row.key)),
        current
      ))
      if (focusedKey !== null && keySet.has(focusedKey)) {
        setFocusedKey(null)
      }
      if (detailsClosedFor !== null && keySet.has(detailsClosedFor)) {
        setDetailsClosedFor(null)
      }
    },
    [commitRemoval, detailsClosedFor, focusedKey, pendingRemoval.pending, visibleRows]
  )

  /** Undo: show the rows again. The backend was never told about them. */
  const undoRemoval = useCallback((): void => {
    setPendingRemoval((current) => undoPendingRemoval(current))
  }, [])

  /** Expire/Esc: commit the pending removal now. */
  const expireRemoval = useCallback((): void => {
    const pending = pendingRemoval.pending
    if (pending === null) return
    void commitRemoval(
      pending.keys,
      planRowAction('remove', pending.rows as UnifiedRow[])
    )
  }, [commitRemoval, pendingRemoval.pending])

  // The window is going away: a hidden row that was never committed would be
  // lost from the list without the backend knowing, so commit on unload.
  const pendingRemovalRef = useRef(pendingRemoval)
  useEffect(() => {
    pendingRemovalRef.current = pendingRemoval
  })
  useEffect(() => {
    const onBeforeUnload = (): void => {
      const pending = pendingRemovalRef.current.pending
      if (pending === null) return
      void executeBulkRemoval(
        planRowAction('remove', pending.rows as UnifiedRow[]),
        window.donDownload
      )
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  /**
   * "Clear list": every entry that is not still in flight. The rows are hidden
   * with the same undo toast as a normal removal, then committed through the
   * bulk removal channels. Files on disk are never touched.
   */
  const requestClearList = useCallback((): void => {
    const plan = planBulkAction('clear-list', allRows)
    if (plan.length === 0) return
    setConfirm({
      ...clearListConfirmation(plan.length),
      onConfirm: () => {
        requestRemove(plan.map((entry) => entry.row))
      }
    })
  }, [allRows, requestRemove])

  const openAddDialog = useCallback((tab: AddDialogTab, url = ''): void => {
    setAddRequest({ tab, url, nonce: ++addSequence.current })
  }, [])

  /** Opens the redesigned scan side sheet over the whole window. */
  const openScanSheet = useCallback((url = ''): void => {
    setAddRequest({ tab: 'scan', url, nonce: ++addSequence.current })
  }, [])

  /** Opens the Add dialog prefilled with a pasted link, routed like a drop. */
  const openAddFromClipboardText = useCallback(
    (text: string): boolean => {
      const url = firstHttpUrl(text)
      if (url === null) return false
      const route = routeDroppedUrl(url)
      if (route === null) return false
      setClipboardUrl(null)
      openAddDialog(route.target, route.url)
      return true
    },
    [openAddDialog]
  )

  /**
   * Global shortcuts. The matching rules live in lib/shortcuts so they can be
   * unit-tested; this handler only performs the resulting action.
   */
  const handleShortcut = useCallback(
    (shortcut: ShortcutId, text = ''): void => {
      switch (shortcut) {
        case 'add':
          openAddDialog('direct')
          return
        case 'paste-add':
          openAddFromClipboardText(text)
          return
        case 'settings':
          setMenu(null)
          setPage('settings')
          return
        case 'batches':
          setMenu(null)
          setPage('batches')
          return
        case 'focus-search':
          setPage('library')
          window.requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>(
              'input[type="search"]'
            )
            input?.focus()
            input?.select()
          })
          return
        case 'shortcuts-help':
          setMenu(null)
          setShortcutsOpen(true)
          return
        case 'undo':
          // Only acts while a removal can still be undone.
          undoRemoval()
          return
        case 'clear-list':
          setMenu(null)
          setPage('library')
          requestClearList()
          return
        case 'escape':
          setPage('library')
          return
      }
    },
    [openAddDialog, openAddFromClipboardText, requestClearList, undoRemoval]
  )

  // The window-level shortcut listener. It reads the latest UI state through
  // an effect-synced ref so it never needs to be re-subscribed while the user
  // types, and so render never touches a ref.
  const shortcutContextRef = useRef<{
    dialogOpen: boolean
    menuOpen: boolean
    page: AppPage
  }>({ dialogOpen: false, menuOpen: false, page })
  const handleShortcutRef = useRef(handleShortcut)

  useEffect(() => {
    shortcutContextRef.current = {
      dialogOpen: addRequest !== null || confirm !== null || shortcutsOpen,
      menuOpen: menu !== null,
      page
    }
    handleShortcutRef.current = handleShortcut
  })

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const shortcut = matchShortcut(event, {
        ...shortcutContextRef.current,
        isTyping: isTypingTarget(event.target as Element | null)
      })
      if (shortcut === null) return
      // Ctrl+Z only belongs to the undo toast while one is open; otherwise
      // leave it to the focused field or the platform.
      if (shortcut === 'undo' && pendingRemovalRef.current.pending === null) {
        return
      }
      event.preventDefault()
      handleShortcutRef.current(shortcut)
    }
    const onPaste = (event: ClipboardEvent): void => {
      const context = shortcutContextRef.current
      if (context.dialogOpen || context.menuOpen) return
      if (isTypingTarget(event.target as Element | null)) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (firstHttpUrl(text) === null) return
      event.preventDefault()
      handleShortcutRef.current('paste-add', text)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  const openRow = useCallback(
    (row: UnifiedRow): void => {
      const plan = planRowAction('open', [row])
      if (plan.length > 0) {
        void runPlan(plan)
      } else {
        setDetailsClosedFor(null)
      }
    },
    [runPlan]
  )

  const showRowInFolder = useCallback(
    (row: UnifiedRow): void => {
      void runPlan(planRowAction('show-in-folder', [row]))
    },
    [runPlan]
  )

  /** First child download/media of a batch that has a completed file on disk. */
  const findBatchFolderRow = useCallback(
    (batch: Batch): UnifiedRow | undefined => {
      for (const item of batch.items) {
        if (item.childId === null) continue
        const row = allRows.find(
          (candidate) =>
            (candidate.download !== null &&
              candidate.download.id === item.childId) ||
            (candidate.media !== null && candidate.media.id === item.childId)
        )
        if (row !== undefined && canShowRow(row)) return row
      }
      return undefined
    },
    [allRows]
  )

  const requestDeleteFile = useCallback(
    (row: UnifiedRow): void => {
      const plan = planRowAction('delete-file', [row])
      if (plan.length === 0) return
      setConfirm({
        ...deleteFileConfirmation(row.title),
        onConfirm: () => {
          void runPlan(plan)
        }
      })
    },
    [runPlan]
  )

  const handleRowClick = useCallback(
    (row: UnifiedRow, mode: SelectionMode): void => {
      setMenu(null)
      setSelection((current) =>
        updateSelection(visibleRows, current, row.key, mode)
      )
      setFocusedKey(row.key)
    },
    [visibleRows]
  )

  const handleToggleRow = useCallback(
    (row: UnifiedRow): void => {
      setSelection((current) =>
        updateSelection(visibleRows, current, row.key, 'toggle')
      )
      setFocusedKey(row.key)
    },
    [visibleRows]
  )

  /** Stable handler so a memoised row is not re-rendered by a new closure. */
  const handleFocusRow = useCallback((row: UnifiedRow): void => {
    setFocusedKey(row.key)
  }, [])

  const handleSelectAll = useCallback((): void => {
    setSelection((current) => {
      const allSelected =
        visibleRows.length > 0 &&
        visibleRows.every((row) => current.selected.includes(row.key))
      return allSelected ? EMPTY_SELECTION : selectAllRows(visibleRows)
    })
  }, [visibleRows])

  const handleContextMenu = useCallback(
    (row: UnifiedRow, event: MouseEvent): void => {
      event.preventDefault()
      const alreadySelected = selection.selected.includes(row.key)
      const rows = alreadySelected
        ? visibleSelection.length > 0
          ? visibleSelection
          : [row]
        : [row]
      if (!alreadySelected) {
        setSelection(selectSingle(row))
        setDetailsClosedFor(null)
      }
      setFocusedKey(row.key)
      setMenu({ x: event.clientX, y: event.clientY, rows })
    },
    [selection.selected, visibleSelection]
  )

  const handleContextAction = useCallback(
    (action: RowActionId): void => {
      const rows = menu?.rows ?? []
      setMenu(null)
      if (rows.length === 0) return
      if (action === 'remove') {
        requestRemove(rows)
        return
      }
      if (action === 'analyze-again') {
        setAddRequest({ tab: 'media', url: '', nonce: ++addSequence.current })
        return
      }
      if (action === 'delete-file') {
        if (rows.length === 1 && rows[0]) requestDeleteFile(rows[0])
        return
      }
      void runPlan(planRowAction(action, rows))
    },
    [menu, requestDeleteFile, requestRemove, runPlan]
  )

  const handleTableKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      ) {
        return
      }

      const focusedRow =
        visibleRows.find((row) => row.key === focusedKey) ?? visibleRows[0]

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const moved = moveFocus(
          visibleRows,
          selection,
          focusedKey,
          event.key === 'ArrowDown' ? 1 : -1,
          event.shiftKey
        )
        setFocusedKey(moved.focus)
        setSelection(moved.selection)
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const moved = jumpFocus(
          visibleRows,
          selection,
          event.key === 'Home' ? 'start' : 'end',
          event.shiftKey
        )
        setFocusedKey(moved.focus)
        setSelection(moved.selection)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelection(selectAllRows(visibleRows))
        return
      }
      if (event.key === 'Enter') {
        if (focusedRow) {
          event.preventDefault()
          openRow(focusedRow)
        }
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const rows =
          visibleSelection.length > 0
            ? visibleSelection
            : focusedRow
              ? [focusedRow]
              : []
        if (rows.length > 0) {
          event.preventDefault()
          requestRemove(rows)
        }
        return
      }
      if (event.key === ' ' && focusedRow) {
        event.preventDefault()
        handleToggleRow(focusedRow)
        return
      }
      if (
        (event.shiftKey && event.key === 'F10') ||
        event.key === 'ContextMenu'
      ) {
        if (!focusedRow) return
        event.preventDefault()
        const element = document.querySelector<HTMLElement>(
          `[data-row-key="${focusedRow.key}"]`
        )
        const rect = element?.getBoundingClientRect()
        setMenu({
          x: rect ? rect.left + 48 : 40,
          y: rect ? rect.top + 24 : 80,
          rows:
            visibleSelection.length > 0 &&
            selection.selected.includes(focusedRow.key)
              ? visibleSelection
              : [focusedRow]
        })
        return
      }
      if (event.key === 'Escape') {
        setSelection(EMPTY_SELECTION)
        setDetailsClosedFor(null)
      }
    },
    [
      focusedKey,
      handleToggleRow,
      openRow,
      requestRemove,
      selection,
      visibleRows,
      visibleSelection
    ]
  )

  const handleRestart = useCallback(async (): Promise<void> => {
    setRestarting(true)
    try {
      applyDownloadResult(await window.donDownload.restartAria2())
    } finally {
      setRestarting(false)
    }
  }, [applyDownloadResult])

  const installAppUpdate = useCallback(async (): Promise<void> => {
    const result = await window.donDownload.installAppUpdate()
    if (!result.ok) {
      setBanner(result.error)
      return
    }
    setAppUpdate(result.value)
  }, [])

  const pauseAll = useCallback((): void => {
    void runPlan(planBulkAction('pause-all', allRows))
  }, [allRows, runPlan])

  const resumeAll = useCallback((): void => {
    void runPlan(planBulkAction('resume-all', allRows))
  }, [allRows, runPlan])

  /** Human line for the add dialog's "Already in your list" hint. */
  const describeDuplicate = useCallback(
    (url: string): string | null => {
      const row = allRows.find((candidate) => candidate.url === url)
      if (row === undefined) return null
      const status = row.statusLabel.toLowerCase()
      // Progress is only meaningful before a download completes.
      if (
        row.statusGroup === 'completed' ||
        row.progress <= 0 ||
        row.indeterminate
      ) {
        return status
      }
      return `${status} at ${Math.round(row.progress)}%`
    },
    [allRows]
  )

  const resumeDuplicateUrl = useCallback(
    (url: string): void => {
      const row = allRows.find((candidate) => candidate.url === url)
      if (row === undefined) return
      if (canResumeRow(row)) void runPlan(planRowAction('resume', [row]))
    },
    [allRows, runPlan]
  )

  const requestClearCompleted = useCallback((): void => {
    const plan = planBulkAction('clear-completed', allRows)
    if (plan.length === 0) return
    setConfirm({
      ...clearCompletedConfirmation(plan.length),
      onConfirm: () => {
        void runPlan(plan)
      }
    })
  }, [allRows, runPlan])

  const pauseRow = useCallback(
    (row: UnifiedRow): void => {
      void runPlan(planRowAction('pause', [row]))
    },
    [runPlan]
  )

  const resumeRow = useCallback(
    (row: UnifiedRow): void => {
      void runPlan(planRowAction('resume', [row]))
    },
    [runPlan]
  )

  const retryRow = useCallback(
    (row: UnifiedRow): void => {
      void runPlan(planRowAction('retry', [row]))
    },
    [runPlan]
  )

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (dragOrigin.current.internal) return
    if (!event.dataTransfer.types.includes('text/uri-list') &&
        !event.dataTransfer.types.includes('text/plain')) {
      return
    }
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }, [])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (dragOrigin.current.internal) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const wasInternal = dragOrigin.current.internal
      dragOrigin.current = reduceDragOrigin(dragOrigin.current, 'drop')
      dragDepth.current = 0
      setDragActive(false)
      if (wasInternal) return
      const url = extractDroppedUrl({
        uriList: event.dataTransfer.getData('text/uri-list'),
        text: event.dataTransfer.getData('text/plain')
      })
      if (!url) return
      const route = routeDroppedUrl(url)
      if (!route) return
      openAddDialog(route.target, route.url)
    },
    [openAddDialog]
  )

  const filtersActive =
    query.trim().length > 0 || statusFilter !== 'all'
  const activeDownloadCount = runningCount(listedRows)
  const aggregateSpeed = totalSpeed(listedRows)
  const totalOnDisk = listedRows.reduce((sum, row) => sum + row.completedBytes, 0)
  const saveDir = snapshot?.downloads[0]?.dir ?? null
  const menuActions = menu ? buildContextActions(menu.rows) : []
  const selectMode = selection.selected.length > 1
  const allSelected =
    visibleRows.length > 0 &&
    visibleRows.every((row) => selection.selected.includes(row.key))

  return (
    <div
      className="surface-app flex h-screen flex-col overflow-hidden text-zinc-100"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="window-app-header relative shrink-0 border-b border-white/[0.07] surface-app">
        <div aria-hidden="true" className="window-drag-region absolute left-0 top-0" />
        <div className="window-app-header-content relative z-10 flex h-14 items-center gap-3 pl-4">
          {page === 'library' ? (
            /* Non-interactive on the library page so the logo and app name
             * stay inside the header drag region. */
            <div className="flex shrink-0 items-center gap-2.5 select-none">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-accent-500 text-on-accent"
              >
                <Icon name="download" size={17} strokeWidth={2} />
              </span>
              <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-100">
                DonDownload
              </h1>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPage('library')}
              className="flex shrink-0 items-center gap-2.5 select-none"
              title="Back to downloads"
            >
              <span
                aria-hidden="true"
                className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-accent-500 text-on-accent"
              >
                <Icon name="download" size={17} strokeWidth={2} />
              </span>
              <span className="flex items-center gap-1 text-sm font-semibold text-zinc-100">
                <Icon name="chevron-left" size={15} />
                Downloads
              </span>
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div
              role="status"
              className="flex items-center gap-1.5 px-1.5 text-[12.5px] text-zinc-400"
            >
              {activeDownloadCount > 0 ? (
                <>
                  <Icon name="download" size={14} className="text-zinc-500" />
                  <span className="font-semibold tabular-nums text-zinc-100">
                    {formatSpeed(aggregateSpeed)}
                  </span>
                  <span className="hidden text-zinc-500 lg:inline">
                    · {activeDownloadCount} active
                  </span>
                </>
              ) : (
                <span className="text-zinc-500">Idle</span>
              )}
            </div>

            <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/10" />

            <button
              type="button"
              onClick={() => setPage('batches')}
              aria-current={page === 'batches' ? 'page' : undefined}
              aria-label="Batches"
              title="Batches (Ctrl+B)"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold text-zinc-300 transition hover:bg-white/5 hover:text-zinc-100"
            >
              <Icon name="layers" size={15} />
              <span className="hidden min-[902px]:inline">Batches</span>
              {batchCount > 0 ? (
                <span className="rounded-full bg-zinc-700/70 px-1.5 text-[11px] font-medium leading-4 tabular-nums text-zinc-300">
                  {batchCount}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              onClick={() => setPage('settings')}
              aria-label="Settings"
              title="Settings (Ctrl+,)"
              aria-current={page === 'settings' ? 'page' : undefined}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
            >
              <Icon name="settings" size={16} />
            </button>

            <button
              type="button"
              onClick={() => openAddDialog('direct')}
              title="Add (Ctrl+N)"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-500 px-3 text-[12px] font-semibold text-on-accent transition hover:bg-accent-400"
            >
              <Icon name="plus" size={15} strokeWidth={2.2} />
              Add
            </button>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {banner && !addRequest ? (
          <div className="mx-4 mt-2.5">
            <ErrorBanner banner={banner} onDismiss={() => setBanner(null)} />
          </div>
        ) : null}

        {appUpdate?.status === 'ready' && appUpdate.canInstall ? (
          <div
            role="status"
            className="mx-4 mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-accent-400/30 bg-accent-400/[0.08] px-3 py-2 text-[12.5px]"
          >
            <span aria-hidden="true" className="flex shrink-0 text-accent-300">
              <Icon name="refresh" size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-zinc-100">
                DonDownload {appUpdate.latestVersion ?? 'update'} is ready.
              </span>{' '}
              <span className="text-zinc-400">
                Running downloads resume after the restart.
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {appUpdate.releaseNotes ? (
                <button
                  type="button"
                  onClick={() => setShowReleaseNotes((value) => !value)}
                  className="h-7 rounded-md px-2.5 text-[11.5px] font-semibold text-zinc-300 transition hover:bg-white/5 hover:text-zinc-100"
                >
                  What's new
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void installAppUpdate()}
                className="h-7 rounded-md bg-accent-500 px-2.5 text-[11.5px] font-semibold text-on-accent transition hover:bg-accent-400"
              >
                Restart now
              </button>
            </span>
            {showReleaseNotes && appUpdate.releaseNotes ? (
              <pre className="w-full basis-full overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[11.5px] leading-6 text-zinc-400">
                {appUpdate.releaseNotes}
              </pre>
            ) : null}
          </div>
        ) : null}

        {page === 'library' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {aria2 && !isReady ? (
              <RuntimeNotice
                aria2={aria2}
                restarting={restarting}
                onRetry={() => {
                  void handleRestart()
                }}
              />
            ) : null}

            {selectMode ? (
              <div className="mx-2 mb-1 mt-2 flex items-center gap-1.5 rounded-xl border border-accent-400/30 bg-accent-400/[0.08] px-3 py-1.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allSelected}
                  aria-label="Select all visible downloads"
                  onClick={handleSelectAll}
                  className="grid h-4 w-4 place-items-center rounded border-[1.5px] border-accent-500 bg-accent-500 text-on-accent"
                >
                  <Icon name="check" size={11} strokeWidth={2.6} />
                </button>
                <span className="mr-2 text-[12.5px] font-semibold text-zinc-100">
                  {selection.selected.length} selected
                </span>
                <SelectionBarButton
                  icon="pause"
                  label="Pause"
                  disabled={!visibleSelection.some(canPauseRow)}
                  onClick={() =>
                    void runPlan(planRowAction('pause', visibleSelection))
                  }
                />
                <SelectionBarButton
                  icon="play"
                  label="Resume"
                  disabled={!visibleSelection.some(canResumeRow)}
                  onClick={() =>
                    void runPlan(planRowAction('resume', visibleSelection))
                  }
                />
                <SelectionBarButton
                  icon="link"
                  label="Copy links"
                  disabled={!visibleSelection.some(canCopyLink)}
                  onClick={() =>
                    void runPlan(planRowAction('copy-link', visibleSelection))
                  }
                />
                <div className="ml-auto flex items-center gap-1">
                  <SelectionBarButton
                    icon="trash"
                    label="Remove"
                    danger
                    disabled={false}
                    onClick={() => requestRemove(visibleSelection)}
                  />
                  <button
                    type="button"
                    onClick={() => setSelection(EMPTY_SELECTION)}
                    aria-label="Clear selection"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
              </div>
            ) : (
              <Toolbar
                query={query}
                onQueryChange={setQuery}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                statusCounts={statusCounts}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSortKeyChange={setSortKey}
                onToggleSortDirection={() =>
                  setSortDirection((direction) =>
                    direction === 'asc' ? 'desc' : 'asc'
                  )
                }
                canPauseAll={allRows.some(canPauseRow)}
                canResumeAll={allRows.some(canResumeRow)}
                onPauseAll={pauseAll}
                onResumeAll={resumeAll}
                canClearCompleted={
                  planBulkAction('clear-completed', allRows).length > 0
                }
                onClearCompleted={requestClearCompleted}
                canClearList={planBulkAction('clear-list', allRows).length > 0}
                onClearList={requestClearList}
              />
            )}

            <DownloadTable
              rows={visibleRows}
              selection={selection}
              focusedKey={focusedKey}
              emptyState={
                <LibraryEmptyState
                  filtersActive={filtersActive}
                  onAdd={() => openAddDialog('direct')}
                  onClearFilters={() => {
                    setQuery('')
                    setStatusFilter('all')
                  }}
                />
              }
              onRowClick={handleRowClick}
              onToggleRow={handleToggleRow}
              onFocusRow={handleFocusRow}
              onOpenRow={openRow}
              onShowInFolder={showRowInFolder}
              onPauseRow={pauseRow}
              onResumeRow={resumeRow}
              onRetryRow={retryRow}
              onContextMenu={handleContextMenu}
              onKeyDown={handleTableKeyDown}
            />

            {showDetails && singleSelected !== null ? (
              <DetailsPane
                row={detailsPaneRow ?? singleSelected}
                onClose={() => setDetailsClosedFor(singleSelected.key)}
                onOpen={openRow}
                onShowInFolder={showRowInFolder}
                onCopyLink={(copyRow) => {
                  if (copyRow.url !== null) void copyText(copyRow.url)
                }}
              />
            ) : null}

            <footer className="flex shrink-0 items-center gap-4 border-t border-white/[0.07] px-4 py-1.5 text-[12px] text-zinc-500">
              <span className="truncate">
                {listedRows.length}{' '}
                {listedRows.length === 1 ? 'download' : 'downloads'} ·{' '}
                {formatBytes(totalOnDisk)} on disk
              </span>
              {saveDir ? (
                <span className="ml-auto hidden truncate lg:inline">
                  Saving to {saveDir}
                </span>
              ) : null}
            </footer>
          </div>
        ) : null}

        {page === 'batches' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 pb-10">
              {aria2 ? (
                <div className="mb-3">
                  <RuntimeNotice
                    aria2={aria2}
                    restarting={restarting}
                    onRetry={() => {
                      void handleRestart()
                    }}
                  />
                </div>
              ) : null}
              <Suspense fallback={<LazyFallback label="Loading batches…" />}>
                <BatchSection
                  onBack={() => setPage('library')}
                  onAddLinks={() => openAddDialog('direct')}
                  findFolderRow={findBatchFolderRow}
                  onShowRowInFolder={showRowInFolder}
                />
              </Suspense>
            </div>
          </div>
        ) : null}

        {page === 'settings' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto w-full max-w-3xl">
              <Suspense fallback={<LazyFallback label="Loading settings…" />}>
                <SettingsSection />
                <BrowserExtensionSection />
              </Suspense>
            </div>
          </div>
        ) : null}
      </main>

      {addRequest ? (
        <Suspense fallback={<LazyFallback label="Opening…" />}>
          {addRequest.tab === 'scan' ? (
            <ScanSheet
              url={addRequest.url}
              sessions={
                addRequest.scanSessionIds === undefined
                  ? null
                  : addRequest.scanSessionIds.flatMap((sessionId) => {
                      const session = scanSessions.find(
                        (candidate) => candidate.sessionId === sessionId
                      )
                      return session === undefined ? [] : [session]
                    })
              }
              disabled={adding}
              onClose={() => setAddRequest(null)}
            />
          ) : (
            <AddDialog
              key={addRequest.nonce}
              tab={addRequest.tab}
              initialUrl={addRequest.url}
              busy={adding}
              describeDuplicate={describeDuplicate}
              onResumeDuplicate={resumeDuplicateUrl}
              defaultConnections={
                settings?.perHostConnections ?? DEFAULT_PER_HOST_CONNECTIONS
              }
              onScanOpen={openScanSheet}
              onClose={() => setAddRequest(null)}
              onAdd={handleAdd}
              onAnalyze={handleAnalyzeMedia}
              onQueue={handleQueueMedia}
            />
          )}
        </Suspense>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={menuActions}
          onSelect={handleContextAction}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      ) : null}

      {shortcutsOpen ? (
        <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      ) : null}

      {dragActive ? (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-400/70 bg-accent-400/[0.08] backdrop-blur-[1px]">
          <div className="rounded-xl border border-accent-400/30 bg-accent-400/10 px-4 py-3 text-center">
            <p className="text-sm font-semibold text-accent-200">
              Drop a link to add
            </p>
            <p className="mt-0.5 text-[11px] text-accent-200/70">
              Media page URLs open the analyzer. Other links open Quick Add.
            </p>
          </div>
        </div>
      ) : null}

      {clipboardUrl ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-11 right-4 z-[70] flex w-[min(92vw,420px)] items-center gap-3 rounded-xl border border-white/10 bg-[var(--surface-card)] p-3 shadow-xl shadow-black/50"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-400/10 text-accent-300"
          >
            <Icon name="link" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-zinc-100">
              Link on clipboard
            </p>
            <p className="truncate text-[12px] text-zinc-500" title={clipboardUrl}>
              {clipboardUrl}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setClipboardUrl(null)}
            className="h-[30px] shrink-0 rounded-md px-2.5 text-[12px] font-semibold text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
          >
            Ignore
          </button>
          <button
            type="button"
            onClick={() => {
              const route = routeDroppedUrl(clipboardUrl)
              setClipboardUrl(null)
              if (route) openAddDialog(route.target, route.url)
            }}
            className="h-[30px] shrink-0 rounded-md bg-accent-500 px-3 text-[12px] font-semibold text-on-accent transition hover:bg-accent-400"
          >
            Add
          </button>
        </div>
      ) : null}

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-full border border-white/10 bg-[var(--surface-card)] px-3 py-1.5 text-[11px] text-zinc-200 shadow-xl shadow-black/50"
        >
          {toast}
        </div>
      ) : null}

      {pendingRemoval.pending !== null ? (
        <UndoToast
          key={pendingRemoval.pending.keys.join('|')}
          label={pendingRemovalLabel(pendingRemoval.pending.titles)}
          durationMs={UNDO_REMOVE_MS}
          onUndo={undoRemoval}
          onDismiss={expireRemoval}
          onExpire={expireRemoval}
        />
      ) : null}

      {adding ? (
        <span role="status" className="sr-only">
          Adding download…
        </span>
      ) : null}
    </div>
  )
}

function ErrorBanner({
  banner,
  onDismiss
}: {
  banner: AppErrorInfo
  onDismiss: () => void
}): JSX.Element {
  return (
    <div
      role="alert"
      className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/5 px-3 py-2.5 text-xs leading-5 text-red-200"
    >
      <div className="min-w-0">
        <p>{banner.message}</p>
        {banner.hint ? (
          <p className="mt-0.5 break-words text-[11px] text-red-300/80">
            {banner.hint}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg border border-red-300/20 px-2 py-1 text-[11px] text-red-200 transition hover:bg-red-300/10"
      >
        Dismiss
      </button>
    </div>
  )
}

function SelectionBarButton({
  icon,
  label,
  disabled,
  danger = false,
  onClick
}: {
  icon: IconName
  label: string
  disabled: boolean
  danger?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-[30px] items-center gap-1.5 rounded-md border border-transparent px-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 ${
        danger
          ? 'text-red-400 hover:bg-red-400/10'
          : 'text-zinc-200 hover:bg-white/5'
      }`}
    >
      <Icon name={icon} size={15} />
      <span className="hidden lg:inline">{label}</span>
    </button>
  )
}

function LibraryEmptyState({
  filtersActive,
  onAdd,
  onClearFilters
}: {
  filtersActive: boolean
  onAdd: () => void
  onClearFilters: () => void
}): JSX.Element {
  if (filtersActive) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center px-6 py-10 text-center">
        <div
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-zinc-500"
        >
          <Icon name="search" size={22} />
        </div>
        <p className="mt-3 text-sm font-medium text-zinc-300">
          No matching downloads
        </p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">
          Try a different search or status filter.
        </p>
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-4 h-8 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5"
        >
          Clear filters
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="flex w-[520px] max-w-full flex-col items-center gap-3 text-center">
        <div
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-[14px] border border-white/10 bg-white/[0.03] text-accent-400"
        >
          <Icon name="download" size={26} />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100">
          Nothing downloading yet
        </h2>
        <p className="text-[12.5px] text-zinc-400">
          Paste a link, drop one here, or use the browser extension on any page.
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[12px] text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-px text-[11px] font-medium text-zinc-400">
              Ctrl V
            </span>
            paste a link
          </span>
          <span aria-hidden="true" className="text-zinc-600">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            drag &amp; drop files
          </span>
          <span aria-hidden="true" className="text-zinc-600">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="puzzle" size={13} />
            browser extension
          </span>
          <span aria-hidden="true" className="text-zinc-600">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-px text-[11px] font-medium text-zinc-400">
              ?
            </span>
            for shortcuts
          </span>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-500 px-3 text-[12px] font-semibold text-on-accent transition hover:bg-accent-400"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} />
          Add download
        </button>
      </div>
    </div>
  )
}
