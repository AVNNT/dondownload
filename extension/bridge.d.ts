export const NATIVE_HOST: string
export const QUEUE_MESSAGE_TYPE: string
export const MAX_URL_LENGTH: number

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
  filesizeBytes: number | null
  estimatedBytes?: number | null
  sizeIsEstimate?: boolean
  outputFormats?: string[]
}

export interface MediaAnalysisDto {
  analysisId: string
  title: string
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

export type AnalyzeMediaResult =
  | { ok: true; analysis: MediaAnalysisDto }
  | BridgeFailure

export type QueueMediaResult = { ok: true; job: MediaJobDto } | BridgeFailure

export function normalizeSupportedUrl(value: unknown): UrlResult
export function sendQueueDownload(
  rawUrl: unknown,
  options?: { force?: boolean }
): Promise<{ ok: boolean; error?: { code: string; message: string } }>
export function sendAnalyzeMedia(rawUrl: unknown): Promise<AnalyzeMediaResult>
export function sendQueueMedia(input: unknown): Promise<QueueMediaResult>
export function sendMediaStatus(jobId: unknown): Promise<QueueMediaResult>
export function sendCancelMedia(jobId: unknown): Promise<QueueMediaResult>
