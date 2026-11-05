import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX
} from 'react'
import type {
  AddDownloadInput,
  ApiResult,
  AppErrorInfo,
  AppSnapshot
} from '@shared/types'
import {
  type MediaAnalysis,
  type MediaOutputFormat,
  type MediaSnapshot
} from '@shared/media'
import { MediaAnalyzer } from './MediaAnalyzer'
import { QuickAdd } from './QuickAdd'
import { Icon } from './Icon'

export type AddDialogTab = 'direct' | 'media'

export interface AddDialogProps {
  tab: AddDialogTab
  initialUrl: string
  busy?: boolean
  onTabChange: (tab: AddDialogTab) => void
  onClose: () => void
  onAdd: (input: AddDownloadInput) => Promise<
    ApiResult<AppSnapshot>
  >
  onAnalyze: (url: string) => Promise<ApiResult<MediaAnalysis>>
  onQueue: (input: {
    analysisId: string
    optionId: string
    outputFormat: MediaOutputFormat
    maxBytes: number | null
  }) => Promise<ApiResult<MediaSnapshot>>
}

export function AddDialog({
  tab,
  initialUrl,
  busy = false,
  onTabChange,
  onClose,
  onAdd,
  onAnalyze,
  onQueue
}: AddDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [queuingOptionId, setQueuingOptionId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const target = dialogRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button'
    )
    target?.focus()
  }, [tab])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!analysis) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [analysis])

  const handleAnalyze = useCallback(
    async (url: string): Promise<ApiResult<MediaAnalysis>> => {
      const request = ++requestRef.current
      setAnalyzing(true)
      setAnalysis(null)
      setAnalysisError(null)
      setNotice(null)
      try {
        const result = await onAnalyze(url)
        if (request === requestRef.current) {
          if (result.ok) {
            setAnalysis(result.value)
            setNow(Date.now())
          } else {
            setAnalysisError(result.error)
          }
        }
        return result
      } catch (error) {
        const info: AppErrorInfo = {
          code: 'MEDIA_REQUEST_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'The media request could not be completed.'
        }
        if (request === requestRef.current) setAnalysisError(info)
        return { ok: false, error: info }
      } finally {
        if (request === requestRef.current) setAnalyzing(false)
      }
    },
    [onAnalyze]
  )

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
        const result = await onQueue({
          analysisId: analysis.analysisId,
          optionId,
          outputFormat,
          maxBytes
        })
        if (result.ok) setNotice('Media download queued.')
        else setAnalysisError(result.error)
      } catch (error) {
        setAnalysisError({
          code: 'MEDIA_REQUEST_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'The media download could not be queued.'
        })
      } finally {
        setQueuingOptionId(null)
      }
    },
    [analysis, onQueue, queuingOptionId]
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-[8vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-dialog-title"
        className="flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[var(--surface-app)] shadow-2xl shadow-black/70"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="add-dialog-title" className="text-sm font-semibold text-zinc-100">
              Add download
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Direct links and media pages are queued only after you confirm.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Add download dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Download type"
          className="flex gap-1 border-b border-white/[0.07] px-3 py-2"
        >
          <TabButton
            active={tab === 'direct'}
            onClick={() => onTabChange('direct')}
            icon="link"
            label="Direct link"
          />
          <TabButton
            active={tab === 'media'}
            onClick={() => onTabChange('media')}
            icon="video"
            label="Media page"
          />
        </div>

        <div
          role="tabpanel"
          aria-label={tab === 'direct' ? 'Direct link' : 'Media page'}
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          {tab === 'direct' ? (
            <QuickAdd
              key={`direct:${initialUrl}`}
              disabled={busy}
              initialUrl={initialUrl}
              onAdd={async (input) => {
                const result = await onAdd(input)
                if (result.ok) onClose()
                return result
              }}
            />
          ) : (
            <MediaAnalyzer
              key={`media:${initialUrl}`}
              analysis={analysis}
              analyzing={analyzing}
              disabled={busy}
              queuingOptionId={queuingOptionId}
              error={analysisError}
              notice={notice}
              now={now}
              initialUrl={initialUrl}
              onAnalyze={handleAnalyze}
              onQueue={(optionId, maxBytes, outputFormat) => {
                void handleQueue(optionId, maxBytes, outputFormat)
              }}
              onClear={() => {
                requestRef.current += 1
                setAnalyzing(false)
                setAnalysis(null)
                setAnalysisError(null)
                setNotice(null)
              }}
              onUrlChange={() => {
                requestRef.current += 1
                setAnalyzing(false)
                setAnalysis(null)
                setAnalysisError(null)
                setNotice(null)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: 'link' | 'video'
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium transition ${
        active
          ? 'bg-emerald-400/10 text-emerald-200 ring-1 ring-inset ring-emerald-400/25'
          : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
      }`}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  )
}
