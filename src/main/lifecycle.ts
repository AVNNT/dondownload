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

/** Progress of the orderly flush/stop/close sequence. */
export interface CleanupState {
  /** The sequence has been entered and must never run twice. */
  started: boolean
  /** The sequence finished; the final internal quit is allowed through. */
  finished: boolean
}

/** Cleanup is still in flight, so quit requests must be cancelled. */
export function isCleanupRunning(cleanup: CleanupState): boolean {
  return cleanup.started && !cleanup.finished
}

export type BeforeQuitAction = 'allow' | 'block' | 'start-cleanup'

export interface BeforeQuitInput {
  cleanup: CleanupState
  /** Services exist and need an orderly flush/stop/close sequence. */
  servicesReady: boolean
}

/**
 * A quit request may arrive repeatedly while cleanup is running: closing the
 * window fires window-all-closed, which calls app.quit again. Every such
 * request must be cancelled until cleanup has finished, otherwise Electron
 * tears down the process before media jobs, aria2 and the database are closed.
 * Once finished, the final internal app.quit is allowed to proceed.
 */
export function decideBeforeQuit(input: BeforeQuitInput): BeforeQuitAction {
  if (input.cleanup.finished) return 'allow'
  if (input.cleanup.started) return 'block'
  if (!input.servicesReady) return 'allow'
  return 'start-cleanup'
}

export interface AllWindowsClosedInput {
  platform: NodeJS.Platform
  isQuitting: boolean
  trayAvailable: boolean
  /** Cleanup is in flight; its final app.quit will handle the exit. */
  cleanupRunning: boolean
}

/**
 * With a tray, losing every window must not stop aria2. macOS already keeps
 * the app alive for activation; elsewhere only a missing tray falls back to
 * the historical quit-on-last-window behavior. While cleanup runs, the
 * pending internal quit is authoritative, so never start a parallel one.
 */
export function shouldQuitWhenAllWindowsClosed(
  input: AllWindowsClosedInput
): boolean {
  if (input.cleanupRunning) return false
  if (input.isQuitting) return true
  if (input.platform === 'darwin') return false
  return !input.trayAvailable
}
