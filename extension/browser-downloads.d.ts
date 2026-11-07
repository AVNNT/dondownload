export const ALL_SITES_OVERLAY_MESSAGE: string

export interface BrowserDownloadResult {
  ok: boolean
  error?: string
  overlay?: boolean
  injected?: number
}

export function requestOverlayReconcile(
  chromeApi: unknown,
  options?: { injectOpenTabs?: boolean }
): Promise<{ overlay: boolean; injected: number }>
export function ensureAllSitesActive(
  chromeApi: unknown,
  options?: {
    injectOpenTabs?: boolean
    reconcile?: () => Promise<{ overlay: boolean; injected: number }>
  }
): Promise<BrowserDownloadResult>
export function browserDownloadStateCopy(state: {
  enabled?: boolean
  minBytes?: number
}): { enabled: boolean; state: string; hint: string }
