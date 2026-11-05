import {
  useEffect,
  useRef,
  useState,
  type JSX
} from 'react'
import type { ApiResult, AppErrorInfo } from '@shared/types'
import {
  MEDIA_OUTPUT_FORMATS,
  type MediaAnalysis,
  type MediaFormatOption,
  type MediaOutputFormat
} from '@shared/media'
import {
  defaultMediaQualityOptionId,
  mediaOptionSize,
  mediaQualityChoices,
  normalizeOutputFormat,
  outputFormatsForOption
} from '@shared/mediaWorkflow'
import { mediaOutputFormatLabel } from '@shared/mediaOutput'
import { MEDIA_SIZE_UNKNOWN, formatMediaSize } from '@shared/format'
import {
  createMediaAutoAnalyzer,
  type MediaAutoAnalyzer
} from '../mediaAutoAnalyze'

interface MediaAnalyzerProps {
  analysis: MediaAnalysis | null
  analyzing: boolean
  disabled: boolean
  queuingOptionId: string | null
  error: AppErrorInfo | null
  notice: string | null
  now: number
  onAnalyze: (url: string) => Promise<ApiResult<MediaAnalysis>>
  onQueue: (
    optionId: string,
    maxBytes: number | null,
    outputFormat: MediaOutputFormat
  ) => void
  onClear: () => void
  onUrlChange?: (rawUrl: string) => void
  /** Prefills and auto-analyzes a URL, used by the Add dialog and drag & drop. */
  initialUrl?: string
}

