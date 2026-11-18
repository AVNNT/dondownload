import { BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc'
import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type {
  MediaAnalysis,
  MediaJob,
  MediaJobDetails,
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
  SmartBatchSubmitResult,
  UrlSizeProbe
} from '@shared/types'
import type { DownloadSettings } from '@shared/settings'
import type { ChecksumResult } from '@shared/checksum'
import type { DesktopSettings } from '@shared/desktopSettings'
import type {
  MediaToolSettings,
  YtdlpUpdateState
} from '@shared/mediaTools'
import type { AppUpdateState } from '@shared/appUpdate'
import type { WelcomeInfo } from '@shared/welcome'
import { WELCOME_RELEASES_URL } from '@shared/welcome'
import type { ScanQueueResult, ScanManualMatchResult, ScanSession, ScanQueueSelectionsResult } from '@shared/scanner'
import {
  parseScanCancelInput,
  parseScanManualMatchInput,
  parseScanMarkAsVideoInput,
  parseScanOpenInBrowserInput,
  parseScanQueueSelectionInput,
  parseScanQueueSelectionsInput,
  parseScanStartInput,
  parseScanStartManyInput
} from '@shared/scanner'
import type { Aria2Service } from './aria2/service'
import type { BatchManager } from './batches/manager'
import type { ChecksumService } from './checksum/service'
import { probeUrlSize } from './net/urlSize'
import type { DownloadManager } from './downloads/manager'
import { AppError, toErrorInfo } from './errors'
import type { MediaJobsManager } from './mediaJobs/manager'
import type { SettingsManager } from './settings/manager'
import type { DesktopSettingsManager } from './settings/desktopManager'
import type { YtdlpUpdater } from './media/updater'
import type { NativeHostRegistrar } from './nativeHost/registration'
import type { AppUpdateChecker } from './appUpdate/checker'
import type { ScanSessionManager } from './scanner/session'
import type { ScanQueueService } from './scanner/queue'
import type { ManualMatchService } from './scanner/manualMatch'
import { isPublicOpenableUrl } from './scanner/openExternal'
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
  /** Streaming file checksum jobs (optional until wired in index.ts). */
  checksums?: ChecksumService
  /** Additive Milestone 5A runtime download settings. */
  settings?: SettingsManager
  /** Desktop-only preferences (notifications, clipboard, startup, zoom). */
  desktopSettings?: DesktopSettingsManager
  /** Main-process clipboard writer so self-copied links can be ignored. */
  clipboardWriter?: { writeText: (text: string) => void }
  /** Verified managed yt-dlp updater (optional until wired in index.ts). */
  mediaUpdater?: YtdlpUpdater
  /** Zero-config browser bridge registration. */
  browserExtension?: NativeHostRegistrar
  /** GitHub Releases application updater (optional until wired in index.ts). */
  appUpdate?: AppUpdateChecker
  /** Smart Link Scanner sessions (discovery only, no queue path). */
  scanner?: ScanSessionManager
  /** Explicit scanner selection queue path. */
  scanQueue?: ScanQueueService
  /** Manual "Match to video file…" support. */
  manualMatch?: ManualMatchService
  /** First-start guide data; detection and folder resolution stay in main. */
  welcome?: { getInfo: () => Promise<WelcomeInfo> }
  /** Send fresh full deltas for every snapshot stream after a renderer gap. */
  requestSnapshotResync?: () => void
  /**
   * Help & diagnostics. Both are fixed, app-owned targets assembled in main:
   * the log folder path and a redacted text block. Neither accepts renderer
   * input, so nothing personal can be smuggled into a report through them.
   */
  openLogFolder?: () => Promise<string>
  buildDiagnostics?: () => string | Promise<string>
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

  invoke<null>(IPC.snapshotResync, () => {
    context.requestSnapshotResync?.()
    return null
  })

  invoke<UrlSizeProbe>(IPC.probeUrlSize, (_event, url) => {
    if (typeof url !== 'string') return Promise.resolve({ size: null })
    return probeUrlSize(url)
  })

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
  invoke<AppSnapshot>(IPC.cancelDownload, (_event, id) =>
    context.manager.cancel(id)
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
  invoke<AppSnapshot>(IPC.removeDownloads, (_event, ids) =>
    context.manager.removeMany(ids)
  )
  invoke<null>(IPC.showInFolder, (_event, id) =>
    context.manager.showInFolder(id)
  )
  invoke<null>(IPC.openFile, (_event, id) => context.manager.openFile(id))
  invoke<AppSnapshot>(IPC.deleteDownloadFile, (_event, id) =>
    context.manager.deleteFile(id)
  )

  // Checksum verification. The renderer sends only the opaque download id and
  // an expected hash; the service resolves the download's own recorded path.
  const checksums = (): ChecksumService => {
    if (!context.checksums) {
      throw new AppError(
        'CHECKSUM_UNAVAILABLE',
        'Checksum verification is not available.'
      )
    }
    return context.checksums
  }

  invoke<ChecksumResult>(IPC.verifyChecksum, (_event, input) =>
    checksums().verify(input)
  )

  invoke<ChecksumResult>(IPC.computeChecksum, (_event, input) =>
    checksums().compute(input)
  )

  invoke<null>(IPC.cancelChecksum, (_event, input) => {
    checksums().cancel(input)
    return null
  })

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

  // Scoped display details for the details pane; snapshots stay clean.
  invoke<MediaJobDetails>(IPC.getMediaJobDetails, (_event, jobId) =>
    media().getMediaJobDetails(jobId)
  )

  invoke<MediaSnapshot>(IPC.cancelMedia, async (_event, jobId) => {
    const manager = media()
    await manager.cancelMedia(jobId)
    return manager.getMediaSnapshot()
  })

  invoke<MediaSnapshot>(IPC.pauseMedia, (_event, jobId) =>
    media().pauseMedia(jobId)
  )

  invoke<MediaSnapshot>(IPC.resumeMedia, (_event, jobId) =>
    media().resumeMedia(jobId)
  )

  invoke<MediaSnapshot>(IPC.retryMedia, (_event, jobId) =>
    media().retryMedia(jobId)
  )

  invoke<MediaSnapshot>(IPC.removeMedia, (_event, jobId) =>
    media().removeMedia(jobId)
  )

  invoke<MediaSnapshot>(IPC.removeMediaJobs, (_event, ids) =>
    media().removeMany(ids)
  )

  invoke<MediaSnapshot>(IPC.deleteMediaFile, (_event, jobId) =>
    media().deleteMediaFile(jobId)
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

  // Quick actions send one value only; the manager merges it with the current
  // settings inside its serialized update instead of trusting a stale snapshot.
  invoke<DownloadSettings>(IPC.setSpeedLimit, (_event, input) => {
    const manager = settings()
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      throw new AppError('INVALID_INPUT', 'The speed limit is invalid.')
    }
    return manager.setGlobalSpeedLimit(input)
  })

  // Desktop-only settings are separate from aria2's download settings so a
  // notification, clipboard or zoom change never rewrites live engine options.
  const desktopSettings = (): DesktopSettingsManager => {
    if (!context.desktopSettings) {
      throw new AppError(
        'SETTINGS_UNAVAILABLE',
        'Desktop settings are not available.'
      )
    }
    return context.desktopSettings
  }

  invoke<DesktopSettings>(IPC.getDesktopSettings, () =>
    desktopSettings().getSettings()
  )

  invoke<DesktopSettings>(IPC.updateDesktopSettings, (_event, input) =>
    desktopSettings().update(input)
  )

  invoke<null>(IPC.copyText, (_event, rawText) => {
    if (
      typeof rawText !== 'string' ||
      rawText.length === 0 ||
      rawText.length > 100_000
    ) {
      throw new AppError(
        'INVALID_CLIPBOARD_TEXT',
        'That text cannot be copied.'
      )
    }
    context.clipboardWriter?.writeText(rawText)
    return null
  })

  // First-start guide. The renderer receives detected browser labels and the
  // current download folder; it never supplies a path or a URL. Opening the
  // releases page uses one fixed, public URL.
  invoke<WelcomeInfo>(IPC.getWelcomeInfo, () => {
    if (!context.welcome) {
      throw new AppError(
        'WELCOME_UNAVAILABLE',
        'The welcome guide is not available.'
      )
    }
    return context.welcome.getInfo()
  })

  invoke<null>(IPC.openWelcomeReleases, async () => {
    try {
      await shell.openExternal(WELCOME_RELEASES_URL)
    } catch {
      throw new AppError(
        'WELCOME_LINK_FAILED',
        'The releases page could not be opened.'
      )
    }
    return null
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

  // Smart Link Scanner. Renderer input is strict and opaque; the scanner never
  // receives a path, header or Cookie from the renderer. Starting/cancelling
  // cannot queue anything.
  const scanner = (): ScanSessionManager => {
    if (!context.scanner) {
      throw new AppError('SCAN_UNAVAILABLE', 'Page scanning is not available.')
    }
    return context.scanner
  }

  const scanQueue = (): ScanQueueService => {
    if (!context.scanQueue) {
      throw new AppError('SCAN_UNAVAILABLE', 'Page scanning is not available.')
    }
    return context.scanQueue
  }

  invoke<ScanSession>(IPC.scanStart, (_event, input) => {
    const parsed = parseScanStartInput(input)
    return scanner().start(parsed.url, { origin: 'paste' })
  })

  invoke<ScanSession[]>(IPC.scanStartMany, (_event, input) => {
    const parsed = parseScanStartManyInput(input)
    return scanner().startMany(parsed.urls, { origin: 'paste' })
  })

  invoke<ScanSession>(IPC.scanCancel, (_event, input) => {
    const parsed = parseScanCancelInput(input)
    return scanner().cancel(parsed.sessionId)
  })

  invoke<ScanQueueResult>(IPC.scanQueueSelection, (_event, input) => {
    const parsed = parseScanQueueSelectionInput(input)
    const videoOptions = parsed.videoOptions ?? []
    if (parsed.pairings === undefined || parsed.pairings.length === 0) {
      return scanQueue().queueSelection(
        parsed.sessionId,
        parsed.itemIds,
        videoOptions
      )
    }
    return scanQueue().queueSelection(
      parsed.sessionId,
      parsed.itemIds,
      videoOptions,
      parsed.pairings
    )
  })

  invoke<ScanQueueSelectionsResult>(
    IPC.scanQueueSelections,
    (_event, input) => {
      const parsed = parseScanQueueSelectionsInput(input)
      return scanQueue().queueSelections(parsed.selections)
    }
  )

  // Browser-only cards: the renderer sends opaque IDs only. Main resolves the
  // stored URL, validates it as public HTTP(S) and opens the user's browser.
  invoke<null>(IPC.scanOpenInBrowser, async (_event, input) => {
    const parsed = parseScanOpenInBrowserInput(input)
    const opened = scanner().openInBrowser(parsed.sessionId, parsed.itemId)
    if (!isPublicOpenableUrl(opened.url)) {
      throw new AppError(
        'SCAN_URL_NOT_PUBLIC',
        'That link cannot be opened because it is not a public web page.'
      )
    }
    if (parsed.pairing !== undefined) {
      scanner().armBrowserMatch(parsed.sessionId, parsed.itemId, {
        videoItemId: parsed.itemId,
        setId: parsed.pairing.setId,
        scriptItemIds: parsed.pairing.scriptItemIds,
        primaryVariant: parsed.pairing.primaryVariant,
        rename: parsed.pairing.rename
      })
    }
    try {
      await shell.openExternal(opened.url)
    } catch {
      throw new AppError(
        'SCAN_OPEN_FAILED',
        'The link could not be opened in the browser.'
      )
    }
    return null
  })

  // "This is a video": opaque IDs only. Main re-validates the stored URL and
  // runs the same bounded analyzer as a normal video page. It never queues.
  invoke<ScanSession>(IPC.scanMarkAsVideo, (_event, input) => {
    const parsed = parseScanMarkAsVideoInput(input)
    return scanner().markAsVideo(parsed.sessionId, parsed.itemId)
  })

  invoke<ScanManualMatchResult | null>(
    IPC.scanPickMatchVideo,
    async (_event, input) => {
      const parsed = parseScanManualMatchInput(input)
      const service = context.manualMatch
      if (!service) {
        throw new AppError(
          'SCAN_MATCH_UNAVAILABLE',
          'Matching a script set to a local video is not available.'
        )
      }
      return service.match(parsed)
    }
  )

  // Help & diagnostics. The folder comes from main's own logger (app data
  // under the user profile), never from a renderer argument, and the copied
  // text is built from renderer-safe values and already-redacted log records.
  const diagnosticsFolder = async (): Promise<string> => {
    if (!context.openLogFolder) {
      throw new AppError(
        'DIAGNOSTICS_UNAVAILABLE',
        'Diagnostics are not available.'
      )
    }
    return context.openLogFolder()
  }

  invoke<null>(IPC.openLogFolder, async () => {
    const folder = await diagnosticsFolder()
    const failure = await shell.openPath(folder)
    if (failure) {
      throw new AppError(
        'LOG_FOLDER_UNAVAILABLE',
        'The log folder could not be opened.'
      )
    }
    return null
  })

  invoke<string>(IPC.copyDiagnostics, async () => {
    if (!context.buildDiagnostics) {
      throw new AppError(
        'DIAGNOSTICS_UNAVAILABLE',
        'Diagnostics are not available.'
      )
    }
    return context.buildDiagnostics()
  })
}
