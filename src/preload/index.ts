import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AnalyzeCollectionInput,
  Batch,
  BatchItemTargetInput,
  BatchTargetInput,
  CollectionPreview,
  CollectionSelectionAvailability,
  CreateCollectionBatchInput
} from '../shared/batches'
import type {
  AnalyzeMediaInput,
  MediaAnalysis,
  MediaJob,
  MediaJobDetails,
  MediaQueueInput,
  MediaSnapshot
} from '../shared/media'
import type {
  AddDownloadInput,
  ApiResult,
  AppSnapshot,
  BatchSnapshot,
  DonDownloadApi,
  SmartBatchSubmitInput,
  SmartBatchSubmitResult,
  UrlSizeProbe
} from '../shared/types'
import type { DownloadSettings } from '../shared/settings'
import type { DesktopSettings } from '../shared/desktopSettings'
import type {
  MediaToolSettings,
  YtdlpUpdateState
} from '../shared/mediaTools'
import type { BrowserExtensionStatus } from '../shared/browserExtension'
import type { AppUpdateState } from '../shared/appUpdate'
import type {
  ScanBrowserScriptSelection,
  ScanManualMatchInput,
  ScanManualMatchResult,
  ScanQueueResult,
  ScanQueueSelectionInput,
  ScanQueueSelectionsResult,
  ScanQueueVideoOption,
  ScanScriptPairingInput,
  ScanSession,
  ScanStartInput
} from '../shared/scanner'

