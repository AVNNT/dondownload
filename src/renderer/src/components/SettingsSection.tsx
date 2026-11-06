import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode
} from 'react'
import {
  APP_THEMES,
  MAX_MAX_CONCURRENT_DOWNLOADS,
  MAX_PER_HOST_CONNECTIONS,
  MIN_MAX_CONCURRENT_DOWNLOADS,
  MIN_PER_HOST_CONNECTIONS,
  type AppTheme,
  type DownloadSettings
} from '@shared/settings'
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
import {
  HOURS_EQUAL_HINT,
  MAX_SPEED_MB,
  SAVED_HINT_MS,
  TEXT_SAVE_DEBOUNCE_MS,
  applyHoursEdit,
  hoursConflict,
  parseSpeedLimitMb,
  settingsPayload,
  speedInputValue,
  speedLimitHelper,
  toggleAllowedHours
} from '../settingsAutoSave'
import { Icon } from './Icon'

const THEME_LABEL: Record<AppTheme, string> = {
  oled: 'OLED',
  dark: 'Dark',
  light: 'Light'
}

/* Reusable token-based control classes (see src/renderer/src/styles.css). */
const BTN_PRIMARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent-500 px-3 text-xs font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400'
const BTN_GHOST =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 surface-card px-3 text-xs font-medium text-zinc-200 transition hover:border-accent-400/40 hover:text-accent-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:opacity-60'
const FIELD =
  'h-8 rounded-lg border border-white/10 surface-input px-2.5 text-xs text-zinc-100 outline-none transition focus:border-accent-400/50 disabled:cursor-not-allowed disabled:opacity-50'
const FIELD_INVALID = 'border-red-500/60 focus:border-red-400'
const SELECT =
  'h-8 rounded-lg border border-white/10 surface-input px-2 text-xs font-semibold text-zinc-100 outline-none transition focus:border-accent-400/50 disabled:cursor-not-allowed disabled:opacity-50'
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

/**
 * Transient auto-save indicator rendered next to a section title.
 *
 * `idle` renders nothing, so the heading never reserves space for a hint that
 * is not there. `saved` fades out on its own; `error` stays until the next
 * successful save or an explicit retry.
 */
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback
}

