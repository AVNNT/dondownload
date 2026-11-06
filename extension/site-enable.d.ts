export interface EnableResult {
  ok: boolean
  error?: string | null
  response?: unknown
}

export function siteAccessGranted(
  chromeApi: unknown,
  origin: unknown
): Promise<boolean>
export function requestExactOriginAccess(
  chromeApi: unknown,
  site: { origin?: unknown; tabId?: unknown } | null,
  onResult: (result: EnableResult) => void
): void
export function enableAllSitesDetection(
  chromeApi: unknown,
  onResult: (result: EnableResult) => void
): void
export function recommendedCapturePermissions(chromeApi: unknown): {
  permissions: string[]
  origins: string[]
}
export function enableRecommendedCapture(
  chromeApi: unknown,
  onResult: (result: EnableResult) => void
): void
