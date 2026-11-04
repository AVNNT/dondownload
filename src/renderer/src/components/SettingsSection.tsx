import { useEffect, useState, type FormEvent, type JSX } from 'react'
import type { DownloadSettings } from '@shared/settings'

export function SettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [draft, setDraft] = useState<DownloadSettings | null>(null)
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
      <section className="mt-7 rounded-2xl border border-white/10 bg-zinc-950 p-4" aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Download settings</h2>
        <p role={error ? 'alert' : undefined} className="mt-3 text-xs text-zinc-500">{error ?? 'Loading settings…'}</p>
      </section>
    )
  }

  const update = (patch: Partial<DownloadSettings>): void => {
    setDraft((current) => current ? { ...current, ...patch } : current)
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
      setMessage('Settings saved and applied.')
    } finally {
      setSaving(false)
    }
  }

  const unchanged = JSON.stringify(settings) === JSON.stringify(draft)

  return (
    <section className="mt-7 rounded-2xl border border-white/10 bg-zinc-950 p-4" aria-labelledby="settings-heading">
      <div className="mb-4">
        <h2 id="settings-heading" className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Download settings</h2>
        <p className="mt-1 text-xs text-zinc-600">Global limits apply immediately. Allowed hours use this computer&apos;s local clock; active downloads are allowed to finish when the window closes.</p>
      </div>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-zinc-400">Concurrent downloads
            <input aria-label="Concurrent downloads" type="number" min={1} max={16} step={1} required value={draft.maxConcurrentDownloads} onChange={(event) => update({ maxConcurrentDownloads: Number(event.currentTarget.value) })} className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400/50" />
          </label>
          <label className="text-xs text-zinc-400">Connections per host
            <input aria-label="Connections per host" type="number" min={1} max={16} step={1} required value={draft.perHostConnections} onChange={(event) => update({ perHostConnections: Number(event.currentTarget.value) })} className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400/50" />
          </label>
          <label className="text-xs text-zinc-400">Global speed limit (bytes/sec; 0 = unlimited)
            <input aria-label="Global speed limit in bytes per second" type="number" min={0} max={1024 * 1024 * 1024} step={1} required value={draft.globalSpeedLimitBps} onChange={(event) => update({ globalSpeedLimitBps: Number(event.currentTarget.value) })} className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400/50" />
          </label>
        </div>
        <fieldset className="rounded-xl border border-white/10 bg-black/30 px-3 py-3">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            Allowed download hours (local time)
          </legend>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
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
            <label className="text-xs text-zinc-400">
              Start (inclusive)
              <input
                aria-label="Allowed hours start"
                type="time"
                step={60}
                value={draft.allowedHours.start}
                onChange={(event) =>
                  updateAllowedHours({ start: event.currentTarget.value })
                }
                className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400/50"
              />
            </label>
            <label className="text-xs text-zinc-400">
              End (exclusive)
              <input
                aria-label="Allowed hours end"
                type="time"
                step={60}
                value={draft.allowedHours.end}
                onChange={(event) =>
                  updateAllowedHours({ end: event.currentTarget.value })
                }
                className="mt-1 block w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400/50"
              />
            </label>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-zinc-600">
            An end before the start crosses midnight. Equal start and end mean all
            day. Downloads already active keep running when the window closes;
            queued and scheduled jobs wait for the next window.
          </p>
        </fieldset>
        {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null}
        {message ? <p role="status" className="text-xs text-emerald-300">{message}</p> : null}
        <div className="flex justify-end">
          <button type="submit" disabled={saving || unchanged} className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs font-medium text-emerald-200 transition hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  )
}
