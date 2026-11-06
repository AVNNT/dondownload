/**
 * Pure countdown math for the undo toast.
 *
 * The countdown is deadline based: it stores the absolute time it should end
 * and derives the remaining time from the clock on every read. Pausing stores
 * the remaining time and drops the deadline; resuming starts a new deadline
 * from the stored remainder. No state is mutated while computing, and the
 * remaining time never goes below zero.
 */

export interface CountdownOptions {
  /** Total window length in milliseconds. */
  durationMs: number
  /** Clock reading (ms timestamp) the countdown starts at. */
  now: number
}

export interface Countdown {
  /** Time left in ms at `now`, clamped to `[0, durationMs]`. */
  remaining(now: number): number
  /** True once the deadline has passed (or the window was zero length). */
  expired(now: number): boolean
  /** Freezes the countdown at `now`; resuming continues from there. */
  pause(now: number): void
  /** Restarts the countdown from the paused remainder at `now`. */
  resume(now: number): void
  /** Whether the countdown is currently paused. */
  paused(): boolean
}

export function createCountdown({ durationMs, now }: CountdownOptions): Countdown {
  const total = Math.max(0, durationMs)
  let remaining = total
  let deadline = now + total
  let isPaused = false

  const remainingAt = (at: number): number => {
    if (isPaused) return remaining
    const left = deadline - at
    return left > 0 ? Math.min(left, total) : 0
  }

  return {
    remaining: remainingAt,
    expired: (at) => remainingAt(at) <= 0,
    pause(at) {
      if (isPaused) return
      remaining = remainingAt(at)
      isPaused = true
    },
    resume(at) {
      if (!isPaused) return
      isPaused = false
      deadline = at + remaining
    },
    paused: () => isPaused
  }
}