export function SettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [draft, setDraft] = useState<DownloadSettings | null>(null)
  const [speedInput, setSpeedInput] = useState('')
  const [speedError, setSpeedError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [downloadsSave, setDownloadsSave] = useState<SaveState>({
    kind: 'idle'
  })
  const [desktopSave, setDesktopSave] = useState<SaveState>({ kind: 'idle' })
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

  /** Latest saved download settings, readable from async callbacks. */
  const savedRef = useRef<DownloadSettings | null>(null)
  /** Latest draft, so a coalesced save always commits the newest values. */
  const draftRef = useRef<DownloadSettings | null>(null)
  const desktopDraftRef = useRef<DesktopSettings>(defaultDesktopSettings())

  /** Serializes download-settings saves so an older round trip can never win. */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const downloadsQueuedRef = useRef(false)
  /** Serializes desktop-preference saves. */
  const desktopChainRef = useRef<Promise<void>>(Promise.resolve())
  const desktopQueuedRef = useRef(false)
  const speedTimerRef = useRef<number | null>(null)
  const savedFadeTimerRef = useRef<number | null>(null)
  const desktopSavedFadeTimerRef = useRef<number | null>(null)

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
      desktopDraftRef.current = next
      setDesktopDraft(next)
    }
    void window.donDownload.getDesktopSettings().then((result) => {
      if (cancelled) return
      if (result.ok) apply(result.value)
      else {
        setDesktopSave({ kind: 'error', message: result.error.message })
      }
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
        savedRef.current = result.value
        draftRef.current = result.value
        setSettings(result.value)
        setDraft(result.value)
        setSpeedInput(speedInputValue(result.value.globalSpeedLimitBps))
      } else {
        setLoadError(result.error.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Clear pending timers when the page unmounts; the debounced save has
  // already been committed by the blur/blur-free path or is simply dropped.
  useEffect(() => {
    return () => {
      if (speedTimerRef.current !== null) {
        window.clearTimeout(speedTimerRef.current)
        speedTimerRef.current = null
      }
      if (savedFadeTimerRef.current !== null) {
        window.clearTimeout(savedFadeTimerRef.current)
        savedFadeTimerRef.current = null
      }
      if (desktopSavedFadeTimerRef.current !== null) {
        window.clearTimeout(desktopSavedFadeTimerRef.current)
        desktopSavedFadeTimerRef.current = null
      }
    }
  }, [])

  const scheduleSavedFade = useCallback((): void => {
    if (savedFadeTimerRef.current !== null) {
      window.clearTimeout(savedFadeTimerRef.current)
    }
    savedFadeTimerRef.current = window.setTimeout(() => {
      savedFadeTimerRef.current = null
      setDownloadsSave((current) =>
        current.kind === 'saved' ? { kind: 'idle' } : current
      )
    }, SAVED_HINT_MS)
  }, [])

  const scheduleDesktopSavedFade = useCallback((): void => {
    if (desktopSavedFadeTimerRef.current !== null) {
      window.clearTimeout(desktopSavedFadeTimerRef.current)
    }
    desktopSavedFadeTimerRef.current = window.setTimeout(() => {
      desktopSavedFadeTimerRef.current = null
      setDesktopSave((current) =>
        current.kind === 'saved' ? { kind: 'idle' } : current
      )
    }, SAVED_HINT_MS)
  }, [])

  const clearSpeedTimer = useCallback((): void => {
    if (speedTimerRef.current !== null) {
      window.clearTimeout(speedTimerRef.current)
      speedTimerRef.current = null
    }
  }, [])

  /**
   * Persist the newest draft. Saves are serialized: a second change while a
   * round trip is in flight is coalesced into one follow-up save that reads
   * the draft at the moment it starts, so the last value always wins.
   */
  const queueDownloadsSave = useCallback((): void => {
    if (downloadsQueuedRef.current) return
    downloadsQueuedRef.current = true
    setDownloadsSave({ kind: 'saving' })
    saveChainRef.current = saveChainRef.current.then(async () => {
      downloadsQueuedRef.current = false
      const next = draftRef.current
      if (!next) return
      try {
        const result = await window.donDownload.updateSettings(
          settingsPayload(next, savedRef.current)
        )
        if (!result.ok) {
          setDownloadsSave({ kind: 'error', message: result.error.message })
          return
        }
        savedRef.current = result.value
        setSettings(result.value)
        // The theme is owned by its own immediate save; keep the draft's.
        if (draftRef.current) {
          draftRef.current = {
            ...result.value,
            theme: draftRef.current.theme
          }
        }
        setDraft((current) =>
          current ? { ...result.value, theme: current.theme } : result.value
        )
        setDownloadsSave({ kind: 'saved' })
        scheduleSavedFade()
      } catch (error) {
        setDownloadsSave({
          kind: 'error',
          message: errorMessage(error, 'The settings could not be saved.')
        })
      }
    })
  }, [scheduleSavedFade])

  const queueDesktopSave = useCallback((): void => {
    if (desktopQueuedRef.current) return
    desktopQueuedRef.current = true
    setDesktopSave({ kind: 'saving' })
    desktopChainRef.current = desktopChainRef.current.then(async () => {
      desktopQueuedRef.current = false
      const next = desktopDraftRef.current
      try {
        const result = await window.donDownload.updateDesktopSettings(next)
        if (!result.ok) {
          setDesktopSave({ kind: 'error', message: result.error.message })
          return
        }
        setDesktopSave({ kind: 'saved' })
        scheduleDesktopSavedFade()
      } catch (error) {
        setDesktopSave({
          kind: 'error',
          message: errorMessage(
            error,
            'The desktop preferences could not be saved.'
          )
        })
      }
    })
  }, [scheduleDesktopSavedFade])

  /**
   * Apply a download-settings change and save it immediately. Used by steppers,
   * toggles and the time fields, where there is no free-form text to validate.
   */
  const commitDownloads = useCallback(
    (patch: Partial<DownloadSettings>): void => {
      if (!draftRef.current) return
      const next: DownloadSettings = { ...draftRef.current, ...patch }
      draftRef.current = next
      setDraft(next)
      queueDownloadsSave()
    },
    [queueDownloadsSave]
  )

  const commitAllowedHours = useCallback(
    (patch: Partial<DownloadSettings['allowedHours']>): void => {
      if (!draftRef.current) return
      commitDownloads({
        allowedHours: { ...draftRef.current.allowedHours, ...patch }
      })
    },
    [commitDownloads]
  )

  const commitDesktop = useCallback(
    (patch: Partial<DesktopSettings>): void => {
      const next: DesktopSettings = { ...desktopDraftRef.current, ...patch }
      desktopDraftRef.current = next
      setDesktopDraft(next)
      queueDesktopSave()
    },
    [queueDesktopSave]
  )

  /**
   * Flush a pending speed-limit edit. Returns false when the text is invalid;
   * invalid text is never written to the draft or to the main process.
   */
  const commitSpeedInput = useCallback((): boolean => {
    clearSpeedTimer()
    const parsed = parseSpeedLimitMb(speedInput)
    if (!parsed.ok) {
      setSpeedError(parsed.hint)
      return false
    }
    setSpeedError(null)
    if (parsed.bps === savedRef.current?.globalSpeedLimitBps) {
      // Nothing changed: drop any debounce that was still waiting.
      return true
    }
    commitDownloads({ globalSpeedLimitBps: parsed.bps })
    return true
  }, [clearSpeedTimer, commitDownloads, speedInput])

  const handleSpeedInput = (value: string): void => {
    setSpeedInput(value)
    const parsed = parseSpeedLimitMb(value)
    setSpeedError(parsed.ok ? null : parsed.hint)
    clearSpeedTimer()
    if (!parsed.ok) return
    speedTimerRef.current = window.setTimeout(() => {
      speedTimerRef.current = null
      if (parsed.bps === savedRef.current?.globalSpeedLimitBps) return
      commitDownloads({ globalSpeedLimitBps: parsed.bps })
    }, TEXT_SAVE_DEBOUNCE_MS)
  }

  const handleHoursChange = (patch: {
    start?: string
    end?: string
  }): void => {
    const current = draftRef.current?.allowedHours
    if (!current) return
    const next = applyHoursEdit(current, patch)
    if (next) commitAllowedHours(next)
  }

  const handleHoursToggle = (enabled: boolean): void => {
    const current = draftRef.current?.allowedHours
    if (!current) return
    commitAllowedHours(toggleAllowedHours(current, enabled))
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
    applyRendererTheme(theme)
    setDraft((current) => (current ? { ...current, theme } : current))
    if (draftRef.current) draftRef.current = { ...draftRef.current, theme }

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
        if (draftRef.current) {
          draftRef.current = { ...draftRef.current, theme: previousTheme }
        }
        setDownloadsSave({ kind: 'error', message: result.error.message })
        return
      }
      const saved = result.value
      savedRef.current = saved
      setSettings(saved)
      setDraft((current) =>
        current ? { ...current, theme: saved.theme } : saved
      )
      if (draftRef.current) {
        draftRef.current = { ...draftRef.current, theme: saved.theme }
      }
      setDownloadsSave({ kind: 'saved' })
      scheduleSavedFade()
    } catch (error) {
      applyRendererTheme(previousTheme)
      setDraft((current) =>
        current ? { ...current, theme: previousTheme } : current
      )
      if (draftRef.current) {
        draftRef.current = { ...draftRef.current, theme: previousTheme }
      }
      setDownloadsSave({
        kind: 'error',
        message: errorMessage(error, 'The appearance could not be saved.')
      })
    } finally {
      setThemePending(false)
    }
  }

  const retryDownloadsSave = (): void => {
    if (draftRef.current && parseSpeedLimitMb(speedInput) !== null) {
      queueDownloadsSave()
    }
  }

  const retryDesktopSave = (): void => {
    queueDesktopSave()
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

  if (!draft) {
    return (
      <div aria-labelledby="settings-heading" className="space-y-6">
        <header className="flex h-14 items-center border-b border-white/[0.07]">
          <h1
            id="settings-heading"
            className="text-[15px] font-semibold text-zinc-100"
          >
            Settings
          </h1>
        </header>
        <p
          role={loadError ? 'alert' : undefined}
          className={`text-xs ${loadError ? 'text-red-400' : 'text-zinc-500'}`}
        >
          {loadError ?? 'Loading settings…'}
        </p>
      </div>
    )
  }

  const appReady =
    appUpdateState?.status === 'ready' && appUpdateState?.canInstall === true
  const ytdlpStatus = ytdlpStatusInfo(updateState)
  const checkedLabel = relativeChecked(updateState?.lastCheckedAt)

  const hoursEnabled = draft.allowedHours.enabled
  const hoursEqual = hoursConflict(draft.allowedHours)
  const speedHelper = speedLimitHelper(draft.globalSpeedLimitBps)

  return (
    <div aria-labelledby="settings-heading" className="space-y-7">
      <header className="flex h-14 items-center border-b border-white/[0.07]">
        <h1
          id="settings-heading"
          className="text-[15px] font-semibold text-zinc-100"
        >
          Settings
        </h1>
      </header>

      <section aria-labelledby="settings-transfers">
        <SectionHeading
          id="settings-transfers"
          title="Transfers"
          description="How many files download at once, and how fast."
          status={
            <SaveStatus
              state={downloadsSave}
              onRetry={retryDownloadsSave}
            />
          }
        />
        {/* A form element keeps Enter inside a text field from submitting
            anything: these fields save on their own via blur/debounce. */}
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            commitSpeedInput()
          }}
        >
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
                onChange={(value) =>
                  commitDownloads({ maxConcurrentDownloads: value })
                }
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
                onChange={(value) =>
                  commitDownloads({ perHostConnections: value })
                }
              />
            </SettingRow>

            <SettingRow
              title="Speed limit"
              description="Applies to all downloads together."
              hint={
                speedError ? (
                  <span id="settings-speed-error" className="text-red-400">
                    {speedError}
                  </span>
                ) : speedHelper ? (
                  <span id="settings-speed-helper">{speedHelper}</span>
                ) : null
              }
            >
              <div className="flex h-8 items-center gap-2">
                <input
                  aria-label="Global speed limit in MB per second"
                  aria-invalid={speedError ? true : undefined}
                  aria-describedby={
                    speedError
                      ? 'settings-speed-error'
                      : speedHelper
                        ? 'settings-speed-helper'
                        : undefined
                  }
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={MAX_SPEED_MB}
                  step="any"
                  placeholder="No limit"
                  value={speedInput}
                  onChange={(event) =>
                    handleSpeedInput(event.currentTarget.value)
                  }
                  onBlur={() => {
                    commitSpeedInput()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitSpeedInput()
                    }
                  }}
                  className={`${FIELD} w-28 tabular-nums ${
                    speedError ? FIELD_INVALID : ''
                  }`}
                />
                <span
                  className="flex h-8 items-center rounded-lg border border-white/10 surface-input px-2 text-xs font-semibold text-zinc-300"
                  aria-hidden="true"
                >
                  MB/s
                </span>
              </div>
            </SettingRow>

            <SettingRow
              title="Only download during set hours"
              description={
                hoursEnabled
                  ? `Queued files wait for ${draft.allowedHours.start} – ${draft.allowedHours.end}. Running downloads finish.`
                  : 'Limit new downloads to a set window. Running downloads finish.'
              }
              hint={
                hoursEqual ? (
                  <span id="settings-hours-error" className="text-red-400">
                    {HOURS_EQUAL_HINT}
                  </span>
                ) : null
              }
            >
              <div
                className={`flex h-8 items-center gap-2 transition-opacity ${
                  hoursEnabled ? '' : 'opacity-50'
                }`}
              >
                <input
                  aria-label="Allowed hours start"
                  aria-invalid={hoursEqual ? true : undefined}
                  aria-describedby={
                    hoursEqual ? 'settings-hours-error' : undefined
                  }
                  type="time"
                  step={60}
                  value={draft.allowedHours.start}
                  disabled={!hoursEnabled}
                  onChange={(event) =>
                    handleHoursChange({ start: event.currentTarget.value })
                  }
                  className={`${FIELD} ${hoursEqual ? FIELD_INVALID : ''}`}
                />
                <span className="text-xs text-zinc-500">to</span>
                <input
                  aria-label="Allowed hours end"
                  aria-invalid={hoursEqual ? true : undefined}
                  aria-describedby={
                    hoursEqual ? 'settings-hours-error' : undefined
                  }
                  type="time"
                  step={60}
                  value={draft.allowedHours.end}
                  disabled={!hoursEnabled}
                  onChange={(event) =>
                    handleHoursChange({ end: event.currentTarget.value })
                  }
                  className={`${FIELD} ${hoursEqual ? FIELD_INVALID : ''}`}
                />
              </div>
              <Switch
                checked={hoursEnabled}
                label="Only download during set hours"
                onChange={handleHoursToggle}
              />
            </SettingRow>
          </div>
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
                disabled={themePending}
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
              value={desktopDraft.interfaceSizePercent}
              onChange={(event) =>
                commitDesktop({
                  interfaceSizePercent: Number(
                    event.currentTarget.value
                  ) as DesktopSettings['interfaceSizePercent']
                })
              }
              className={SELECT}
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
          status={
            <SaveStatus state={desktopSave} onRetry={retryDesktopSave} />
          }
        />
        <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
          <SettingRow
            title="Start when I sign in to Windows"
            description="Opens minimised to the tray."
          >
            <Switch
              checked={desktopDraft.launchAtLogin}
              label="Start when I sign in to Windows"
              onChange={(checked) => commitDesktop({ launchAtLogin: checked })}
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
                commitDesktop({ resumeInterruptedOnStartup: checked })
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
              onChange={(checked) => commitDesktop({ showNotifications: checked })}
            />
          </SettingRow>
          <SettingRow
            title="Watch the clipboard for links"
            description="When you copy a link, DonDownload offers to add it. Nothing downloads on its own."
          >
            <Switch
              checked={desktopDraft.watchClipboard}
              label="Watch the clipboard for links"
              onChange={(checked) => commitDesktop({ watchClipboard: checked })}
            />
          </SettingRow>
        </div>
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

