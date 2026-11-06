import {
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
  AppSnapshot,
  Aria2State
} from '@shared/types'
import type {
  MediaAnalysis,
  MediaOutputFormat,
  MediaSnapshot
} from '@shared/media'
import type { AppUpdateState } from '@shared/appUpdate'
import type { ScanSession } from '@shared/scanner'
import { formatSpeed } from '@shared/format'
import { BatchSection } from './components/BatchSection'
import { RuntimeNotice } from './components/RuntimeNotice'
import { SettingsSection } from './components/SettingsSection'
import { BrowserExtensionSection } from './components/BrowserExtensionSection'
import { Sidebar, type SidebarPage } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { DownloadTable } from './components/DownloadTable'
import { AddDialog, type AddDialogTab } from './components/AddDialog'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog'
import { ContextMenu } from './components/ContextMenu'
import { DetailsPane } from './components/DetailsPane'
import { Icon } from './components/Icon'
import {
  buildUnifiedRows,
  categoryCounts as buildCategoryCounts,
  filterRows,
  runningCount,
  sortRows,
  statusCounts as buildStatusCounts,
  totalSpeed,
  type CategoryId,
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
  canPauseRow,
  canResumeRow,
  canRetryRow,
  clearCompletedConfirmation,
  deleteFileConfirmation,
  executeActionPlan,
  planBulkAction,
  planRowAction,
  removeConfirmation,
  type ActionPlanEntry,
  type RowActionId
} from './lib/actions'
import {
  IDLE_DRAG_ORIGIN,
  extractDroppedUrl,
  reduceDragOrigin,
  routeDroppedUrl,
  type DragOriginState
} from './lib/dnd'
import { applyRendererTheme } from './theme'
import appLogo from './assets/logo.svg'

