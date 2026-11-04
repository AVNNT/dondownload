import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc'
import type { AppSnapshot } from '@shared/types'
import { Aria2Service, defaultDownloadDir } from './aria2/service'
import { BatchManager } from './batches/manager'
import { openDownloadDatabase, resolveDownloadDatabasePath } from './db/database'
import { DownloadManager } from './downloads/manager'
import { createPixeldrainAdapter } from './hosts/pixeldrain'
import { createMediaEngine } from './media/engine'
import { MediaJobsManager } from './mediaJobs/manager'
import { registerIpc } from './ipc'
import {
  decideBeforeQuit,
  decideWindowClose,
  isCleanupRunning,
  shouldQuitWhenAllWindowsClosed
} from './lifecycle'
import { startNativeBridge, type NativeBridge } from './nativeBridge/server'
import { createAppTray, type AppTray } from './tray'
import { createMainWindow } from './window'

let mainWindow: BrowserWindow | null = null
let appTray: AppTray | null = null
let aria2: Aria2Service | null = null
let manager: DownloadManager | null = null
let mediaJobs: MediaJobsManager | null = null
let batches: BatchManager | null = null
let nativeBridge: NativeBridge | null = null
/** A user or OS quit request has been accepted; windows may now close. */
let quitRequested = false
/** The orderly flush/stop/close sequence is running; never run it twice. */
let cleanupStarted = false
/** Cleanup completed; only then may the final internal app.quit proceed. */
let cleanupFinished = false

function isMainWindowVisible(): boolean {
  return Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
  )
}

function refreshTray(): void {
  appTray?.refresh()
}

