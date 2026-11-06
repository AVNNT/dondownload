export const PENDING_SCAN_KEY: string
export const PENDING_SCAN_TTL_MS: number
export function scanCookiesReady(chromeApi: unknown, origin: string): Promise<boolean>
export function rememberPendingScan(
  chromeApi: unknown,
  rawUrl: unknown,
  now?: number
): Promise<boolean>
export function takePendingScan(
  chromeApi: unknown,
  origin: unknown,
  now?: number
): Promise<string | null>
