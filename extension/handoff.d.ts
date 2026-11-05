export const HANDOFF_BADGE_CLEAR_MS: number

export type HandoffOutcome =
  | 'cancelled'
  | 'left-running'
  | 'left-running-unreadable'
  | 'left-running-completed'
  | 'left-running-cancel-failed'
  | 'duplicate-uncertain'
  | 'disabled'
  | 'downloads-unavailable'
  | 'permission-required'
  | 'settings-unavailable'
  | `ignored:${string}`
  | `not-claimed:${string}`

export function handleCreatedDownload(
  chromeApi: unknown,
  item: unknown
): Promise<HandoffOutcome>
export function installDownloadsListener(
  chromeApi: unknown,
  onCreated: (item: unknown) => unknown
): boolean
