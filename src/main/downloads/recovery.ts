import type { DownloadBlockReason, DownloadStatus } from '@shared/types'

/**
 * Startup reconciliation policy. It is deliberately conservative:
 *
 * - A manually paused transfer always stays paused, whether or not aria2 still
 *   tracks its GID. aria2 can report a tracked paused transfer as `active` or
 *   `waiting` (for example after its own restart handling), and applying that
 *   status would silently unpause the download. Only an explicit user Resume
 *   may leave the paused state.
 * - Any other transfer that aria2 still tracks is reattached.
 * - A transfer that was active/queued/waiting but is no longer tracked is
 *   marked `interrupted`; the app does not silently re-download it.
 * - Completed/error history is never touched.
 */
export type RecoveryOutcome =
  | 'reattach'
  | 'interrupt'
  | 'keep-paused'
  | 'keep-terminal'

export const INTERRUPTED_MESSAGE =
  'Interrupted before it finished because DonDownload or aria2 stopped. Your partial file is kept. Use Retry to continue it.'

export interface AutoResumeSelection {
  /** User preference "Resume interrupted downloads on startup". */
  resumeEnabled: boolean
  status: DownloadStatus
  blockReason: DownloadBlockReason | null
  /** Bytes already written by the previous process. */
  completedBytes: number
  attempts: number
  maxAttempts: number
}

/**
 * Decide whether a persisted download is safe to resume automatically.
 *
 * Only the recovery-owned `interrupted` state is eligible. A manual pause is a
 * persisted user intent and is never resumed, even when it has partial bytes.
 * A policy hold is also kept for the next window/start, and terminal or
 * queued/waiting rows are left to their explicit user actions. At least one
 * byte must have been written, and the existing retry budget still applies.
 */
export function shouldAutoResumeOnStartup(
  input: AutoResumeSelection
): boolean {
  if (!input.resumeEnabled) return false
  if (input.status !== 'interrupted') return false
  if (input.blockReason !== null) return false
  if (input.completedBytes <= 0) return false
  return input.attempts >= 1 && input.attempts < input.maxAttempts
}

export function decideStartupRecovery(
  status: DownloadStatus,
  aria2TracksGid: boolean
): RecoveryOutcome {
  if (status === 'complete' || status === 'error') {
    return 'keep-terminal'
  }
  // Paused is a persisted user intent: never let aria2's tracked status
  // (which may be active/waiting) override it during reconciliation.
  if (status === 'paused') {
    return 'keep-paused'
  }
  if (aria2TracksGid) {
    return 'reattach'
  }
  if (status === 'active' || status === 'queued' || status === 'waiting') {
    return 'interrupt'
  }
  // Already interrupted: leave the explicit user-action state in place.
  return 'keep-terminal'
}
