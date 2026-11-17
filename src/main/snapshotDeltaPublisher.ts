import {
  buildSnapshotDelta,
  type SnapshotClientState,
  type SnapshotDelta,
  type SnapshotPayload
} from '@shared/snapshotDelta'

export interface SnapshotDeltaPublisherOptions<Row extends { id: string }, Fields extends object> {
  /** Deliver one delta to the renderer. Must not throw. */
  send: (delta: SnapshotDelta<Row, Fields>) => void
  /** The window must be visible and not minimized to receive progress. */
  isVisible: () => boolean
  rowVersion?: (row: Row) => unknown
}

/**
 * Revisioned, hidden-aware delta publisher for one snapshot stream.
 *
 * - While the window is hidden/minimized only the latest payload is retained;
 *   no IPC message is sent. Showing the window flushes one catch-up delta.
 * - Revisions count *sent* deltas, so suppressed updates never create gaps for
 *   the renderer.
 * - A renderer resync request forces one full delta on the next flush.
 */
export class SnapshotDeltaPublisher<Row extends { id: string }, Fields extends object> {
  private latest: SnapshotPayload<Row, Fields> | null = null
  private lastSent: SnapshotClientState<Row, Fields> | null = null
  private nextRevision = 1
  private forceFull = false
  private visible: boolean

  constructor(
    private readonly options: SnapshotDeltaPublisherOptions<Row, Fields>
  ) {
    this.visible = options.isVisible()
  }

  /** The revision of the most recently sent delta (0 before the first). */
  get revision(): number {
    return this.nextRevision - 1
  }

  get isVisible(): boolean {
    return this.visible
  }

  publish(payload: SnapshotPayload<Row, Fields>): void {
    this.latest = payload
    this.flush()
  }

  setVisible(visible: boolean): void {
    const becameVisible = visible && !this.visible
    this.visible = visible
    if (becameVisible) this.flush()
  }

  /** Next flush must send a full snapshot, regardless of what changed. */
  requestFull(): void {
    this.forceFull = true
    this.flush()
  }

  /**
   * Forget what the previous renderer was sent. The window is destroyed when
   * the app is hidden to the tray, so the next window has no state at all: a
   * patch against the old baseline would be rejected as a revision gap. The
   * next flush therefore builds a full snapshot from the retained payload.
   */
  reset(): void {
    this.lastSent = null
    this.forceFull = false
  }

  flush(): void {
    if (this.latest === null || !this.visible) return

    const revision = this.nextRevision
    const built = buildSnapshotDelta(this.lastSent, this.latest, revision, {
      ...(this.forceFull ? { forceFull: true } : {}),
      ...(this.options.rowVersion === undefined
        ? {}
        : { rowVersion: this.options.rowVersion })
    })
    if (built === null) {
      this.forceFull = false
      return
    }

    this.forceFull = false
    this.lastSent = built.state
    this.nextRevision = revision + 1
    try {
      this.options.send(built.delta)
    } catch {
      // A renderer that is closing must not break orchestration.
    }
  }
}
