export const OVERLAY_PENDING_STORAGE_KEY: string
export const OVERLAY_PENDING_TTL_MS: number
export const OVERLAY_HOST_ID: string
export const OVERLAY_TABS_STORAGE_KEY: string
export const OVERLAY_MAX_TRACKED_TABS: number

export interface OverlayError {
  code: string
  message: string
}

export interface OverlayResult {
  ok: boolean
  granted?: boolean
  registered?: boolean
  injected?: boolean
  reason?: string
  message?: string
  error?: OverlayError
  registrationRemoved?: boolean
  permissionRemoved?: boolean
  notifiedTabs?: number
  failedNotifications?: number
}

export interface PendingEnable {
  origin: string
  tabId: number | null
  createdAt: number
}

export interface OverlayStatus {
  state: 'unavailable' | 'off' | 'on' | 'attention'
  label: string
  tone: 'on' | 'off' | 'error'
  hint: string
}

export function overlayPresenceProbe(): boolean
export function enableOverlayForTab(
  chromeApi: unknown,
  origin: unknown,
  tabId: unknown
): Promise<OverlayResult>
export function syncOverlayForTab(
  chromeApi: unknown,
  origin: unknown,
  tabId: unknown
): Promise<OverlayResult>
export function disableOverlayForOrigin(
  chromeApi: unknown,
  origin: unknown,
  tabId: unknown
): Promise<OverlayResult>
export function rememberPendingEnable(
  chromeApi: unknown,
  origin: unknown,
  tabId: unknown
): Promise<boolean>
export function clearPendingEnable(chromeApi: unknown): Promise<boolean>
export function readPendingEnable(
  chromeApi: unknown,
  now?: number
): Promise<PendingEnable | null>
export function handlePermissionsAdded(
  chromeApi: unknown,
  permissions: unknown
): Promise<OverlayResult | null>
export function handlePermissionsRemoved(
  chromeApi: unknown,
  permissions: unknown
): Promise<string[]>
export function handleOverlayReady(
  chromeApi: unknown,
  message: unknown,
  sender: unknown
): Promise<boolean>
export function isOverlayTabTracked(
  chromeApi: unknown,
  origin: unknown,
  tabId: unknown
): Promise<boolean>
export function rememberOverlayTab(
  chromeApi: unknown,
  origin: unknown,
  tabId: unknown
): Promise<boolean>
export function forgetOverlayTab(
  chromeApi: unknown,
  tabId: unknown
): Promise<boolean>
export function overlayRemovalConfirmed(result: unknown): boolean
export function allSitesHostsGranted(chromeApi: unknown): Promise<boolean>
export function allSitesOverlayWantedFromSettings(chromeApi: unknown): Promise<boolean>
export function injectAllSitesIntoOpenTabs(chromeApi: unknown): Promise<{
  ok: boolean
  injected: number[]
  skipped: number[]
  failed: number[]
}>
export function reconcileOverlayMode(
  chromeApi: unknown,
  options?: { injectOpenTabs?: boolean }
): Promise<{
  ok: boolean
  mode: 'all-sites' | 'per-origin' | 'unknown'
  registered: boolean
  restored?: number
  injected: number[]
}>
export function describeOverlayStatus(input: {
  available?: boolean
  granted?: boolean
  ready?: boolean
  site?: string
  shortcut?: string
}): OverlayStatus
