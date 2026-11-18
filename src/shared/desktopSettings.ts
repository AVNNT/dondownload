import { ValidationError } from './errors'

/**
 * Desktop-only preferences that never touch aria2.
 *
 * They are stored separately from `DownloadSettings` so a notification,
 * clipboard or appearance change can never rewrite aria2's live global options.
 * Every value is a renderer-safe primitive; no URL, path or secret is stored.
 */

/** Supported interface scales. Values are integer percent. */
export const INTERFACE_SIZES = [90, 100, 110, 125] as const
export type InterfaceSize = (typeof INTERFACE_SIZES)[number]

export const DEFAULT_INTERFACE_SIZE: InterfaceSize = 100
export const DEFAULT_RESUME_INTERRUPTED_ON_STARTUP = true
export const DEFAULT_SHOW_NOTIFICATIONS = false
export const DEFAULT_WATCH_CLIPBOARD = false
export const DEFAULT_LAUNCH_AT_LOGIN = false
export const DEFAULT_EXIT_TO_TRAY_STUB_WHEN_IDLE = true
/**
 * The first-start guide is shown once. A fresh profile (and an upgraded one)
 * starts with `false`; closing or skipping the guide persists `true`.
 */
export const DEFAULT_WELCOME_GUIDE_SEEN = false

/** Non-secret command-line argument used by the login item to start hidden. */
export const START_HIDDEN_ARG = '--hidden'
export const LOGIN_ITEM_ARGS: readonly string[] = [START_HIDDEN_ARG]

export interface DesktopSettings {
  /** Resume recovery-interrupted downloads with partial data on startup. */
  resumeInterruptedOnStartup: boolean
  /** Show a Windows notification when a download or media job finishes. */
  showNotifications: boolean
  /** Poll the clipboard for a single http(s) link while the app runs. */
  watchClipboard: boolean
  /** Register the packaged app to start when the user signs in. */
  launchAtLogin: boolean
  /**
   * Replace the idle app with the native tray stub while it sits in the tray
   * with nothing to do, freeing most of its memory.
   */
  exitToTrayStubWhenIdle: boolean
  /** True once the first-start guide has been shown and dismissed. */
  welcomeGuideSeen: boolean
  /** Renderer zoom percentage. */
  interfaceSizePercent: InterfaceSize
}

export function defaultDesktopSettings(): DesktopSettings {
  return {
    resumeInterruptedOnStartup: DEFAULT_RESUME_INTERRUPTED_ON_STARTUP,
    showNotifications: DEFAULT_SHOW_NOTIFICATIONS,
    watchClipboard: DEFAULT_WATCH_CLIPBOARD,
    launchAtLogin: DEFAULT_LAUNCH_AT_LOGIN,
    exitToTrayStubWhenIdle: DEFAULT_EXIT_TO_TRAY_STUB_WHEN_IDLE,
    welcomeGuideSeen: DEFAULT_WELCOME_GUIDE_SEEN,
    interfaceSizePercent: DEFAULT_INTERFACE_SIZE
  }
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid desktop settings payload.')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[]
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key)) {
      throw new ValidationError(
        'The desktop settings payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        'The desktop settings payload is missing required fields.'
      )
    }
  }
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new ValidationError(
      'The desktop settings payload contains an invalid flag.'
    )
  }
  return value
}

/** True only for one of the four supported zoom percentages. */
export function isInterfaceSize(value: unknown): value is InterfaceSize {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (INTERFACE_SIZES as readonly number[]).includes(value)
  )
}

export function parseInterfaceSize(value: unknown): InterfaceSize {
  if (!isInterfaceSize(value)) {
    throw new ValidationError('Invalid interface size.')
  }
  return value
}

/** Renderer zoom factor for an already validated percentage. */
export function zoomFactorFor(size: InterfaceSize): number {
  return size / 100
}

/**
 * Step through the supported zoom levels.
 *
 * `direction` 0 resets to 100%; -1 and +1 move one supported step and clamp at
 * the ends. Ctrl+= / Ctrl+- use this so the persisted value can never hold an
 * unsupported intermediate percentage.
 */
export function nextInterfaceSize(
  current: InterfaceSize,
  direction: -1 | 0 | 1
): InterfaceSize {
  if (direction === 0) return DEFAULT_INTERFACE_SIZE
  const index = INTERFACE_SIZES.indexOf(current)
  const next = Math.min(
    INTERFACE_SIZES.length - 1,
    Math.max(0, index + direction)
  )
  return INTERFACE_SIZES[next] ?? DEFAULT_INTERFACE_SIZE
}

/** Parse the full exact-key desktop settings object. */
export function parseDesktopSettings(value: unknown): DesktopSettings {
  const record = asPlainObject(value)
  exactKeys(record, [
    'resumeInterruptedOnStartup',
    'showNotifications',
    'watchClipboard',
    'launchAtLogin',
    'exitToTrayStubWhenIdle',
    'welcomeGuideSeen',
    'interfaceSizePercent'
  ])
  return {
    resumeInterruptedOnStartup: booleanValue(
      record,
      'resumeInterruptedOnStartup'
    ),
    showNotifications: booleanValue(record, 'showNotifications'),
    watchClipboard: booleanValue(record, 'watchClipboard'),
    launchAtLogin: booleanValue(record, 'launchAtLogin'),
    exitToTrayStubWhenIdle: booleanValue(record, 'exitToTrayStubWhenIdle'),
    welcomeGuideSeen: booleanValue(record, 'welcomeGuideSeen'),
    interfaceSizePercent: parseInterfaceSize(record.interfaceSizePercent)
  }
}
