import {
  useEffect,
  useState,
  type FormEvent,
  type JSX
} from 'react'
import type { ApiResult, AppErrorInfo } from '@shared/types'
import {
  normalizeMediaSourceUrl,
  type MediaAnalysis,
  type MediaFormatOption
} from '@shared/media'
import { formatBytes } from '@shared/format'

interface MediaAnalyzerProps {
  analysis: MediaAnalysis | null
  analyzing: boolean
  disabled: boolean
  queuingOptionId: string | null
  error: AppErrorInfo | null
  notice: string | null
  now: number
  onAnalyze: (url: string) => Promise<ApiResult<MediaAnalysis>>
  onQueue: (optionId: string) => void
  onClear: () => void
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
  onClear
}: MediaAnalyzerProps): JSX.Element {
  const [url, setUrl] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)

  const videoOptions = analysis
    ? analysis.options.filter(
        (option) => option.kind === 'video' && option.hasAudio
      )
    : []
  const audioOptions = analysis
    ? analysis.options.filter((option) => option.kind === 'audio')
    : []

  const bestVideo = analysis
    ? (analysis.options.find(
        (option) =>
          option.optionId === analysis.bestVideoOptionId &&
          option.kind === 'video' &&
          option.hasAudio
      ) ?? null)
    : null
  const bestAudio = analysis
    ? (analysis.options.find(
        (option) =>
          option.optionId === analysis.bestAudioOptionId &&
          option.kind === 'audio'
      ) ?? null)
    : null

  const defaultOptionId =
    bestVideo?.optionId ??
    bestAudio?.optionId ??
    videoOptions[0]?.optionId ??
    audioOptions[0]?.optionId ??
    null
  const analysisId = analysis?.analysisId ?? null

  useEffect(() => {
    setSelectedOptionId(defaultOptionId)
  }, [analysisId])

  const expired = analysis !== null && now >= analysis.expiresAt
  const remainingMs = analysis ? Math.max(0, analysis.expiresAt - now) : 0
  const selectedOption =
    analysis?.options.find((option) => option.optionId === selectedOptionId) ??
    null
  const busy = analyzing || queuingOptionId !== null
  const controlsDisabled = disabled || expired

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault()
    setLocalError(null)

    let normalizedUrl: string
    try {
      normalizedUrl = normalizeMediaSourceUrl(url)
    } catch (submitError) {
      setLocalError(
        submitError instanceof Error
          ? submitError.message
          : 'Enter a valid media page URL.'
      )
      return
    }

    const result = await onAnalyze(normalizedUrl)
    if (result.ok) {
      setUrl('')
    }
  }

  function optionRow(option: MediaFormatOption): JSX.Element {
    const checked = option.optionId === selectedOptionId
    const isBestVideo = option.optionId === bestVideo?.optionId
    const isBestAudio = option.optionId === bestAudio?.optionId

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
          name="media-option"
          value={option.optionId}
          checked={checked}
          disabled={controlsDisabled || busy}
          onChange={() => setSelectedOptionId(option.optionId)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-400"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-medium text-zinc-200">
              {option.label}
            </span>
            {isBestVideo || isBestAudio ? (
              <span className="shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                {isBestVideo ? 'Best' : 'Best audio'}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[11px] leading-5 text-zinc-500">
            {describeOption(option)}
          </span>
        </span>
      </label>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="rounded-2xl border border-white/10 bg-[#070707] p-3 sm:p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="media-url"
          className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400"
        >
          Analyze media page
        </label>
        <span className="shrink-0 text-[10px] text-zinc-600">
          Video and audio
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="media-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setLocalError(null)
          }}
          placeholder="https://example.com/watch?v=..."
          disabled={disabled || analyzing}
          aria-describedby={
            localError ? 'media-url-help media-url-error' : 'media-url-help'
          }
          aria-invalid={localError !== null}
          className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-black px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || busy || url.trim().length === 0}
          className="h-11 shrink-0 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {analyzing ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
      <p
        id="media-url-help"
        className="mt-2 px-1 text-[11px] leading-5 text-zinc-600"
      >
        Analyzes the page first. Nothing downloads until you pick an option.
      </p>

      {localError ? (
        <p
          id="media-url-error"
          role="alert"
          className="mt-2 px-1 text-[11px] leading-5 text-red-400"
        >
          {localError}
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-red-400/25 bg-red-400/5 px-3 py-2 text-[11px] leading-5 text-red-200"
        >
          <p>{error.message}</p>
          {error.hint ? (
            <p className="mt-1 break-words text-[11px] text-red-300/70">
              {error.hint}
            </p>
          ) : null}
        </div>
      ) : null}

      {analysis ? (
        <div className="mt-4 rounded-xl border border-white/10 bg-black/40 p-3 sm:p-4">
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
              <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                {analysis.durationSeconds !== null
                  ? `${formatDuration(analysis.durationSeconds)} · `
                  : ''}
                {expired
                  ? 'Analysis expired — analyze the page again to download.'
                  : `Analysis expires in ${formatRemaining(remainingMs)}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setLocalError(null)
                onClear()
              }}
              disabled={busy}
              className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>
          </div>

          {bestVideo ? (
            <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3">
              <button
                type="button"
                onClick={() => onQueue(bestVideo.optionId)}
                disabled={controlsDisabled || busy}
                className="h-9 w-full rounded-lg bg-emerald-400 px-4 text-xs font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400 sm:w-auto"
              >
                {queuingOptionId === bestVideo.optionId
                  ? 'Queueing…'
                  : 'Download best quality'}
              </button>
              <p className="mt-2 text-[11px] leading-5 text-zinc-400">
                {bestVideo.label}
                <span className="text-zinc-600">
                  {' '}
                  · includes audio
                  {bestVideo.requiresMerge ? ' · merges video + audio' : ''}
                  {bestVideo.filesizeBytes !== null
                    ? ` · ${formatBytes(bestVideo.filesizeBytes)}`
                    : ''}
                </span>
              </p>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] leading-5 text-amber-200">
              {audioOptions.length > 0
                ? 'No video with audio is available for this page. Choose an audio-only option below.'
                : 'No downloadable option with audio is available for this page.'}
            </p>
          )}

          {videoOptions.length > 0 ? (
            <fieldset className="mt-4">
              <legend className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                Video quality
              </legend>
              <div className="mt-2 space-y-1.5">
                {videoOptions.map(optionRow)}
              </div>
            </fieldset>
          ) : null}

          {audioOptions.length > 0 ? (
            <fieldset className="mt-4">
              <legend className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                Audio only
              </legend>
              <div className="mt-2 space-y-1.5">
                {audioOptions.map(optionRow)}
              </div>
            </fieldset>
          ) : null}

          {selectedOption ? (
            <div className="mt-4 flex flex-col gap-2 border-t border-white/5 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 text-[11px] leading-5 text-zinc-500">
                Selected:{' '}
                <span className="text-zinc-300">{selectedOption.label}</span>
              </p>
              <button
                type="button"
                onClick={() => onQueue(selectedOption.optionId)}
                disabled={controlsDisabled || busy}
                className="h-9 shrink-0 rounded-lg border border-emerald-400/30 px-4 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/10 disabled:cursor-not-allowed disabled:opacity-40"
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
    </form>
  )
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
  const codec = option.videoCodec ?? option.audioCodec
  if (codec) {
    parts.push(codec)
  }
  if (option.requiresMerge) {
    parts.push('merges video + audio')
  }
  if (option.filesizeBytes !== null) {
    parts.push(formatBytes(option.filesizeBytes))
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
