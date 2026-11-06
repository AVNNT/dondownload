import type {
  AnalyzeCollectionInput,
  Batch,
  BatchItemTargetInput,
  BatchTargetInput,
  CollectionPreview,
  CollectionSelectionAvailability,
  CreateCollectionBatchInput
} from './batches'
import type {
  AnalyzeMediaInput,
  MediaAnalysis,
  MediaJob,
  MediaJobDetails,
  MediaQueueInput,
  MediaSnapshot
} from './media'
import type { DownloadControls, DownloadSettings } from './settings'
import type { DesktopSettings } from './desktopSettings'
import type {
  MediaToolSettings,
  YtdlpUpdateState
} from './mediaTools'
import type { BrowserExtensionStatus } from './browserExtension'
import type { AppUpdateState } from './appUpdate'
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
} from './scanner'

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

/**
 * Why a waiting download has not been handed to aria2 yet. A manual pause is
 * represented by `status: 'paused'` instead, so the UI can always tell a
 * user-paused job apart from one the schedule or allowed-hours policy is
 * holding back.
 */
export type DownloadBlockReason = 'scheduled' | 'allowed-hours'

export const DOWNLOAD_BLOCK_REASONS: readonly DownloadBlockReason[] = [
  'scheduled',
  'allowed-hours'
]

export function isDownloadBlockReason(
  value: unknown
): value is DownloadBlockReason {
  return (
    typeof value === 'string' &&
    (DOWNLOAD_BLOCK_REASONS as readonly string[]).includes(value)
  )
}

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
  /**
   * Optional per-download controls. They are always present in manager
   * snapshots but optional in the type so older fixtures and narrow ports stay
   * valid.
   */
  scheduledAt?: number | null
  speedLimitBps?: number | null
  connections?: number | null
  /** Null when the job is not waiting on schedule/allowed-hours policy. */
  blockReason?: DownloadBlockReason | null
}

/** A progressive media file observed during real page playback. */
export interface CapturedSourceInput {
  url: string
  filename?: string
  /**
   * Exact video/mp4 or video/webm response type observed for an extensionless
   * URL. The desktop still verifies it anonymously before queueing.
   */
  contentType?: 'video/mp4' | 'video/webm'
  /** Complete-file total observed from Content-Range/Content-Length. */
  expectedBytes?: number
  /**
   * One-job Referer/User-Agent headers for a player URL that only the browser
   * page can identify (for example a KVS file URL). Never persisted.
   */
  requestHeaders?: DownloadRequestHeaders
}

export const MAX_CAPTURED_SOURCE_FILENAME_LENGTH = 180

/**
 * One-job request headers learned from an explicitly enabled browser page.
 * These are in-memory only and are never written to the database or logs.
 */
export interface DownloadRequestHeaders {
  referer?: string
  userAgent?: string
  cookie?: string
}

export interface AddDownloadInput {
  url: string
  filename?: string
  requestHeaders?: DownloadRequestHeaders
  /**
   * Internal: a redirect chain that a trusted caller (the scanner probe or the
   * browser hand-off preflight) already resolved. DownloadManager still enforces
   * host and scheme scope before it sends a Cookie; it never trusts this value
   * to widen a cookie's origin.
   */
  resolvedUrl?: string
  /**
   * Explicit user opt-in for a deliberate second copy of an unfinished URL.
   * Never set this automatically; it only comes from a Download again action.
   */
  force?: boolean
  /**
   * Optional schedule/speed/connection controls. Omitted controls mean
   * unscheduled, unlimited and aria2's global connection setting.
   */
  controls?: DownloadControls
}

export interface AppSnapshot {
  aria2: Aria2State
  downloads: DownloadItem[]
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppErrorInfo }

/** Result of the main process's bounded HEAD size probe for a direct link. */
export interface UrlSizeProbe {
  /** Total `content-length` bytes, or null when the size cannot be known. */
  size: number | null
}

/* ------------------------------------------------------------------------- *
 * Milestone 3B batch orchestration (renderer-safe)
 * ------------------------------------------------------------------------- */

/** Safe snapshot of every persisted parent batch. */
export interface BatchSnapshot {
  batches: Batch[]
}

/** Input for the smart multi-URL submit action. */
export interface SmartBatchSubmitInput {
  urls: string[]
}

export const SMART_BATCH_ENTRY_OUTCOMES = [
  'batch-item',
  'collection-preview',
  'unsupported',
  'invalid',
  'failed'
] as const
export type SmartBatchEntryOutcome =
  (typeof SMART_BATCH_ENTRY_OUTCOMES)[number]

