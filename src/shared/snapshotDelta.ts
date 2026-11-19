import type { Batch } from './batches'
import type { MediaJob, MediaSnapshot, MediaToolState } from './media'
import type {
  AppSnapshot,
  Aria2State,
  BatchSnapshot,
  DownloadItem
} from './types'

/**
 * Revisioned snapshot deltas shared by the main process and the renderer.
 *
 * The first message for a stream is always a `full` delta. Later messages are
 * `patch` deltas that carry only changed top-level fields, upserted rows and
 * removed ids. A renderer that sees a revision gap applies nothing and asks the
 * main process for a fresh `full` delta instead.
 *
 * Rows are keyed by `id`. Applying a patch preserves the object identity of
 * every unchanged row, so memoized list rows can skip re-rendering.
 */

export interface SnapshotPayload<Row, Fields> {
  fields: Fields
  rows: Row[]
  /**
   * Revision of the stream when this payload was built, for payloads that come
   * from a plain invoke response rather than a delta. Optional: a response
   * without one is trusted as-is.
   */
  revision?: number
}

export interface SnapshotClientState<Row, Fields> extends SnapshotPayload<Row, Fields> {
  revision: number
}

export interface SnapshotFullDelta<Row, Fields> extends SnapshotPayload<Row, Fields> {
  kind: 'full'
  revision: number
  /**
   * Authoritative full snapshot (resync after a gap or after the sending side
   * dropped its baseline). The receiver replaces its whole state with it even
   * when its own revision is higher, because the two revision counters may be
   * unrelated after a window was recreated.
   */
  replaces?: boolean
}

export interface SnapshotPatchDelta<Row, Fields> {
  kind: 'patch'
  revision: number
  /** Revision this patch expects the receiver to hold. */
  baseRevision: number
  /** Only the top-level fields whose values changed. */
  fields: Partial<Fields>
  upserted: Row[]
  removedIds: string[]
  /**
   * Complete row id order. Present only when rows were inserted or removed,
   * so the receiver can restore the server's ordering without re-sorting.
   */
  order?: string[]
}

export type SnapshotDelta<Row, Fields> =
  | SnapshotFullDelta<Row, Fields>
  | SnapshotPatchDelta<Row, Fields>

/* ------------------------------------------------------------------------- *
 * Concrete streams
 * ------------------------------------------------------------------------- */

export interface AppSnapshotFields {
  aria2: Aria2State
}

export interface MediaSnapshotFields {
  tool: MediaToolState
}

/** Batches have no top-level fields besides the row list itself. */
export type BatchSnapshotFields = Record<string, never>

export type AppSnapshotDelta = SnapshotDelta<DownloadItem, AppSnapshotFields>
export type MediaSnapshotDelta = SnapshotDelta<MediaJob, MediaSnapshotFields>
export type BatchSnapshotDelta = SnapshotDelta<Batch, BatchSnapshotFields>

export function appSnapshotPayload(
  snapshot: AppSnapshot
): SnapshotPayload<DownloadItem, AppSnapshotFields> {
  return {
    fields: { aria2: snapshot.aria2 },
    rows: snapshot.downloads,
    ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision })
  }
}

export function appSnapshotFromState(
  state: SnapshotClientState<DownloadItem, AppSnapshotFields>
): AppSnapshot {
  return { aria2: state.fields.aria2, downloads: state.rows }
}

export function mediaSnapshotPayload(
  snapshot: MediaSnapshot
): SnapshotPayload<MediaJob, MediaSnapshotFields> {
  return {
    fields: { tool: snapshot.tool },
    rows: snapshot.jobs,
    ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision })
  }
}

export function mediaSnapshotFromState(
  state: SnapshotClientState<MediaJob, MediaSnapshotFields>
): MediaSnapshot {
  return { tool: state.fields.tool, jobs: state.rows }
}

export function batchSnapshotPayload(
  snapshot: BatchSnapshot
): SnapshotPayload<Batch, BatchSnapshotFields> {
  return { fields: {}, rows: snapshot.batches }
}

export function batchSnapshotFromState(
  state: SnapshotClientState<Batch, BatchSnapshotFields>
): BatchSnapshot {
  return { batches: state.rows }
}

