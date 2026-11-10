export const HANDOFF_BADGE_CLEAR_MS: number
export const HANDOFF_SUGGEST_TIMEOUT_MS: number
export const HELD_REQUEST_URL_TTL_MS: number

export type HandoffOutcome =
  | 'cancelled'
  | 'left-running'
  | 'left-running-unreadable'
  | 'left-running-completed'
  | 'left-running-cancel-failed'
  | 'duplicate-uncertain'
  | 'needs-login'
  | 'disabled'
  | 'downloads-unavailable'
  | 'settings-unavailable'
  | `ignored:${string}`
  | `not-claimed:${string}`

export interface HandoffOptions {
  /**
   * True for a chrome.downloads.onDeterminingFilename item: the browser holds
   * the download until suggest() is called, so it is cancelled and erased
   * instead of being re-read and cancelled later.
   */
  held?: boolean
}

export function handleCreatedDownload(
  chromeApi: unknown,
  item: unknown,
  options?: HandoffOptions
): Promise<HandoffOutcome>
export function handoffHeldRequest(
  chromeApi: unknown,
  item: unknown
): Promise<HandoffOutcome>
export function installDownloadsListener(
  chromeApi: unknown,
  onCreated: (item: unknown, options?: HandoffOptions) => unknown
): boolean
export function resetDownloadsListenerForTests(): void
export function rememberDecidedDownload(item: unknown): void
export function rememberHeldRequestUrl(value: unknown): void
export function resetHeldRequestUrlsForTests(): void
export function hasNeedsLoginBadge(): boolean
export function clearNeedsLoginBadge(): void
