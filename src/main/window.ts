import { join } from 'node:path'
import { BrowserWindow, session } from 'electron'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    show: false,
    backgroundColor: '#000000',
    title: 'DonDownload',
    autoHideMenuBar: true,
    webPreferences: {
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

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
