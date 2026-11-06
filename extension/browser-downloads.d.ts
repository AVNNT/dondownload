export const BROWSER_DOWNLOAD_HOST_ORIGINS: readonly string[]
export const ALL_SITES_OVERLAY_MESSAGE: string

export interface BrowserDownloadPermissions {
  permissions: string[]
  origins: string[]
}

export interface BrowserDownloadToggleResult {
  ok: boolean
  error?: string
  listener?: boolean
  overlay?: boolean
  injected?: number
}

export function browserDownloadPermissions(chromeApi: unknown): BrowserDownloadPermissions
export function browserDownloadPermissionsGranted(chromeApi: unknown): Promise<boolean>
export function enableBrowserDownloadTakeover(
  chromeApi: unknown,
  onResult: (result: BrowserDownloadToggleResult) => void
): void
export function disableBrowserDownloadTakeover(chromeApi: unknown): Promise<boolean>
export function notifyDownloadsSupport(
  chromeApi: unknown
): Promise<{ listener: boolean }>
export function requestOverlayReconcile(
  chromeApi: unknown
): Promise<{ overlay: boolean; injected: number }>
export function browserDownloadStateCopy(state: {
  enabled?: boolean
  minBytes?: number
}): { enabled: boolean; state: string; hint: string }
