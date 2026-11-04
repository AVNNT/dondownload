import type {
  MediaAnalysisDto,
  MediaFormatOptionDto,
  MediaJobDto
} from './bridge'

export const MAX_MEDIA_TITLE_LENGTH: number
export const MAX_MEDIA_LABEL_LENGTH: number
export const MAX_MEDIA_ERROR_LENGTH: number
export const MAX_MEDIA_OPTIONS: number

export function isOpaqueMediaId(value: unknown): boolean
export function parseMediaFormatOption(value: unknown): MediaFormatOptionDto
export function parseMediaAnalysis(value: unknown): MediaAnalysisDto
export function parseMediaJob(value: unknown): MediaJobDto
export function parseMediaBridgeResponse(
  value: unknown
):
  | { ok: true; operation: 'analyze-media'; analysis: MediaAnalysisDto }
  | { ok: true; operation: 'queue-media' | 'media-status' | 'cancel-media'; job: MediaJobDto }
  | { ok: false; error: { code: string; message: string } }
