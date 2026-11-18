import type { MenuItemConstructorOptions } from 'electron'
import type { DownloadFolderChoice } from '@shared/downloadDestination'
import type { CoreHost } from '../host'
import { AppError } from '../errors'
import {
  buildTrayMenuTemplate,
  clipboardUrlForMenu,
  canPauseAll,
  canResumeAll,
  trayStatusLine,
  type TrayDownloadLike,
  type TrayMediaJobLike,
  type TrayMenuActions,
  type TrayMenuState
} from '../trayMenu'
import type { DownloadDestinationStore } from '../downloads/destination'

/**
 * Isolated, opt-in hooks for `scripts/electron-features-verification.mjs`.
 *
 * The harness drives the real packaged renderer through CDP, but a few things
 * cannot be reached from a page: the native "Save to" dialog, the tray menu
 * (never created in smoke mode) and a Windows toast activation. This module
 * exposes those paths to the main-process inspector instead.
 *
 * Everything here is inert unless BOTH the existing smoke mode and the
 * explicit `DONDOWNLOAD_FEATURES_VERIFY=1` opt-in are present. A normal desktop
 * run therefore never defines the global, never records host calls and never
 * stubs a shell action. `tests/features-verification.test.ts` proves that.
 */

export const FEATURES_VERIFY_ENV = 'DONDOWNLOAD_FEATURES_VERIFY'
/** Name of the main-process global the harness evaluates against. */
export const FEATURES_VERIFY_GLOBAL = '__dondownloadFeaturesVerify'

export interface FeaturesVerificationGateInput {
  /** True only when the existing smoke configuration was accepted. */
  smokeEnabled: boolean
  env: NodeJS.ProcessEnv
}

/** The single gate: smoke mode plus the explicit features-verification opt-in. */
export function featuresVerificationEnabled(
  input: FeaturesVerificationGateInput
): boolean {
  return input.smokeEnabled && input.env[FEATURES_VERIFY_ENV] === '1'
}

/* ------------------------------------------------------------------------- *
 * Host call recorder
 * ------------------------------------------------------------------------- */

export interface HostCallRecord {
  method: 'openPath' | 'showItemInFolder'
  target: string
  at: number
}

export interface RecordingHost {
  host: CoreHost
  calls: readonly HostCallRecord[]
  clear: () => void
}

/**
 * Wrap the Electron host so "Open" and "Show in folder" are recorded instead
 * of reaching the shell. The renderer still goes through the real IPC →
 * DownloadManager → host path, so the recorded target is the exact path the
 * production code would have opened; only the final OS call is suppressed.
 */
