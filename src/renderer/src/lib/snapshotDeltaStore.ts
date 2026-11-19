import {
  applySnapshotDelta,
  type SnapshotClientState,
  type SnapshotDelta,
  type SnapshotPayload
} from '@shared/snapshotDelta'

export interface SnapshotDeltaStoreOptions<Row extends { id: string }, Fields extends object> {
  initial?: SnapshotPayload<Row, Fields> | null
  rowVersion: (row: Row) => unknown
  /** Called at most once per animation frame with the latest state. */
  onChange: (state: SnapshotClientState<Row, Fields>) => void
  /** Ask main for a fresh full delta after a revision gap. */
  requestResync: () => void
  /** Injectable scheduler for tests; defaults to requestAnimationFrame. */
  schedule?: (flush: () => void) => () => void
}

export interface SnapshotDeltaStore<Row extends { id: string }, Fields extends object> {
  applyDelta: (delta: SnapshotDelta<Row, Fields>) => void
  /**
   * Replace the local data from a full API response (initial load or an action
   * result).
   *
   * An invoke result reflects the moment main serialized it, which may be older
   * than a delta that already arrived. `revision` (or `payload.revision`) must
   * therefore be the revision main had when it built the response, or absent
   * for a response that predates revisioning: a payload that is less than the
   * last applied revision is ignored instead of overwriting fresher progress.
   * The local revision is kept so later patches still line up; unchanged rows
   * keep their previous object reference.
   */
  replacePayload: (payload: SnapshotPayload<Row, Fields>, revision?: number) => void
  getState: () => SnapshotClientState<Row, Fields> | null
  dispose: () => void
}

function defaultSchedule(flush: () => void): () => void {
  const scheduler = globalThis as unknown as {
    requestAnimationFrame?: (callback: () => void) => number
    cancelAnimationFrame?: (id: number) => void
  }
  if (
    typeof scheduler.requestAnimationFrame === 'function' &&
    typeof scheduler.cancelAnimationFrame === 'function'
  ) {
    const id = scheduler.requestAnimationFrame(flush)
    return () => scheduler.cancelAnimationFrame?.(id)
  }
  const id = setTimeout(flush, 0)
  return () => clearTimeout(id)
}

/**
 * Renderer-side delta receiver with structural sharing and one state update per
 * animation frame. A burst of patches therefore causes a single React render,
 * and unchanged rows keep the same object identity across updates.
 */
export function createSnapshotDeltaStore<
  Row extends { id: string },
  Fields extends object
>(
  options: SnapshotDeltaStoreOptions<Row, Fields>
): SnapshotDeltaStore<Row, Fields> {
  let state: SnapshotClientState<Row, Fields> | null =
    options.initial === undefined || options.initial === null
      ? null
      : { revision: 0, ...options.initial }
  let scheduledCancel: (() => void) | null = null
  let resyncRequested = false
  let disposed = false
  const schedule = options.schedule ?? defaultSchedule

  const scheduleChange = (): void => {
    if (disposed || scheduledCancel !== null) return
    scheduledCancel = schedule(() => {
      scheduledCancel = null
      if (disposed || state === null) return
      options.onChange(state)
    })
  }

  const applyDelta = (delta: SnapshotDelta<Row, Fields>): void => {
    if (disposed) return
    const result = applySnapshotDelta(state, delta)
    if (result.status === 'resync') {
      if (!resyncRequested) {
        resyncRequested = true
        try {
          options.requestResync()
        } catch {
          resyncRequested = false
        }
      }
      return
    }
    resyncRequested = false
    if (result.status === 'unchanged' || result.state === null) return
    state = result.state
    scheduleChange()
  }

  const replacePayload = (
    payload: SnapshotPayload<Row, Fields>,
    explicitRevision?: number
  ): void => {
    if (disposed) return

    // The payload may carry the revision main had when it built the response;
    // an explicit argument (when a caller knows better) takes precedence.
    const revision = explicitRevision ?? payload.revision

    // A response older than the state already applied must not move the UI
    // backwards (for example an invoke that resolved after two progress
    // deltas). Unknown revisions are trusted: the caller cannot do better.
    if (
      state !== null &&
      revision !== undefined &&
      Number.isFinite(revision) &&
      revision < state.revision
    ) {
      return
    }

    if (state === null) {
      state = {
        revision: revision !== undefined && Number.isFinite(revision) ? revision : 0,
        fields: payload.fields,
        rows: payload.rows
      }
      scheduleChange()
      return
    }

    const previousById = new Map(state.rows.map((row) => [row.id, row]))
    const fieldsUnchanged =
      JSON.stringify(state.fields) === JSON.stringify(payload.fields)
    let rowsChanged = payload.rows.length !== state.rows.length
    const rows: Row[] = []
    for (let index = 0; index < payload.rows.length; index += 1) {
      const row = payload.rows[index] as Row
      const previous = previousById.get(row.id)
      if (
        previous !== undefined &&
        options.rowVersion(previous) === options.rowVersion(row)
      ) {
        rows.push(previous)
      } else {
        rows.push(row)
        rowsChanged = true
      }
      if (state.rows[index]?.id !== row.id) rowsChanged = true
    }

    if (!rowsChanged && fieldsUnchanged) return

    state = {
      revision: state.revision,
      fields: fieldsUnchanged ? state.fields : payload.fields,
      rows: rowsChanged ? rows : state.rows
    }
    scheduleChange()
  }

  return {
    applyDelta,
    replacePayload,
    getState: () => state,
    dispose: () => {
      disposed = true
      if (scheduledCancel !== null) {
        scheduledCancel()
        scheduledCancel = null
      }
    }
  }
}
