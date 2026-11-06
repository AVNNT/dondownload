import { BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc'
import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type {
  MediaAnalysis,
  MediaJob,
  MediaSnapshot
} from '@shared/media'
import type {
  Batch,
  CollectionPreview,
  CollectionSelectionAvailability
} from '@shared/batches'
import type {
  ApiResult,
  AppSnapshot,
  BatchSnapshot,
  SmartBatchSubmitResult
} from '@shared/types'
import type { DownloadSettings } from '@shared/settings'
import type {
  MediaToolSettings,
  YtdlpUpdateState
} from '@shared/mediaTools'
import type { AppUpdateState } from '@shared/appUpdate'
import type { Aria2Service } from './aria2/service'
import type { BatchManager } from './batches/manager'
import type { DownloadManager } from './downloads/manager'
import { AppError, toErrorInfo } from './errors'
import type { MediaJobsManager } from './mediaJobs/manager'
import type { SettingsManager } from './settings/manager'
import type { YtdlpUpdater } from './media/updater'
import type { NativeHostRegistrar } from './nativeHost/registration'
import type { AppUpdateChecker } from './appUpdate/checker'
import { applyThemeToWindow } from './settings/theme'

export interface IpcContext {
  manager: DownloadManager
  aria2: Aria2Service
  /**
   * Optional until the orchestrator wires the manager in `index.ts`. Existing
   * download channels are unchanged; media channels report a safe error while
   * the property is absent.
   */
  mediaJobs?: MediaJobsManager
  /** Additive Milestone 3B batch orchestration. */
  batches?: BatchManager
  /** Additive Milestone 5A runtime download settings. */
  settings?: SettingsManager
  /** Verified managed yt-dlp updater (optional until wired in index.ts). */
  mediaUpdater?: YtdlpUpdater
  /** Zero-config browser bridge registration. */
  browserExtension?: NativeHostRegistrar
  /** GitHub Releases application updater (optional until wired in index.ts). */
  appUpdate?: AppUpdateChecker
  getWindow: () => BrowserWindow | null
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null
): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    throw new AppError('UNTRUSTED_SENDER', 'No application window is available.')
  }
  if (event.sender !== window.webContents) {
    throw new AppError('UNTRUSTED_SENDER', 'The IPC sender is not the application window.')
  }
  if (event.senderFrame !== window.webContents.mainFrame) {
    throw new AppError('UNTRUSTED_SENDER', 'IPC is only accepted from the top-level frame.')
  }
  if (event.senderFrame.url !== window.webContents.getURL()) {
    throw new AppError('UNTRUSTED_SENDER', 'The IPC sender frame is not trusted.')
  }
}

