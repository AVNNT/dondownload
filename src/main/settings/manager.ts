import {
  defaultDownloadSettings,
  parseDownloadSettings,
  type DownloadSettings
} from '@shared/settings'
import { AppError } from '../errors'

/** Minimal persistence port; `DownloadDatabase` satisfies this shape. */
export interface SettingsStore {
  loadSettings(): DownloadSettings
  saveSettings(settings: DownloadSettings): void
}

/** The subset of `Aria2Client` used to change global options. */
export interface SettingsAria2Client {
  call(method: string, params?: unknown[]): Promise<unknown>
}

/** Minimal aria2 port; `Aria2Service` satisfies this shape. */
export interface SettingsAria2Gateway {
  getReadyClient(): SettingsAria2Client | null
}

export interface SettingsManagerOptions {
  /** Null keeps defaults in memory and rejects updates (storage unavailable). */
  store: SettingsStore | null
  aria2: SettingsAria2Gateway | null
  /**
   * Notifies the download policy owner after a validated update is committed.
   * It never restarts aria2 or touches active transfers.
   */
  onChanged?: (settings: DownloadSettings) => void
}

/**
 * Map persistent settings to the aria2 `aria2.changeGlobalOption` payload.
 * These are the only three global options this milestone changes.
 */
export function toAria2GlobalOptions(
  settings: DownloadSettings
): Record<string, string> {
  return {
    'max-concurrent-downloads': String(settings.maxConcurrentDownloads),
    'max-connection-per-server': String(settings.perHostConnections),
    'max-overall-download-limit': String(settings.globalSpeedLimitBps)
  }
}

/** Apply the three global download limits through aria2's live RPC. */
export async function applyGlobalDownloadOptions(
  client: SettingsAria2Client,
  settings: DownloadSettings
): Promise<void> {
  await client.call('aria2.changeGlobalOption', [
    toAria2GlobalOptions(settings)
  ])
}

function cloneSettings(settings: DownloadSettings): DownloadSettings {
  return {
    ...settings,
    allowedHours: { ...settings.allowedHours }
  }
}

/**
 * Owns the runtime view of the persisted download settings.
 *
 * Updates are validated with the shared exact-key parser before anything is
 * persisted or sent to aria2. When aria2 is ready the new global options are
 * applied first and the settings row is saved only after aria2 accepts them;
 * both are rolled back to the previous values when a later step fails. The
 * service never restarts aria2 and never touches active downloads.
 */
export class SettingsManager {
  private readonly store: SettingsStore | null
  private readonly aria2: SettingsAria2Gateway | null
  private readonly onChanged: ((settings: DownloadSettings) => void) | null
  private current: DownloadSettings
  private startupApply: Promise<void> | null = null
  /**
   * Serializes every settings mutation. The live apply and the persisted row
   * must move together: two overlapping updates would otherwise each build
   * their payload from the same stale snapshot, and a failed rollback could
   * overwrite options the other update already applied.
   */
  private updateChain: Promise<void> = Promise.resolve()

  constructor(options: SettingsManagerOptions) {
    this.store = options.store
    this.aria2 = options.aria2
    this.onChanged = options.onChanged ?? null
    this.current = defaultDownloadSettings()

    if (!this.store) return
    try {
      // `DownloadDatabase` already parses on load; parse again so this service
      // never trusts a store implementation that skips the shared contract.
      this.current = parseDownloadSettings(this.store.loadSettings())
    } catch (error) {
      // Keep the app usable with safe defaults. Do not log settings values.
      const detail = error instanceof Error ? error.message : 'unknown error'
      console.error(`Download settings could not be loaded: ${detail}`)
    }
  }

  /** Return a copy so callers cannot mutate the runtime snapshot. */
  getSettings(): DownloadSettings {
    return cloneSettings(this.current)
  }

