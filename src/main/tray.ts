import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import trayIconPath from './assets/tray.ico?asset'
import { trayMenuLabel } from './lifecycle'

export interface TrayActions {
  showWindow: () => void
  hideWindow: () => void
  quit: () => void
  isWindowVisible: () => boolean
}

export interface AppTray {
  tray: Tray
  /** Rebuild the menu so the Show/Hide label matches the real window state. */
  refresh: () => void
  destroy: () => void
}

/**
 * Windows-first tray integration. A single click (or double-click) restores
 * the window; the menu offers an explicit Show/Hide toggle and Quit. The tray
 * exists only while the app is running and never starts the app by itself.
 */
export function createAppTray(actions: TrayActions): AppTray | null {
  let icon: NativeImage
  try {
    icon = nativeImage.createFromPath(trayIconPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    console.error(`Tray icon could not be loaded: ${detail}`)
    return null
  }

  if (icon.isEmpty()) {
    console.error(`Tray icon is missing or invalid: ${trayIconPath}`)
    return null
  }

  let tray: Tray
  try {
    // Pass the ICO path rather than the decoded image so Windows can pick the
    // size that matches the current DPI/tray scaling.
    tray = new Tray(trayIconPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    console.error(`The system tray is unavailable: ${detail}`)
    return null
  }

  tray.setToolTip('DonDownload')

  const refresh = (): void => {
    if (tray.isDestroyed()) return
    const visible = actions.isWindowVisible()
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: trayMenuLabel(visible),
          click: () => {
            if (actions.isWindowVisible()) actions.hideWindow()
            else actions.showWindow()
          }
        },
        { type: 'separator' },
        {
          label: 'Quit DonDownload',
          click: () => actions.quit()
        }
      ])
    )
  }

  const restore = (): void => actions.showWindow()

  tray.on('click', restore)
  tray.on('double-click', restore)
  refresh()

  return {
    tray,
    refresh,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}
