import { useEffect, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import {
  APP_THEMES,
  MAX_SPEED_LIMIT_BPS,
  MAX_MAX_CONCURRENT_DOWNLOADS,
  MAX_PER_HOST_CONNECTIONS,
  MIN_MAX_CONCURRENT_DOWNLOADS,
  MIN_PER_HOST_CONNECTIONS,
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
import { Icon } from './Icon'

const THEME_LABEL: Record<AppTheme, string> = {
  oled: 'OLED',
  dark: 'Dark',
  light: 'Light'
}

const BYTES_PER_MB = 1_000_000
const MAX_SPEED_MB = MAX_SPEED_LIMIT_BPS / BYTES_PER_MB

/* Reusable token-based control classes (see src/renderer/src/styles.css). */
const BTN_PRIMARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent-500 px-3 text-xs font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400'
const BTN_GHOST =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 surface-card px-3 text-xs font-medium text-zinc-200 transition hover:border-accent-400/40 hover:text-accent-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:opacity-60'
const FIELD =
  'h-8 rounded-lg border border-white/10 surface-input px-2.5 text-xs text-zinc-100 outline-none transition focus:border-accent-400/50'
const KBD =
  'rounded border border-white/10 px-1 text-[10px] leading-4 text-zinc-500'

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

function relativeChecked(timestamp: number | null | undefined): string | null {
  if (timestamp === null || timestamp === undefined) return null
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function ytdlpStatusInfo(state: YtdlpUpdateState | null): {
  label: string
  tone: 'ok' | 'warn' | 'err'
} | null {
  // "Working" only after a successful check. Before anything has been checked
  // (no state yet, or idle) there is no known-good result, so render no pill.
  if (!state || state.status === 'idle') return null
  switch (state.status) {
    case 'failed':
      return { label: 'Failed', tone: 'err' }
    case 'checking':
      return { label: 'Checking…', tone: 'warn' }
    case 'updating':
      return { label: 'Updating…', tone: 'warn' }
    default:
      return { label: 'Working', tone: 'ok' }
  }
}

export function SettingsSection({
  onBack
}: {
  onBack?: () => void
}): JSX.Element {
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
      <div aria-labelledby="settings-heading" className="space-y-6">
        <header className="flex h-14 items-center gap-3 border-b border-white/[0.07]">
          {onBack ? (
            <button
              type="button"
              aria-label="Back"
              onClick={onBack}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:text-zinc-100"
            >
              <Icon name="chevron-left" size={16} />
            </button>
          ) : null}
          <h1 id="settings-heading" className="text-[15px] font-semibold text-zinc-100">
            Settings
          </h1>
        </header>
        <p
          role={error ? 'alert' : undefined}
          className={`text-xs ${error ? 'text-red-400' : 'text-zinc-500'}`}
        >
          {error ?? 'Loading settings…'}
        </p>
      </div>
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

  const appReady =
    appUpdateState?.status === 'ready' && appUpdateState?.canInstall === true
  const ytdlpStatus = ytdlpStatusInfo(updateState)
  const checkedLabel = relativeChecked(updateState?.lastCheckedAt)

  return (
    <div aria-labelledby="settings-heading" className="space-y-7">
      <header className="flex h-14 items-center gap-3 border-b border-white/[0.07]">
        {onBack ? (
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
          >
            <Icon name="chevron-left" size={16} />
          </button>
        ) : null}
        <h1 id="settings-heading" className="text-[15px] font-semibold text-zinc-100">
          Settings
        </h1>
      </header>

      <section aria-labelledby="settings-downloads">
        <SectionHeading
          id="settings-downloads"
          title="Downloads"
          description="How many files download at once, and how fast."
        />
        <form onSubmit={(event) => void submit(event)}>
          <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
            <SettingRow
              title="Downloads at the same time"
              description="Others wait in the queue."
            >
              <Stepper
                label="Downloads at the same time"
                value={draft.maxConcurrentDownloads}
                min={MIN_MAX_CONCURRENT_DOWNLOADS}
                max={MAX_MAX_CONCURRENT_DOWNLOADS}
                onChange={(value) => update({ maxConcurrentDownloads: value })}
              />
            </SettingRow>

            <SettingRow
              title="Connections per file"
              description="More connections are usually faster, but some servers limit them."
            >
              <Stepper
                label="Connections per file"
                value={draft.perHostConnections}
                min={MIN_PER_HOST_CONNECTIONS}
                max={MAX_PER_HOST_CONNECTIONS}
                onChange={(value) => update({ perHostConnections: value })}
              />
            </SettingRow>

            <SettingRow
              title="Speed limit"
              description="Applies to all downloads together."
            >
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
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
                    className={`${FIELD} w-[84px]`}
                  />
                  <span
                    className="flex h-8 items-center gap-1 rounded-lg border border-white/10 surface-input px-2 text-xs font-semibold text-zinc-300"
                    aria-hidden="true"
                  >
                    MB/s
                  </span>
                </div>
                <span
                  id="settings-speed-exact"
                  className="text-[11px] leading-4 text-zinc-500"
                >
                  {speedInput.trim().length === 0
                    ? 'Unlimited'
                    : draft.globalSpeedLimitBps === 0
                      ? 'Unlimited (0 B/s)'
                      : `Stored exactly as ${exactSpeedLabel(
                          draft.globalSpeedLimitBps
                        )}`}
                </span>
              </div>
            </SettingRow>

            <SettingRow
              title="Only download during set hours"
              description={
                draft.allowedHours.enabled
                  ? `Queued files wait for ${draft.allowedHours.start} – ${draft.allowedHours.end}. Running downloads finish.`
                  : 'Limit new downloads to a set window. Running downloads finish.'
              }
            >
              <input
                aria-label="Allowed hours start"
                type="time"
                step={60}
                value={draft.allowedHours.start}
                disabled={!draft.allowedHours.enabled}
                onChange={(event) =>
                  updateAllowedHours({ start: event.currentTarget.value })
                }
                className={FIELD}
              />
              <span className="text-xs text-zinc-500">to</span>
              <input
                aria-label="Allowed hours end"
                type="time"
                step={60}
                value={draft.allowedHours.end}
                disabled={!draft.allowedHours.enabled}
                onChange={(event) =>
                  updateAllowedHours({ end: event.currentTarget.value })
                }
                className={FIELD}
              />
              <Switch
                checked={draft.allowedHours.enabled}
                label="Only download during set hours"
                onChange={(checked) => updateAllowedHours({ enabled: checked })}
              />
            </SettingRow>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] leading-4 text-zinc-500">
              {unchanged
                ? 'Settings match the saved values.'
                : 'You have unsaved changes.'}
            </p>
            <button
              type="submit"
              disabled={saving || unchanged}
              className={BTN_PRIMARY}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>

          {error ? (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {error}
            </p>
          ) : null}
          {message ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 text-xs text-emerald-400"
            >
              {message}
            </p>
          ) : null}
        </form>
      </section>

      <section aria-labelledby="settings-appearance">
        <SectionHeading
          id="settings-appearance"
          title="Appearance"
          description="Switches immediately. Downloads keep running."
        />
        <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
          <div className="grid grid-cols-3 gap-2.5 p-4">
            {APP_THEMES.map((theme) => (
              <ThemeOption
                key={theme}
                theme={theme}
                selected={draft.theme === theme}
                disabled={themePending || saving}
                onSelect={() => {
                  void changeTheme(theme)
                }}
              />
            ))}
          </div>
          <SettingRow
            title="Interface size"
            description={
              <>
                Use <kbd className={KBD}>Ctrl +</kbd> and{' '}
                <kbd className={KBD}>Ctrl −</kbd> to change it.
              </>
            }
          >
            <select
              aria-label="Interface size"
              form="desktop-settings-form"
              value={desktopDraft.interfaceSizePercent}
              onChange={(event) =>
                setDesktopDraft((current) => ({
                  ...current,
                  interfaceSizePercent: Number(
                    event.currentTarget.value
                  ) as DesktopSettings['interfaceSizePercent']
                }))
              }
              className="h-8 rounded-lg border border-white/10 surface-input px-2 text-xs font-semibold text-zinc-100 outline-none transition focus:border-accent-400/50"
            >
              {INTERFACE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}%
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      </section>

      <section aria-labelledby="settings-media-tool">
        <SectionHeading
          id="settings-media-tool"
          title="Media tool"
          description="Reads video pages and downloads streams. Updates are checked against the publisher's signatures."
        />
        <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
          <SettingRow
            title={`yt-dlp ${updateState?.currentVersion ?? 'Unknown'}`}
            description={
              <>
                {updateStatusLabel(updateState)}
                {checkedLabel ? ` · checked ${checkedLabel}` : ''}
              </>
            }
          >
            {ytdlpStatus ? (
              <StatusPill label={ytdlpStatus.label} tone={ytdlpStatus.tone} />
            ) : null}
            <button
              type="button"
              onClick={() => void checkForUpdate()}
              disabled={updating}
              className={BTN_GHOST}
            >
              {updating ? 'Updating…' : 'Check now'}
            </button>
          </SettingRow>
          <SettingRow
            title="Update automatically"
            description="At most once a day. A new version is used from the next video, never mid-download."
          >
            <Switch
              checked={mediaTools?.autoUpdateYtdlp ?? true}
              disabled={mediaTools === null}
              label="Update yt-dlp automatically"
              onChange={(checked) => {
                void toggleAutoUpdate(checked)
              }}
            />
          </SettingRow>
        </div>
        {mediaToolsError ? (
          <p role="alert" className="mt-2 text-xs text-red-400">
            {mediaToolsError}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="settings-startup">
        <SectionHeading
          id="settings-startup"
          title="Startup"
          description="What DonDownload does when it opens and while it runs."
        />
        <form
          id="desktop-settings-form"
          onSubmit={(event) => void saveDesktop(event)}
        >
          <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
            <SettingRow
              title="Start when I sign in to Windows"
              description="Opens minimised to the tray."
            >
              <Switch
                checked={desktopDraft.launchAtLogin}
                label="Start when I sign in to Windows"
                onChange={(checked) =>
                  setDesktopDraft((current) => ({
                    ...current,
                    launchAtLogin: checked
                  }))
                }
              />
            </SettingRow>
            <SettingRow
              title="Resume unfinished downloads"
              description="Downloads stopped when the app closed start again on launch."
            >
              <Switch
                checked={desktopDraft.resumeInterruptedOnStartup}
                label="Resume unfinished downloads"
                onChange={(checked) =>
                  setDesktopDraft((current) => ({
                    ...current,
                    resumeInterruptedOnStartup: checked
                  }))
                }
              />
            </SettingRow>
            <SettingRow
              title="Notifications"
              description="When a download finishes or fails. Not for every file in a batch."
            >
              <Switch
                checked={desktopDraft.showNotifications}
                label="Notifications"
                onChange={(checked) =>
                  setDesktopDraft((current) => ({
                    ...current,
                    showNotifications: checked
                  }))
                }
              />
            </SettingRow>
            <SettingRow
              title="Watch the clipboard for links"
              description="When you copy a link, DonDownload offers to add it. Nothing downloads on its own."
            >
              <Switch
                checked={desktopDraft.watchClipboard}
                label="Watch the clipboard for links"
                onChange={(checked) =>
                  setDesktopDraft((current) => ({
                    ...current,
                    watchClipboard: checked
                  }))
                }
              />
            </SettingRow>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] leading-4 text-zinc-500">
              {desktopUnchanged
                ? 'Desktop preferences match the saved values.'
                : 'You have unsaved changes.'}
            </p>
            <button
              type="submit"
              disabled={desktopSaving || desktopUnchanged}
              className={BTN_PRIMARY}
            >
              {desktopSaving ? 'Saving…' : 'Save preferences'}
            </button>
          </div>

          {desktopError ? (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {desktopError}
            </p>
          ) : null}
          {desktopMessage ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 text-xs text-emerald-400"
            >
              {desktopMessage}
            </p>
          ) : null}
        </form>
      </section>

      <section aria-labelledby="settings-updates">
        <SectionHeading
          id="settings-updates"
          title="Updates"
          description={`DonDownload ${appUpdateState?.currentVersion ?? ''} · signed updates only.`}
        />
        <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
          <SettingRow
            title={
              appReady
                ? `DonDownload ${appUpdateState?.latestVersion ?? ''} is ready to install`
                : 'App updates'
            }
            description={
              appReady
                ? 'Downloaded and verified. Running downloads resume after the restart.'
                : appUpdateStatusLabel(appUpdateState)
            }
            accent={appReady}
          >
            <button
              type="button"
              onClick={() => void checkForAppUpdate()}
              disabled={appUpdateBusy || !appUpdateState?.configured}
              className={BTN_GHOST}
            >
              {appUpdateBusy && appUpdateState?.status === 'checking'
                ? 'Checking…'
                : 'Check now'}
            </button>
            {appReady ? (
              <button
                type="button"
                onClick={() => void installAppUpdate()}
                disabled={appUpdateBusy}
                className={BTN_PRIMARY}
              >
                Restart and install
              </button>
            ) : null}
          </SettingRow>
          <SettingRow
            title="Check for updates automatically"
            description="At most once a day."
          >
            <Switch
              checked={appUpdateState?.autoCheck ?? true}
              disabled={appUpdateState === null}
              label="Check for updates automatically"
              onChange={(checked) => {
                void toggleAppAutoCheck(checked)
              }}
            />
          </SettingRow>
          {appUpdateState?.releaseNotes ? (
            <div className="px-4 py-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                Release notes
              </p>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-4 text-zinc-400">
                {appUpdateState.releaseNotes}
              </p>
            </div>
          ) : null}
        </div>
        {appUpdateError ? (
          <p role="alert" className="mt-2 text-xs text-red-400">
            {appUpdateError}
          </p>
        ) : null}
      </section>
    </div>
  )
}

function SectionHeading({
  id,
  title,
  description
}: {
  id: string
  title: string
  description: ReactNode
}): JSX.Element {
  return (
    <div className="mb-3">
      <h2 id={id} className="text-base font-semibold text-zinc-100">
        {title}
      </h2>
      <p className="mt-0.5 text-xs leading-5 text-zinc-400">{description}</p>
    </div>
  )
}

function SettingRow({
  title,
  description,
  accent = false,
  children
}: {
  title: ReactNode
  description?: ReactNode
  accent?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <div
      className={`flex min-h-[62px] flex-wrap items-center gap-3 px-4 py-3.5 ${
        accent ? 'bg-accent-500/10' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-semibold text-zinc-100">
          {title}
        </p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-zinc-500">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  )
}

function Switch({
  checked,
  disabled = false,
  onChange,
  label
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
}): JSX.Element {
  return (
    <label
      className={`relative inline-flex h-5 w-[34px] shrink-0 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus-ring)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--surface-card)] ${
          checked ? 'bg-accent-500' : 'bg-zinc-800'
        }`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-0.5 h-4 w-4 rounded-full transition-all ${
          checked ? 'left-4 bg-white' : 'left-0.5 bg-zinc-500'
        }`}
      />
    </label>
  )
}