function openMainWindow(): BrowserWindow {
  const window = createMainWindow()

  window.on('close', (event) => {
    const action = decideWindowClose({
      isQuitting: quitRequested || cleanupStarted,
      trayAvailable: appTray !== null
    })
    if (action === 'hide-to-tray') {
      // Keep the renderer, aria2 and polling alive in the background.
      event.preventDefault()
      window.hide()
      refreshTray()
    }
  })
  window.on('show', refreshTray)
  window.on('hide', refreshTray)
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    refreshTray()
  })

  return window
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = openMainWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  refreshTray()
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  refreshTray()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second launch focuses the existing app, including after close-to-tray.
    showMainWindow()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.dondownload.app')
    const downloadDir = defaultDownloadDir(app.getPath('downloads'))

    aria2 = new Aria2Service(() => downloadDir)

    // History uses the SQLite runtime bundled with Electron's Node (node:sqlite),
    // in a dedicated file under Electron's userData directory.
    let database: ReturnType<typeof openDownloadDatabase> | null = null
    try {
      database = openDownloadDatabase(
        resolveDownloadDatabasePath(app.getPath('userData'))
      )
    } catch (error) {
      // Keep the app usable if storage is unavailable; downloads still work but
      // history will not survive a relaunch. Do not log URLs or payloads.
      const detail = error instanceof Error ? error.message : 'unknown error'
      console.error(`Download history is unavailable: ${detail}`)
    }

    manager = new DownloadManager(
      aria2,
      downloadDir,
      (snapshot: AppSnapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot)
        }
      },
      database
    )

    const mediaDir = path.join(downloadDir, 'Media')
    const mediaEngine = createMediaEngine()
    mediaJobs = new MediaJobsManager({
      engine: mediaEngine,
      mediaDir,
      database,
      onUpdate: (snapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.mediaSnapshotChanged, snapshot)
        }
      }
    })

    // Milestone 3B: the batch manager reuses the existing download and media
    // managers as ports, so duplicate policy and child lifecycles stay owned by
    // those systems. It loads persisted batches and marks any active work
    // interrupted instead of auto-resuming it.
    batches = new BatchManager({
      downloads: manager,
      mediaJobs,
      collectionEngine: mediaEngine,
      pixeldrain: createPixeldrainAdapter(),
      database,
      onUpdate: (snapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.batchSnapshotChanged, snapshot)
        }
      }
    })

    registerIpc({
      manager,
      aria2,
      mediaJobs,
      batches,
      getWindow: () => mainWindow
    })

    // Probe external media tools without delaying the first window. The media
    // job manager publishes the verified state when the probe settles.
    void mediaJobs.refreshToolState()

    // The browser bridge is intentionally started without touching the
    // window. It keeps working while the app lives only in the tray and only
    // forwards validated URLs to the same DownloadManager/aria2 instance.
    try {
      nativeBridge = await startNativeBridge({
        manager,
        mediaBridge: mediaJobs,
        userDataPath: app.getPath('userData'),
        logger: (message) => console.error(message)
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      console.error(`Browser bridge is unavailable: ${detail}`)
    }

    // Create the tray before the window so a close always has a safe target.
    // If tray creation fails, the policy falls back to close-and-quit.
    appTray = createAppTray({
      showWindow: showMainWindow,
      hideWindow: hideMainWindow,
      quit: () => {
        quitRequested = true
        app.quit()
      },
      isWindowVisible: isMainWindowVisible
    })

    mainWindow = openMainWindow()

    aria2.onStateChange = () => {
      manager?.publish()
    }

    // Start eagerly so the top bar can explain a missing/broken aria2, then
    // reconcile persisted records once we know whether aria2 is available.
    void (async () => {
      try {
        await aria2?.start()
      } catch {
        manager?.publish(true)
      }
      try {
        await manager?.reconcileDownloads()
      } catch {
        // Recovery is best-effort; persisted rows are never deleted here.
      }
    })()

    app.on('activate', () => {
      // macOS Dock activation and Windows taskbar relaunches restore the same
      // hidden window instead of creating a duplicate.
      showMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (
      shouldQuitWhenAllWindowsClosed({
        platform: process.platform,
        isQuitting: quitRequested || cleanupStarted,
        trayAvailable: appTray !== null,
        // Closing the window during cleanup fires this event; the pending
        // internal quit owns the shutdown, so do not start a parallel one.
        cleanupRunning: isCleanupRunning({
          started: cleanupStarted,
          finished: cleanupFinished
        })
      })
    ) {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    quitRequested = true

    const action = decideBeforeQuit({
      cleanup: { started: cleanupStarted, finished: cleanupFinished },
      servicesReady: aria2 !== null
    })
    if (action === 'allow') {
      // Startup never reached the services, or cleanup already finished and
      // this is the final internal quit.
      return
    }
    // Cancel every request that arrives while cleanup is still running so it
    // cannot jump ahead of the flush/stop/close sequence.
    event.preventDefault()
    if (action === 'block') return

    cleanupStarted = true
    void (async () => {
      // Stop accepting browser requests before stopping aria2, so a late
      // native message cannot restart the engine during shutdown.
      try {
        await nativeBridge?.close()
      } catch {
        // Never block quitting on bridge cleanup.
      }
      nativeBridge = null

      // Persist batch recovery state first: active parents/items become
      // interrupted and are never auto-resumed. Child cancellation remains the
      // media/download managers' responsibility below.
      try {
        batches?.close()
      } catch {
        // Batch recovery state is best effort; quitting must still proceed.
      }
      batches = null

      // Persist the last known lifecycle/progress state, stop aria2 cleanly,
      // then close the database. Crash recovery can still rely on the bounded
      // progress snapshots written while the app was running.
      try {
        await mediaJobs?.close()
      } catch {
        // Media children are cancelled best-effort; the process must still quit.
      }
      mediaJobs = null
      try {
        manager?.flushPersistence()
      } catch {
        // Never block quitting on a history flush.
      }
      try {
        await aria2?.stop()
      } catch {
        // The process may already be gone.
      }
      try {
        manager?.close()
      } catch {
        // Never block quitting on a database close.
      }
      try {
        appTray?.destroy()
      } catch {
        // The tray may already be gone.
      }
      appTray = null
      // Mark the sequence complete immediately before the final internal
      // quit, so that this one request is allowed through.
      cleanupFinished = true
      app.quit()
    })()
  })
}
