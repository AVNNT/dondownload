import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type {
  AddDownloadInput,
  ApiResult,
  AppErrorInfo,
  AppSnapshot
} from '@shared/types'
import { formatBytes } from '@shared/format'
import {
  type MediaAnalysis,
  type MediaOutputFormat,
  type MediaSnapshot
} from '@shared/media'
import { MediaAnalyzer } from './MediaAnalyzer'
import { QuickAdd } from './QuickAdd'
import { BatchSubmit } from './BatchSubmit'
import { Icon } from './Icon'
import { useWheelScrollLock } from '../lib/useWheelScrollLock'
import {
  filenameFromUrl,
  parseAddInput,
  type AddLinkKind,
  type ParsedAddLink
} from '../lib/addParse'

export type AddDialogTab = 'direct' | 'media' | 'scan'

export interface AddDialogProps {
  /** Opening hint: 'media' seeds the qualities view; 'scan' noop, files seed text. */
  tab: AddDialogTab
  initialUrl: string
  busy?: boolean
  /** Short human summary of an already-queued item, e.g. "paused at 64%". */
  describeDuplicate?: (url: string) => string | null
  /** Resumes the already-queued item instead of forcing a second copy. */
  onResumeDuplicate?: (url: string) => void
  /** Global connection count shown on the Options stepper while "Default". */
  defaultConnections?: number
  /** Opens the scan side sheet for one pasted page link. */
  onScanOpen: (url: string) => void
  onClose: () => void
  onAdd: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
  onAnalyze: (url: string) => Promise<ApiResult<MediaAnalysis>>
  onQueue: (input: {
    analysisId: string
    optionId: string
    outputFormat: MediaOutputFormat
    maxBytes: number | null
  }) => Promise<ApiResult<MediaSnapshot>>
}

const TAG_CLASS: Record<AddLinkKind, string> = {
  file: 'bg-zinc-800/80 text-zinc-400',
  media: 'bg-accent-400/10 text-accent-300',
  page: 'bg-accent-400/10 text-accent-300'
}

const TAG_LABEL: Record<AddLinkKind, string> = {
  file: 'File',
  media: 'Video',
  page: 'Page'
}

/**
 * One link field with type detection, per the redesign: a direct file link
 * shows the file form, a media page leads to the quality analyzer, a pasted
 * page link offers the scan sheet, and several links submit as one batch
 * (playlists and lists included — their preview comes back unchanged).
 * Detection is only a default; ambiguous links keep an explicit path to every
 * other flow.
 */
