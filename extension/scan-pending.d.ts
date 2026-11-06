export const PENDING_SCAN_KEY: string
export const PENDING_SCAN_TTL_MS: number
export const MAX_PENDING_SCANS: number
export function scanCookiesReady(chromeApi: unknown, origin: string): Promise<boolean>
export function rememberPendingScan(
  chromeApi: unknown,
  rawUrl: unknown,
  now?: number
): Promise<boolean>
export function rememberPendingScans(
  chromeApi: unknown,
  urls: unknown,
  now?: number
): Promise<boolean>
export function takePendingScan(
  chromeApi: unknown,
  origin: unknown,
  now?: number
): Promise<string | null>
export function takePendingScans(
  chromeApi: unknown,
  origin: unknown,
  now?: number
): Promise<string[]>
export interface PendingScanGroup {
  origin: string
  urls: string[]
}
export function pendingScanGroups(
  chromeApi: unknown,
  now?: number
): Promise<PendingScanGroup[]>