const api: DonDownloadApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<ApiResult<AppSnapshot>>,
  addDownload: (input: AddDownloadInput) =>
    ipcRenderer.invoke(IPC.addDownload, input) as Promise<ApiResult<AppSnapshot>>,
  pauseDownload: (id: string) =>
    ipcRenderer.invoke(IPC.pauseDownload, id) as Promise<ApiResult<AppSnapshot>>,
  resumeDownload: (id: string) =>
    ipcRenderer.invoke(IPC.resumeDownload, id) as Promise<ApiResult<AppSnapshot>>,
  startDownloadNow: (id: string) =>
    ipcRenderer.invoke(IPC.startDownloadNow, id) as Promise<
      ApiResult<AppSnapshot>
    >,
  retryDownload: (id: string) =>
    ipcRenderer.invoke(IPC.retryDownload, id) as Promise<ApiResult<AppSnapshot>>,
  removeDownload: (id: string) =>
    ipcRenderer.invoke(IPC.removeDownload, id) as Promise<ApiResult<AppSnapshot>>,
  removeDownloads: (ids: string[]) =>
    ipcRenderer.invoke(IPC.removeDownloads, ids) as Promise<
      ApiResult<AppSnapshot>
    >,
  showInFolder: (id: string) =>
    ipcRenderer.invoke(IPC.showInFolder, id) as Promise<ApiResult<null>>,
  openFile: (id: string) =>
    ipcRenderer.invoke(IPC.openFile, id) as Promise<ApiResult<null>>,
  deleteDownloadFile: (id: string) =>
    ipcRenderer.invoke(IPC.deleteDownloadFile, id) as Promise<
      ApiResult<AppSnapshot>
    >,
  restartAria2: () =>
    ipcRenderer.invoke(IPC.restartAria2) as Promise<ApiResult<AppSnapshot>>,
  probeUrlSize: (url: string) =>
    ipcRenderer.invoke(IPC.probeUrlSize, url) as Promise<
      ApiResult<UrlSizeProbe>
    >,
  onSnapshotChanged: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on(IPC.snapshotChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.snapshotChanged, handler)
    }
  },
  analyzeMedia: (input: AnalyzeMediaInput) =>
    ipcRenderer.invoke(IPC.analyzeMedia, input) as Promise<ApiResult<MediaAnalysis>>,
  queueMedia: (input: MediaQueueInput) =>
    ipcRenderer.invoke(IPC.queueMedia, input) as Promise<ApiResult<MediaSnapshot>>,
  getMediaSnapshot: () =>
    ipcRenderer.invoke(IPC.getMediaSnapshot) as Promise<ApiResult<MediaSnapshot>>,
  getMediaJob: (jobId: string) =>
    ipcRenderer.invoke(IPC.getMediaJob, jobId) as Promise<ApiResult<MediaJob>>,
  getMediaJobDetails: (jobId: string) =>
    ipcRenderer.invoke(IPC.getMediaJobDetails, jobId) as Promise<
      ApiResult<MediaJobDetails>
    >,
  cancelMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.cancelMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  pauseMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.pauseMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  resumeMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.resumeMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  retryMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.retryMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  removeMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.removeMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  removeMediaJobs: (ids: string[]) =>
    ipcRenderer.invoke(IPC.removeMediaJobs, ids) as Promise<
      ApiResult<MediaSnapshot>
    >,
  deleteMediaFile: (jobId: string) =>
    ipcRenderer.invoke(IPC.deleteMediaFile, jobId) as Promise<
      ApiResult<MediaSnapshot>
    >,
  showMediaInFolder: (jobId: string) =>
    ipcRenderer.invoke(IPC.showMediaInFolder, jobId) as Promise<ApiResult<null>>,
  openMediaFile: (jobId: string) =>
    ipcRenderer.invoke(IPC.openMediaFile, jobId) as Promise<ApiResult<null>>,
  onMediaSnapshotChanged: (listener: (snapshot: MediaSnapshot) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: MediaSnapshot
    ): void => {
      listener(snapshot)
    }
    ipcRenderer.on(IPC.mediaSnapshotChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.mediaSnapshotChanged, handler)
    }
  },
  analyzeBatchCollection: (input: AnalyzeCollectionInput) =>
    ipcRenderer.invoke(IPC.analyzeBatchCollection, input) as Promise<
      ApiResult<CollectionPreview>
    >,
  analyzeCollectionSelection: (input: CreateCollectionBatchInput) =>
    ipcRenderer.invoke(IPC.analyzeCollectionSelection, input) as Promise<
      ApiResult<CollectionSelectionAvailability>
    >,
  submitSmartBatch: (input: SmartBatchSubmitInput) =>
    ipcRenderer.invoke(IPC.submitSmartBatch, input) as Promise<
      ApiResult<SmartBatchSubmitResult>
    >,
  createCollectionBatch: (input: CreateCollectionBatchInput) =>
    ipcRenderer.invoke(IPC.createCollectionBatch, input) as Promise<
      ApiResult<Batch>
    >,
  getBatchSnapshot: () =>
    ipcRenderer.invoke(IPC.getBatchSnapshot) as Promise<
      ApiResult<BatchSnapshot>
    >,
  getBatch: (batchId: string) =>
    ipcRenderer.invoke(IPC.getBatch, batchId) as Promise<ApiResult<Batch>>,
  cancelBatchItem: (input: BatchItemTargetInput) =>
    ipcRenderer.invoke(IPC.cancelBatchItem, input) as Promise<
      ApiResult<BatchSnapshot>
    >,
  cancelBatch: (input: BatchTargetInput) =>
    ipcRenderer.invoke(IPC.cancelBatch, input) as Promise<
      ApiResult<BatchSnapshot>
    >,
  retryBatchItem: (input: BatchItemTargetInput) =>
    ipcRenderer.invoke(IPC.retryBatchItem, input) as Promise<
      ApiResult<BatchSnapshot>
    >,
  removeBatch: (input: BatchTargetInput) =>
    ipcRenderer.invoke(IPC.removeBatch, input) as Promise<
      ApiResult<BatchSnapshot>
    >,
  openBatchSource: (input: BatchItemTargetInput) =>
    ipcRenderer.invoke(IPC.openBatchSource, input) as Promise<ApiResult<null>>,
  onBatchSnapshotChanged: (listener: (snapshot: BatchSnapshot) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: BatchSnapshot
    ): void => {
      listener(snapshot)
    }
    ipcRenderer.on(IPC.batchSnapshotChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.batchSnapshotChanged, handler)
    }
  },
  getSettings: () =>
    ipcRenderer.invoke(IPC.getSettings) as Promise<ApiResult<DownloadSettings>>,
  updateSettings: (settings: DownloadSettings) =>
    ipcRenderer.invoke(IPC.updateSettings, settings) as Promise<
      ApiResult<DownloadSettings>
    >,
  setSpeedLimit: (bps: number) =>
    ipcRenderer.invoke(IPC.setSpeedLimit, bps) as Promise<
      ApiResult<DownloadSettings>
    >,
  onSettingsChanged: (listener: (settings: DownloadSettings) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: DownloadSettings
    ): void => {
      listener(settings)
    }
    ipcRenderer.on(IPC.settingsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.settingsChanged, handler)
    }
  },
  getDesktopSettings: () =>
    ipcRenderer.invoke(IPC.getDesktopSettings) as Promise<
      ApiResult<DesktopSettings>
    >,
  updateDesktopSettings: (settings: DesktopSettings) =>
    ipcRenderer.invoke(IPC.updateDesktopSettings, settings) as Promise<
      ApiResult<DesktopSettings>
    >,
  onDesktopSettingsChanged: (listener: (settings: DesktopSettings) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: DesktopSettings
    ): void => {
      listener(settings)
    }
    ipcRenderer.on(IPC.desktopSettingsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.desktopSettingsChanged, handler)
    }
  },
  copyText: (text: string) =>
    ipcRenderer.invoke(IPC.copyText, text) as Promise<ApiResult<null>>,
  onClipboardLink: (listener: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string): void => {
      listener(url)
    }
    ipcRenderer.on(IPC.clipboardLink, handler)
    return () => {
      ipcRenderer.removeListener(IPC.clipboardLink, handler)
    }
  },
  onRevealRow: (listener: (rowKey: string) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      rowKey: string
    ): void => {
      listener(rowKey)
    }
    ipcRenderer.on(IPC.revealRow, handler)
    return () => {
      ipcRenderer.removeListener(IPC.revealRow, handler)
    }
  },
  getMediaToolSettings: () =>
    ipcRenderer.invoke(IPC.getMediaToolSettings) as Promise<
      ApiResult<MediaToolSettings>
    >,
  updateMediaToolSettings: (input: { autoUpdateYtdlp: boolean }) =>
    ipcRenderer.invoke(IPC.updateMediaToolSettings, input) as Promise<
      ApiResult<MediaToolSettings>
    >,
  getYtdlpUpdateState: () =>
    ipcRenderer.invoke(IPC.getYtdlpUpdateState) as Promise<
      ApiResult<YtdlpUpdateState>
    >,
  checkYtdlpUpdate: () =>
    ipcRenderer.invoke(IPC.checkYtdlpUpdate) as Promise<
      ApiResult<YtdlpUpdateState>
    >,
  getBrowserExtensionStatus: () =>
    ipcRenderer.invoke(IPC.getBrowserExtensionStatus) as Promise<
      ApiResult<BrowserExtensionStatus>
    >,
  repairBrowserExtension: () =>
    ipcRenderer.invoke(IPC.repairBrowserExtension) as Promise<
      ApiResult<BrowserExtensionStatus>
    >,
  openBrowserExtensionFolder: () =>
    ipcRenderer.invoke(IPC.openBrowserExtensionFolder) as Promise<
      ApiResult<null>
    >,
  copyBrowserExtensionFolderPath: () =>
    ipcRenderer.invoke(IPC.copyBrowserExtensionFolderPath) as Promise<
      ApiResult<null>
    >,
  getAppUpdateState: () =>
    ipcRenderer.invoke(IPC.getAppUpdateState) as Promise<
      ApiResult<AppUpdateState>
    >,
  checkAppUpdate: () =>
    ipcRenderer.invoke(IPC.checkAppUpdate) as Promise<ApiResult<AppUpdateState>>,
  installAppUpdate: () =>
    ipcRenderer.invoke(IPC.installAppUpdate) as Promise<
      ApiResult<AppUpdateState>
    >,
  setAppUpdateAutoCheck: (input: { autoCheck: boolean }) =>
    ipcRenderer.invoke(IPC.setAppUpdateAutoCheck, input) as Promise<
      ApiResult<AppUpdateState>
    >,
  onAppUpdateStateChanged: (
    listener: (state: AppUpdateState) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: AppUpdateState
    ): void => {
      listener(state)
    }
    ipcRenderer.on(IPC.appUpdateStateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.appUpdateStateChanged, handler)
    }
  },
  startScan: (input: ScanStartInput) =>
    ipcRenderer.invoke(IPC.scanStart, input) as Promise<ApiResult<ScanSession>>,
  startScans: (urls: string[]) =>
    ipcRenderer.invoke(IPC.scanStartMany, { urls }) as Promise<
      ApiResult<ScanSession[]>
    >,
  cancelScan: (sessionId: string) =>
    ipcRenderer.invoke(IPC.scanCancel, { sessionId }) as Promise<
      ApiResult<ScanSession>
    >,
  queueScanSelection: (
    sessionId: string,
    itemIds: string[],
    videoOptions?: ScanQueueVideoOption[],
    pairings?: ScanScriptPairingInput[]
  ) =>
    ipcRenderer.invoke(IPC.scanQueueSelection, {
      sessionId,
      itemIds,
      ...(videoOptions === undefined ? {} : { videoOptions }),
      ...(pairings === undefined ? {} : { pairings })
    }) as Promise<ApiResult<ScanQueueResult>>,
  queueScanSelections: (selections: ScanQueueSelectionInput[]) =>
    ipcRenderer.invoke(IPC.scanQueueSelections, { selections }) as Promise<
      ApiResult<ScanQueueSelectionsResult>
    >,
  openScanInBrowser: (
    sessionId: string,
    itemId: string,
    pairing?: ScanBrowserScriptSelection
  ) =>
    ipcRenderer.invoke(IPC.scanOpenInBrowser, {
      sessionId,
      itemId,
      ...(pairing === undefined ? {} : { pairing })
    }) as Promise<ApiResult<null>>,
  markScanItemAsVideo: (sessionId: string, itemId: string) =>
    ipcRenderer.invoke(IPC.scanMarkAsVideo, {
      sessionId,
      itemId
    }) as Promise<ApiResult<ScanSession>>,
  pickScanMatchVideo: (input: ScanManualMatchInput) =>
    ipcRenderer.invoke(IPC.scanPickMatchVideo, input) as Promise<
      ApiResult<ScanManualMatchResult | null>
    >,
  onScanUpdated: (listener: (session: ScanSession) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      session: ScanSession
    ): void => {
      listener(session)
    }
    ipcRenderer.on(IPC.scanUpdated, handler)
    return () => {
      ipcRenderer.removeListener(IPC.scanUpdated, handler)
    }
  }
}

contextBridge.exposeInMainWorld('donDownload', api)