export function AddDialog({
  tab,
  initialUrl,
  busy = false,
  describeDuplicate,
  onResumeDuplicate,
  defaultConnections = 8,
  onScanOpen,
  onClose,
  onAdd,
  onAnalyze,
  onQueue
}: AddDialogProps): JSX.Element {
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)
  const quickSubmitRef = useRef<(() => void) | null>(null)
  const [text, setText] = useState(initialUrl)
  const [forcedFile, setForcedFile] = useState(false)
  const [mediaSeed, setMediaSeed] = useState<string | null>(
    tab === 'media' && initialUrl.trim().length > 0 ? initialUrl : null
  )
  const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [queuingOptionId, setQueuingOptionId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const registerQuickSubmit = useCallback(
    (submit: (() => void) | null): void => {
      quickSubmitRef.current = submit
    },
    []
  )

  useWheelScrollLock(backdropRef)

  useEffect(() => {
    // Focus the link textarea, not the close (X) button that precedes it.
    const target =
      dialogRef.current?.querySelector<HTMLTextAreaElement>('textarea')
    target?.focus()
  }, [])

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

  const parsed = useMemo(() => parseAddInput(text), [text])
  const batchMode = parsed.links.length > 1
  const single = parsed.links.length === 1 ? (parsed.links[0] ?? null) : null
  const mediaMode = mediaSeed !== null && !batchMode
  const pageMode =
    !batchMode &&
    !mediaMode &&
    !forcedFile &&
    single !== null &&
    single.kind === 'page'
  const fileMode = single?.kind === 'file' || forcedFile
  const fileSize = useProbedFileSize(
    !batchMode && !mediaMode && fileMode && single !== null ? single.url : null
  )

  const handleTextChange = useCallback((value: string): void => {
    setText(value)
    setForcedFile(false)
  }, [])

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

  const clearAnalysis = useCallback((): void => {
    requestRef.current += 1
    setAnalyzing(false)
    setAnalysis(null)
    setAnalysisError(null)
    setNotice(null)
  }, [])

  let body: JSX.Element
  if (mediaMode && mediaSeed !== null) {
    body = (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 px-0.5">
          <p className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title={mediaSeed}>
            {mediaSeed}
          </p>
          <button
            type="button"
            onClick={() => {
              clearAnalysis()
              setMediaSeed(null)
            }}
            className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          >
            Change input
          </button>
        </div>
        <MediaAnalyzer
          key={mediaSeed}
          analysis={analysis}
          analyzing={analyzing}
          disabled={busy}
          queuingOptionId={queuingOptionId}
          error={analysisError}
          notice={notice}
          now={now}
          initialUrl={mediaSeed}
          onAnalyze={handleAnalyze}
          onQueue={(optionId, maxBytes, outputFormat) => {
            void handleQueue(optionId, maxBytes, outputFormat)
          }}
          onClear={clearAnalysis}
          onUrlChange={() => {
            clearAnalysis()
          }}
        />
      </div>
    )
  } else if (batchMode) {
    body = (
      <div className="flex flex-col gap-2.5">
        <InvalidLines invalid={parsed.invalid} />
        {/* Remount on membership change so outcome rows never mix inputs. */}
        <BatchSubmit
          key={parsed.links.map((link) => link.url).join('\n')}
          urls={parsed.links.map((link) => link.url)}
          disabled={busy}
        />
      </div>
    )
  } else if (single !== null && fileMode) {
    const sizeLabel = fileSize.probing
      ? '…'
      : fileSize.size !== null
        ? formatBytes(fileSize.size)
        : null
    body = (
      <div className="flex flex-col gap-2.5">
        <LinkRow
          link={{ ...single, kind: 'file' }}
          subtitle={[hostOf(single.url), sizeLabel]
            .filter((part) => part !== null)
            .join(' · ')}
        />
        <QuickAdd
          disabled={busy}
          onAdd={async (input) => {
            const result = await onAdd(input)
            if (result.ok) onClose()
            return result
          }}
          url={single.url}
          onUrlChange={handleTextChange}
          registerSubmit={registerQuickSubmit}
          describeDuplicate={describeDuplicate}
          onResumeDuplicate={onResumeDuplicate}
          defaultConnections={defaultConnections}
        />
      </div>
    )
  } else if (pageMode && single !== null) {
    body = (
      <div className="flex flex-col gap-2.5">
        <LinkRow
          link={single}
          subtitle={`${hostOf(single.url)} · scanned before anything downloads`}
          actions={
            <>
              <button
                type="button"
                onClick={() => onScanOpen(single.url)}
                className="h-7 shrink-0 rounded-md px-2.5 text-[11px] font-semibold text-zinc-200 transition hover:bg-white/5"
              >
                Scan
              </button>
              <button
                type="button"
                onClick={() => setForcedFile(true)}
                className="h-7 shrink-0 rounded-md border border-white/10 px-2.5 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
              >
                Add as file
              </button>
            </>
          }
        />
        <p className="px-1 text-[11px] leading-5 text-zinc-500">
          Not a recognised file or video link? Scan the page for downloadable
          links, or queue the URL as a direct download.
        </p>
      </div>
    )
  } else if (single !== null) {
    // Detected media link, qualities not requested yet (or forced file off).
    body = (
      <div className="flex flex-col gap-2.5">
        <LinkRow
          link={single}
          subtitle={`${hostOf(single.url)} · qualities load before anything downloads`}
          actions={
            <>
              <button
                type="button"
                onClick={() => setMediaSeed(single.url)}
                className="h-7 shrink-0 rounded-md px-2.5 text-[11px] font-semibold text-accent-300 transition hover:bg-accent-400/10"
              >
                Show qualities
              </button>
              <button
                type="button"
                onClick={() => setForcedFile(true)}
                className="h-7 shrink-0 rounded-md border border-white/10 px-2.5 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
              >
                Add as file
              </button>
            </>
          }
        />
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-2.5">
        <InvalidLines invalid={parsed.invalid} />
        <p className="px-1 text-[12px] leading-5 text-zinc-500">
          Paste one or more links. Direct files download after you confirm,
          media pages show their qualities, playlists and lists load a preview
          first, and a page link can be scanned before anything downloads.
        </p>
      </div>
    )
  }

  const footerPrimary = batchMode
    ? null // BatchSubmit owns its explicit submission UI.
    : mediaMode
      ? null // Queueing happens inside the quality analyzer.
      : fileMode
        ? 'Download'
        : pageMode
          ? 'Scan page'
          : single?.kind === 'media'
            ? 'Show qualities'
            : null

  const runFooterPrimary = (): void => {
    if (batchMode || single === null) return
    if (fileMode) {
      quickSubmitRef.current?.()
      return
    }
    if (single.kind === 'page') {
      onScanOpen(single.url)
      return
    }
    setMediaSeed(single.url)
  }

  return (
    <div
      ref={backdropRef}
      className="no-drag fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-[rgb(0_0_0_/_0.55)] p-4 pt-[8vh]"
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
              Add downloads
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Nothing downloads until you confirm it here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Add download dialog"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          {mediaMode ? null : (
            <div className="flex flex-col gap-1.5">
              <label className="sr-only" htmlFor="add-links">
                One or more links, one per line
              </label>
              <textarea
                id="add-links"
                rows={3}
                autoComplete="off"
                spellCheck={false}
                value={text}
                onChange={(event) => handleTextChange(event.target.value)}
                placeholder={
                  'https://example.com/file.zip\nhttps://media.example.com/watch/video\nhttps://example.com/list'
                }
                disabled={busy}
                aria-describedby="add-links-help"
                className="min-h-[76px] w-full resize-y rounded-[10px] border border-accent-500 bg-[var(--surface-app)] px-3 py-2.5 font-mono text-[12.5px] leading-6 text-zinc-100 shadow-[0_0_0_3px] shadow-accent-500/10 placeholder:text-zinc-600 outline-none transition focus:ring-2 focus:ring-accent-400/25 disabled:opacity-50"
              />
              <p id="add-links-help" className="px-1 text-[11px] text-zinc-500">
                One link per line · several lines are handled together as one batch
              </p>
            </div>
          )}

          <div className="mt-2.5">{body}</div>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.07] px-4 py-3">
          <span className="flex items-center gap-1.5 text-[12px] text-zinc-400">
            <Icon name="folder" size={14} />
            Downloads\DonDownload
          </span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg px-3 text-[12px] font-semibold text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
            >
              Cancel
            </button>
            {footerPrimary !== null ? (
              <button
                type="button"
                onClick={runFooterPrimary}
                disabled={busy || single === null}
                className="h-9 rounded-lg bg-accent-500 px-4 text-[12px] font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {footerPrimary}
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  )
}

