import { useEffect, useState, type FormEvent, type JSX } from 'react'
import type { DownloadControls } from '@shared/settings'
import type { AddDownloadInput, ApiResult, AppSnapshot } from '@shared/types'
import { isObviousDirectFileUrl } from '@shared/scanner'
import { normalizeHttpUrl, sanitizeFilename } from '@shared/validation'

interface QuickAddProps {
  disabled: boolean
  onAdd: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
  /** Prefills the URL field, used by the Add dialog and drag & drop. */
  initialUrl?: string
  /** A pasted page URL can open the Scan page tab automatically. */
  onScanSuggested?: (url: string) => void
}

const MAX_SPEED_MIB = 1024
const BYTES_PER_MIB = 1024 * 1024

function parseControls(
  startAt: string,
  speedMib: string,
  connections: string
): DownloadControls | null {
  const hasSchedule = startAt.trim().length > 0
  const hasSpeed = speedMib.trim().length > 0
  const hasConnections = connections.trim().length > 0
  if (!hasSchedule && !hasSpeed && !hasConnections) return null

  let scheduledAt: number | null = null
  if (hasSchedule) {
    scheduledAt = new Date(startAt).getTime()
    if (!Number.isFinite(scheduledAt)) {
      throw new Error('Enter a valid local start date and time.')
    }
  }

  let speedLimitBps: number | null = null
  if (hasSpeed) {
    const value = Number(speedMib)
    if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEED_MIB) {
      throw new Error(`Speed limit must be between 0.01 and ${MAX_SPEED_MIB} MiB/s.`)
    }
    speedLimitBps = Math.max(1, Math.round(value * BYTES_PER_MIB))
  }

  let connectionCount: number | null = null
  if (hasConnections) {
    const value = Number(connections)
    if (!Number.isInteger(value) || value < 1 || value > 16) {
      throw new Error('Connections must be a whole number from 1 to 16.')
    }
    connectionCount = value
  }

  return {
    scheduledAt,
    speedLimitBps,
    connections: connectionCount
  }
}

/** Show the exact byte/sec value the backend receives for the entered MiB/s. */
function speedLimitPreview(speedMib: string): string | null {
  const trimmed = speedMib.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEED_MIB) return null
  return `${Math.max(1, Math.round(value * BYTES_PER_MIB)).toLocaleString()} B/s`
}

