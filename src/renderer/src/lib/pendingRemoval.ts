/**
 * Deferred removal with undo.
 *
 * Removing rows from the downloads list is permanent in the backend, so the
 * renderer hides the rows immediately and only commits the removal after a
 * short grace period. Every rule lives here so it can be unit-tested without
 * React, timers or IPC.
 *
 * Lifecycle:
 * - `add` hides rows and starts the undo window.
 * - `undo` restores them and drops the window (no backend call).
 * - `expire` (timeout, Esc, another removal, window unload) commits the
 *   stored plan; `settle` drops the keys once the backend no longer lists them.
 * - `fail` restores the rows when the commit could not be completed.
 */

export interface PendingRemovalEntry {
  /** Row keys hidden from the list, in the order they were removed. */
  keys: string[]
  /** Titles of the removed rows, used for the toast copy. */
  titles: string[]
  /** Rows hidden by this removal (current snapshot objects). */
  rows: unknown[]
}

export interface PendingRemovalState {
  /** Row keys currently hidden from the list. */
  hidden: ReadonlySet<string>
  /** The removal waiting for an undo or a commit, if any. */
  pending: PendingRemovalEntry | null
}

export const EMPTY_PENDING_REMOVAL: PendingRemovalState = {
  hidden: new Set(),
  pending: null
}

/** Hides rows and makes them the pending removal (replacing any older one). */
export function addPendingRemoval(
  state: PendingRemovalState,
  keys: readonly string[],
  titles: readonly string[],
  rows: readonly unknown[]
): PendingRemovalState {
  if (keys.length === 0) return state
  const hidden = new Set(state.hidden)
  for (const key of keys) hidden.add(key)
  return {
    hidden,
    pending: { keys: [...keys], titles: [...titles], rows: [...rows] }
  }
}

/** Restores the pending rows; the backend was never told about them. */
export function undoPendingRemoval(
  state: PendingRemovalState
): PendingRemovalState {
  const pending = state.pending
  if (pending === null) return state
  const hidden = new Set(state.hidden)
  for (const key of pending.keys) hidden.delete(key)
  return { hidden, pending: null }
}

/**
 * Commits the pending removal: the caller runs the plan, then calls
 * `settlePendingRemoval` once the snapshot no longer lists the keys.
 */
export function expirePendingRemoval(
  state: PendingRemovalState
): PendingRemovalState {
  if (state.pending === null) return state
  return { hidden: state.hidden, pending: null }
}

/** Drops the keys of a committed removal from the hidden set. */
export function settlePendingRemoval(
  state: PendingRemovalState,
  keys: readonly string[]
): PendingRemovalState {
  if (keys.length === 0) return state
  let changed = false
  const hidden = new Set(state.hidden)
  for (const key of keys) {
    if (hidden.delete(key)) changed = true
  }
  return changed ? { hidden, pending: state.pending } : state
}

/**
 * Drops every hidden key the current rows no longer contain. A committed
 * removal whose snapshot already caught up needs no further bookkeeping.
 */
export function reconcilePendingRemoval(
  state: PendingRemovalState,
  presentKeys: ReadonlySet<string>
): PendingRemovalState {
  let changed = false
  const hidden = new Set<string>()
  for (const key of state.hidden) {
    if (presentKeys.has(key)) hidden.add(key)
    else changed = true
  }
  return changed ? { hidden, pending: state.pending } : state
}

/**
 * The commit failed: restore the rows and show them again so the user can
 * retry. Returns the restored state and the keys that came back.
 */
export function failPendingRemoval(
  state: PendingRemovalState,
  keys: readonly string[]
): PendingRemovalState {
  const hidden = new Set(state.hidden)
  for (const key of keys) hidden.delete(key)
  return { hidden, pending: state.pending }
}

/** Toast copy: one title for a single row, a count for several. */
export function pendingRemovalLabel(
  titles: readonly string[]
): string {
  if (titles.length <= 1) {
    return titles[0] ?? 'download'
  }
  return `${titles.length} downloads`
}