const PROBE_SIZE_DEBOUNCE_MS = 400

/**
 * Debounced size probe for the single direct-file row. The settled probe is
 * stored keyed by its URL, so results that arrive after the URL (or dialog
 * state) changed are ignored by the request counter; a failed or size-less
 * probe just leaves the size hidden. Whether anything is in flight is
 * derived: anything not yet settled for the current URL still shows "…".
 */
function useProbedFileSize(
  url: string | null
): { size: number | null; probing: boolean } {
  const requestRef = useRef(0)
  const [settled, setSettled] = useState<{
    url: string
    probing: boolean
    size: number | null
  }>({ url: '', probing: false, size: null })

  useEffect(() => {
    if (url === null) return
    const request = ++requestRef.current
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.donDownload.probeUrlSize(url)
          if (requestRef.current === request) {
            setSettled({
              url,
              probing: false,
              size: result.ok ? result.value.size : null
            })
          }
        } catch {
          if (requestRef.current === request) {
            setSettled({ url, probing: false, size: null })
          }
        }
      })()
    }, PROBE_SIZE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [url])

  if (url === null) return { size: null, probing: false }
  if (settled.url !== url) return { size: null, probing: true }
  return { size: settled.size, probing: settled.probing }
}

/** Mock "det" row: type tag, name, host/summary and optional inline actions. */
function LinkRow({
  link,
  subtitle,
  actions
}: {
  link: ParsedAddLink
  subtitle: string
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-white/10 surface-soft px-3 py-2.5">
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TAG_CLASS[link.kind]}`}
      >
        {TAG_LABEL[link.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[12.5px] font-semibold text-zinc-100"
          title={filenameFromUrl(link.url)}
        >
          {filenameFromUrl(link.url)}
        </span>
        <span className="block truncate text-[11px] text-zinc-500" title={link.url}>
          {subtitle}
        </span>
      </span>
      {actions}
    </div>
  )
}

function InvalidLines({ invalid }: { invalid: string[] }): JSX.Element {
  if (invalid.length === 0) return <></>
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200"
    >
      {invalid.map((line) => (
        <p key={line} className="break-words">
          Not a link: {line}
        </p>
      ))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
