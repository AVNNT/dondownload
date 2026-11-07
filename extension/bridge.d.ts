export const NATIVE_HOST: string
export const QUEUE_MESSAGE_TYPE: string
export const PROBE_MESSAGE_TYPE: string
export const CAPTURED_SOURCE_MESSAGE_TYPE: string
export const DURABLE_HANDOFF_MESSAGE_TYPE: string
export const DOWNLOAD_STATUS_MESSAGE_TYPE: string
export const SHOW_DOWNLOAD_MESSAGE_TYPE: string
export const SCAN_PAGE_MESSAGE_TYPE: string
export const SCAN_IMAGES_MESSAGE_TYPE: string
export const SCAN_GOFILE_MESSAGE_TYPE: string
export const SCAN_VIDEO_MESSAGE_TYPE: string
export const MAX_SCAN_VIDEO_SOURCES: number
export const MAX_VIDEO_LABEL_LENGTH: number
export const MAX_VIDEO_TITLE_LENGTH: number
export const MAX_SCAN_GOFILE_FILES: number
export const MAX_GOFILE_NAME_LENGTH: number
export const MAX_SCAN_IMAGES: number
export const MAX_IMAGE_ALT_LENGTH: number
export const MAX_PAGE_TITLE_LENGTH: number
export const MAX_URL_LENGTH: number
export const MAX_CAPTURED_FILENAME_LENGTH: number
export const HANDOFF_TIMEOUT_MS: number

export interface BridgeFailure {
  ok: false
  error: { code: string; message: string }
}

export interface MediaFormatOptionDto {
  kind: 'video' | 'audio'
  optionId: string
  label: string
  container: string
  width: number | null
  height: number | null
  fps: number | null
  videoCodec: string | null
  audioCodec: string | null
  hasAudio: boolean
  requiresMerge: boolean
  hdr?: boolean
  filesizeBytes: number | null
  estimatedBytes?: number | null
  sizeIsEstimate?: boolean
  outputFormats?: string[]
  outputSizes?: Record<string, { bytes: number | null; isEstimate: boolean }>
  formatIds?: string[]
}

export interface MediaAnalysisDto {
  analysisId: string
  title: string
  thumbnailUrl?: string | null
  durationSeconds: number | null
  options: MediaFormatOptionDto[]
  bestVideoOptionId: string | null
  bestAudioOptionId: string | null
  expiresAt: number
}

export interface MediaJobDto {
  id: string
  analysisId: string
  optionId: string
  kind: 'video' | 'audio'
  title: string
  label: string
  status: string
  completedBytes: number
  totalBytes: number | null
  speedBps: number
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type UrlResult =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string }

export type NormalizedCapturedSource =
  | {
      ok: true
      url: string
      filename?: string
      contentType?: 'video/mp4' | 'video/webm'
      expectedBytes?: number
      referer?: string
      userAgent?: string
    }
  | { ok: false; code: string; message: string }

export type AnalyzeMediaResult =
  | { ok: true; analysis: MediaAnalysisDto }
  | BridgeFailure

export type QueueMediaResult = { ok: true; job: MediaJobDto } | BridgeFailure

export interface DurableHandoffReceiptDto {
  downloadId: string
  persistedAt: number
}

export type DurableHandoffResult =
  | { ok: true; durable: true; receipt: DurableHandoffReceiptDto }
  | BridgeFailure

export type HandoffDownloadStatusName =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'

export interface HandoffDownloadStatusDto {
  status: HandoffDownloadStatusName
  completedBytes: number
  totalBytes: number
  filename: string
  errorMessage?: string
}

export type DownloadStatusResult =
  | ({ ok: true } & HandoffDownloadStatusDto)
  | BridgeFailure

export function sendDownloadStatus(
  rawDownloadId: unknown
): Promise<DownloadStatusResult>
export function sendShowDownload(
  rawDownloadId: unknown
): Promise<{ ok: true } | BridgeFailure>

export function normalizeSupportedUrl(value: unknown): UrlResult
export function normalizeCapturedSource(
  rawUrl: unknown,
  rawFilename?: unknown,
  evidence?: {
    contentType?: unknown
    expectedBytes?: unknown
    referer?: unknown
    userAgent?: unknown
  }
): NormalizedCapturedSource
export function sendQueueCapturedSource(
  rawUrl: unknown,
  rawFilename?: unknown,
  evidence?: {
    contentType?: unknown
    expectedBytes?: unknown
    referer?: unknown
    userAgent?: unknown
  }
): Promise<{ ok: true } | BridgeFailure>
export function sendDurableHandoff(
  rawUrl: unknown,
  rawFilename?: unknown,
  options?: {
    timeoutMs?: number
    expectedBytes?: number
    expectedContentType?: string
    referer?: string
    userAgent?: string
    cookie?: string
    /** Minimum known size for an automatic browser download. */
    minBytes?: number
    /** The candidate already decided this file ignores the size threshold. */
    ignoreMinimumBytes?: boolean
  }
): Promise<DurableHandoffResult>
export function sendQueueDownload(
  rawUrl: unknown,
  options?: { force?: boolean }
): Promise<{ ok: boolean; error?: { code: string; message: string } }>
export function sendScanPage(
  rawUrl: unknown,
  rawCookie?: unknown
): Promise<{ ok: true } | BridgeFailure>
export function sendScanImages(
  input: unknown
): Promise<{ ok: true } | BridgeFailure>
export function sendScanGofile(
  input: unknown
): Promise<{ ok: true } | BridgeFailure>
export function sendScanVideo(
  input: unknown
): Promise<{ ok: true; sourceCount: number } | BridgeFailure>
export function probeNativeConnection(): Promise<
  { ok: true } | { ok: false; error: { code: string; message: string } }
>
export function sendAnalyzeMedia(rawUrl: unknown): Promise<AnalyzeMediaResult>
export function sendQueueMedia(input: unknown): Promise<QueueMediaResult>
export function sendMediaStatus(jobId: unknown): Promise<QueueMediaResult>
export function sendCancelMedia(jobId: unknown): Promise<QueueMediaResult>

/**
 * One persistent native messaging port serves every request for the lifetime of
 * the service worker. Each request carries an `id` that the host echoes, and a
 * request that cannot use the port falls back to a one-shot sendNativeMessage.
 */
export function resetNativeBridgeForTests(): void