/* ------------------------------------------------------------------------- *
 * Cheap per-row versions
 * ------------------------------------------------------------------------- */

/**
 * A compact change key for one download. It avoids deep equality over the whole
 * history: only fields that can change after the row was first published are
 * included. `updatedAt` alone is not enough for tests or for policy/retry state
 * that is stored outside the record.
 */
export function downloadRowVersion(row: DownloadItem): string {
  return [
    row.updatedAt,
    row.gid,
    row.status,
    row.totalBytes,
    row.completedBytes,
    row.speedBps,
    row.etaSeconds ?? '',
    row.filename,
    row.filePath ?? '',
    row.errorMessage ?? '',
    row.errorDetail ?? '',
    row.attempts,
    row.completedAt ?? '',
    row.retryAt ?? '',
    row.scheduledAt ?? '',
    row.speedLimitBps ?? '',
    row.connections ?? '',
    row.blockReason ?? ''
  ].join('|')
}

export function mediaRowVersion(row: MediaJob): string {
  return [
    row.updatedAt,
    row.status,
    row.completedBytes,
    row.totalBytes ?? '',
    row.speedBps,
    row.errorMessage ?? '',
    row.completedAt ?? '',
    row.label,
    row.mergeProgress?.completedBytes ?? '',
    row.mergeProgress?.totalBytes ?? ''
  ].join('|')
}

export function batchRowVersion(row: Batch): string {
  return [
    row.updatedAt,
    row.status,
    row.progress.totalItems,
    row.progress.completedItems,
    row.progress.failedItems,
    row.progress.skippedItems,
    row.progress.completedBytes,
    row.progress.totalBytes ?? '',
    row.items.length,
    row.errorMessage ?? ''
  ].join('|')
}

/* ------------------------------------------------------------------------- *
 * Apply
 * ------------------------------------------------------------------------- */

export type SnapshotApplyStatus = 'applied' | 'unchanged' | 'resync'

export interface SnapshotApplyResult<Row, Fields> {
  status: SnapshotApplyStatus
  /** Null only before the first full delta. */
  state: SnapshotClientState<Row, Fields> | null
}

function shallowFieldsChanged<Fields extends object>(
  previous: Fields,
  next: Fields
): (keyof Fields)[] {
  const changed: (keyof Fields)[] = []
  const keys = new Set<keyof Fields>([
    ...(Object.keys(previous) as (keyof Fields)[]),
    ...(Object.keys(next) as (keyof Fields)[])
  ])
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      changed.push(key)
    }
  }
  return changed
}

/**
 * Apply one delta. Unchanged rows keep their previous object reference.
 *
 * A `full` delta always replaces the state, including a marked `replaces` full
 * whose revision is not newer: the sending side recreated its baseline and the
 * receiver's revision can no longer be compared with it.
 *
 * A `resync` result means the receiver must not apply the patch; the caller
 * should request a fresh full snapshot.
 */
export function applySnapshotDelta<Row extends { id: string }, Fields>(
  current: SnapshotClientState<Row, Fields> | null,
  delta: SnapshotDelta<Row, Fields>
): SnapshotApplyResult<Row, Fields> {
  if (delta.kind === 'full') {
    return {
      status: 'applied',
      state: {
        revision: delta.revision,
        fields: delta.fields,
        rows: delta.rows
      }
    }
  }

  if (
    current === null ||
    delta.baseRevision !== current.revision ||
    delta.revision <= current.revision
  ) {
    return { status: 'resync', state: current }
  }

  const changedFieldKeys = Object.keys(delta.fields) as (keyof Fields)[]
  const removed = new Set(delta.removedIds)
  const previousById = new Map(current.rows.map((row) => [row.id, row]))
  const nextById = new Map<string, Row>()
  for (const row of current.rows) {
    if (!removed.has(row.id)) nextById.set(row.id, row)
  }

  let changed = false
  let membershipChanged = removed.size > 0
  for (const row of delta.upserted) {
    if (!previousById.has(row.id)) membershipChanged = true
    const previous = nextById.get(row.id)
    if (previous !== row) {
      nextById.set(row.id, row)
      changed = true
    }
  }

  let rows: Row[]
  if (delta.order !== undefined) {
    rows = []
    for (const id of delta.order) {
      const row = nextById.get(id)
      if (row !== undefined) rows.push(row)
    }
    if (!changed) {
      changed =
        rows.length !== current.rows.length ||
        rows.some((row, index) => row !== current.rows[index])
    }
  } else if (membershipChanged) {
    rows = current.rows
      .filter((row) => !removed.has(row.id))
      .map((row) => nextById.get(row.id) ?? row)
    const seen = new Set(rows.map((row) => row.id))
    for (const row of delta.upserted) {
      if (!seen.has(row.id)) {
        rows.push(row)
        seen.add(row.id)
      }
    }
  } else if (changed) {
    rows = current.rows.map((row) => nextById.get(row.id) ?? row)
  } else {
    rows = current.rows
  }

  const fields =
    changedFieldKeys.length === 0
      ? current.fields
      : ({ ...current.fields, ...delta.fields } as Fields)

  if (!changed && !membershipChanged && changedFieldKeys.length === 0) {
    return { status: 'unchanged', state: current }
  }

  return {
    status: 'applied',
    state: { revision: delta.revision, fields, rows }
  }
}