  /**
   * Apply the current settings before aria2 reports ready. Called by
   * `Aria2Service` while the process is still starting, so a failed apply
   * prevents a ready state rather than silently running with old options.
   */
  async applyStartup(
    client: SettingsAria2Client
  ): Promise<void> {
    const run = applyGlobalDownloadOptions(client, this.current)
    const tracked = run.finally(() => {
      if (this.startupApply === tracked) this.startupApply = null
    })
    this.startupApply = tracked
    return tracked
  }

  /**
   * Change only the global download limit (used by the tray and toolbar quick
   * presets). It delegates to `update`, so the same exact-key validation,
   * live aria2 apply/rollback, persistence and `onChanged` notification run as
   * for a value edited on the Settings page.
   */
  async setGlobalSpeedLimit(globalSpeedLimitBps: number): Promise<DownloadSettings> {
    // Merge inside the serialized critical section so a concurrent update to
    // another field is never reverted by a stale full snapshot.
    return this.enqueueUpdate(() =>
      this.applyUpdate(
        parseDownloadSettings({
          ...this.current,
          globalSpeedLimitBps
        })
      )
    )
  }

  /**
   * Validate and persist one complete settings object. Unknown/missing keys and
   * out-of-range values are rejected by the shared parser before persistence.
   * Updates are serialized so the live options and the saved row always
   * represent the same, latest snapshot.
   */
  async update(rawInput: unknown): Promise<DownloadSettings> {
    const next = parseDownloadSettings(rawInput)
    return this.enqueueUpdate(() => this.applyUpdate(next))
  }

  private enqueueUpdate(
    run: () => Promise<DownloadSettings>
  ): Promise<DownloadSettings> {
    const result = this.updateChain.then(run)
    // Keep the chain alive after a rejected update; the caller still observes
    // the rejection through `result`.
    this.updateChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async applyUpdate(next: DownloadSettings): Promise<DownloadSettings> {
    if (!this.store) {
      throw new AppError(
        'SETTINGS_UNAVAILABLE',
        'Download settings cannot be saved because storage is unavailable.'
      )
    }

    // An update that arrives while the startup apply is in flight waits for it;
    // by then aria2 has normally reported ready and the live path below applies
    // the new snapshot rather than letting startup win with stale options.
    if (this.startupApply) {
      try {
        await this.startupApply
      } catch {
        // Startup reports its own failure; a pending update still persists for
        // the next successful start.
      }
    }

    const previous = this.current
    const client = this.aria2?.getReadyClient() ?? null
    // An appearance-only update must never touch aria2. Download settings
    // still take the existing live apply/rollback path below.
    const downloadOptionsChanged =
      previous.maxConcurrentDownloads !== next.maxConcurrentDownloads ||
      previous.perHostConnections !== next.perHostConnections ||
      previous.globalSpeedLimitBps !== next.globalSpeedLimitBps
    let appliedLive = false

    if (client && downloadOptionsChanged) {
      try {
        await applyGlobalDownloadOptions(client, next)
        appliedLive = true
      } catch {
        // A partially applied option set is rolled back when aria2 is still
        // reachable. Persistence and the runtime snapshot stay on `previous`.
        await this.rollback(client, previous)
        throw new AppError(
          'SETTINGS_APPLY_FAILED',
          'The download settings could not be applied to aria2.',
          'Try again, or restart aria2 after saving the settings.'
        )
      }
    }

    try {
      this.store.saveSettings(next)
    } catch (error) {
      if (appliedLive && client) {
        await this.rollback(client, previous)
      }
      throw error
    }

    this.current = next
    try {
      this.onChanged?.(this.getSettings())
    } catch {
      // A policy listener must never turn a saved settings update into an
      // error response. The next policy tick still reads the new snapshot.
    }
    return cloneSettings(this.current)
  }

  private async rollback(
    client: SettingsAria2Client,
    previous: DownloadSettings
  ): Promise<void> {
    try {
      await applyGlobalDownloadOptions(client, previous)
    } catch (error) {
      // Persisted and cached state are still `previous`; only aria2 may keep a
      // partially applied option set. Never mask the original failure.
      const detail = error instanceof Error ? error.message : 'unknown error'
      console.error(`Download settings rollback failed: ${detail}`)
    }
  }
}
