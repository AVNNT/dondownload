import type {
  AnalyzeMediaInput,
  MediaAnalysis,
  MediaJob,
  MediaQueueInput,
  MediaSnapshot
} from './media'

export type DownloadStatus =
  | 'queued'
  | 'active'
  | 'waiting'
  | 'paused'
  | 'complete'
  | 'error'
  | 'interrupted'

export type Aria2RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'unavailable'
  | 'error'

export interface AppErrorInfo {
  code: string
  message: string
  hint?: string
}

export interface Aria2State {
  status: Aria2RuntimeStatus
  version: string | null
  binaryPath: string | null
  message: string | null
  hint: string | null
}

export interface DownloadItem {
  id: string
  gid: string
  url: string
  filename: string
  dir: string
  filePath: string | null
  status: DownloadStatus
  totalBytes: number
  completedBytes: number
  speedBps: number
  etaSeconds: number | null
  errorMessage: string | null
  attempts: number
  maxAttempts: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface AddDownloadInput {
  url: string
  filename?: string
  /**
   * Explicit user opt-in for a deliberate second copy of an unfinished URL.
   * Never set this automatically; it only comes from a Download again action.
   */
  force?: boolean
}

export interface AppSnapshot {
  aria2: Aria2State
  downloads: DownloadItem[]
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppErrorInfo }

export interface DonDownloadApi {
  getSnapshot: () => Promise<ApiResult<AppSnapshot>>
  addDownload: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
  pauseDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  resumeDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  retryDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  removeDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  showInFolder: (id: string) => Promise<ApiResult<null>>
  restartAria2: () => Promise<ApiResult<AppSnapshot>>
  onSnapshotChanged: (listener: (snapshot: AppSnapshot) => void) => () => void

  // Media (Milestone 3A). These are additive and do not change the download
  // API above. Public media values never contain URLs, paths or raw metadata.
  analyzeMedia: (input: AnalyzeMediaInput) => Promise<ApiResult<MediaAnalysis>>
  queueMedia: (input: MediaQueueInput) => Promise<ApiResult<MediaSnapshot>>
  getMediaSnapshot: () => Promise<ApiResult<MediaSnapshot>>
  getMediaJob: (jobId: string) => Promise<ApiResult<MediaJob>>
  cancelMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  removeMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  showMediaInFolder: (jobId: string) => Promise<ApiResult<null>>
  onMediaSnapshotChanged: (
    listener: (snapshot: MediaSnapshot) => void
  ) => () => void
}