/* ------------------------------------------------------------------------- *
 * Build (main process)
 * ------------------------------------------------------------------------- */

export interface SnapshotDeltaBuildOptions<Row> {
  /** Emit a full delta even when a patch would be sufficient. */
  forceFull?: boolean
  /** Cheap change key for one row. Defaults to object identity. */
  rowVersion?: (row: Row) => unknown
}

export interface BuiltSnapshotDelta<Row, Fields> {
  delta: SnapshotDelta<Row, Fields>
  state: SnapshotClientState<Row, Fields>
}

/**
 * Build the next delta from the last state sent to the renderer.
 *
 * Returns null when neither the rows nor the top-level fields changed; that is
 * the "emit nothing" path. Row change detection is O(rows) cheap-key compares,
 * never a deep equality of the whole history payload. A full delta without
 * `replaces` (the first one for a stream) means the receiver must have no state;
 * a forced full always carries `replaces` so a receiver that kept an older
 * state accepts it.
 */
export function buildSnapshotDelta<Row extends { id: string }, Fields extends object>(
  previous: SnapshotClientState<Row, Fields> | null,
  next: SnapshotPayload<Row, Fields>,
  revision: number,
  options: SnapshotDeltaBuildOptions<Row> = {}
): BuiltSnapshotDelta<Row, Fields> | null {
  const state: SnapshotClientState<Row, Fields> = {
    revision,
    fields: next.fields,
    rows: next.rows
  }

  if (previous === null || options.forceFull === true) {
    return {
      delta: {
        kind: 'full',
        revision,
        ...(options.forceFull === true ? { replaces: true } : {}),
        fields: next.fields,
        rows: next.rows
      },
      state
    }
  }

  const versionOf =
    options.rowVersion ?? ((row: Row): unknown => row)
  const previousById = new Map(previous.rows.map((row) => [row.id, row]))
  const nextIds = new Set(next.rows.map((row) => row.id))
  const changedFieldKeys = shallowFieldsChanged(previous.fields, next.fields)

  const upserted: Row[] = []
  let inserted = false
  for (const row of next.rows) {
    const before = previousById.get(row.id)
    if (before === undefined) {
      inserted = true
      upserted.push(row)
      continue
    }
    if (versionOf(before) !== versionOf(row)) {
      upserted.push(row)
    }
  }

  const removedIds: string[] = []
  for (const row of previous.rows) {
    if (!nextIds.has(row.id)) removedIds.push(row.id)
  }

  const orderChanged =
    previous.rows.length !== next.rows.length ||
    previous.rows.some((row, index) => next.rows[index]?.id !== row.id)

  if (
    upserted.length === 0 &&
    removedIds.length === 0 &&
    changedFieldKeys.length === 0 &&
    !orderChanged
  ) {
    return null
  }

  const fields: Partial<Fields> = {}
  for (const key of changedFieldKeys) {
    fields[key] = next.fields[key]
  }

  return {
    delta: {
      kind: 'patch',
      revision,
      baseRevision: previous.revision,
      fields,
      upserted,
      removedIds,
      ...(inserted || removedIds.length > 0 || orderChanged
        ? { order: next.rows.map((row) => row.id) }
        : {})
    },
    state
  }
}
