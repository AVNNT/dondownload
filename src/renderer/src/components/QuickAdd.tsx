import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX
} from 'react'
import {
  DEFAULT_PER_HOST_CONNECTIONS,
  type DownloadControls
} from '@shared/settings'
import type { AddDownloadInput, ApiResult, AppSnapshot } from '@shared/types'
import type { DuplicateWarning } from '@shared/duplicates'
import { isObviousDirectFileUrl } from '@shared/scanner'
import { normalizeHttpUrl, sanitizeFilename } from '@shared/validation'
import { filenameFromUrl } from '../lib/addParse'
import { duplicateNotice } from '../lib/duplicateNotice'

interface QuickAddProps {
  disabled: boolean
  onAdd: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
  /** Prefills the URL field, used by the Add dialog and drag & drop. */
  initialUrl?: string
  /** A pasted page URL can open the Scan sheet automatically. */
  onScanSuggested?: (url: string) => void
  /** Resumes the already-queued item instead of forcing a second copy. */
  onResumeDuplicate?: (url: string) => void
  /** Short human summary of an already-queued item, e.g. "paused at 64%". */
  describeDuplicate?: (url: string) => string | null
  /** Reveals an existing row for the active-duplicate notice. */
  onShowDuplicate?: (warning: DuplicateWarning) => void
  /** Global connection count shown on the stepper while it stays "Default". */
  defaultConnections?: number
  /**
   * Controlled URL + hidden field: the Add dialog owns the single link field
   * and renders this component for detected direct downloads only.
   */
  url?: string
  onUrlChange?: (value: string) => void
  /** Lets the dialog footer trigger this component's submit handler. */
  registerSubmit?: (submit: (() => void) | null) => void
  /** Opaque token for a folder chosen in the dialog's "Save to" picker. */
  destinationToken?: string
  /** Human label for the save location shown under the form. */
  savedToLabel?: string
}

