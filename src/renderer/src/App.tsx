import { useCallback, useEffect, useState, type JSX } from 'react'
import type {
  AddDownloadInput,
  ApiResult,
  AppErrorInfo,
  AppSnapshot,
  Aria2State,
  DownloadItem,
  DownloadStatus
} from '@shared/types'
import { BatchSection } from './components/BatchSection'
import { DownloadCard } from './components/DownloadCard'
import { MediaSection } from './components/MediaSection'
import { QuickAdd } from './components/QuickAdd'
import { RuntimeNotice } from './components/RuntimeNotice'
import { SettingsSection } from './components/SettingsSection'

type PageId = 'downloads' | 'media' | 'batches' | 'settings'

const PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: 'downloads', label: 'Downloads' },
  { id: 'media', label: 'Media' },
  { id: 'batches', label: 'Batches' },
  { id: 'settings', label: 'Settings' }
]

/**
 * Active work always sorts above finished work so the first screenful is the
 * part of the queue a user can actually act on. Completed items keep their
 * newest-first order at the bottom.
 */
const DOWNLOAD_STATUS_ORDER: Record<DownloadStatus, number> = {
  active: 0,
  waiting: 1,
  queued: 2,
  paused: 3,
  interrupted: 4,
  error: 5,
  complete: 6
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

function runtimeShortLabel(aria2: Aria2State | null): string {
  if (!aria2) return 'Connecting'
  switch (aria2.status) {
    case 'ready':
      return 'Ready'
    case 'starting':
      return 'Starting'
    case 'unavailable':
    case 'error':
    case 'stopped':
      return 'Offline'
  }
}

export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [banner, setBanner] = useState<AppErrorInfo | null>(null)
  const [adding, setAdding] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [page, setPage] = useState<PageId>('downloads')

  useEffect(() => {
    let cancelled = false

    const refresh = async (): Promise<void> => {
      const result = await window.donDownload.getSnapshot()
      if (cancelled) return
      if (result.ok) {
        setSnapshot(result.value)
      } else {
        setBanner(result.error)
      }
    }

    void refresh()
    const unsubscribe = window.donDownload.onSnapshotChanged((next) => {
      if (!cancelled) setSnapshot(next)
    })
    const timer = window.setInterval(() => {
      void refresh()
    }, 5_000)

    return () => {
      cancelled = true
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [page])

  const applyResult = useCallback((result: ApiResult<AppSnapshot>): boolean => {
    if (!result.ok) {
      setBanner(result.error)
      return false
    }
    setBanner(null)
    setSnapshot(result.value)
    return true
  }, [])

  const handleAdd = useCallback(
    async (input: AddDownloadInput): Promise<ApiResult<AppSnapshot>> => {
      setAdding(true)
      try {
        const result = await window.donDownload.addDownload(input)
        applyResult(result)
        return result
      } finally {
        setAdding(false)
      }
    },
    [applyResult]
  )

  const runItemAction = useCallback(
    async (
      id: string,
      action: () => Promise<ApiResult<AppSnapshot>>
    ): Promise<void> => {
      setPendingId(id)
      try {
        applyResult(await action())
      } finally {
        setPendingId(null)
      }
    },
    [applyResult]
  )

  const handleShowInFolder = useCallback(async (id: string): Promise<void> => {
    setPendingId(id)
    try {
      const result = await window.donDownload.showInFolder(id)
      setBanner(result.ok ? null : result.error)
    } finally {
      setPendingId(null)
    }
  }, [])

  const handleRestart = useCallback(async (): Promise<void> => {
    setRestarting(true)
    try {
      applyResult(await window.donDownload.restartAria2())
    } finally {
      setRestarting(false)
    }
  }, [applyResult])

  const downloads = snapshot
    ? [...snapshot.downloads].sort((left, right) => {
        const byStatus =
          DOWNLOAD_STATUS_ORDER[left.status] -
          DOWNLOAD_STATUS_ORDER[right.status]
        return byStatus !== 0 ? byStatus : right.createdAt - left.createdAt
      })
    : []
  const aria2 = snapshot?.aria2 ?? null
  const isReady = aria2?.status === 'ready'
  const activeCount = downloads.filter(
    (item) => item.status === 'active'
  ).length

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <header className="window-app-header border-b border-white/10 bg-black">
        <div aria-hidden="true" className="window-drag-region" />
        <div className="window-app-header-content mx-auto flex w-full max-w-[720px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:flex-none">
            <div
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-400/10 text-base font-semibold text-emerald-300"
            >
              ↓
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight">
                DonDownload
              </h1>
              <p className="truncate text-[11px] text-zinc-400">
                Direct HTTP(S) downloads
              </p>
            </div>
          </div>

          <nav
            aria-label="Sections"
            className="order-last grid w-full grid-cols-4 gap-0.5 rounded-xl border border-white/10 bg-white/[0.02] p-0.5 sm:order-none sm:mx-auto sm:flex sm:w-auto"
          >
            {PAGES.map((entry) => {
              const active = entry.id === page
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setPage(entry.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`min-h-8 rounded-lg px-1.5 py-1.5 text-[11px] font-medium transition sm:px-3 sm:text-xs ${
                    active
                      ? 'bg-emerald-400/10 text-emerald-200 ring-1 ring-inset ring-emerald-400/25'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                  }`}
                >
                  {entry.label}
                </button>
              )
            })}
          </nav>

          <div
            role="status"
            title={runtimeLabel(aria2)}
            className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-400"
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
            <span className="sm:hidden">{runtimeShortLabel(aria2)}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[720px] px-4 pb-10 pt-4 sm:px-5">
        {banner ? (
          <ErrorBanner banner={banner} onDismiss={() => setBanner(null)} />
        ) : null}

        {page === 'downloads' ? (
          <div className="space-y-3">
            <QuickAdd disabled={adding || snapshot === null} onAdd={handleAdd} />

            {aria2 ? (
              <RuntimeNotice
                aria2={aria2}
                restarting={restarting}
                onRetry={() => {
                  void handleRestart()
                }}
              />
            ) : null}

            <section aria-labelledby="downloads-heading">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2
                  id="downloads-heading"
                  className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
                >
                  Downloads
                </h2>
                {downloads.length > 0 ? (
                  <span className="text-[11px] tabular-nums text-zinc-500">
                    {activeCount > 0 ? (
                      <span className="text-emerald-300">
                        {activeCount} active
                      </span>
                    ) : null}
                    {activeCount > 0 ? ' · ' : null}
                    {downloads.length}{' '}
                    {downloads.length === 1 ? 'item' : 'items'}
                  </span>
                ) : null}
              </div>

              {downloads.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="space-y-2">
                  {downloads.map((item: DownloadItem) => (
                    <DownloadCard
                      key={item.id}
                      item={item}
                      busy={pendingId === item.id}
                      onPause={() => {
                        void runItemAction(item.id, () =>
                          window.donDownload.pauseDownload(item.id)
                        )
                      }}
                      onResume={() => {
                        void runItemAction(item.id, () =>
                          window.donDownload.resumeDownload(item.id)
                        )
                      }}
                      onStartNow={() => {
                        void runItemAction(item.id, () =>
                          window.donDownload.startDownloadNow(item.id)
                        )
                      }}
                      onRetry={() => {
                        void runItemAction(item.id, () =>
                          window.donDownload.retryDownload(item.id)
                        )
                      }}
                      onRemove={() => {
                        void runItemAction(item.id, () =>
                          window.donDownload.removeDownload(item.id)
                        )
                      }}
                      onShowInFolder={() => {
                        void handleShowInFolder(item.id)
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {page === 'media' ? <MediaSection /> : null}

        {page === 'batches' ? (
          <div className="space-y-3">
            {aria2 ? (
              <RuntimeNotice
                aria2={aria2}
                restarting={restarting}
                onRetry={() => {
                  void handleRestart()
                }}
              />
            ) : null}
            <BatchSection />
          </div>
        ) : null}

        {page === 'settings' ? <SettingsSection /> : null}

        <footer className="mt-8 border-t border-white/5 pt-3 text-[10px] leading-5 text-zinc-400">
          Files are saved to your Downloads folder under DonDownload. History
          stays on this device until you remove it.
        </footer>
      </main>
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

function EmptyState(): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-[#050505] px-6 py-7 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-base text-zinc-400"
      >
        ↓
      </div>
      <p className="mt-2.5 text-sm font-medium text-zinc-300">
        No downloads yet
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Paste a direct HTTP(S) link above to start.
      </p>
    </div>
  )
}
