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
    createNotification: (options: HostNotificationOptions): HostNotification =>
      new Notification({ title: options.title, body: options.body })
  }
}
