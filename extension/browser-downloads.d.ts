export const BROWSER_DOWNLOAD_HOST_ORIGINS: readonly string[]

export interface BrowserDownloadPermissions {
  permissions: string[]
  origins: string[]
}

export function browserDownloadPermissions(chromeApi: unknown): BrowserDownloadPermissions
export function browserDownloadPermissionsGranted(chromeApi: unknown): Promise<boolean>
export function enableBrowserDownloadTakeover(
  chromeApi: unknown,
  onResult: (result: { ok: boolean; error?: string; listener?: boolean }) => void
): void
export function disableBrowserDownloadTakeover(chromeApi: unknown): Promise<boolean>
export function notifyDownloadsSupport(
  chromeApi: unknown
): Promise<{ listener: boolean }>
export function browserDownloadStateCopy(state: {
  enabled?: boolean
  minBytes?: number
}): { enabled: boolean; state: string; hint: string }
