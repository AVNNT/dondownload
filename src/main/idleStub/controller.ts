import { logError } from '../logging'
/**
 * Idle tray stub hand-off.
 *
 * While the window is closed to the tray and nothing is running, the full
 * Electron engine keeps roughly 140 MB resident only to draw a tray icon. After
 * a grace period this controller asks the entry point to replace it with the
 * tiny native stub (`dondownload-tray.exe`), which keeps the same icon and
 * wakes the app again when the user clicks it.
 *
 * The controller owns no timers of its own beyond one grace timeout, so it is
 * pure and unit testable: every signal, the scheduler and the hand-off are
 * injected. Any activity, or the window coming back, cancels the pending exit
 * and a fresh grace period only starts once the app is idle and hidden again.
 */

export interface IdleStubTimerDependencies {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface IdleStubControllerOptions {
  /** True while a live main window exists (hidden or shown). */
  isWindowOpen: () => boolean
  /** True when the main window is visible and not minimised. */
  isWindowVisible: () => boolean
  /** True while the engine has real work: downloads, media, batches, scans… */
  isBusy: () => boolean
  /** The user's "Free memory when idle in the tray" preference. */
  isEnabled: () => boolean
  /** Milliseconds of continuous idleness before handing off to the stub. */
  graceMs: number
  /** Spawn the native stub and quit through the normal shutdown path. */
  exitToStub: () => void
  setTimer?: IdleStubTimerDependencies['setTimer']
  clearTimer?: IdleStubTimerDependencies['clearTimer']
  /** Optional diagnostics; never receives user data. */
  log?: (message: string) => void
}

export interface IdleStubController {
  /**
   * Re-evaluate the current state. Call after any change that may affect the
   * window, the busy signals or the setting; it is cheap and idempotent.
   */
  evaluate: () => void
  /** True while a hand-off grace period is counting down. */
  isArmed: () => boolean
  /** Cancel a pending hand-off (shutdown, smoke, a tray show). */
  cancel: () => void
  /**
   * Stop for good: no timer is armed and `evaluate` becomes a no-op. Used once
   * the shutdown sequence owns the process.
   */
  dispose: () => void
}

export function createIdleStubController(
  options: IdleStubControllerOptions
): IdleStubController {
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const handle = setTimeout(callback, delayMs)
      // A pending hand-off must never be the reason the process stays alive.
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    })
  const clearTimer: IdleStubTimerDependencies['clearTimer'] =
    options.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })
  const graceMs = Math.max(0, Math.floor(options.graceMs))
  const log = options.log ?? (() => undefined)

  let timer: unknown = null
  let armed = false
  let disposed = false
  /** True once the hand-off was requested; it must happen exactly once. */
  let fired = false

  const cancel = (): void => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    armed = false
  }

  /** Every reason to stay in the full app, re-read at decision time. */
  const eligible = (): boolean => {
    if (fired || disposed) return false
    if (!options.isEnabled()) return false
    if (options.isWindowOpen() || options.isWindowVisible()) return false
    if (options.isBusy()) return false
    return true
  }

  const fire = (): void => {
    timer = null
    armed = false
    // The state can change while the grace period runs: a download started, a
    // scan opened, the window was shown, or the setting was turned off. Re-check
    // rather than trusting the state from graceMs ago.
    if (!eligible()) {
      log('idle stub hand-off skipped: no longer idle')
      return
    }
    fired = true
    log(`idle stub hand-off after ${graceMs}ms`)
    try {
      options.exitToStub()
    } catch (error) {
      // A failed spawn must leave the app running, not take it down.
      const detail = error instanceof Error ? error.message : 'unknown error'
      logError('Tray stub could not be started: %s', detail)
      // Allow a later idle period to try again.
      fired = false
    }
  }

  return {
    evaluate: () => {
      if (disposed || fired) return
      if (!eligible()) {
        cancel()
        return
      }
      if (armed) return
      armed = true
      timer = setTimer(fire, graceMs)
    },
    isArmed: () => armed,
    cancel,
    dispose: () => {
      disposed = true
      cancel()
    }
  }
}
