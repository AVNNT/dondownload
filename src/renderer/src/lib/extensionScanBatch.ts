/**
 * Group the extension's per-URL scan messages into one desktop view.
 *
 * The native host protocol stays one `scan-page` message per URL. A "Scan
 * several links" click therefore produces several independent scan sessions
 * within a few seconds. Sessions whose first update arrives inside the window
 * are treated as one batch so the renderer opens a single multi-topic view.
 *
 * The window is measured from when the newest session joined, not from later
 * progress updates, so a long-running first scan cannot pull an unrelated
 * later click into its batch.
 */

export const EXTENSION_SCAN_BATCH_WINDOW_MS = 10_000

export interface ExtensionScanBatchState {
  /** Sessions in this batch, in arrival order. */
  sessionIds: string[]
  /** Arrival time of the newest new session. */
  updatedAt: number
}

export interface ExtensionScanBatchDecision {
  batch: ExtensionScanBatchState
  /** False when this update starts a new batch. */
  isContinuation: boolean
}

export function groupExtensionScan(
  current: ExtensionScanBatchState | null,
  sessionId: string,
  now: number,
  windowMs = EXTENSION_SCAN_BATCH_WINDOW_MS
): ExtensionScanBatchDecision {
  if (current !== null) {
    if (current.sessionIds.includes(sessionId)) {
      // A progress update for a session already in the batch never extends the
      // window or creates a second dialog.
      return { batch: current, isContinuation: true }
    }
    if (
      Number.isFinite(windowMs) &&
      windowMs >= 0 &&
      now >= current.updatedAt &&
      now - current.updatedAt <= windowMs
    ) {
      return {
        batch: {
          sessionIds: [...current.sessionIds, sessionId],
          updatedAt: now
        },
        isContinuation: true
      }
    }
  }
  return {
    batch: { sessionIds: [sessionId], updatedAt: now },
    isContinuation: false
  }
}
