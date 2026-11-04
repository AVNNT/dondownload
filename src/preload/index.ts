import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AnalyzeCollectionInput,
  Batch,
  BatchItemTargetInput,
  BatchTargetInput,
  CollectionPreview,
  CreateCollectionBatchInput
} from '../shared/batches'
import type {
  AnalyzeMediaInput,
  MediaAnalysis,
  MediaJob,
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
  SmartBatchSubmitResult
} from '../shared/types'

const api: DonDownloadApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<ApiResult<AppSnapshot>>,
  addDownload: (input: AddDownloadInput) =>
    ipcRenderer.invoke(IPC.addDownload, input) as Promise<ApiResult<AppSnapshot>>,
  pauseDownload: (id: string) =>
    ipcRenderer.invoke(IPC.pauseDownload, id) as Promise<ApiResult<AppSnapshot>>,
  resumeDownload: (id: string) =>
    ipcRenderer.invoke(IPC.resumeDownload, id) as Promise<ApiResult<AppSnapshot>>,
  retryDownload: (id: string) =>
    ipcRenderer.invoke(IPC.retryDownload, id) as Promise<ApiResult<AppSnapshot>>,
  removeDownload: (id: string) =>
    ipcRenderer.invoke(IPC.removeDownload, id) as Promise<ApiResult<AppSnapshot>>,
  showInFolder: (id: string) =>
    ipcRenderer.invoke(IPC.showInFolder, id) as Promise<ApiResult<null>>,
  restartAria2: () =>
    ipcRenderer.invoke(IPC.restartAria2) as Promise<ApiResult<AppSnapshot>>,
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
  cancelMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.cancelMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  removeMedia: (jobId: string) =>
    ipcRenderer.invoke(IPC.removeMedia, jobId) as Promise<ApiResult<MediaSnapshot>>,
  showMediaInFolder: (jobId: string) =>
    ipcRenderer.invoke(IPC.showMediaInFolder, jobId) as Promise<ApiResult<null>>,
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
  }
}

contextBridge.exposeInMainWorld('donDownload', api)
