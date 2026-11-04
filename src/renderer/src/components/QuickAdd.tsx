import { useState, type FormEvent, type JSX } from 'react'
import type { DownloadControls } from '@shared/settings'
import type { AddDownloadInput, ApiResult, AppSnapshot } from '@shared/types'
import { normalizeHttpUrl, sanitizeFilename } from '@shared/validation'

interface QuickAddProps {
  disabled: boolean
  onAdd: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
}

const MAX_SPEED_MIB = 1024

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
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_SPEED_MIB
    ) {
      throw new Error(`Speed limit must be between 0.01 and ${MAX_SPEED_MIB} MiB/s.`)
    }
    speedLimitBps = Math.max(1, Math.round(value * 1024 * 1024))
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

export function QuickAdd({ disabled, onAdd }: QuickAddProps): JSX.Element {
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [startAt, setStartAt] = useState('')
  const [speedMib, setSpeedMib] = useState('')
  const [connections, setConnections] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [duplicateInput, setDuplicateInput] = useState<AddDownloadInput | null>(
    null
  )

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
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="rounded-2xl border border-white/10 bg-[#070707] p-3 sm:p-4"
    >
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
          className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-black px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
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
          className="h-11 min-w-0 rounded-xl border border-white/10 bg-black px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50 sm:w-44 lg:w-52"
        />
        <button
          type="submit"
          disabled={disabled || url.trim().length === 0}
          className="h-11 shrink-0 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {disabled ? 'Adding…' : 'Add download'}
        </button>
      </div>
      <details className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium text-zinc-400">
          Schedule &amp; limits (optional)
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-[11px] text-zinc-500">
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
              className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50 disabled:opacity-50"
            />
          </label>
          <label className="text-[11px] text-zinc-500">
            Speed limit (MiB/s, blank = unlimited)
            <input
              aria-label="Download speed limit in MiB per second"
              type="number"
              min={0.01}
              max={MAX_SPEED_MIB}
              step={0.01}
              placeholder="Unlimited"
              value={speedMib}
              onChange={(event) => {
                setSpeedMib(event.target.value)
                resetDuplicate()
              }}
              disabled={disabled}
              className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50 disabled:opacity-50"
            />
          </label>
          <label className="text-[11px] text-zinc-500">
            Connections (1–16, blank = global)
            <input
              aria-label="Download connections"
              type="number"
              min={1}
              max={16}
              step={1}
              placeholder="Global"
              value={connections}
              onChange={(event) => {
                setConnections(event.target.value)
                resetDuplicate()
              }}
              disabled={disabled}
              className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-xs text-zinc-100 outline-none transition focus:border-emerald-400/50 disabled:opacity-50"
            />
          </label>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-zinc-600">
          The start time uses this computer&apos;s local clock. Allowed hours
          are enforced separately in Download settings.
        </p>
      </details>
      {duplicateInput ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/25 bg-amber-400/5 px-3 py-2">
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
            className="h-8 shrink-0 rounded-lg border border-amber-300/30 px-3 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download again
          </button>
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3 px-1 pt-2">
        <p className="text-[11px] leading-5 text-zinc-600">
          Direct HTTP(S) links. Saved to Downloads\DonDownload.
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
