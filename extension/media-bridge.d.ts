import type {
  AnalyzeMediaResult,
  BridgeFailure,
  QueueMediaResult
} from './bridge'

export const MEDIA_MESSAGE_TYPES: Readonly<{
  ANALYZE: string
  ANALYZE_EMBED: string
  QUEUE: string
  CAPTURE_QUEUE: string
}>

export type MediaAuthorization =
  | { ok: true; origin: string; tabId: number; url: string }
  | BridgeFailure

export function authorizeMediaSender(
  chromeApi: unknown,
  sender: unknown
): Promise<MediaAuthorization>
export function analyzeMediaForSender(
  chromeApi: unknown,
  message: unknown,
  sender: unknown
): Promise<AnalyzeMediaResult>
export function analyzeEmbeddedPageForSender(
  chromeApi: unknown,
  message: unknown,
  sender: unknown
): Promise<AnalyzeMediaResult>
export function queueMediaForSender(
  chromeApi: unknown,
  message: unknown,
  sender: unknown
): Promise<QueueMediaResult>
export function queueCapturedSourceForSender(
  chromeApi: unknown,
  message: unknown,
  sender: unknown
): Promise<{ ok: true } | BridgeFailure>
