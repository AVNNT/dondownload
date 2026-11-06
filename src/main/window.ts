import { join } from 'node:path'
import { BrowserWindow, session, shell } from 'electron'
import { isPublicOpenableUrl } from './scanner/openExternal'
import { DEFAULT_THEME, type AppTheme } from '@shared/settings'
import { themeWindowColors } from './settings/theme'
import windowIconPath from './assets/icon.ico?asset'

export interface CreateMainWindowOptions {
  /**
   * Smoke verification creates the real renderer window but must never display
   * or focus it. Normal application startup keeps the existing visible flow.
   */
  show?: boolean
  /** Render a real BrowserWindow offscreen for isolated CDP verification. */
  offscreen?: boolean
  /** Persisted appearance, applied to the native title bar before first paint. */
  theme?: AppTheme
}

export function createMainWindow(
  options: CreateMainWindowOptions = {}
): BrowserWindow {
  const show = options.show ?? true
  const offscreen = options.offscreen ?? false
  const colors = themeWindowColors(options.theme ?? DEFAULT_THEME)
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    show: false,
    backgroundColor: colors.backgroundColor,
    accentColor: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: colors.titleBarOverlay,
    title: 'DonDownload',
    // electron-vite copies the ?asset import beside the main bundle in both
    // dev and packaged builds, so the window/taskbar icon resolves from asar.
    icon: windowIconPath,
    autoHideMenuBar: true,
    webPreferences: {
      offscreen,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      spellcheck: false
    }
  })

  const rendererSession = session.defaultSession
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  rendererSession.setPermissionCheckHandler(() => false)

  // The renderer never hosts a new window. Public page links (a
  // `target="_blank"` anchor such as "Open topic") route to the user's
  // browser via the same guard as "Open in browser"; everything else,
  // including private and credential-bearing URLs, stays denied.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isPublicOpenableUrl(url)) {
      void shell.openExternal(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  window.once('ready-to-show', () => {
    if (show) window.show()
  })

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
