import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { ApiResult, AppErrorInfo } from '@shared/types'
import type {
  MediaAnalysis,
  MediaOutputFormat,
  MediaSnapshot,
  MediaToolState
} from '@shared/media'
import { MediaAnalyzer } from './MediaAnalyzer'
import { MediaJobCard } from './MediaJobCard'

const SNAPSHOT_REFRESH_MS = 5_000

export function MediaSection(): JSX.Element {
  const [snapshot, setSnapshot] = useState<MediaSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<AppErrorInfo | null>(null)
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null)
  const [analysisError, setAnalysisError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [queuingOptionId, setQueuingOptionId] = useState<string | null>(null)
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const analysisRequestRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    const refresh = async (): Promise<void> => {
      try {
        const result = await window.donDownload.getMediaSnapshot()
        if (cancelled) return
        if (result.ok) {
          setSnapshot(result.value)
          setSnapshotError(null)
        } else {
          setSnapshotError(result.error)
        }
      } catch (error) {
        if (!cancelled) setSnapshotError(rejectedToError(error))
      }
    }

    void refresh()
    const unsubscribe = window.donDownload.onMediaSnapshotChanged((next) => {
      if (!cancelled) {
        setSnapshot(next)
        setSnapshotError(null)
      }
    })
    const timer = window.setInterval(() => {
      void refresh()
    }, SNAPSHOT_REFRESH_MS)

    return () => {
      cancelled = true
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!analysis) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [analysis])

  const handleAnalyze = useCallback(
    async (url: string): Promise<ApiResult<MediaAnalysis>> => {
      const request = ++analysisRequestRef.current
      setAnalyzing(true)
      setAnalysis(null)
      setAnalysisError(null)
      setNotice(null)

      try {
        const result = await window.donDownload.analyzeMedia({ url })
        if (request !== analysisRequestRef.current) return result
        if (result.ok) {
          setAnalysis(result.value)
          setNow(Date.now())
        } else {
          setAnalysisError(result.error)
        }
        return result
      } catch (error) {
        const info = rejectedToError(error)
        if (request === analysisRequestRef.current) {
          setAnalysisError(info)
        }
        return { ok: false, error: info }
      } finally {
        if (request === analysisRequestRef.current) setAnalyzing(false)
      }
    },
    []
  )

  const handleUrlChange = useCallback((): void => {
    // A changed URL invalidates any request already in flight, even before the
    // debounce for the new URL fires.
    analysisRequestRef.current += 1
    setAnalyzing(false)
  }, [])

  const handleQueue = useCallback(
    async (
      optionId: string,
      maxBytes: number | null,
      outputFormat: MediaOutputFormat
    ): Promise<void> => {
      if (!analysis || queuingOptionId !== null) return

      setQueuingOptionId(optionId)
      setAnalysisError(null)
      setNotice(null)

      try {
        const result = await window.donDownload.queueMedia({
          analysisId: analysis.analysisId,
          optionId,
          outputFormat,
          ...(maxBytes === null ? {} : { maxBytes })
        })
        if (result.ok) {
          setSnapshot(result.value)
          setSnapshotError(null)
          setNotice('Media download queued.')
        } else {
          setAnalysisError(result.error)
        }
      } catch (error) {
        setAnalysisError(rejectedToError(error))
      } finally {
        setQueuingOptionId(null)
      }
    },
    [analysis, queuingOptionId]
  )

  const runJobAction = useCallback(
    async (
      jobId: string,
      action: () => Promise<ApiResult<MediaSnapshot>>
    ): Promise<void> => {
      setPendingJobId(jobId)
      setSnapshotError(null)

      try {
        const result = await action()
        if (result.ok) {
          setSnapshot(result.value)
          setSnapshotError(null)
        } else {
          setSnapshotError(result.error)
        }
      } catch (error) {
        setSnapshotError(rejectedToError(error))
      } finally {
        setPendingJobId(null)
      }
    },
    []
  )

  const handleShowInFolder = useCallback(async (jobId: string): Promise<void> => {
    setPendingJobId(jobId)

    try {
      const result = await window.donDownload.showMediaInFolder(jobId)
      setSnapshotError(result.ok ? null : result.error)
    } catch (error) {
      setSnapshotError(rejectedToError(error))
    } finally {
      setPendingJobId(null)
    }
  }, [])

  const jobs = snapshot?.jobs ?? []
  const tool = snapshot?.tool ?? null
  const toolWarning = tool !== null && tool.status !== 'ready'
  const toolBlocked =
    tool !== null && (tool.status === 'unavailable' || tool.status === 'error')

  return (
    <section aria-labelledby="media-heading">
      <div className="mb-2 flex items-baseline justify-between">
        <h2
          id="media-heading"
          className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
        >
          Media downloads
        </h2>
        {jobs.length > 0 ? (
          <span className="text-[11px] tabular-nums text-zinc-500">
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
          </span>
        ) : null}
      </div>

      {snapshotError ? (
        <div
          role="alert"
          className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/5 px-4 py-3 text-xs leading-5 text-red-200"
        >
          <div className="min-w-0">
            <p>{snapshotError.message}</p>
            {snapshotError.hint ? (
              <p className="mt-1 break-words text-[11px] text-red-300/70">
                {snapshotError.hint}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setSnapshotError(null)}
            className="shrink-0 rounded-lg border border-red-300/20 px-2 py-0.5 text-[11px] text-red-200 transition hover:bg-red-300/10"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {toolWarning && tool ? <MediaToolNotice tool={tool} /> : null}

      <MediaAnalyzer
        analysis={analysis}
        analyzing={analyzing}
        disabled={toolBlocked}
        queuingOptionId={queuingOptionId}
        error={analysisError}
        notice={notice}
        now={now}
        onAnalyze={handleAnalyze}
        onQueue={(optionId, maxBytes, outputFormat) => {
          void handleQueue(optionId, maxBytes, outputFormat)
        }}
        onClear={() => {
          analysisRequestRef.current += 1
          setAnalyzing(false)
          setAnalysis(null)
          setAnalysisError(null)
          setNotice(null)
        }}
        onUrlChange={handleUrlChange}
      />

      {jobs.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-white/10 surface-inset px-6 py-8 text-center">
          <div
            aria-hidden="true"
            className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-base text-zinc-400"
          >
            ▶
          </div>
          <p className="mt-2.5 text-sm font-medium text-zinc-300">
            No media downloads yet
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Analyze a media page above to choose a video or audio download.
          </p>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {jobs.map((job) => (
            <MediaJobCard
              key={job.id}
              job={job}
              busy={pendingJobId === job.id}
              onCancel={() => {
                void runJobAction(job.id, () =>
                  window.donDownload.cancelMedia(job.id)
                )
              }}
              onRemove={() => {
                void runJobAction(job.id, () =>
                  window.donDownload.removeMedia(job.id)
                )
              }}
              onShowInFolder={() => {
                void handleShowInFolder(job.id)
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function MediaToolNotice({ tool }: { tool: MediaToolState }): JSX.Element {
  const tone =
    tool.status === 'error' || tool.status === 'unavailable'
      ? 'border-red-400/25 bg-red-400/5 text-red-200'
      : 'border-amber-400/25 bg-amber-400/5 text-amber-200'

  return (
    <div
      role="status"
      className={`mb-3 rounded-xl border px-4 py-3 text-xs leading-5 ${tone}`}
    >
      <p className="font-medium">{toolStatusLabel(tool)}</p>
      {tool.message ? <p className="mt-1 break-words">{tool.message}</p> : null}
      {tool.hint ? (
        <p className="mt-1 break-words text-[11px] opacity-70">{tool.hint}</p>
      ) : null}
    </div>
  )
}

function toolStatusLabel(tool: MediaToolState): string {
  switch (tool.status) {
    case 'ready':
      return tool.version
        ? `Media engine ready (${tool.version})`
        : 'Media engine ready'
    case 'starting':
      return 'Starting media engine…'
    case 'stopped':
      return 'Media engine stopped'
    case 'unavailable':
      return 'Media engine unavailable'
    case 'error':
      return 'Media engine error'
  }
}

function rejectedToError(error: unknown): AppErrorInfo {
  const message = error instanceof Error ? error.message : ''
  if (/No handler registered/i.test(message)) {
    return {
      code: 'MEDIA_UNAVAILABLE',
      message: 'Media downloads are not available in this build.',
      hint: 'The media service is not connected yet.'
    }
  }

  return {
    code: 'MEDIA_REQUEST_FAILED',
    message: 'The media request could not be completed.',
    hint: 'Try again in a moment.'
  }
}
