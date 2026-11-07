import type { BridgeFailure } from './bridge'

export const GOFILE_SCAN_MESSAGE_TYPE: string
export const GOFILE_COLLECTOR_FILE: string
export const GOFILE_RESULT_TIMEOUT_MS: number
export const GOFILE_POLL_MS: number
export const GOFILE_CAPTURE_WINDOW_MS: number
export const GOFILE_CAPTURE_SETTLE_MS: number

export interface GofileScanRow {
  name: string
  size: number | null
  url?: string | null
}

export interface GofileScanResult {
  ok: true
  shareId: string
  status: 'ok' | 'empty' | 'not-found' | 'password' | 'premium' | 'timeout'
  fileCount: number
  unavailableCount: number
  cookieAttached: boolean
}

export interface GofileCapturedDownload {
  url: string
  filename: string | null
}

export function isGofileShareUrl(raw: unknown): boolean
export function shareIdOf(raw: unknown): string | null
export function findGofileTab(
  chromeApi: unknown,
  pageUrl: unknown
): Promise<number | null>
export function matchCapturedDownloads(
  rows: readonly GofileScanRow[],
  downloads: readonly GofileCapturedDownload[]
): {
  files: Array<{ name: string; size: number | null; url: string }>
  unavailable: Array<{ name: string; size: number | null }>
}
export function runGofileScan(
  chromeApi: unknown,
  input: { tabId?: unknown; pageUrl?: unknown },
  deps?: { sleep?: (ms: number) => Promise<void> }
): Promise<GofileScanResult | BridgeFailure>