/**
 * Per-input outcome of a smart batch submit. `index` maps back to the caller's
 * input order. No source URL, path, token or header is ever included: entry
 * text is limited to stable codes and safe messages.
 */
export interface SmartBatchSubmitEntry {
  index: number
  outcome: SmartBatchEntryOutcome
  batchId: string | null
  itemId: string | null
  previewId: string | null
  code: string | null
  message: string | null
}

/**
 * Result of a smart submit: a created direct-item batch (when at least one URL
 * became a direct item), separately pending collection previews that require an
 * explicit selection, and independent invalid/failed entries. Nothing from a
 * collection preview is queued automatically.
 */
export interface SmartBatchSubmitResult {
  batch: Batch | null
  previews: CollectionPreview[]
  entries: SmartBatchSubmitEntry[]
}

export interface DonDownloadApi {
  getSnapshot: () => Promise<ApiResult<AppSnapshot>>
  addDownload: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
  pauseDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  resumeDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  /** Explicit user override for a scheduled or allowed-hours-blocked job. */
  startDownloadNow: (id: string) => Promise<ApiResult<AppSnapshot>>
  retryDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  removeDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  showInFolder: (id: string) => Promise<ApiResult<null>>
  /** Open a completed download's verified file with the OS default app. */
  openFile: (id: string) => Promise<ApiResult<null>>
  /** Move a finished download's recorded output to the Recycle Bin. */
  deleteDownloadFile: (id: string) => Promise<ApiResult<AppSnapshot>>
  restartAria2: () => Promise<ApiResult<AppSnapshot>>
  /** Bounded anonymous HEAD probe: total bytes of a direct file URL, or null. */
  probeUrlSize: (url: string) => Promise<ApiResult<UrlSizeProbe>>
  onSnapshotChanged: (listener: (snapshot: AppSnapshot) => void) => () => void

  // Media (Milestone 3A). These are additive and do not change the download
  // API above. Public media values never contain URLs, paths or raw metadata.
  analyzeMedia: (input: AnalyzeMediaInput) => Promise<ApiResult<MediaAnalysis>>
  queueMedia: (input: MediaQueueInput) => Promise<ApiResult<MediaSnapshot>>
  getMediaSnapshot: () => Promise<ApiResult<MediaSnapshot>>
  getMediaJob: (jobId: string) => Promise<ApiResult<MediaJob>>
  /**
   * Display-only details for one media job, fetched on demand by the details
   * pane. The bulk media DTOs above stay free of source URLs and paths.
   */
  getMediaJobDetails: (jobId: string) => Promise<ApiResult<MediaJobDetails>>
  cancelMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  pauseMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  resumeMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  retryMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  removeMedia: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  /** Move a finished media job's recorded output to the Recycle Bin. */
  deleteMediaFile: (jobId: string) => Promise<ApiResult<MediaSnapshot>>
  showMediaInFolder: (jobId: string) => Promise<ApiResult<null>>
  /** Open a completed media output with the OS default app. */
  openMediaFile: (jobId: string) => Promise<ApiResult<null>>
  onMediaSnapshotChanged: (
    listener: (snapshot: MediaSnapshot) => void
  ) => () => void

  // Batch orchestration (Milestone 3B). Collection previews are ephemeral and
  // batches are created only from an explicit selection of preview entry IDs.
  analyzeBatchCollection: (
    input: AnalyzeCollectionInput
  ) => Promise<ApiResult<CollectionPreview>>
  analyzeCollectionSelection: (
    input: CreateCollectionBatchInput
  ) => Promise<ApiResult<CollectionSelectionAvailability>>
  submitSmartBatch: (
    input: SmartBatchSubmitInput
  ) => Promise<ApiResult<SmartBatchSubmitResult>>
  createCollectionBatch: (
    input: CreateCollectionBatchInput
  ) => Promise<ApiResult<Batch>>
  getBatchSnapshot: () => Promise<ApiResult<BatchSnapshot>>
  getBatch: (batchId: string) => Promise<ApiResult<Batch>>
  cancelBatchItem: (
    input: BatchItemTargetInput
  ) => Promise<ApiResult<BatchSnapshot>>
  cancelBatch: (input: BatchTargetInput) => Promise<ApiResult<BatchSnapshot>>
  retryBatchItem: (
    input: BatchItemTargetInput
  ) => Promise<ApiResult<BatchSnapshot>>
  removeBatch: (input: BatchTargetInput) => Promise<ApiResult<BatchSnapshot>>
  openBatchSource: (input: BatchItemTargetInput) => Promise<ApiResult<null>>
  onBatchSnapshotChanged: (
    listener: (snapshot: BatchSnapshot) => void
  ) => () => void

