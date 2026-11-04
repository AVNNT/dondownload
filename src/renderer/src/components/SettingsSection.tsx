import { useEffect, useState, type FormEvent, type JSX } from 'react'
import {
  MAX_SPEED_LIMIT_BPS,
  type DownloadSettings
} from '@shared/settings'
import { formatSpeed } from '@shared/format'

const BYTES_PER_MB = 1_000_000
const MAX_SPEED_MB = MAX_SPEED_LIMIT_BPS / BYTES_PER_MB

/**
 * Render the stored bytes/sec value in MB/s for humans without ever writing
 * this rounded text back unless the user actually edits the field.
 */
function speedInputValue(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  const mb = bytesPerSecond / BYTES_PER_MB
  const rounded = Number(mb.toFixed(mb >= 1 ? 3 : 6))
  return String(rounded)
}

function exactSpeedLabel(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return 'Unlimited'
  return `${bytesPerSecond.toLocaleString()} B/s · ${formatSpeed(bytesPerSecond)}`
}

export function SettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [draft, setDraft] = useState<DownloadSettings | null>(null)
  const [speedInput, setSpeedInput] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.donDownload.getSettings().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setSettings(result.value)
        setDraft(result.value)
        setSpeedInput(speedInputValue(result.value.globalSpeedLimitBps))
      } else {
        setError(result.error.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!draft) {
    return (
      <section
        className="rounded-xl border border-white/10 bg-[#080808] p-4"
        aria-labelledby="settings-heading"
      >
        <h2
          id="settings-heading"
          className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
        >
          Download settings
        </h2>
        <p
          role={error ? 'alert' : undefined}
          className={`mt-3 text-xs ${error ? 'text-red-300' : 'text-zinc-500'}`}
        >
          {error ?? 'Loading settings…'}
        </p>
      </section>
    )
  }

  const update = (patch: Partial<DownloadSettings>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const updateAllowedHours = (
    patch: Partial<DownloadSettings['allowedHours']>
  ): void => {
    setDraft((current) =>
      current
        ? {
            ...current,
            allowedHours: { ...current.allowedHours, ...patch }
          }
        : current
    )
  }

  const handleSpeedInput = (value: string): void => {
    setSpeedInput(value)
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      update({ globalSpeedLimitBps: 0 })
      return
    }
    const mb = Number(trimmed)
    if (!Number.isFinite(mb) || mb < 0) return
    update({
      globalSpeedLimitBps: Math.min(
        MAX_SPEED_LIMIT_BPS,
        Math.max(0, Math.round(mb * BYTES_PER_MB))
      )
    })
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const result = await window.donDownload.updateSettings(draft)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setSettings(result.value)
      setDraft(result.value)
      setSpeedInput(speedInputValue(result.value.globalSpeedLimitBps))
      setMessage('Settings saved and applied.')
    } finally {
      setSaving(false)
    }
  }

  const unchanged = JSON.stringify(settings) === JSON.stringify(draft)

  return (
    <section
      className="rounded-xl border border-white/10 bg-[#080808] p-3 sm:p-4"
      aria-labelledby="settings-heading"
    >
      <div className="mb-3">
        <h2
          id="settings-heading"
          className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
        >
          Download settings
        </h2>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          Global limits apply immediately. Allowed hours use this computer&apos;s
          local clock; active downloads are allowed to finish when the window
          closes.
        </p>
      </div>

      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-[11px] text-zinc-400">
            Concurrent downloads
            <input
              aria-label="Concurrent downloads"
              type="number"
              min={1}
              max={16}
              step={1}
              required
              value={draft.maxConcurrentDownloads}
              onChange={(event) =>
                update({
                  maxConcurrentDownloads: Number(event.currentTarget.value)
                })
              }
              className="mt-1 block h-9 w-full rounded-lg border border-white/10 bg-black px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
            />
          </label>
          <label className="text-[11px] text-zinc-400">
            Connections per host
            <input
              aria-label="Connections per host"
              type="number"
              min={1}
              max={16}
              step={1}
              required
              value={draft.perHostConnections}
              onChange={(event) =>
                update({
                  perHostConnections: Number(event.currentTarget.value)
                })
              }
              className="mt-1 block h-9 w-full rounded-lg border border-white/10 bg-black px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
            />
          </label>
          <label className="text-[11px] text-zinc-400">
            Global speed limit (MB/s)
            <input
              aria-label="Global speed limit in MB per second"
              aria-describedby="settings-speed-exact"
              type="number"
              min={0}
              max={MAX_SPEED_MB}
              step="any"
              placeholder="Unlimited"
              value={speedInput}
              onChange={(event) => handleSpeedInput(event.currentTarget.value)}
              className="mt-1 block h-9 w-full rounded-lg border border-white/10 bg-black px-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/50"
            />
            <span
              id="settings-speed-exact"
              className="mt-1 block min-h-8 break-words text-[10px] leading-4 text-zinc-400"
            >
              {speedInput.trim().length === 0
                ? 'Unlimited'
                : draft.globalSpeedLimitBps === 0
                  ? 'Unlimited (0 B/s)'
                  : `Stored exactly as ${exactSpeedLabel(
                      draft.globalSpeedLimitBps
                    )}`}
            </span>
          </label>
        </div>

        <fieldset className="rounded-lg border border-white/10 bg-black/30 px-3 py-3">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            Allowed download hours (local time)
          </legend>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.allowedHours.enabled}
              onChange={(event) =>
                updateAllowedHours({ enabled: event.currentTarget.checked })
              }
              className="h-3.5 w-3.5 accent-emerald-400"
            />
            Only start new downloads inside this window
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-zinc-400">
              Start (inclusive)
              <input
                aria-label="Allowed hours start"
                type="time"
                step={60}
                value={draft.allowedHours.start}
                onChange={(event) =>
                  updateAllowedHours({ start: event.currentTarget.value })
                }
                className="mt-1 block h-9 w-full rounded-lg border border-white/10 bg-black px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
              />
            </label>
            <label className="text-[11px] text-zinc-400">
              End (exclusive)
              <input
                aria-label="Allowed hours end"
                type="time"
                step={60}
                value={draft.allowedHours.end}
                onChange={(event) =>
                  updateAllowedHours({ end: event.currentTarget.value })
                }
                className="mt-1 block h-9 w-full rounded-lg border border-white/10 bg-black px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
              />
            </label>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-zinc-400">
            An end before the start crosses midnight. Equal start and end mean
            all day. Downloads already active keep running when the window
            closes; queued and scheduled jobs wait for the next window.
          </p>
        </fieldset>

        {error ? (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" aria-live="polite" className="text-xs text-emerald-300">
            {message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
          <p className="text-[10px] leading-4 text-zinc-400">
            {unchanged
              ? 'Settings match the saved values.'
              : 'You have unsaved changes.'}
          </p>
          <button
            type="submit"
            disabled={saving || unchanged}
            className="min-h-9 rounded-lg bg-emerald-400 px-4 text-xs font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  )
}