interface AddRequest {
  tab: AddDialogTab
  url: string
  nonce: number
  /** Extension-created scan session to seed the Scan page view. */
  scanSessionId?: string
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

function runtimeLabel(aria2: Aria2State | null): string {
  if (!aria2) return 'Connecting…'
  switch (aria2.status) {
    case 'ready':
      return aria2.version ? `aria2 ${aria2.version}` : 'aria2 connected'
    case 'starting':
      return 'Starting aria2…'
    case 'unavailable':
      return 'aria2 not found'
    case 'error':
      return 'aria2 stopped'
    case 'stopped':
      return 'aria2 offline'
  }
}

export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [mediaSnapshot, setMediaSnapshot] = useState<MediaSnapshot | null>(null)
  const [banner, setBanner] = useState<AppErrorInfo | null>(null)
  const [page, setPage] = useState<SidebarPage>('library')
  const [category, setCategory] = useState<CategoryId>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>('all')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [detailsClosedFor, setDetailsClosedFor] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [addRequest, setAddRequest] = useState<AddRequest | null>(null)
  const [scanSession, setScanSession] = useState<ScanSession | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const [appUpdate, setAppUpdate] = useState<AppUpdateState | null>(null)
  const [appUpdateDismissed, setAppUpdateDismissed] = useState(false)
  const dragDepth = useRef(0)
  const dragOrigin = useRef<DragOriginState>(IDLE_DRAG_ORIGIN)
  const addSequence = useRef(0)
  const openedExtensionScans = useRef<Set<string>>(new Set())

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
      if (!cancelled && result.ok) applyRendererTheme(result.value.theme)
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
      setScanSession((current) => mergeScanSession(current, session))
      if (session.origin !== 'extension') return
      if (openedExtensionScans.current.has(session.sessionId)) return
      openedExtensionScans.current.add(session.sessionId)
      // The extension explicitly asked the desktop to show this scan. Focus is
      // handled in the main process; this opens the matching view once.
      setAddRequest({
        tab: 'scan',
        url: '',
        nonce: ++addSequence.current,
        scanSessionId: session.sessionId
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
      setCategory('all')
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
  const categoryCounts = useMemo(() => buildCategoryCounts(allRows), [allRows])
  const statusCounts = useMemo(
    () => buildStatusCounts(allRows, category, query),
    [allRows, category, query]
  )
  const filteredRows = useMemo(
    () => filterRows(allRows, { category, status: statusFilter, query }),
    [allRows, category, statusFilter, query]
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
  }, [page, category, statusFilter, query, sortKey, sortDirection])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!focusedKey) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.closest('[role="grid"]')) {
      return
    }
    const target = document.querySelector<HTMLElement>(
      `[data-row-key="${focusedKey}"]`
    )
    if (target && target !== active) target.focus()
  }, [focusedKey])

  const showDetails =
    singleSelected !== null && detailsClosedFor !== singleSelected.key

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

  const openAddDialog = useCallback((tab: AddDialogTab, url = ''): void => {
    setAddRequest({ tab, url, nonce: ++addSequence.current })
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

  const requestRemove = useCallback(
    (rows: readonly UnifiedRow[]): void => {
      if (rows.length === 0) return
      const plan = planRowAction('remove', rows)
      if (rows.length > 1) {
        const copy = removeConfirmation(rows.length)
        setConfirm({
          ...copy,
          onConfirm: () => {
            void runPlan(plan)
          }
        })
      } else {
        void runPlan(plan)
      }
    },
    [runPlan]
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

  const clearCompleted = useCallback((): void => {
    const plan = planBulkAction('clear-completed', allRows)
    if (plan.length === 0) return
    setConfirm({
      ...clearCompletedConfirmation(plan.length),
      onConfirm: () => {
        void runPlan(plan)
      }
    })
  }, [allRows, runPlan])

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
    query.trim().length > 0 || category !== 'all' || statusFilter !== 'all'
  const completedCount = allRows.filter(
    (row) => row.statusGroup === 'completed'
  ).length
  const activeDownloadCount = runningCount(allRows)
  const aggregateSpeed = totalSpeed(allRows)
  const menuActions = menu ? buildContextActions(menu.rows) : []

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
        <div className="window-app-header-content relative z-10 flex h-14 items-center gap-3 px-4">
          <img
            src={appLogo}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-9 w-9 shrink-0 rounded-[10px] border border-white/10"
          />
          <div className="min-w-0 select-none">
            <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-50">
              DonDownload
            </h1>
            <p className="truncate text-[11px] text-zinc-500">
              Downloads &amp; media
            </p>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div
              role="status"
              title={runtimeLabel(aria2)}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[11px] text-zinc-400"
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  isReady
                    ? 'bg-emerald-400'
                    : aria2?.status === 'starting' || !aria2
                      ? 'animate-pulse bg-amber-400'
                      : 'bg-red-400'
                }`}
              />
              <span className="hidden sm:inline">{runtimeLabel(aria2)}</span>
              <span className="sm:hidden">
                {isReady ? 'Ready' : aria2 ? 'Offline' : 'Connecting'}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar
          page={page}
          category={category}
          status={statusFilter}
          categoryCounts={categoryCounts}
          statusCounts={statusCounts}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onSelectCategory={(next) => {
            setPage('library')
            setCategory(next)
          }}
          onSelectStatus={(next) => {
            setPage('library')
            setStatusFilter(next)
          }}
          onSelectPage={(next) => setPage(next)}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-0 pt-3 sm:px-4">
          {banner ? (
            <ErrorBanner banner={banner} onDismiss={() => setBanner(null)} />
          ) : null}

          {appUpdate?.status === 'ready' &&
          appUpdate.canInstall &&
          !appUpdateDismissed ? (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-[11px] text-emerald-100"
            >
              <span className="min-w-0 flex-1">
                DonDownload {appUpdate.latestVersion ?? 'update'} is ready to
                install.
              </span>
              <button
                type="button"
                onClick={() => void installAppUpdate()}
                className="h-7 rounded-md bg-emerald-400 px-2.5 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-300"
              >
                Restart and install
              </button>
              <button
                type="button"
                onClick={() => setAppUpdateDismissed(true)}
                className="h-7 rounded-md border border-emerald-300/20 px-2 text-[11px] text-emerald-200/80 transition hover:bg-emerald-300/10"
              >
                Not now
              </button>
            </div>
          ) : null}

          {page === 'library' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <Toolbar
                query={query}
                onQueryChange={setQuery}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSortKeyChange={setSortKey}
                onToggleSortDirection={() =>
                  setSortDirection((direction) =>
                    direction === 'asc' ? 'desc' : 'asc'
                  )
                }
                runningCount={activeDownloadCount}
                speedBps={aggregateSpeed}
                completedCount={completedCount}
                canPauseAll={allRows.some(canPauseRow)}
                canResumeAll={allRows.some(canResumeRow)}
                onAdd={() => openAddDialog('direct')}
                onPauseAll={pauseAll}
                onResumeAll={resumeAll}
                onClearCompleted={clearCompleted}
              />

              {visibleSelection.length > 1 ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-2.5 py-1.5">
                  <span className="mr-1 text-[11px] font-medium text-emerald-200">
                    {visibleSelection.length} selected
                  </span>
                  <BulkButton
                    label="Pause"
                    disabled={!visibleSelection.some(canPauseRow)}
                    onClick={() =>
                      void runPlan(planRowAction('pause', visibleSelection))
                    }
                  />
                  <BulkButton
                    label="Resume"
                    disabled={!visibleSelection.some(canResumeRow)}
                    onClick={() =>
                      void runPlan(planRowAction('resume', visibleSelection))
                    }
                  />
                  <BulkButton
                    label="Retry"
                    disabled={!visibleSelection.some(canRetryRow)}
                    onClick={() =>
                      void runPlan(planRowAction('retry', visibleSelection))
                    }
                  />
                  <BulkButton
                    label="Remove"
                    danger
                    disabled={false}
                    onClick={() => requestRemove(visibleSelection)}
                  />
                  <button
                    type="button"
                    onClick={() => setSelection(EMPTY_SELECTION)}
                    className="ml-auto text-[11px] text-emerald-200/70 transition hover:text-emerald-100"
                  >
                    Clear selection
                  </button>
                </div>
              ) : null}

              {aria2 && !isReady ? (
                <div className="pb-3">
                  <RuntimeNotice
                    aria2={aria2}
                    restarting={restarting}
                    onRetry={() => {
                      void handleRestart()
                    }}
                  />
                </div>
              ) : null}

              <DownloadTable
                rows={visibleRows}
                selection={selection}
                focusedKey={focusedKey}
                sortKey={sortKey}
                sortDirection={sortDirection}
                emptyState={
                  <LibraryEmptyState
                    filtersActive={filtersActive}
                    onAdd={() => openAddDialog('direct')}
                    onClearFilters={() => {
                      setQuery('')
                      setCategory('all')
                      setStatusFilter('all')
                    }}
                  />
                }
                onSort={(key) => {
                  if (key === sortKey) {
                    setSortDirection((direction) =>
                      direction === 'asc' ? 'desc' : 'asc'
                    )
                  } else {
                    setSortKey(key)
                    setSortDirection(key === 'name' ? 'asc' : 'desc')
                  }
                }}
                onRowClick={handleRowClick}
                onToggleRow={handleToggleRow}
                onSelectAll={handleSelectAll}
                onFocusRow={(row) => setFocusedKey(row.key)}
                onOpenRow={openRow}
                onContextMenu={handleContextMenu}
                onKeyDown={handleTableKeyDown}
              />

              {showDetails && singleSelected ? (
                <DetailsPane
                  row={singleSelected}
                  onClose={() => setDetailsClosedFor(singleSelected.key)}
                  onOpen={openRow}
                  onShowInFolder={showRowInFolder}
                />
              ) : null}

              <div className="flex shrink-0 items-center justify-between gap-3 px-1 py-2 text-[11px] text-zinc-600">
                <span className="truncate">
                  Double-click to open · Right-click for actions · Ctrl/Shift-click
                  to select
                </span>
                <span className="hidden shrink-0 sm:inline">
                  {formatSpeed(aggregateSpeed)} total · history only, files stay on
                  disk
                </span>
              </div>
            </div>
          ) : null}

          {page === 'batches' ? (
            <div className="min-h-0 flex-1 overflow-y-auto pb-8">
              <div className="mx-auto w-full max-w-3xl">
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
                <BatchSection />
              </div>
            </div>
          ) : null}

          {page === 'settings' ? (
            <div className="min-h-0 flex-1 overflow-y-auto pb-8">
              <div className="mx-auto w-full max-w-3xl">
                <SettingsSection />
                <BrowserExtensionSection />
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {addRequest ? (
        <AddDialog
          key={addRequest.nonce}
          tab={addRequest.tab}
          initialUrl={addRequest.url}
          scanSession={
            addRequest.scanSessionId !== undefined &&
            scanSession?.sessionId === addRequest.scanSessionId
              ? scanSession
              : null
          }
          busy={adding}
          onTabChange={(tab) =>
            setAddRequest((current) => (current ? { ...current, tab } : current))
          }
          onClose={() => setAddRequest(null)}
          onAdd={handleAdd}
          onAnalyze={handleAnalyzeMedia}
          onQueue={handleQueueMedia}
        />
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

      {dragActive ? (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-emerald-400/70 bg-emerald-400/[0.08] backdrop-blur-[1px]">
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-center">
            <p className="text-sm font-semibold text-emerald-200">
              Drop a link to add
            </p>
            <p className="mt-0.5 text-[11px] text-emerald-200/70">
              Media page URLs open the analyzer. Other links open Quick Add.
            </p>
          </div>
        </div>
      ) : null}

      {clipboardUrl ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-[70] w-[min(92vw,520px)] -translate-x-1/2 rounded-xl border border-white/10 bg-[var(--surface-card)] px-3 py-2 text-[11px] text-zinc-200 shadow-xl shadow-black/50"
        >
          <p className="truncate" title={clipboardUrl}>
            <span className="font-medium text-zinc-100">Link on clipboard</span>
            <span className="ml-2 text-zinc-400">{clipboardUrl}</span>
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setClipboardUrl(null)}
              className="h-7 rounded-md border border-white/10 px-2 text-[11px] text-zinc-300 transition hover:bg-white/5"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                const route = routeDroppedUrl(clipboardUrl)
                setClipboardUrl(null)
                if (route) openAddDialog(route.target, route.url)
              }}
              className="h-7 rounded-md bg-emerald-400 px-2.5 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-300"
            >
              Download
            </button>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className={`fixed left-1/2 z-[70] -translate-x-1/2 rounded-full border border-white/10 bg-[var(--surface-card)] px-3 py-1.5 text-[11px] text-zinc-200 shadow-xl shadow-black/50 ${
            clipboardUrl ? 'bottom-28' : 'bottom-4'
          }`}
        >
          {toast}
        </div>
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

function BulkButton({
  label,
  disabled,
  danger = false,
  onClick
}: {
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
      className={`h-7 rounded-md border px-2 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-35 ${
        danger
          ? 'border-red-400/25 text-red-300 hover:bg-red-400/10'
          : 'border-white/10 text-zinc-300 hover:bg-white/5 hover:text-zinc-100'
      }`}
    >
      {label}
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
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center px-6 py-10 text-center">
      <div
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-zinc-500"
      >
        <Icon name={filtersActive ? 'search' : 'download'} size={22} />
      </div>
      <p className="mt-3 text-sm font-medium text-zinc-300">
        {filtersActive ? 'No matching downloads' : 'No downloads yet'}
      </p>
      <p className="mt-1 max-w-sm text-xs leading-5 text-zinc-500">
        {filtersActive
          ? 'Try a different search, category or status filter.'
          : 'Add a direct HTTP(S) link or analyze a media page to get started. You can also drop a link anywhere on this window.'}
      </p>
      <div className="mt-4 flex items-center gap-2">
        {filtersActive ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="h-8 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5"
          >
            Clear filters
          </button>
        ) : null}
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-400 px-3 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-300"
        >
          <Icon name="plus" size={13} strokeWidth={2.2} />
          Add download
        </button>
      </div>
    </div>
  )
}