function Stepper({
  value,
  min,
  max,
  onChange,
  label
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  label: string
}): JSX.Element {
  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg border border-white/10">
      <button
        type="button"
        aria-label={`${label}: decrease`}
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="w-8 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        −
      </button>
      <span className="w-12 select-none border-x border-white/10 text-center text-sm font-semibold leading-8 tabular-nums text-zinc-100">
        {value}
      </span>
      <button
        type="button"
        aria-label={`${label}: increase`}
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-8 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        +
      </button>
    </div>
  )
}

const THEME_PREVIEW: Record<
  AppTheme,
  { background: string; side: string; body: string; accent: string }
> = {
  // Fixed colorways copied from the mockup: each swatch previews that theme's
  // own surfaces, so it must stay constant regardless of the active theme.
  oled: { background: '#000000', side: '#141414', body: '#0a0a0a', accent: '#3b82f6' },
  dark: { background: '#121214', side: '#1d1d21', body: '#18181b', accent: '#3b82f6' },
  light: { background: '#fafafa', side: '#e6e6e8', body: '#ffffff', accent: '#2563eb' }
}

function ThemeOption({
  theme,
  selected,
  disabled,
  onSelect
}: {
  theme: AppTheme
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): JSX.Element {
  const preview = THEME_PREVIEW[theme]
  return (
    <label
      className={`flex cursor-pointer flex-col gap-2 rounded-[10px] border p-2 transition ${
        selected
          ? 'border-accent-500 ring-[3px] ring-accent-500/10'
          : 'border-white/10'
      } ${disabled ? 'cursor-not-allowed opacity-70' : ''}`}
    >
      <input
        type="radio"
        name="theme"
        value={theme}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className="grid h-[62px] grid-cols-[22px_1fr] gap-[5px] rounded-md border border-white/10 p-1.5"
        style={{ background: preview.background }}
      >
        <span className="rounded-[3px]" style={{ background: preview.side }} />
        <span
          className="rounded-[3px]"
          style={{
            background: preview.body,
            boxShadow: `inset 0 -14px 0 -10px ${preview.accent}`
          }}
        />
      </span>
      <span className="flex items-center justify-between px-0.5 font-semibold text-zinc-100">
        {THEME_LABEL[theme]}
        {selected ? (
          <Icon name="check" size={14} className="text-accent-400" />
        ) : null}
      </span>
    </label>
  )
}

function StatusPill({
  label,
  tone
}: {
  label: string
  tone: 'ok' | 'warn' | 'err'
}): JSX.Element {
  const toneText =
    tone === 'ok' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : 'text-red-400'
  const toneDot =
    tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : 'bg-red-400'
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${toneText}`}
    >
      <span aria-hidden="true" className={`h-[7px] w-[7px] rounded-full ${toneDot}`} />
      {label}
    </span>
  )
}