export function MediaAnalyzer({
  analysis,
  analyzing,
  disabled,
  queuingOptionId,
  error,
  notice,
  now,
  onAnalyze,
  onQueue,
  onClear,
  onUrlChange,
  initialUrl
}: MediaAnalyzerProps): JSX.Element {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [outputFormat, setOutputFormat] = useState<MediaOutputFormat>('auto')
  const [maxMiB, setMaxMiB] = useState('')
  const analyzerRef = useRef<MediaAutoAnalyzer | null>(null)

  const maxBytes =
    maxMiB.trim() === '' ? null : Math.round(Number(maxMiB) * 1024 * 1024)
  const validMaxBytes =
    maxBytes === null ||
    (Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 100 * 1024 ** 3)

  useEffect(() => {
    const analyzer = createMediaAutoAnalyzer({
      analyze: onAnalyze
    })
    analyzerRef.current = analyzer
    if (initialUrl && initialUrl.trim().length > 0) {
      analyzer.update(initialUrl)
    }
    return () => {
      analyzer.cancel()
      analyzerRef.current = null
    }
  }, [onAnalyze, initialUrl])

  const qualityChoices = analysis ? mediaQualityChoices(analysis) : []
  const defaultOptionId = analysis ? defaultMediaQualityOptionId(analysis) : null
  const analysisId = analysis?.analysisId ?? null

  useEffect(() => {
    setSelectedOptionId(defaultOptionId)
    setOutputFormat('auto')
  }, [analysisId, defaultOptionId])

  const expired = analysis !== null && now >= analysis.expiresAt
  const remainingMs = analysis ? Math.max(0, analysis.expiresAt - now) : 0
  const selectedOption =
    analysis?.options.find((option) => option.optionId === selectedOptionId) ??
    null

  useEffect(() => {
    setOutputFormat((current) => normalizeOutputFormat(selectedOption, current))
  }, [selectedOption])

  const availableOutputFormats = outputFormatsForOption(selectedOption)
  const selectedOutputFormat = normalizeOutputFormat(
    selectedOption,
    outputFormat
  )
  const busy = analyzing || queuingOptionId !== null
  const controlsDisabled = disabled || expired
  const typingUrl = url.trim().length > 0

  function optionRow(
    option: MediaFormatOption,
    displayLabel = option.label,
    includeDetails = true,
    radioName = 'media-advanced-option'
  ): JSX.Element {
    const checked = option.optionId === selectedOptionId
    const best = analysis?.bestVideoOptionId === option.optionId
    const bestAudio = analysis?.bestAudioOptionId === option.optionId
    const size = mediaOptionSize(
      option,
      option.optionId === selectedOptionId ? selectedOutputFormat : 'auto'
    )
    const sizeLabel = formatMediaSize(
      size.bytes,
      size.isEstimate
    )

    return (
      <label
        key={option.optionId}
        className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
          checked
            ? 'border-emerald-400/40 bg-emerald-400/[0.06]'
            : 'border-white/10 hover:border-white/20'
        } ${controlsDisabled || busy ? 'cursor-not-allowed opacity-70' : ''}`}
      >
        <input
          type="radio"
          name={radioName}
          value={option.optionId}
          checked={checked}
          disabled={controlsDisabled || busy}
          onChange={() => setSelectedOptionId(option.optionId)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-400"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-medium text-zinc-200">
              {displayLabel}
            </span>
            {best || bestAudio ? (
              <span className="shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                {best ? 'Best' : 'Best audio'}
              </span>
            ) : null}
            <span
              className={`shrink-0 tabular-nums text-[10px] ${
                sizeLabel === MEDIA_SIZE_UNKNOWN ? 'text-zinc-500' : 'text-zinc-400'
              }`}
            >
              {sizeLabel}
            </span>
          </span>
          {includeDetails ? (
            <span className="mt-0.5 block text-[11px] leading-5 text-zinc-400">
              {describeOption(option)}
            </span>
          ) : null}
        </span>
      </label>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 surface-card p-3">
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="media-url"
          className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400"
        >
          Media page URL
        </label>
        <span className="shrink-0 text-[10px] text-zinc-500">
          {analyzing ? 'Analyzing…' : 'Video and audio'}
        </span>
      </div>
      <div className="mt-2">
        <input
          id="media-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            const nextUrl = event.target.value
            onUrlChange?.(nextUrl)
            analyzerRef.current?.update(nextUrl)
            setUrl(nextUrl)
          }}
          placeholder="https://example.com/watch?v=..."
          disabled={disabled}
          aria-busy={analyzing}
          className="h-10 w-full rounded-lg border border-white/10 surface-input px-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
        />
      </div>
      <p className="mt-2 px-1 text-[11px] leading-5 text-zinc-400">
        {analyzing
          ? 'Reading the page metadata… nothing is queued until you choose an option.'
          : typingUrl
            ? 'Analysis starts automatically when the address is complete.'
            : 'Paste a supported media page URL. It is analyzed automatically; a download is queued only when you choose one.'}
      </p>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-red-400/25 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-200"
        >
          <p>{mediaErrorText(error)}</p>
          {error.hint && error.code !== 'MEDIA_DRM_PROTECTED' ? (
            <p className="mt-1 break-words text-[11px] text-red-300/70">
              {error.hint}
            </p>
          ) : null}
        </div>
      ) : null}

      {analysis ? (
        <div className="mt-3 rounded-lg border border-white/10 surface-soft p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                Analyzed media
              </p>
              <h3
                className="mt-1 text-sm font-semibold text-zinc-100"
                title={analysis.title}
              >
                {analysis.title}
              </h3>
              {analysis.thumbnailUrl ? (
                <img
                  src={analysis.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="mt-2 max-h-36 w-full rounded-lg object-cover"
                />
              ) : null}
              <p className="mt-1 text-[11px] leading-5 text-zinc-400">
                {analysis.durationSeconds !== null
                  ? `${formatDuration(analysis.durationSeconds)} · `
                  : ''}
                {expired
                  ? 'Analysis expired – analyze the page again to download.'
                  : `Analysis expires in ${formatRemaining(remainingMs)}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setUrl('')
                onUrlChange?.('')
                analyzerRef.current?.update('')
                onClear()
              }}
              disabled={busy}
              className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>
          </div>

          {qualityChoices.length > 0 ? (
            <fieldset className="mt-4">
              <legend className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                Quality
              </legend>
              <div className="mt-2 space-y-1.5">
                {qualityChoices.map(({ option, label, best }) =>
                  optionRow(
                    option,
                    best
                      ? `Best available · ${label}`
                      : label,
                    false,
                    'media-quality-option'
                  )
                )}
              </div>
            </fieldset>
          ) : (
            <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200">
              No downloadable option with audio is available for this page.
            </p>
          )}

          {selectedOption ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-[10px] font-medium text-zinc-400">
                Output format
                <select
                  value={selectedOutputFormat}
                  onChange={(event) =>
                    setOutputFormat(event.target.value as MediaOutputFormat)
                  }
                  disabled={controlsDisabled || busy}
                  className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2 text-xs text-zinc-100"
                >
                  {MEDIA_OUTPUT_FORMATS.map((format) => (
                    <option
                      key={format}
                      value={format}
                      disabled={!availableOutputFormats.includes(format)}
                    >
                      {mediaOutputFormatLabel(format)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col justify-end">
                <p className="text-[10px] leading-4 text-zinc-500">
                  Only compatible containers are enabled. Auto keeps the
                  source-compatible container; other choices remux or merge
                  without transcoding.
                </p>
              </div>
            </div>
          ) : null}

          <details className="mt-4 border-t border-white/10 pt-3">
            <summary className="cursor-pointer text-[11px] font-medium text-zinc-300 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
              Advanced details
            </summary>
            <fieldset className="mt-3">
              <legend className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                All verified formats ({analysis.options.length})
              </legend>
              <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {analysis.options.map((option) => optionRow(option))}
              </div>
            </fieldset>
            <label className="mt-3 block max-w-xs text-[10px] font-medium text-zinc-400">
              Optional maximum output size per job (MiB)
              <input
                type="number"
                min="0.01"
                max="102400"
                step="0.01"
                value={maxMiB}
                onChange={(event) => setMaxMiB(event.target.value)}
                placeholder="No limit"
                aria-invalid={!validMaxBytes}
                className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2 text-xs text-zinc-100 placeholder:text-zinc-600"
              />
              <span className="mt-1 block font-normal text-zinc-500">
                Unknown and merged sizes are checked during transfer and against
                the final output. A brief network overrun is possible while
                progress catches up.
              </span>
            </label>
            {!validMaxBytes ? (
              <p role="alert" className="mt-1 text-[10px] text-red-300">
                Enter a positive limit up to 102400 MiB.
              </p>
            ) : null}
          </details>

          {selectedOption ? (
            <div className="mt-4 flex flex-col gap-2 border-t border-white/5 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-[11px] leading-5 text-zinc-400">
                Selected:{' '}
                <span className="text-zinc-300">{selectedOption.label}</span>
                <span className="text-zinc-500">
                  {' · '}
                  {mediaOutputFormatLabel(selectedOutputFormat)}
                  {' · '}
                  {formatMediaSize(
                    mediaOptionSize(selectedOption, selectedOutputFormat).bytes,
                    mediaOptionSize(selectedOption, selectedOutputFormat)
                      .isEstimate
                  )}
                </span>
              </p>
              <button
                type="button"
                onClick={() =>
                  onQueue(
                    selectedOption.optionId,
                    maxBytes,
                    selectedOutputFormat
                  )
                }
                disabled={controlsDisabled || busy || !validMaxBytes}
                className="h-9 shrink-0 rounded-lg bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                {queuingOptionId === selectedOption.optionId
                  ? 'Queueing…'
                  : 'Download selected'}
              </button>
            </div>
          ) : null}

          {notice ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[11px] leading-5 text-emerald-200"
            >
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Stable media error codes carry a general message. DRM is a distinct outcome
 * and must not read like a retryable network or extractor failure.
 */
function mediaErrorText(error: AppErrorInfo): string {
  if (error.code === 'MEDIA_DRM_PROTECTED') {
    return "This video is DRM-protected and can't be downloaded."
  }
  return error.message
}

function describeOption(option: MediaFormatOption): string {
  const parts: string[] = []

  if (option.width !== null && option.height !== null) {
    parts.push(`${option.width}×${option.height}`)
  } else if (option.height !== null) {
    parts.push(`${option.height}p`)
  } else if (option.kind === 'audio') {
    parts.push('Audio only')
  }

  parts.push(option.container.toUpperCase())

  if (option.fps !== null) {
    parts.push(`${Math.round(option.fps)} fps`)
  }
  if (option.hdr) parts.push('HDR')
  const codec = option.videoCodec ?? option.audioCodec
  if (codec) {
    parts.push(codec)
  }
  if (option.requiresMerge) {
    parts.push('merges video + audio')
    parts.push('separate streams')
  }
  if (option.formatIds?.length) {
    parts.push(`yt-dlp ${option.formatIds.join('+')}`)
  }

  return parts.join(' · ')
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secs = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function formatRemaining(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1_000))
  if (total >= 3_600) {
    const hours = Math.floor(total / 3_600)
    const minutes = Math.floor((total % 3_600) / 60)
    return `${hours}h ${minutes}m`
  }
  if (total >= 60) {
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${minutes}m ${seconds}s`
  }
  return `${total}s`
}
