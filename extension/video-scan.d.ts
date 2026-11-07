import type { BridgeFailure } from './bridge'

export const VIDEO_SCAN_MESSAGE_TYPE: string
export const VIDEO_COLLECTOR_FILE: string
export const VIDEO_RESULT_TIMEOUT_MS: number
export const VIDEO_POLL_MS: number

export interface VideoScanResult {
  ok: true
  sent: boolean
  sourceCount: number
  pageUrl: string
  title: string | null
  cookieAttached?: boolean
}

export function runVideoScan(
  chromeApi: unknown,
  input: { tabId?: unknown; pageUrl?: unknown },
  deps?: { sleep?: (ms: number) => Promise<void> }
): Promise<VideoScanResult | BridgeFailure>

export function isVideoScanResult(result: unknown): boolean
