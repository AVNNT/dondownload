import { useEffect, useState, type FormEvent, type JSX } from 'react'
import {
  APP_THEMES,
  MAX_SPEED_LIMIT_BPS,
  type AppTheme,
  type DownloadSettings
} from '@shared/settings'
import { formatSpeed } from '@shared/format'
import type {
  MediaToolSettings,
  YtdlpUpdateState
} from '@shared/mediaTools'
import { applyRendererTheme } from '../theme'

const THEME_LABEL: Record<AppTheme, string> = {
  oled: 'OLED black',
  dark: 'Dark',
  light: 'Light'
}

const THEME_DESCRIPTION: Record<AppTheme, string> = {
  oled: 'Pure black surfaces',
  dark: 'Soft near-black surfaces',
  light: 'Light surfaces and dark text'
}

const BYTES_PER_MB = 1_000_000
const MAX_SPEED_MB = MAX_SPEED_LIMIT_BPS / BYTES_PER_MB

function updateStatusLabel(state: YtdlpUpdateState | null): string {
  if (!state) return 'Not checked yet'
  switch (state.status) {
    case 'idle':
      return 'Not checked yet'
    case 'checking':
      return 'Checking…'
    case 'up-to-date':
      return 'Up to date'
    case 'updating':
      return 'Updating…'
    case 'updated':
      return state.currentVersion
        ? `Updated to ${state.currentVersion}`
        : 'Updated'
    case 'deferred':
      return state.latestVersion
        ? `Update ready (${state.latestVersion}) — applies to the next media job`
        : 'Update ready — applies to the next media job'
    case 'failed':
      return state.message ? `Failed: ${state.message}` : 'Failed'
    case 'disabled':
      return state.message ?? 'Automatic updates are off'
    case 'throttled':
      return 'Checked recently'
  }
}

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
  const [themePending, setThemePending] = useState(false)
  const [mediaTools, setMediaTools] = useState<MediaToolSettings | null>(null)
  const [updateState, setUpdateState] = useState<YtdlpUpdateState | null>(null)
  const [updating, setUpdating] = useState(false)
  const [mediaToolsError, setMediaToolsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.donDownload.getMediaToolSettings().then((result) => {
      if (cancelled) return
      if (result.ok) setMediaTools(result.value)
      else setMediaToolsError(result.error.message)
    })
    void window.donDownload.getYtdlpUpdateState().then((result) => {
      if (cancelled) return
      if (result.ok) setUpdateState(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.donDownload.getSettings().then((result) => {
      if (cancelled) return
      if (result.ok) {
        applyRendererTheme(result.value.theme)
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
        className="rounded-xl border border-white/10 surface-card p-4"
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

  /**
   * Appearance is an immediate preference: apply the renderer token set and
   * persist the same IPC round trip. Saved download settings are resent, so an
   * unsaved draft for the numeric fields is never committed by a theme click.
   */
  const changeTheme = async (theme: AppTheme): Promise<void> => {
    if (!settings || settings.theme === theme || themePending) return
    const previousTheme = settings.theme
    setThemePending(true)
    setError(null)
    setMessage(null)
    applyRendererTheme(theme)
    setDraft((current) => (current ? { ...current, theme } : current))

    try {
      const result = await window.donDownload.updateSettings({
        ...settings,
        theme
      })
      if (!result.ok) {
        applyRendererTheme(previousTheme)
        setDraft((current) =>
          current ? { ...current, theme: previousTheme } : current
        )
        setError(result.error.message)
        return
      }
      const saved = result.value
      setSettings(saved)
      setDraft((current) =>
        current ? { ...current, theme: saved.theme } : saved
      )
      setMessage('Appearance saved and applied.')
    } catch (error) {
      applyRendererTheme(previousTheme)
      setDraft((current) =>
        current ? { ...current, theme: previousTheme } : current
      )
      setError(
        error instanceof Error
          ? error.message
          : 'The appearance could not be saved.'
      )
    } finally {
      setThemePending(false)
    }
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

  const toggleAutoUpdate = async (checked: boolean): Promise<void> => {
    setMediaToolsError(null)
    setMediaTools((current) =>
      current ? { ...current, autoUpdateYtdlp: checked } : current
    )
    try {
      const result = await window.donDownload.updateMediaToolSettings({
        autoUpdateYtdlp: checked
      })
      if (!result.ok) {
        setMediaToolsError(result.error.message)
        setMediaTools((current) =>
          current ? { ...current, autoUpdateYtdlp: !checked } : current
        )
        return
      }
      setMediaTools(result.value)
    } catch (error) {
      setMediaToolsError(
        error instanceof Error
          ? error.message
          : 'The yt-dlp update preference could not be saved.'
      )
      setMediaTools((current) =>
        current ? { ...current, autoUpdateYtdlp: !checked } : current
      )
    }
  }

  const checkForUpdate = async (): Promise<void> => {
    setUpdating(true)
    setMediaToolsError(null)
    setUpdateState((current) =>
      current
        ? { ...current, status: 'updating', message: null }
        : {
            status: 'updating',
            currentVersion: null,
            latestVersion: null,
            message: null,
            lastCheckedAt: null
          }
    )
    try {
      const result = await window.donDownload.checkYtdlpUpdate()
      if (!result.ok) {
        setMediaToolsError(result.error.message)
        return
      }
      setUpdateState(result.value)
    } catch (error) {
      setMediaToolsError(
        error instanceof Error
          ? error.message
          : 'The yt-dlp update check failed.'
      )
    } finally {
      setUpdating(false)
    }
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
      className="rounded-xl border border-white/10 surface-card p-3 sm:p-4"
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
        <fieldset className="rounded-lg border border-white/10 surface-soft px-3 py-3">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            Appearance
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {APP_THEMES.map((theme) => {
              const selected = draft.theme === theme
              return (
                <label
                  key={theme}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition ${
                    selected
                      ? 'border-emerald-400/40 surface-card text-zinc-100 ring-1 ring-inset ring-emerald-400/20'
                      : 'border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-300'
                  } ${
                    themePending || saving
                      ? 'cursor-not-allowed opacity-70'
                      : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={theme}
                    checked={selected}
                    disabled={themePending || saving}
                    onChange={() => {
                      void changeTheme(theme)
                    }}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-400"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">
                      {THEME_LABEL[theme]}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">
                      {THEME_DESCRIPTION[theme]}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-zinc-500">
            Switches immediately, including the native title bar, and is restored
            the next time DonDownload starts. Downloads keep running.
          </p>
        </fieldset>

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
              className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
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
              className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
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
              className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/50"
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

        <fieldset className="rounded-lg border border-white/10 surface-soft px-3 py-3">
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
                className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
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
                className="mt-1 block h-9 w-full rounded-lg border border-white/10 surface-input px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
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
            className="min-h-9 rounded-lg bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>

      <fieldset className="mt-4 rounded-lg border border-white/10 surface-soft px-3 py-3">
        <legend className="px-1 text-[11px] font-medium text-zinc-400">
          yt-dlp media tool
        </legend>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <label className="flex min-w-0 items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={mediaTools?.autoUpdateYtdlp ?? true}
              disabled={mediaTools === null}
              onChange={(event) => {
                void toggleAutoUpdate(event.currentTarget.checked)
              }}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-400"
            />
            <span>
              <span className="block font-medium">
                Keep yt-dlp up to date automatically
              </span>
              <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">
                Checks at most once every 24 hours in the background. Updates
                are verified against GitHub&apos;s SHA-256 sums and are applied
                to the next media job, never under a running download.
              </span>
            </span>
          </label>
          <button
            type="button"
            onClick={() => void checkForUpdate()}
            disabled={updating}
            className="min-h-9 rounded-lg border border-white/10 surface-card px-3 text-xs font-medium text-zinc-200 transition hover:border-emerald-400/40 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {updating ? 'Updating…' : 'Check for yt-dlp update'}
          </button>
        </div>
        <dl className="mt-3 grid gap-1 text-[11px] text-zinc-400 sm:grid-cols-2">
          <div className="flex gap-1">
            <dt className="text-zinc-500">Current:</dt>
            <dd className="text-zinc-300">
              {updateState?.currentVersion ?? 'Unknown'}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-zinc-500">Latest:</dt>
            <dd className="text-zinc-300">
              {updateState?.latestVersion ?? 'Not checked'}
            </dd>
          </div>
          <div className="flex gap-1 sm:col-span-2">
            <dt className="text-zinc-500">Status:</dt>
            <dd
              role={updateState?.status === 'failed' ? 'alert' : 'status'}
              aria-live="polite"
              className={
                updateState?.status === 'failed'
                  ? 'text-red-300'
                  : 'text-zinc-300'
              }
            >
              {updateStatusLabel(updateState)}
            </dd>
          </div>
        </dl>
        {mediaToolsError ? (
          <p role="alert" className="mt-2 text-xs text-red-300">
            {mediaToolsError}
          </p>
        ) : null}
      </fieldset>
    </section>
  )
}
