import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import trayIconPath from './assets/tray.ico?asset'
import { logError } from './logging'
import {
  TRAY_TOOLTIP_INTERVAL_MS,
  buildTrayMenuTemplate,
  clipboardUrlForMenu,
  hasActiveDownloads,
  trayTooltip,
  type TrayDownloadLike,
  type TrayMediaJobLike,
  type TrayMenuActions,
  type TrayMenuState
} from './trayMenu'

export interface TrayActions extends Omit<TrayMenuActions, 'quit'> {
  quit: () => void
  /** True while the main window is shown (drives the Show/Hide item). */
  isWindowVisible: () => boolean
  /** Current global download limit in bytes per second (`0` = unlimited). */
  getSpeedLimitBps: () => number
  /** Apply one of the quick presets through the settings update path. */
  setSpeedLimitBps: (bps: number) => void
  /** Raw download rows for the status line and the Recent submenu. */
  getDownloads: () => readonly TrayDownloadLike[]
  /** Media jobs, so pause/resume-all covers them exactly like the toolbar. */
  getMediaJobs: () => readonly TrayMediaJobLike[]
  /**
   * Read the clipboard now; called only when the menu opens. Electron may
   * resolve a promise, which is handled the same way.
   */
  readClipboardText: () => string | Promise<string>
}

export interface AppTray {
  tray: Tray
  /**
   * Cheap hint that window visibility changed. The menu is built when it is
   * about to open, so this never pays for a native menu build.
   */
  refresh: () => void
  /**
   * Forward one published download/media state. The menu needs no rebuild;
   * this only keeps the (throttled) tooltip current.
   */
  onDownloadStateChanged: () => void
  destroy: () => void
}

/**
 * Windows-first tray integration.
 *
 * No context menu is ever installed with `setContextMenu`: on Windows that
 * makes the shell open an already-built menu by itself on right- and
 * left-click, which cannot be guaranteed to be fresh. Instead the tray keeps
 * no menu at all, and the one `popUpContextMenu` call in `openMenu` builds the
 * template at that instant, so it always shows current state without any
 * background rebuild. A plain left click restores the window.
 *
 * With nothing downloading the tray owns no timer at all. While something is
 * downloading, one self-re-arming tooltip throttle runs at most every two
 * seconds, and the tooltip returns to "DonDownload" when everything stops.
 */
export function createAppTray(actions: TrayActions): AppTray | null {
  let icon: NativeImage
  try {
    icon = nativeImage.createFromPath(trayIconPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    logError('Tray icon could not be loaded: %s', detail)
    return null
  }

  if (icon.isEmpty()) {
    logError('Tray icon is missing or invalid: %s', trayIconPath)
    return null
  }

  let tray: Tray
  try {
    // Pass the ICO path rather than the decoded image so Windows can pick the
    // size that matches the current DPI/tray scaling.
    tray = new Tray(trayIconPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    logError('The system tray is unavailable: %s', detail)
    return null
  }

  let destroyed = false
  let installedTooltip: string | null = null
  let tooltipTimer: ReturnType<typeof setTimeout> | null = null

  /** Everything the template would show, plus the clipboard flag when read. */
  const currentState = (clipboardUrl: string | null): TrayMenuState => ({
    windowVisible: actions.isWindowVisible(),
    downloads: actions.getDownloads(),
    mediaJobs: actions.getMediaJobs(),
    speedLimitBps: actions.getSpeedLimitBps(),
    clipboardUrl
  })

  const applyTooltip = (): void => {
    if (destroyed || tray.isDestroyed()) return
    const tooltip = trayTooltip(actions.getDownloads())
    if (tooltip === installedTooltip) return
    installedTooltip = tooltip
    try {
      // `null` restores the plain "DonDownload" hover text.
      tray.setToolTip(tooltip ?? 'DonDownload')
    } catch {
      // A shell without a notification area must not break the app.
    }
  }

  /**
   * One timer at most, only while something is downloading. It stops itself
   * as soon as the last transfer ends, so an idle tray sleeps until the next
   * menu open (Electron still serves `click` and `right-click` through its own
   * window procedure, with no timer needed).
   */
  const scheduleTooltip = (): void => {
    if (destroyed || tooltipTimer !== null) return
    if (!hasActiveDownloads(actions.getDownloads())) return
    tooltipTimer = setTimeout(() => {
      tooltipTimer = null
      applyTooltip()
      scheduleTooltip()
    }, TRAY_TOOLTIP_INTERVAL_MS)
    tooltipTimer.unref?.()
  }

  const stopTooltip = (): void => {
    if (tooltipTimer !== null) {
      clearTimeout(tooltipTimer)
      tooltipTimer = null
    }
  }

  /**
   * The menu is built here and nowhere else: right before it is shown, with
   * the clipboard read at that same instant. Nothing is cached between opens.
   */
  const openMenu = (): void => {
    if (destroyed || tray.isDestroyed()) return
    const state = currentState(clipboardUrlForMenu(safeReadClipboard(actions)))
    tray.popUpContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(state, actions)))
    // The tooltip is cheap to confirm here and stays truthful across a pause.
    applyTooltip()
  }

  const restore = (): void => actions.showWindow()

  tray.on('click', restore)
  tray.on('double-click', restore)
  tray.on('right-click', openMenu)

  try {
    tray.setToolTip('DonDownload')
  } catch {
    // Non-fatal: hover text is cosmetic.
  }

  return {
    tray,
    refresh: () => undefined,
    onDownloadStateChanged: () => {
      if (destroyed) return
      // The menu needs no refresh (it is built on open); only the tooltip is
      // throttled, and only while something is downloading.
      scheduleTooltip()
    },
    destroy: () => {
      destroyed = true
      stopTooltip()
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}

/**
 * A synchronous clipboard read when the platform returns a string, `''` when
 * it resolves one asynchronously (the item simply stays disabled for that
 * open), and `''` when another process has the clipboard locked.
 */
function safeReadClipboard(actions: TrayActions): string {
  try {
    const value = actions.readClipboardText()
    return typeof value === 'string' ? value : ''
  } catch {
    // A clipboard locked by another process only disables the menu item.
    return ''
  }
}
