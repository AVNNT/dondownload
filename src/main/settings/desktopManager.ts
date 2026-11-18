import {
  parseDesktopSettings,
  defaultDesktopSettings,
  type DesktopSettings
} from '@shared/desktopSettings'
import { AppError } from '../errors'
import { logError } from '../logging'

/** Minimal persistence port; `DownloadDatabase` satisfies this shape. */
export interface DesktopSettingsStore {
  loadDesktopSettings(): DesktopSettings
  saveDesktopSettings(settings: DesktopSettings): void
}

export interface DesktopSettingsManagerOptions {
  store: DesktopSettingsStore | null
  /** Applies side effects (zoom, login item, clipboard watcher) after a save. */
  onChanged?: (settings: DesktopSettings) => void
}

function clone(settings: DesktopSettings): DesktopSettings {
  return { ...settings }
}

/**
 * Owns desktop-only preferences. Unlike the aria2 settings manager this never
 * talks to the engine: an appearance or privacy change must not touch live
 * transfers. Values are validated with the shared exact-key parser before they
 * are persisted, and storage failure leaves the previous snapshot in place.
 */
export class DesktopSettingsManager {
  private readonly store: DesktopSettingsStore | null
  private readonly onChanged: ((settings: DesktopSettings) => void) | null
  private current: DesktopSettings

  constructor(options: DesktopSettingsManagerOptions) {
    this.store = options.store
    this.onChanged = options.onChanged ?? null
    this.current = defaultDesktopSettings()

    if (!this.store) return
    try {
      this.current = parseDesktopSettings(this.store.loadDesktopSettings())
    } catch (error) {
      // Keep safe defaults; never log settings values.
      const detail = error instanceof Error ? error.message : 'unknown error'
      logError('Desktop settings could not be loaded: %s', detail)
    }
  }

  getSettings(): DesktopSettings {
    return clone(this.current)
  }

  async update(rawInput: unknown): Promise<DesktopSettings> {
    const next = parseDesktopSettings(rawInput)
    if (!this.store) {
      throw new AppError(
        'SETTINGS_UNAVAILABLE',
        'Desktop settings cannot be saved because storage is unavailable.'
      )
    }

    this.store.saveDesktopSettings(next)
    this.current = next
    try {
      this.onChanged?.(this.getSettings())
    } catch {
      // A side-effect listener must never turn a saved update into an error.
    }
    return clone(this.current)
  }

  /**
   * Mark the first-start guide as seen without sending the whole settings
   * object through the renderer. A read-modify-write from the UI could revert a
   * concurrent change (for example a notification toggle) to a stale value.
   */
  markWelcomeGuideSeen(): DesktopSettings {
    if (!this.store) {
      throw new AppError(
        'SETTINGS_UNAVAILABLE',
        'Desktop settings cannot be saved because storage is unavailable.'
      )
    }
    if (this.current.welcomeGuideSeen) return clone(this.current)
    const next: DesktopSettings = { ...this.current, welcomeGuideSeen: true }
    this.store.saveDesktopSettings(next)
    this.current = next
    try {
      this.onChanged?.(this.getSettings())
    } catch {
      // A side-effect listener must never turn a saved update into an error.
    }
    return clone(this.current)
  }
}