export function createRecordingHost(
  inner: CoreHost,
  now: () => number = Date.now
): RecordingHost {
  const calls: HostCallRecord[] = []
  const host: CoreHost = {
    ...inner,
    // An empty string is Electron's "opened successfully" result.
    openPath: async (target: string) => {
      calls.push({ method: 'openPath', target, at: now() })
      return ''
    },
    showItemInFolder: (target: string) => {
      calls.push({ method: 'showItemInFolder', target, at: now() })
    }
  }
  return {
    host,
    calls,
    clear: () => {
      calls.length = 0
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Tray menu probe
 * ------------------------------------------------------------------------- */

export interface TrayMenuProbeItem {
  label: string
  type: string
  enabled: boolean
  checked: boolean | null
  /** True when the item has a click handler the probe can invoke. */
  clickable: boolean
  submenu: TrayMenuProbeItem[] | null
}

export interface TrayMenuProbeState {
  statusLine: string
  windowVisible: boolean
  canPauseAll: boolean
  canResumeAll: boolean
  speedLimitBps: number
  downloadCount: number
}

export interface TrayMenuProbeBuild {
  state: TrayMenuProbeState
  items: TrayMenuProbeItem[]
}

function submenuItems(
  submenu: MenuItemConstructorOptions['submenu']
): MenuItemConstructorOptions[] | null {
  if (submenu === undefined) return null
  if (Array.isArray(submenu)) return submenu
  return null
}

/** JSON-safe view of a native menu template, without any click closures. */
export function serializeMenuTemplate(
  template: readonly MenuItemConstructorOptions[]
): TrayMenuProbeItem[] {
  return template.map((item) => ({
    label: typeof item.label === 'string' ? item.label : '',
    type: item.type ?? (item.label === undefined ? 'separator' : 'normal'),
    enabled: item.enabled !== false,
    checked: typeof item.checked === 'boolean' ? item.checked : null,
    clickable: typeof item.click === 'function',
    submenu: (() => {
      const children = submenuItems(item.submenu)
      return children === null ? null : serializeMenuTemplate(children)
    })()
  }))
}

export interface TrayMenuProbePorts {
  windowVisible: () => boolean
  downloads: () => readonly TrayDownloadLike[]
  mediaJobs: () => readonly TrayMediaJobLike[]
  speedLimitBps: () => number
  /** Raw clipboard text; only read when the probe does not override it. */
  readClipboardText: () => string | Promise<string>
  actions: TrayMenuActions
}

/**
 * Builds the production tray template with live app state and keeps the last
 * template so one item's real click handler can be invoked by path.
 *
 * The template itself is built by `buildTrayMenuTemplate`, the same function
 * `src/main/tray.ts` calls when the menu is about to open; this class only
 * adds serialization and a way to press an item without popping up a native
 * menu on the user's desktop.
 */
export class TrayMenuProbe {
  private template: readonly MenuItemConstructorOptions[] = []

  constructor(private readonly ports: TrayMenuProbePorts) {}

  build(clipboardText?: string | null): TrayMenuProbeBuild {
    const rawClipboard =
      clipboardText === undefined
        ? this.ports.readClipboardText()
        : clipboardText
    // A promise-returning clipboard read disables "Add from clipboard" in the
    // real tray too; the probe mirrors that instead of awaiting.
    const clipboardUrl =
      typeof rawClipboard === 'string' ? clipboardUrlForMenu(rawClipboard) : null
    const state: TrayMenuState = {
      windowVisible: this.ports.windowVisible(),
      downloads: this.ports.downloads(),
      mediaJobs: this.ports.mediaJobs(),
      speedLimitBps: this.ports.speedLimitBps(),
      clipboardUrl
    }
    this.template = buildTrayMenuTemplate(state, this.ports.actions)
    return {
      state: {
        statusLine: trayStatusLine(state.downloads),
        windowVisible: state.windowVisible,
        canPauseAll: canPauseAll(state),
        canResumeAll: canResumeAll(state),
        speedLimitBps: state.speedLimitBps,
        downloadCount: state.downloads.length
      },
      items: serializeMenuTemplate(this.template)
    }
  }

  /** Press the item at `[top, child, grandchild…]` from the last build. */
  invoke(path: readonly number[]): {
    invoked: boolean
    label: string
    reason: string | null
  } {
    let items: readonly MenuItemConstructorOptions[] = this.template
    let item: MenuItemConstructorOptions | undefined
    for (const index of path) {
      item = items[index]
      if (item === undefined) {
        return { invoked: false, label: '', reason: 'item-not-found' }
      }
      items = submenuItems(item.submenu) ?? []
    }
    if (item === undefined) {
      return { invoked: false, label: '', reason: 'empty-path' }
    }
    const label = typeof item.label === 'string' ? item.label : ''
    if (item.enabled === false) {
      return { invoked: false, label, reason: 'disabled' }
    }
    if (typeof item.click !== 'function') {
      return { invoked: false, label, reason: 'not-clickable' }
    }
    // Electron passes (menuItem, window, event); the tray handlers in this app
    // ignore all three, so the probe can press the item without a native menu.
    ;(item.click as unknown as () => void)()
    return { invoked: true, label, reason: null }
  }
}

/* ------------------------------------------------------------------------- *
 * Installed hooks
 * ------------------------------------------------------------------------- */

export interface DestinationProbeResult {
  ok: boolean
  token: string | null
  path: string | null
  code: string | null
  message: string | null
}

export interface WindowProbeState {
  visible: boolean
  focused: boolean
  destroyed: boolean
  offscreen: boolean
}

export interface FeaturesVerificationHooks {
  appVersion: string
  tray: () => TrayMenuProbe
  /** Proves the harness window never appeared or took focus. */
  windowState: () => WindowProbeState
  registerDestination: (directory: unknown) => DestinationProbeResult
  resolveDestination: (token: unknown) => string | null
  /** Invoke the completion-toast activation callback with real arguments. */
  notificationActivate: (
    kind: 'download' | 'media',
    id: string,
    action: 'activate' | 'open' | 'show'
  ) => void
  /** Write one line through the production logger so redaction can be checked. */
  probeLog: (message: string) => void
  hostCalls: () => readonly HostCallRecord[]
  clearHostCalls: () => void
}

export interface InstalledFeaturesVerification extends FeaturesVerificationHooks {
  enabled: true
}

export interface InstallFeaturesVerificationInput {
  enabled: boolean
  hooks: FeaturesVerificationHooks
  globalObject?: Record<string, unknown>
}

/**
 * Publish the hooks on the main-process global for the inspector.
 *
 * Returns false and touches nothing when not explicitly enabled, which is what
 * makes the whole module inert for a normal desktop run.
 */
export function installFeaturesVerification(
  input: InstallFeaturesVerificationInput
): boolean {
  if (!input.enabled) return false
  const target = input.globalObject ?? (globalThis as Record<string, unknown>)
  target[FEATURES_VERIFY_GLOBAL] = input.hooks
  return true
}

/** Build the register/resolve probes over the production token store. */
export function createDestinationProbe(
  store: DownloadDestinationStore
): Pick<FeaturesVerificationHooks, 'registerDestination' | 'resolveDestination'> {
  return {
    registerDestination: (directory: unknown): DestinationProbeResult => {
      try {
        if (typeof directory !== 'string') {
          throw new AppError(
            'DOWNLOAD_FOLDER_INVALID',
            'That download folder cannot be used.'
          )
        }
        const choice: DownloadFolderChoice = store.register(directory)
        return {
          ok: true,
          token: choice.token,
          path: choice.path,
          code: null,
          message: null
        }
      } catch (error) {
        return {
          ok: false,
          token: null,
          path: null,
          code:
            error instanceof AppError
              ? error.code
              : ((error as { code?: string }).code ?? 'DOWNLOAD_FOLDER_INVALID'),
          message: error instanceof Error ? error.message : 'unknown error'
        }
      }
    },
    resolveDestination: (token: unknown) => store.resolve(token)
  }
}