const MAX_SPEED_MIB = 1024
const BYTES_PER_MIB = 1024 * 1024
const MIN_CONNECTIONS = 1
const MAX_CONNECTIONS = 16

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
    if (!Number.isInteger(value) || value < MIN_CONNECTIONS || value > MAX_CONNECTIONS) {
      throw new Error(`Connections must be a whole number from ${MIN_CONNECTIONS} to ${MAX_CONNECTIONS}.`)
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

export function QuickAdd({
  disabled,
  onAdd,
  initialUrl,
  onScanSuggested,
  onResumeDuplicate,
  describeDuplicate,
  onShowDuplicate,
  defaultConnections = DEFAULT_PER_HOST_CONNECTIONS,
  url,
  onUrlChange,
  registerSubmit,
  destinationToken,
  savedToLabel
}: QuickAddProps): JSX.Element {
  const controlled = onUrlChange !== undefined
  const [internalUrl, setInternalUrl] = useState(initialUrl ?? '')
  const value = url !== undefined ? url : internalUrl
  const setValue = (next: string): void => {
    if (onUrlChange !== undefined) {
      onUrlChange(next)
    } else {
      setInternalUrl(next)
    }
  }
  const [filename, setFilename] = useState('')
  const [startAt, setStartAt] = useState('')
  const [speedMib, setSpeedMib] = useState('')
  const [connections, setConnections] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [duplicateInput, setDuplicateInput] = useState<AddDownloadInput | null>(
    null
  )
  const [duplicateAnswer, setDuplicateAnswer] = useState<{
    url: string
    warning: DuplicateWarning | null
  } | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)

  const currentUrl = useMemo(() => {
    try {
      return normalizeHttpUrl(value)
    } catch {
      return null
    }
  }, [value])
  const duplicateWarning =
    duplicateAnswer !== null &&
    currentUrl !== null &&
    duplicateAnswer.url === currentUrl
      ? duplicateAnswer.warning
      : null

  const speedPreview = speedLimitPreview(speedMib)

  useEffect(() => {
    // When the field is hidden the Add dialog owns the text and classifies it;
    // only the standalone field keeps the typing-debounce suggestion.
    if (controlled || !onScanSuggested) return
    const raw = value.trim()
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
  }, [controlled, onScanSuggested, value])

  useEffect(() => {
    // Advisory only. Main validates the URL again and returns null when the
    // user switched duplicate warnings off. The debounce keeps typing cheap.
    if (currentUrl === null) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await window.donDownload.checkDuplicate(currentUrl)
          if (cancelled) return
          setDuplicateAnswer({
            url: currentUrl,
            warning: result.ok ? result.value : null
          })
        } catch {
          if (!cancelled) setDuplicateAnswer({ url: currentUrl, warning: null })
        }
      })()
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [currentUrl])

  function resetDuplicate(): void {
    setDuplicateInput(null)
  }

  const connectionsValue = connections.trim() === ''
    ? null
    : Number(connections)

  function stepConnections(delta: number): void {
    const base = connectionsValue ?? defaultConnections
    const next = Math.min(
      MAX_CONNECTIONS,
      Math.max(MIN_CONNECTIONS, base + delta)
    )
    setConnections(String(next))
  }

  function buildInput(): AddDownloadInput | null {
    try {
      const normalizedUrl = normalizeHttpUrl(value)
      const trimmedName = filename.trim()
      const controls = parseControls(startAt, speedMib, connections)
      return {
        url: normalizedUrl,
        ...(trimmedName.length > 0
          ? { filename: sanitizeFilename(trimmedName) }
          : {}),
        ...(controls ? { controls } : {}),
        ...(destinationToken === undefined ? {} : { destinationToken })
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Check the URL.')
      return null
    }
  }

  function clearForm(): void {
    setValue('')
    setFilename('')
    setStartAt('')
    setSpeedMib('')
    setConnections('')
    setDuplicateAnswer(null)
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault()
    setLocalError(null)
    resetDuplicate()

    // The safe default is explicit: an existing active or finished record is
    // never submitted again by the primary action. "Show it" / "Download
    // again" in the notice are the deliberate choices.
    if (duplicateWarning !== null) {
      setLocalError(
        duplicateWarning.state === 'active'
          ? 'This link is already in your list — use Show it to reveal it.'
          : 'This link is already downloaded — choose Download again to make a second copy.'
      )
      return
    }

    const input = buildInput()
    if (input === null) return

    const result = await onAdd(input)
    if (result.ok) {
      clearForm()
    } else if (result.error.code === 'DUPLICATE_DOWNLOAD') {
      // Keep the entered URL/name and make the intentional repeat explicit.
      setDuplicateInput(input)
    } else {
      // Never swallow a failure: a save-to token may have expired, and the
      // user has to see that instead of assuming the default folder was used.
      setLocalError(result.error.message)
    }
  }

  async function handleDownloadAgain(): Promise<void> {
    if (disabled) return
    setLocalError(null)
    const input = duplicateInput ?? buildInput()
    if (input === null) return

    const result = await onAdd({ ...input, force: true })
    if (result.ok) {
      clearForm()
      setDuplicateInput(null)
    } else if (result.error.code === 'DUPLICATE_DOWNLOAD') {
      setDuplicateInput(input)
    } else {
      // The retry path must surface an expired save-to folder (or any other
      // refusal) instead of silently posting to the default folder.
      setLocalError(result.error.message)
    }
  }

  async function handleOpenDuplicate(): Promise<void> {
    if (duplicateWarning === null) return
    setLocalError(null)
    try {
      const result = await window.donDownload.openFile(duplicateWarning.id)
      if (!result.ok) setLocalError(result.error.message)
    } catch {
      setLocalError('The finished file could not be opened.')
    }
  }

  async function handleShowDuplicateInFolder(): Promise<void> {
    if (duplicateWarning === null) return
    setLocalError(null)
    try {
      const result = await window.donDownload.showInFolder(duplicateWarning.id)
      if (!result.ok) setLocalError(result.error.message)
    } catch {
      setLocalError('The download folder could not be opened.')
    }
  }

  function handleShowExisting(): void {
    if (duplicateWarning === null || onShowDuplicate === undefined) return
    const warning = duplicateWarning
    setDuplicateAnswer(null)
    onShowDuplicate(warning)
  }

  function handleResume(): void {
    if (duplicateInput === null) return
    const target = duplicateInput.url
    setDuplicateInput(null)
    if (onResumeDuplicate) onResumeDuplicate(target)
  }

  const duplicateSummary = duplicateInput
    ? describeDuplicate?.(duplicateInput.url) ?? 'in progress'
    : null
  const notice = duplicateWarning === null ? null : duplicateNotice(duplicateWarning)

  // The Add dialog footer hosts the primary action when this component runs in
  // controlled mode; re-register every render so the closure stays current.
  useEffect(() => {
    if (!registerSubmit) return
    registerSubmit(() => {
      void handleSubmit()
    })
    return () => registerSubmit(null)
  })

  return (
    <form
      aria-labelledby="quick-add-heading"
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="flex flex-col gap-2"
    >
      {controlled ? null : (
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
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              resetDuplicate()
            }}
            placeholder="https://example.com/file.zip"
            disabled={disabled}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 surface-input px-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/60 focus:ring-2 focus:ring-accent-400/15 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={disabled || value.trim().length === 0}
            className="h-10 shrink-0 rounded-lg bg-accent-500 px-4 text-sm font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {disabled ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {!controlled && value.trim().length > 0 ? (
        <p className="truncate px-1 text-[11px] text-zinc-500">
          {filenameFromUrl(value)}
        </p>
      ) : null}

      <details
        open={optionsOpen}
        onToggle={(event) =>
          setOptionsOpen((event.target as HTMLDetailsElement).open)
        }
        className="rounded-lg border border-white/10 surface-soft"
      >
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] font-medium text-zinc-300 transition hover:text-zinc-100">
          <span>Options</span>
          <span className="ml-auto truncate text-[11px] font-normal text-zinc-500">
            {filename.trim().length > 0
              ? filename
              : 'Names from the links'}
            {' · '}
            {connectionsValue === null
              ? `${defaultConnections} connections`
              : `${connectionsValue} connections`}
          </span>
        </summary>
        <div className="grid gap-3 border-t border-white/10 px-3 py-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
            File name
            <input
              aria-label="Custom file name (optional)"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={filename}
              onChange={(event) => {
                setFilename(event.target.value)
                resetDuplicate()
              }}
              placeholder="From the link"
              disabled={disabled}
              className="h-8 w-full rounded-lg border border-white/10 surface-input px-2.5 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/50 disabled:opacity-50"
            />
          </label>
          <div className="flex flex-col gap-1 text-[11px] text-zinc-400">
            <span>Connections for these downloads</span>
            <div className="flex h-8 w-fit items-center rounded-lg border border-white/10 surface-input">
              <button
                type="button"
                aria-label="Fewer connections"
                onClick={() => stepConnections(-1)}
                disabled={disabled}
                className="grid h-full w-7 place-items-center text-zinc-300 transition hover:text-zinc-100 disabled:opacity-40"
              >
                −
              </button>
              <span className="min-w-[92px] border-x border-white/10 text-center text-xs font-semibold text-zinc-200">
                {connectionsValue === null
                  ? `Default · ${defaultConnections}`
                  : connectionsValue}
              </span>
              <button
                type="button"
                aria-label="More connections"
                onClick={() => stepConnections(1)}
                disabled={disabled}
                className="grid h-full w-7 place-items-center text-zinc-300 transition hover:text-zinc-100 disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>
          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
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
              className="h-8 w-full rounded-lg border border-white/10 surface-input px-2.5 text-xs text-zinc-100 outline-none transition focus:border-accent-400/50 disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
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
              className="h-8 w-full rounded-lg border border-white/10 surface-input px-2.5 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/50 disabled:opacity-50"
            />
            <span
              id="download-speed-help"
              className="block min-h-4 text-[11px] leading-4 text-zinc-500"
            >
              {speedPreview ? `Backend value: ${speedPreview}` : 'Blank means unlimited.'}
            </span>
          </label>
        </div>
        <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-4 text-zinc-500">
          The start time uses this computer&apos;s local clock. Allowed hours
          are enforced separately in Settings.
        </p>
      </details>

      {notice !== null && duplicateWarning !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2"
        >
          <div className="min-w-0 text-[11px] leading-5 text-amber-200">
            <p className="break-words font-semibold text-amber-100">
              {notice.title}
            </p>
            {notice.detail !== null ? (
              <p className="mt-0.5 break-words text-amber-200/80">
                {notice.detail}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-amber-300/30">
            {notice.actions.includes('open') ? (
              <button
                type="button"
                onClick={() => {
                  void handleOpenDuplicate()
                }}
                className="h-7 border-r border-amber-300/30 px-2.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10"
              >
                Open file
              </button>
            ) : null}
            {notice.actions.includes('show') ? (
              <button
                type="button"
                onClick={() => {
                  void handleShowDuplicateInFolder()
                }}
                className="h-7 border-r border-amber-300/30 px-2.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10"
              >
                Show in folder
              </button>
            ) : null}
            {notice.actions.includes('reveal') ? (
              <button
                type="button"
                onClick={handleShowExisting}
                disabled={disabled || onShowDuplicate === undefined}
                className="h-7 px-2.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Show it
              </button>
            ) : null}
            {notice.actions.includes('again') ? (
              <button
                type="button"
                onClick={() => {
                  void handleDownloadAgain()
                }}
                disabled={disabled}
                className="h-7 px-2.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Download again
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {duplicateInput ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2"
        >
          <p className="min-w-0 text-[11px] leading-5 text-amber-200">
            <span className="font-semibold text-amber-100">
              Already in your list
            </span>
            {' · '}
            {duplicateSummary}
          </p>
          <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-amber-300/30">
            <button
              type="button"
              onClick={handleResume}
              disabled={disabled}
              className="h-7 border-r border-amber-300/30 px-2.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Resume that one
            </button>
            <button
              type="button"
              onClick={() => {
                void handleDownloadAgain()
              }}
              disabled={disabled}
              className="h-7 px-2.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download again
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3 px-0.5">
        <p className="text-[11px] leading-5 text-zinc-400">
          Saved to {savedToLabel ?? 'Downloads\\DonDownload'}.
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
