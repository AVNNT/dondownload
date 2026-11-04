export type WindowCloseAction = 'hide-to-tray' | 'close'

export interface WindowCloseInput {
  /** True once an explicit quit has begun; the window must be allowed to close. */
  isQuitting: boolean
  /** True when a usable tray icon exists; without one, a hidden app is unreachable. */
  trayAvailable: boolean
}

/**
 * Closing the main window is a background action, not a quit: hide it to the
 * tray so aria2 keeps downloading. An explicit quit, or a failed tray, falls
 * back to the normal close path.
 */
export function decideWindowClose(input: WindowCloseInput): WindowCloseAction {
  if (input.isQuitting || !input.trayAvailable) return 'close'
  return 'hide-to-tray'
}

/** The tray's first menu item toggles visibility with an accurate label. */
export function trayMenuLabel(windowVisible: boolean): string {
  return windowVisible ? 'Hide DonDownload' : 'Show DonDownload'
}

export interface AllWindowsClosedInput {
  platform: NodeJS.Platform
  isQuitting: boolean
  trayAvailable: boolean
}

/**
 * With a tray, losing every window must not stop aria2. macOS already keeps
 * the app alive for activation; elsewhere only a missing tray falls back to
 * the historical quit-on-last-window behavior.
 */
export function shouldQuitWhenAllWindowsClosed(
  input: AllWindowsClosedInput
): boolean {
  if (input.isQuitting) return true
  if (input.platform === 'darwin') return false
  return !input.trayAvailable
}