export function QuickAdd({ disabled, onAdd, initialUrl, onScanSuggested }: QuickAddProps): JSX.Element {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [filename, setFilename] = useState('')
  const [startAt, setStartAt] = useState('')
  const [speedMib, setSpeedMib] = useState('')
  const [connections, setConnections] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [duplicateInput, setDuplicateInput] = useState<AddDownloadInput | null>(
    null
  )

  const speedPreview = speedLimitPreview(speedMib)

  useEffect(() => {
    if (!onScanSuggested) return
    const raw = url.trim()
    if (raw.length === 0) return
    const timer = window.setTimeout(() => {
      try {
        const normalized = normalizeHttpUrl(raw)
        if (!isObviousDirectFileUrl(normalized)) onScanSuggested(normalized)
      } catch {
        // Incomplete text is not a scan request.
      }
    }, 450)
    return () => window.clearTimeout(timer)
  }, [onScanSuggested, url])

  function resetDuplicate(): void {
    setDuplicateInput(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLocalError(null)
    resetDuplicate()

    let input: AddDownloadInput
    try {
      const normalizedUrl = normalizeHttpUrl(url)
      const trimmedName = filename.trim()
      const controls = parseControls(startAt, speedMib, connections)
      input = {
        url: normalizedUrl,
        ...(trimmedName.length > 0
          ? { filename: sanitizeFilename(trimmedName) }
          : {}),
        ...(controls ? { controls } : {})
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Check the URL.')
      return
    }

    const result = await onAdd(input)
    if (result.ok) {
      setUrl('')
      setFilename('')
      setStartAt('')
      setSpeedMib('')
      setConnections('')
    } else if (result.error.code === 'DUPLICATE_DOWNLOAD') {
      // Keep the entered URL/name and make the intentional repeat explicit.
      setDuplicateInput(input)
    }
  }

  async function handleDownloadAgain(): Promise<void> {
    if (disabled || duplicateInput === null) return
    setLocalError(null)

    const result = await onAdd({ ...duplicateInput, force: true })
    if (result.ok) {
      setUrl('')
      setFilename('')
      setStartAt('')
      setSpeedMib('')
      setConnections('')
      setDuplicateInput(null)
    } else if (result.error.code === 'DUPLICATE_DOWNLOAD') {
      setDuplicateInput(duplicateInput)
    }
  }

  return (
    <form
      aria-labelledby="quick-add-heading"
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="rounded-xl border border-white/10 surface-card p-3"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2
          id="quick-add-heading"
          className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
        >
          Quick add
        </h2>
        <span className="text-[11px] text-zinc-400">Direct HTTP(S) links</span>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="download-url">
          Download URL
        </label>
        <input
          id="download-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            resetDuplicate()
          }}
          placeholder="https://example.com/file.zip"
          disabled={disabled}
          className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 surface-input px-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/60 focus:ring-2 focus:ring-accent-400/15 disabled:opacity-50"
        />
        <label className="sr-only" htmlFor="download-filename">
          Custom file name (optional)
        </label>
        <input
          id="download-filename"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={filename}
          onChange={(event) => {
            setFilename(event.target.value)
            resetDuplicate()
          }}
          placeholder="File name (optional)"
          disabled={disabled}
          className="h-10 min-w-0 rounded-lg border border-white/10 surface-input px-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/60 focus:ring-2 focus:ring-accent-400/15 disabled:opacity-50 sm:w-40 lg:w-48"
        />
        <button
          type="submit"
          disabled={disabled || url.trim().length === 0}
          className="h-10 shrink-0 rounded-lg bg-accent-500 px-4 text-sm font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {disabled ? 'Adding…' : 'Add download'}
        </button>
      </div>

      <details className="mt-2 rounded-lg border border-white/10 surface-soft px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium text-zinc-400 transition hover:text-zinc-200">
          Schedule &amp; limits (optional)
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-[11px] text-zinc-400">
            Start at (local time)
            <input
              aria-label="Scheduled start (local time)"
              type="datetime-local"
              value={startAt}
              onChange={(event) => {
                setStartAt(event.target.value)
                resetDuplicate()
              }}
              disabled={disabled}
              className="mt-1 block w-full min-w-0 rounded-lg border border-white/10 surface-input px-2.5 py-2 text-xs text-zinc-100 outline-none transition focus:border-accent-400/50 disabled:opacity-50"
            />
          </label>
          <label className="text-[11px] text-zinc-400">
            Speed limit (MiB/s)
            <input
              aria-label="Download speed limit in MiB per second"
              aria-describedby="download-speed-help"
              type="number"
              min={0.01}
              max={MAX_SPEED_MIB}
              step="any"
              placeholder="Unlimited"
              value={speedMib}
              onChange={(event) => {
                setSpeedMib(event.target.value)
                resetDuplicate()
              }}
              disabled={disabled}
              className="mt-1 block w-full min-w-0 rounded-lg border border-white/10 surface-input px-2.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/50 disabled:opacity-50"
            />
            <span
              id="download-speed-help"
              className="mt-1 block min-h-4 text-[11px] leading-4 text-zinc-400"
            >
              {speedPreview
                ? `Backend value: ${speedPreview}`
                : 'Blank means unlimited.'}
            </span>
          </label>
          <label className="text-[11px] text-zinc-400">
            Connections (1–16)
            <input
              aria-label="Download connections"
              type="number"
              min={1}
              max={16}
              step={1}
              placeholder="Global default"
              value={connections}
              onChange={(event) => {
                setConnections(event.target.value)
                resetDuplicate()
              }}
              disabled={disabled}
              className="mt-1 block w-full min-w-0 rounded-lg border border-white/10 surface-input px-2.5 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/50 disabled:opacity-50"
            />
            <span className="mt-1 block min-h-4 text-[11px] leading-4 text-zinc-400">
              Blank uses the global setting.
            </span>
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-zinc-500">
          The start time uses this computer&apos;s local clock. Allowed hours
          are enforced separately in Settings.
        </p>
      </details>

      {duplicateInput ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2">
          <p className="text-[11px] leading-5 text-amber-200">
            This URL is already queued or downloading. The entered URL and name
            were kept.
          </p>
          <button
            type="button"
            onClick={() => {
              void handleDownloadAgain()
            }}
            disabled={disabled}
            className="min-h-8 shrink-0 rounded-lg border border-amber-300/30 px-3 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download again
          </button>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3 px-0.5 pt-2">
        <p className="text-[11px] leading-5 text-zinc-400">
          Saved to Downloads\DonDownload.
        </p>
        {localError ? (
          <p role="alert" className="text-right text-[11px] leading-5 text-red-400">
            {localError}
          </p>
        ) : null}
      </div>
    </form>
  )
}