/**
 * Small, unobtrusive save indicator that lives next to a section title:
 * "Saving…", a fading "Saved", or "Couldn't save — <reason>" with a retry.
 */
function SaveStatus({
  state,
  onRetry
}: {
  state: SaveState
  onRetry: () => void
}): JSX.Element | null {
  if (state.kind === 'idle') return null
  if (state.kind === 'error') {
    return (
      <span
        role="status"
        aria-live="polite"
        className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-red-400"
      >
        <span className="truncate" title={`Couldn't save — ${state.message}`}>
          {`Couldn't save — ${state.message}`}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded font-semibold underline underline-offset-2 transition hover:text-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300"
        >
          Retry
        </button>
      </span>
    )
  }
  return (
    <span
      role="status"
      aria-live="polite"
      className={`text-[11px] leading-4 transition-opacity duration-500 ${
        state.kind === 'saved'
          ? 'text-emerald-400 opacity-100'
          : 'text-zinc-500 opacity-100'
      }`}
    >
      {state.kind === 'saved' ? 'Saved' : 'Saving…'}
    </span>
  )
}

function SectionHeading({
  id,
  title,
  description,
  status
}: {
  id: string
  title: string
  description: ReactNode
  status?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-3">
      <div className="flex min-h-5 items-baseline justify-between gap-3">
        <h2 id={id} className="text-base font-semibold text-zinc-100">
          {title}
        </h2>
        {status ? <div className="shrink-0">{status}</div> : null}
      </div>
      <p className="mt-0.5 text-xs leading-5 text-zinc-400">{description}</p>
    </div>
  )
}

/**
 * One settings row: label and one-line description on the left, the control
 * right-aligned, with the same height and padding everywhere. `hint` renders
 * an optional inline message (validation or helper) under the description.
 */
function SettingRow({
  title,
  description,
  hint,
  accent = false,
  children
}: {
  title: ReactNode
  description?: ReactNode
  hint?: ReactNode
  accent?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <div
      className={`flex min-h-[62px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3.5 ${
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
        {hint ? (
          <p className="mt-1 text-[11px] leading-4 text-zinc-500">{hint}</p>
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