export function registerIpc(context: IpcContext): void {
  const invoke = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>
  ): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<ApiResult<T>> => {
      try {
        assertTrustedSender(event, context.getWindow)
        return { ok: true, value: await handler(event, ...args) }
      } catch (error) {
        return { ok: false, error: toErrorInfo(error) }
      }
    })
  }

  invoke<AppSnapshot>(IPC.getSnapshot, () => context.manager.getSnapshot())

  invoke<AppSnapshot>(IPC.restartAria2, async () => {
    await context.aria2.restart()
    // A new aria2 process has no prior GIDs. Reconcile explicitly so in-flight
    // records become interrupted instead of looking live forever.
    await context.manager.reconcileDownloads()
    context.manager.publish(true)
    return context.manager.getSnapshot()
  })

  invoke<AppSnapshot>(IPC.addDownload, (_event, input) =>
    context.manager.add(input)
  )
  invoke<AppSnapshot>(IPC.pauseDownload, (_event, id) =>
    context.manager.pause(id)
  )
  invoke<AppSnapshot>(IPC.resumeDownload, (_event, id) =>
    context.manager.resume(id)
  )
  invoke<AppSnapshot>(IPC.startDownloadNow, (_event, id) =>
    context.manager.startNow(id)
  )
  invoke<AppSnapshot>(IPC.retryDownload, (_event, id) =>
    context.manager.retry(id)
  )
  invoke<AppSnapshot>(IPC.removeDownload, (_event, id) =>
    context.manager.remove(id)
  )
  invoke<null>(IPC.showInFolder, (_event, id) =>
    context.manager.showInFolder(id)
  )
  invoke<null>(IPC.openFile, (_event, id) => context.manager.openFile(id))

  // Additive media channels. They reuse the same trusted-sender wrapper and
  // never widen the existing download capabilities.
  const media = (): MediaJobsManager => {
    if (!context.mediaJobs) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is not available.')
    }
    return context.mediaJobs
  }

  invoke<MediaAnalysis>(IPC.analyzeMedia, (_event, input) =>
    media().analyzeMedia(input)
  )

  invoke<MediaSnapshot>(IPC.queueMedia, async (_event, input) => {
    const manager = media()
    await manager.queueMedia(input)
    return manager.getMediaSnapshot()
  })

  invoke<MediaSnapshot>(IPC.getMediaSnapshot, () =>
    media().getMediaSnapshot()
  )

  invoke<MediaJob>(IPC.getMediaJob, (_event, jobId) =>
    media().getMediaJob(jobId)
  )

  invoke<MediaSnapshot>(IPC.cancelMedia, async (_event, jobId) => {
    const manager = media()
    await manager.cancelMedia(jobId)
    return manager.getMediaSnapshot()
  })

  invoke<MediaSnapshot>(IPC.removeMedia, (_event, jobId) =>
    media().removeMedia(jobId)
  )

  invoke<null>(IPC.showMediaInFolder, (_event, jobId) =>
    media().showMediaInFolder(jobId)
  )

  invoke<null>(IPC.openMediaFile, (_event, jobId) =>
    media().openMediaFile(jobId)
  )

  // Additive Milestone 3B batch channels. Every handler goes through the same
  // trusted-sender wrapper above, and public results are safe Batch or
  // CollectionPreview DTOs only (no source URL, path, token or headers).
  const batches = (): BatchManager => {
    if (!context.batches) {
      throw new AppError(
        'BATCH_UNAVAILABLE',
        'Batch support is not available.'
      )
    }
    return context.batches
  }

  invoke<CollectionPreview>(IPC.analyzeBatchCollection, (_event, input) =>
    batches().analyzeCollection(input)
  )

  invoke<CollectionSelectionAvailability>(IPC.analyzeCollectionSelection, (_event, input) =>
    batches().analyzeCollectionSelection(input)
  )

  invoke<SmartBatchSubmitResult>(IPC.submitSmartBatch, (_event, input) =>
    batches().submitSmartBatch(input)
  )

  invoke<Batch>(IPC.createCollectionBatch, (_event, input) =>
    batches().createCollectionBatch(input)
  )

  invoke<BatchSnapshot>(IPC.getBatchSnapshot, () =>
    batches().getBatchSnapshot()
  )

  invoke<Batch>(IPC.getBatch, (_event, batchId) =>
    batches().getBatch(batchId)
  )

  invoke<BatchSnapshot>(IPC.cancelBatchItem, (_event, input) =>
    batches().cancelBatchItem(input)
  )

  invoke<BatchSnapshot>(IPC.cancelBatch, (_event, input) =>
    batches().cancelBatch(input)
  )

  invoke<BatchSnapshot>(IPC.retryBatchItem, (_event, input) =>
    batches().retryBatchItem(input)
  )

  invoke<BatchSnapshot>(IPC.removeBatch, (_event, input) =>
    batches().removeBatch(input)
  )

  invoke<null>(IPC.openBatchSource, (_event, input) =>
    batches().openBatchSource(input)
  )

  // Additive Milestone 5A settings channels. The manager validates the complete
  // exact-key object before persisting and before changing aria2; this wrapper
  // only enforces the trusted-sender boundary.
  const settings = (): SettingsManager => {
    if (!context.settings) {
      throw new AppError(
        'SETTINGS_UNAVAILABLE',
        'Download settings are not available.'
      )
    }
    return context.settings
  }

  invoke<DownloadSettings>(IPC.getSettings, () => settings().getSettings())

  invoke<DownloadSettings>(IPC.updateSettings, async (_event, input) => {
    const updated = await settings().update(input)
    // Theme changes are applied to the native caption buttons here, in the
    // same IPC round trip that persists them. No window reload occurs.
    const window = context.getWindow()
    if (window && !window.isDestroyed()) {
      applyThemeToWindow(window, updated.theme)
    }
    return updated
  })

  // Managed yt-dlp update channels. The updater performs only fixed HTTPS
  // requests, verifies the SHA-256 sums and the new binary's own --version
  // output, and returns renderer-safe state without URLs or paths.
  const mediaUpdater = (): YtdlpUpdater => {
    if (!context.mediaUpdater) {
      throw new AppError(
        'MEDIA_UPDATER_UNAVAILABLE',
        'The yt-dlp updater is not available.'
      )
    }
    return context.mediaUpdater
  }

  invoke<MediaToolSettings>(IPC.getMediaToolSettings, () =>
    mediaUpdater().getSettings()
  )

  invoke<MediaToolSettings>(IPC.updateMediaToolSettings, (_event, input) =>
    mediaUpdater().updateSettings(input)
  )

  invoke<YtdlpUpdateState>(IPC.getYtdlpUpdateState, () =>
    mediaUpdater().getState()
  )

  invoke<YtdlpUpdateState>(IPC.checkYtdlpUpdate, () =>
    mediaUpdater().check({ force: true })
  )

  // Zero-config browser extension registration. The renderer never supplies a
  // path: both folder actions resolve the one fixed extension directory and
  // reject anything that is not exactly it.
  const browserExtension = (): NativeHostRegistrar => {
    if (!context.browserExtension) {
      throw new AppError(
        'BROWSER_EXTENSION_UNAVAILABLE',
        'Browser extension registration is not available.'
      )
    }
    return context.browserExtension
  }

  const exactExtensionFolder = (): string => {
    const folder = path.resolve(browserExtension().extensionFolder())
    // The registrar builds this from Electron's own resources/app path, never
    // from renderer input. Reject a malformed value rather than opening it.
    if (!path.isAbsolute(folder) || path.basename(folder).toLowerCase() !== 'extension') {
      throw new AppError(
        'BROWSER_EXTENSION_FOLDER_INVALID',
        'The browser extension folder is not valid.'
      )
    }
    return folder
  }

  invoke<BrowserExtensionStatus>(IPC.getBrowserExtensionStatus, () =>
    browserExtension().getStatus()
  )

  invoke<BrowserExtensionStatus>(IPC.repairBrowserExtension, () =>
    browserExtension().repair()
  )

  invoke<null>(IPC.openBrowserExtensionFolder, async () => {
    const failure = await shell.openPath(exactExtensionFolder())
    if (failure) {
      throw new AppError(
        'BROWSER_EXTENSION_FOLDER_UNAVAILABLE',
        'The browser extension folder could not be opened.'
      )
    }
    return null
  })

  invoke<null>(IPC.copyBrowserExtensionFolderPath, () => {
    clipboard.writeText(exactExtensionFolder())
    return null
  })
  // Application self-update channels. The same trusted-sender wrapper applies.
  // `check` may download and verify an installer; `install` can only launch the
  // already-verified file and refuses while any job is active.
  const appUpdate = (): AppUpdateChecker => {
    if (!context.appUpdate) {
      throw new AppError(
        'APP_UPDATE_UNAVAILABLE',
        'The application updater is not available.'
      )
    }
    return context.appUpdate
  }

  invoke<AppUpdateState>(IPC.getAppUpdateState, () => appUpdate().getState())

  invoke<AppUpdateState>(IPC.checkAppUpdate, () =>
    appUpdate().check({ force: true })
  )

  invoke<AppUpdateState>(IPC.installAppUpdate, () => appUpdate().install())

  invoke<AppUpdateState>(IPC.setAppUpdateAutoCheck, (_event, input) =>
    appUpdate().setAutoCheck(input)
  )
}
