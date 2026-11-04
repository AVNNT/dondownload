import { useCallback, useEffect, useState, type JSX } from 'react'
import type {
  AddDownloadInput,
  ApiResult,
  AppErrorInfo,
  AppSnapshot,
  Aria2State,
  DownloadItem
} from '@shared/types'
import { BatchSection } from './components/BatchSection'
import { DownloadCard } from './components/DownloadCard'
import { MediaSection } from './components/MediaSection'
import { QuickAdd } from './components/QuickAdd'
import { RuntimeNotice } from './components/RuntimeNotice'

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
  const [banner, setBanner] = useState<AppErrorInfo | null>(null)
  const [adding, setAdding] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

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

  const downloads = snapshot?.downloads ?? []
  const aria2 = snapshot?.aria2 ?? null
  const isReady = aria2?.status === 'ready'

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-black/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[800px] items-center justify-between px-5">
          <div className="flex min-w-0 items-center gap-2.5">
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
              <p className="truncate text-[11px] text-zinc-500">
                Direct HTTP(S) downloads
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-400">
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
            <span className="sm:hidden">{isReady ? 'Ready' : 'Offline'}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[800px] px-5 pb-12 pt-7">
        <QuickAdd disabled={adding || snapshot === null} onAdd={handleAdd} />

        {banner ? (
          <div
            role="alert"
            className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/5 px-4 py-3 text-xs leading-5 text-red-200"
          >
            <div className="min-w-0">
              <p>{banner.message}</p>
              {banner.hint ? (
                <p className="mt-1 break-words text-[11px] text-red-300/70">
                  {banner.hint}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="shrink-0 rounded-lg border border-red-300/20 px-2 py-0.5 text-[11px] text-red-200 transition hover:bg-red-300/10"
            >
              Dismiss
            </button>
          </div>
        ) : null}

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

        <MediaSection />

        <section className="mt-7" aria-labelledby="downloads-heading">
          <div className="mb-3 flex items-baseline justify-between">
            <h2
              id="downloads-heading"
              className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500"
            >
              Downloads
            </h2>
            {downloads.length > 0 ? (
              <span className="text-[11px] tabular-nums text-zinc-600">
                {downloads.length} {downloads.length === 1 ? 'item' : 'items'}
              </span>
            ) : null}
          </div>

          {downloads.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2.5">
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

        <footer className="mt-10 border-t border-white/5 pt-4 text-[10px] leading-5 text-zinc-600">
          Downloads are written to your user Downloads folder under
          DonDownload. History is stored locally and kept until you remove it.
        </footer>
      </main>
    </div>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-[#050505] px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-lg text-zinc-500"
      >
        ↓
      </div>
      <p className="mt-3 text-sm font-medium text-zinc-300">No downloads yet</p>
      <p className="mt-1 text-xs text-zinc-600">
        Paste a direct HTTP(S) link above to start.
      </p>
    </div>
  )
}
