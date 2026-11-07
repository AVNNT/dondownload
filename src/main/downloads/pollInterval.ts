/**
 * Poll cadence for the download manager.
 *
 * - ACTIVE: a transfer is queued or running, so progress and completion must
 *   be observed about once a second.
 * - IDLE: nothing is transferring, but there is still work to watch (a future
 *   schedule, allowed-hours hold or media policy job). Five seconds is enough
 *   for a scheduler tick and removes 80% of the idle RPC traffic.
 * - `null`: nothing to do at all. The manager stops its timer and only wakes
 *   on add/resume/retry/reconcile/settings changes.
 */
export const ACTIVE_POLL_INTERVAL_MS = 1_000
export const IDLE_POLL_INTERVAL_MS = 5_000

export interface PollIntervalInput {
  /** A local transfer is queued/active or media work is progressing. */
  hasActiveWork: boolean
  /** Waiting/scheduled/policy-held work or pending media policy work. */
  hasPendingWork: boolean
}

export function nextPollDelay(input: PollIntervalInput): number | null {
  if (input.hasActiveWork) return ACTIVE_POLL_INTERVAL_MS
  if (input.hasPendingWork) return IDLE_POLL_INTERVAL_MS
  return null
}
