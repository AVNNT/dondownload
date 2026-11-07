export const GOFILE_CAPTURE_TIMEOUT_MS: number
export const GOFILE_CAPTURE_MAX_DOWNLOADS: number
export const GOFILE_CAPTURE_ERASE_DELAY_MS: number

export interface GofileCaptureInput {
  tabId?: number | null
  pageUrl?: string
  timeoutMs?: number
}

export interface GofileCaptureRecord {
  url: string
  filename: string | null
}

export function isGofileHostUrl(value: unknown): boolean
export function isGofileCaptureArmed(): boolean
export function armGofileCapture(
  input?: GofileCaptureInput
): { armed: true; tabId: number | null; timeoutMs: number }
export function disarmGofileCapture(): { armed: false; recorded?: number }
export function resetGofileCaptureForTests(): void
export function isArmedGofileDownload(item: unknown): boolean
export function recordGofileCapture(item: unknown): GofileCaptureRecord | null
export function readGofileCapture(): {
  armed: boolean
  downloads: GofileCaptureRecord[]
}
export function captureGofileDownload(chromeApi: unknown, item: unknown): boolean
export function updateGofileCapture(delta: unknown): boolean
export function installGofileCaptureListeners(chromeApi: unknown): boolean
export function resetGofileCaptureListenersForTests(): void
