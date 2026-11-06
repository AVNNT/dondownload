import { useEffect, useState, type FormEvent, type JSX } from 'react'
import {
  APP_THEMES,
  MAX_SPEED_LIMIT_BPS,
  type AppTheme,
  type DownloadSettings
} from '@shared/settings'
import { formatSpeed } from '@shared/format'
import {
  INTERFACE_SIZES,
  defaultDesktopSettings,
  type DesktopSettings
} from '@shared/desktopSettings'
import type {
  MediaToolSettings,
  YtdlpUpdateState
} from '@shared/mediaTools'
import type { AppUpdateState } from '@shared/appUpdate'
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

function appUpdateStatusLabel(state: AppUpdateState | null): string {
  if (!state) return 'Not checked yet'
  if (!state.configured || state.status === 'not-configured') {
    return state.message ?? 'Update source not configured'
  }
  switch (state.status) {
    case 'idle':
      return 'Not checked yet'
    case 'checking':
      return 'Checking…'
    case 'up-to-date':
      return 'Up to date'
    case 'available':
      return state.latestVersion
        ? `v${state.latestVersion} is available`
        : 'Update available'
    case 'downloading':
      return state.latestVersion
        ? `Downloading v${state.latestVersion} ${
            state.progressPercent ?? 0
          }%`
        : 'Downloading…'
    case 'ready':
      return state.latestVersion
        ? `Ready to install v${state.latestVersion}`
        : 'Ready to install'
    case 'installing':
      return 'Restarting to install…'
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
 */function speedInputValue(bytesPerSecond: number): string {
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
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(
    null
  )
  const [appUpdateBusy, setAppUpdateBusy] = useState(false)
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null)
  const [desktopDraft, setDesktopDraft] = useState<DesktopSettings>(
    defaultDesktopSettings()
  )
  const [desktopSaved, setDesktopSaved] = useState<DesktopSettings>(
    defaultDesktopSettings()
  )
  const [desktopMessage, setDesktopMessage] = useState<string | null>(null)
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const [desktopSaving, setDesktopSaving] = useState(false)

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
    void window.donDownload.getAppUpdateState().then((result) => {
      if (cancelled) return
      if (result.ok) setAppUpdateState(result.value)
      else setAppUpdateError(result.error.message)
    })
    const unsubscribe = window.donDownload.onAppUpdateStateChanged((state) => {
      if (!cancelled) setAppUpdateState(state)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const apply = (next: DesktopSettings): void => {
      setDesktopDraft(next)
      setDesktopSaved(next)
    }
    void window.donDownload.getDesktopSettings().then((result) => {
      if (cancelled) return
      if (result.ok) apply(result.value)
      else setDesktopError(result.error.message)
    })
    const unsubscribe = window.donDownload.onDesktopSettingsChanged((next) => {
      if (!cancelled) apply(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
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

  const toggleAppAutoCheck = async (checked: boolean): Promise<void> => {
    setAppUpdateError(null)
    setAppUpdateState((current) =>
      current ? { ...current, autoCheck: checked } : current
    )
    try {
      const result = await window.donDownload.setAppUpdateAutoCheck({
        autoCheck: checked
      })
      if (!result.ok) {
        setAppUpdateError(result.error.message)
        setAppUpdateState((current) =>
          current ? { ...current, autoCheck: !checked } : current
        )
        return
      }
      setAppUpdateState(result.value)
    } catch (error) {
      setAppUpdateError(
        error instanceof Error
          ? error.message
          : 'The application update preference could not be saved.'
      )
      setAppUpdateState((current) =>
        current ? { ...current, autoCheck: !checked } : current
      )
    }
  }

  const checkForAppUpdate = async (): Promise<void> => {
    setAppUpdateBusy(true)
    setAppUpdateError(null)
    setAppUpdateState((current) =>
      current ? { ...current, status: 'checking', message: null } : current
    )
    try {
      const result = await window.donDownload.checkAppUpdate()
      if (!result.ok) {
        setAppUpdateError(result.error.message)
        return
      }
      setAppUpdateState(result.value)
    } catch (error) {
      setAppUpdateError(
        error instanceof Error
          ? error.message
          : 'The application update check failed.'
      )
    } finally {
      setAppUpdateBusy(false)
    }
  }

  const installAppUpdate = async (): Promise<void> => {
    setAppUpdateBusy(true)
    setAppUpdateError(null)
    try {
      const result = await window.donDownload.installAppUpdate()
      if (!result.ok) {
        setAppUpdateError(result.error.message)
        return
      }
      setAppUpdateState(result.value)
    } catch (error) {
      setAppUpdateError(
        error instanceof Error
          ? error.message
          : 'The application installer could not be started.'
      )
    } finally {
      setAppUpdateBusy(false)
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

  const saveDesktop = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setDesktopSaving(true)
    setDesktopError(null)
    setDesktopMessage(null)
    try {
      const result = await window.donDownload.updateDesktopSettings(desktopDraft)
      if (!result.ok) {
        setDesktopError(result.error.message)
        return
      }
      setDesktopDraft(result.value)
      setDesktopSaved(result.value)
      setDesktopMessage('Desktop preferences saved.')
    } finally {
      setDesktopSaving(false)
    }
  }

  const unchanged = JSON.stringify(settings) === JSON.stringify(draft)
  const desktopUnchanged =
    JSON.stringify(desktopSaved) === JSON.stringify(desktopDraft)

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
                    <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
                      {THEME_DESCRIPTION[theme]}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-zinc-500">
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
              className="mt-1 block min-h-8 break-words text-[11px] leading-4 text-zinc-400"
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
          <p className="mt-2 text-[11px] leading-4 text-zinc-400">
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
          <p className="text-[11px] leading-4 text-zinc-400">
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
              <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
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

      <fieldset className="mt-4 rounded-lg border border-white/10 surface-soft px-3 py-3">
        <legend className="px-1 text-[11px] font-medium text-zinc-400">
          App updates
        </legend>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <label className="flex min-w-0 items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={appUpdateState?.autoCheck ?? true}
              disabled={appUpdateState === null}
              onChange={(event) => {
                void toggleAppAutoCheck(event.currentTarget.checked)
              }}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-400"
            />
            <span>
              <span className="block font-medium">
                Check for app updates automatically
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
                At most once every 24 hours. Checks are disabled until an update
                source is configured.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void checkForAppUpdate()}
              disabled={appUpdateBusy || !appUpdateState?.configured}
              className="min-h-9 rounded-lg border border-white/10 surface-card px-3 text-xs font-medium text-zinc-200 transition hover:border-emerald-400/40 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {appUpdateBusy && appUpdateState?.status === 'checking'
                ? 'Checking…'
                : 'Check now'}
            </button>
            <button
              type="button"
              onClick={() => void installAppUpdate()}
              disabled={
                appUpdateBusy ||
                appUpdateState?.status !== 'ready' ||
                appUpdateState?.canInstall !== true
              }
              className="min-h-9 rounded-lg bg-emerald-400 px-3 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              Restart and install
            </button>
          </div>
        </div>
        <dl className="mt-3 grid gap-1 text-[11px] text-zinc-400 sm:grid-cols-2">
          <div className="flex gap-1">
            <dt className="text-zinc-500">Current:</dt>
            <dd className="text-zinc-300">
              {appUpdateState?.currentVersion ?? 'Unknown'}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-zinc-500">Latest:</dt>
            <dd className="text-zinc-300">
              {appUpdateState?.latestVersion ?? 'Not checked'}
            </dd>
          </div>
          <div className="flex gap-1 sm:col-span-2">
            <dt className="text-zinc-500">Status:</dt>
            <dd
              role={appUpdateState?.status === 'failed' ? 'alert' : 'status'}
              aria-live="polite"
              className={
                appUpdateState?.status === 'failed'
                  ? 'text-red-300'
                  : 'text-zinc-300'
              }
            >
              {appUpdateStatusLabel(appUpdateState)}
            </dd>
          </div>
        </dl>
        {appUpdateState?.releaseNotes ? (
          <div className="mt-3 rounded-lg border border-white/5 surface-card px-2.5 py-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">
              Release notes
            </p>
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-zinc-300">
              {appUpdateState.releaseNotes}
            </p>
          </div>
        ) : null}
        {appUpdateError ? (
          <p role="alert" className="mt-2 text-xs text-red-300">
            {appUpdateError}
          </p>
        ) : null}
      </fieldset>

      <form onSubmit={(event) => void saveDesktop(event)}>
        <fieldset className="mt-4 rounded-lg border border-white/10 surface-soft px-3 py-3">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            Desktop &amp; startup
          </legend>
          <div className="space-y-2">
            <DesktopToggle
              label="Resume interrupted downloads on startup"
              description="Continues downloads that stopped mid-transfer with partial data. Paused jobs are never resumed."
              checked={desktopDraft.resumeInterruptedOnStartup}
              onChange={(checked) =>
                setDesktopDraft((current) => ({
                  ...current,
                  resumeInterruptedOnStartup: checked
                }))
              }
            />
            <DesktopToggle
              label="Show notifications"
              description="Shows a Windows notification when a download or media job completes or fails."
              checked={desktopDraft.showNotifications}
              onChange={(checked) =>
                setDesktopDraft((current) => ({
                  ...current,
                  showNotifications: checked
                }))
              }
            />
            <DesktopToggle
              label="Watch clipboard for links"
              description="Checks the clipboard every 1.5 seconds while DonDownload runs. Only a single http(s) link opens a Download / Dismiss prompt; nothing starts automatically."
              checked={desktopDraft.watchClipboard}
              onChange={(checked) =>
                setDesktopDraft((current) => ({
                  ...current,
                  watchClipboard: checked
                }))
              }
            />
            <DesktopToggle
              label="Start DonDownload when I sign in"
              description="Uses the hidden-start flag. Only applies to an installed build, never to development runs."
              checked={desktopDraft.launchAtLogin}
              onChange={(checked) =>
                setDesktopDraft((current) => ({
                  ...current,
                  launchAtLogin: checked
                }))
              }
            />
            <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-300">
              <span>
                <span className="block font-medium">Interface size</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
                  Ctrl+= and Ctrl+- step the scale; Ctrl+0 resets to 100%.
                </span>
              </span>
              <select
                aria-label="Interface size"
                value={desktopDraft.interfaceSizePercent}
                onChange={(event) =>
                  setDesktopDraft((current) => ({
                    ...current,
                    interfaceSizePercent: Number(event.currentTarget.value) as DesktopSettings['interfaceSizePercent']
                  }))
                }
                className="h-9 rounded-lg border border-white/10 surface-input px-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
              >
                {INTERFACE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}%
                  </option>
                ))}
              </select>
            </label>
          </div>
          {desktopError ? (
            <p role="alert" className="mt-2 text-xs text-red-300">
              {desktopError}
            </p>
          ) : null}
          {desktopMessage ? (
            <p role="status" aria-live="polite" className="mt-2 text-xs text-emerald-300">
              {desktopMessage}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-end border-t border-white/5 pt-3">
            <button
              type="submit"
              disabled={desktopSaving || desktopUnchanged}
              className="min-h-9 rounded-lg bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {desktopSaving ? 'Saving…' : 'Save desktop preferences'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  )
}

function DesktopToggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 text-xs text-zinc-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-400"
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
          {description}
        </span>
      </span>
    </label>
  )
}