  // Milestone 5A runtime settings. The update replaces the complete, exact-key
  // settings object; values are validated before persistence and before aria2
  // is changed. No secret, URL or path is part of this contract.
  getSettings: () => Promise<ApiResult<DownloadSettings>>
  updateSettings: (
    settings: DownloadSettings
  ) => Promise<ApiResult<DownloadSettings>>

  // Desktop-only preferences (notifications, clipboard, startup, zoom).
  getDesktopSettings: () => Promise<ApiResult<DesktopSettings>>
  updateDesktopSettings: (
    settings: DesktopSettings
  ) => Promise<ApiResult<DesktopSettings>>
  onDesktopSettingsChanged: (
    listener: (settings: DesktopSettings) => void
  ) => () => void

  /** Copy text through the main process so the clipboard watcher ignores it. */
  copyText: (text: string) => Promise<ApiResult<null>>
  /** A single changed http(s) URL when clipboard watching is enabled. */
  onClipboardLink: (listener: (url: string) => void) => () => void
  /** Notification click: reveal (select) one download or media row. */
  onRevealRow: (listener: (rowKey: string) => void) => () => void

  // Managed yt-dlp updater. The update request only carries the automatic
  // toggle; a check can report up-to-date, updated, deferred or a safe failure.
  getMediaToolSettings: () => Promise<ApiResult<MediaToolSettings>>
  updateMediaToolSettings: (input: {
    autoUpdateYtdlp: boolean
  }) => Promise<ApiResult<MediaToolSettings>>
  getYtdlpUpdateState: () => Promise<ApiResult<YtdlpUpdateState>>
  checkYtdlpUpdate: () => Promise<ApiResult<YtdlpUpdateState>>

  // Zero-config browser bridge registration. Repair re-runs the same
  // manifest/registry logic used at startup; folder actions are fixed-path.
  getBrowserExtensionStatus: () => Promise<ApiResult<BrowserExtensionStatus>>
  repairBrowserExtension: () => Promise<ApiResult<BrowserExtensionStatus>>
  openBrowserExtensionFolder: () => Promise<ApiResult<null>>
  copyBrowserExtensionFolderPath: () => Promise<ApiResult<null>>
  // Application self-update. State is renderer-safe and never carries an
  // installer URL or path. Installing is only ever an explicit user action.
  getAppUpdateState: () => Promise<ApiResult<AppUpdateState>>
  checkAppUpdate: () => Promise<ApiResult<AppUpdateState>>
  installAppUpdate: () => Promise<ApiResult<AppUpdateState>>
  setAppUpdateAutoCheck: (input: {
    autoCheck: boolean
  }) => Promise<ApiResult<AppUpdateState>>
  onAppUpdateStateChanged: (
    listener: (state: AppUpdateState) => void
  ) => () => void

  // Smart Link Scanner phase 1. A scan only discovers and verifies candidates;
  // it has no queue path. Downloading requires the explicit item selection.
  startScan: (input: ScanStartInput) => Promise<ApiResult<ScanSession>>
  /** Start several topic scans at once; extras queue behind MAX_ACTIVE_SCANS. */
  startScans: (urls: string[]) => Promise<ApiResult<ScanSession[]>>
  cancelScan: (sessionId: string) => Promise<ApiResult<ScanSession>>
  queueScanSelection: (
    sessionId: string,
    itemIds: string[],
    videoOptions?: ScanQueueVideoOption[],
    pairings?: ScanScriptPairingInput[]
  ) => Promise<ApiResult<ScanQueueResult>>
  /** One click across topics: each session is validated independently. */
  queueScanSelections: (
    selections: ScanQueueSelectionInput[]
  ) => Promise<ApiResult<ScanQueueSelectionsResult>>
  /**
   * Open a browser-only card. The renderer sends opaque IDs only; the stored
   * URL never crosses IPC. With a pairing, main also arms the browser hand-off.
   */
  openScanInBrowser: (
    sessionId: string,
    itemId: string,
    pairing?: ScanBrowserScriptSelection
  ) => Promise<ApiResult<null>>
  /**
   * Mark a listed page link as a video page. The renderer sends opaque IDs only;
   * main re-validates the stored URL and resolves it with the usual budget.
   */
  markScanItemAsVideo: (
    sessionId: string,
    itemId: string
  ) => Promise<ApiResult<ScanSession>>
  /** Ask main for a local video file and queue the chosen scripts into it. */
  pickScanMatchVideo: (
    input: ScanManualMatchInput
  ) => Promise<ApiResult<ScanManualMatchResult | null>>
  onScanUpdated: (listener: (session: ScanSession) => void) => () => void
}
