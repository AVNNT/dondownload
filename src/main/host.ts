/**
 * Narrow port between the Electron-free core services and the desktop shell.
 *
 * Only `src/main/electronHost.ts` may import `electron`. Everything the core
 * needs from the desktop (shell actions, app paths, notifications) arrives
 * through this interface, so the same services stay importable from a plain
 * Node process (for example a future tray-only background host).
 */
export interface HostNotificationOptions {
  title: string
  body: string
  /**
   * Windows-only raw toast XML. Used for completion notifications because
   * Electron's `actions` list has no Windows button support.
   */
  toastXml?: string
  /** Windows toast tag; must be unique per visible notification. */
  id?: string
}

/** The small notification surface the core uses; Electron's class fits it. */
export interface HostNotification {
  on(event: 'click', listener: () => void): void
  /** Button activation; `actionIndex` is the index in the toast's actions. */
  onAction(listener: (actionIndex: number) => void): void
  show(): void
}

export interface CoreHost {
  /**
   * Open a file or folder with the OS default handler. Resolves to an empty
   * string on success or a human-readable failure message.
   */
  openPath(target: string): Promise<string>
  /** Reveal a file in the OS file manager. */
  showItemInFolder(target: string): void
  /** Move a file to the Recycle Bin (Windows) or Trash. */
  trashItem(target: string): Promise<void>
  /** Open an http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>
  /** Equivalent of Electron's `app.isPackaged`. */
  isPackaged(): boolean
  /** Equivalent of Electron's `app.getAppPath()`. */
  getAppPath(): string
  /** Equivalent of Electron's `process.resourcesPath`. */
  getResourcesPath(): string
  /** Equivalent of Electron's `app.getPath(name)`. */
  getPath(name: 'userData' | 'downloads'): string
  /** Equivalent of `Notification.isSupported()`. */
  isNotificationSupported(): boolean
  createNotification(options: HostNotificationOptions): HostNotification
}

/**
 * Inert host for narrow tests and non-desktop callers that never invoke a
 * shell action. Production wiring always passes the Electron host explicitly.
 */
export function createNoopHost(): CoreHost {
  return {
    openPath: async () => '',
    showItemInFolder: () => undefined,
    trashItem: async () => undefined,
    openExternal: async () => undefined,
    isPackaged: () => false,
    getAppPath: () => process.cwd(),
    getResourcesPath: () => '',
    getPath: () => process.cwd(),
    isNotificationSupported: () => false,
    createNotification: () => ({
      on: () => undefined,
      onAction: () => undefined,
      show: () => undefined
    })
  }
}
