import { Notification, app, shell } from 'electron'
import type {
  CoreHost,
  HostNotification,
  HostNotificationOptions
} from './host'

/**
 * The only place the Electron-free core services meet Electron. Keeping every
 * import here lets the core run in a plain Node process that injects its own
 * host (for example a future tray-only background process).
 */
export function createElectronHost(): CoreHost {
  return {
    openPath: (target) => shell.openPath(target),
    showItemInFolder: (target) => shell.showItemInFolder(target),
    trashItem: (target) => shell.trashItem(target),
    openExternal: (url) => shell.openExternal(url),
    isPackaged: () => app.isPackaged,
    getAppPath: () => app.getAppPath(),
    getResourcesPath: () => process.resourcesPath,
    getPath: (name) => app.getPath(name),
    isNotificationSupported: () => Notification.isSupported(),
    createNotification: (
      options: HostNotificationOptions
    ): HostNotification => {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        // Only Windows understands raw toast XML; passing it elsewhere would
        // simply be ignored, but the service only sets it on win32.
        ...(options.toastXml === undefined
          ? {}
          : { toastXml: options.toastXml }),
        ...(options.id === undefined ? {} : { id: options.id })
      })

      // The core only needs clicks and action indices. Electron's Windows
      // toast implementation reports the pressed button index through the
      // `action` event, including for custom toast XML.
      return {
        on: (event, listener) => {
          if (event === 'click') {
            notification.on('click', () => listener())
          }
        },
        onAction: (listener) => {
          notification.on('action', (details) => {
            listener(details.actionIndex)
          })
        },
        show: () => {
          notification.show()
        }
      }
    }
  }
}
