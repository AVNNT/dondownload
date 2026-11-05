export interface CaptureStreamingState {
  detected: boolean
  code?: string
  message?: string
  embedded?: boolean
}

export interface CaptureAnalysisOption {
  kind: 'video' | 'audio'
  optionId: string
  label: string
  container: string
  width: number | null
  height: number | null
  fps: number | null
  hdr?: boolean
  requiresMerge?: boolean
  estimatedBytes?: number | null
  filesizeBytes?: number | null
  sizeIsEstimate?: boolean
}

export interface CaptureAnalysisView {
  analysisId: string
  title: string
  options: CaptureAnalysisOption[]
}

export interface CaptureQueryResponse {
  ok?: boolean
  origin?: string
  url?: string
  sources?: Array<{
    url: string
    filename: string
    container?: string
    qualityLabel?: string | null
    current?: boolean
  }>
  streaming?: CaptureStreamingState
  analysis?: CaptureAnalysisView | null
  status?: string
  queuedOptionIds?: string[]
}

export interface CaptureViewModel {
  mode: 'streaming' | 'progressive' | 'empty'
  streaming: CaptureStreamingState
  streamingDetected: boolean
  analysis: CaptureAnalysisView | null
  options: CaptureAnalysisOption[]
  status: string
  analyzing: boolean
  failed: boolean
  queuedOptionIds: string[]
  detectedLabel: string
  detail: string | null
  showFindAction: boolean
  showAnalysis: boolean
}

export function formatBytes(value: unknown): string
export function formatOptionDetail(option: unknown): string
export function optionQueueKey(analysisId: unknown, optionId: unknown): string
export function captureViewModel(response: unknown): CaptureViewModel
