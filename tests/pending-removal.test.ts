import { describe, expect, it } from 'vitest'
import {
  EMPTY_PENDING_REMOVAL,
  addPendingRemoval,
  expirePendingRemoval,
  failPendingRemoval,
  pendingRemovalLabel,
  reconcilePendingRemoval,
  settlePendingRemoval,
  undoPendingRemoval,
  type PendingRemovalState
} from '../src/renderer/src/lib/pendingRemoval'

const rowA = { key: 'download:a', title: 'Alpha.iso' }
const rowB = { key: 'media:b', title: 'Beta video' }
const rowC = { key: 'download:c', title: 'Gamma.zip' }

function hidden(state: PendingRemovalState): string[] {
  return [...state.hidden].sort()
}

describe('pending removal with undo', () => {
  it('starts empty', () => {
    expect(hidden(EMPTY_PENDING_REMOVAL)).toEqual([])
    expect(EMPTY_PENDING_REMOVAL.pending).toBeNull()
  })

  it('hides rows and keeps them as the pending removal', () => {
    const state = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key],
      [rowA.title],
      [rowA]
    )
    expect(hidden(state)).toEqual([rowA.key])
    expect(state.pending?.keys).toEqual([rowA.key])
    expect(state.pending?.titles).toEqual([rowA.title])
    expect(state.pending?.rows).toEqual([rowA])
  })

  it('undo restores the rows and closes the window', () => {
    const added = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key, rowB.key],
      [rowA.title, rowB.title],
      [rowA, rowB]
    )
    const undone = undoPendingRemoval(added)
    expect(hidden(undone)).toEqual([])
    expect(undone.pending).toBeNull()
  })

  it('undo without a pending removal is a no-op', () => {
    expect(undoPendingRemoval(EMPTY_PENDING_REMOVAL)).toBe(
      EMPTY_PENDING_REMOVAL
    )
  })

  it('expire commits: the window closes but the rows stay hidden', () => {
    const added = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key],
      [rowA.title],
      [rowA]
    )
    const expired = expirePendingRemoval(added)
    expect(expired.pending).toBeNull()
    expect(hidden(expired)).toEqual([rowA.key])
  })

  it('settle drops the committed keys once the snapshot caught up', () => {
    const expired = expirePendingRemoval(
      addPendingRemoval(EMPTY_PENDING_REMOVAL, [rowA.key], [rowA.title], [rowA])
    )
    const settled = settlePendingRemoval(expired, [rowA.key])
    expect(hidden(settled)).toEqual([])
    expect(settled.pending).toBeNull()
  })

  it('settle leaves unrelated hidden keys alone', () => {
    let state = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key],
      [rowA.title],
      [rowA]
    )
    state = expirePendingRemoval(state)
    state = addPendingRemoval(state, [rowB.key], [rowB.title], [rowB])
    const settled = settlePendingRemoval(state, [rowA.key])
    expect(hidden(settled)).toEqual([rowB.key])
    expect(settled.pending?.keys).toEqual([rowB.key])
  })

  it('a new removal replaces the previous window', () => {
    const first = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key],
      [rowA.title],
      [rowA]
    )
    const second = addPendingRemoval(first, [rowB.key], [rowB.title], [rowB])
    expect(hidden(second)).toEqual([rowA.key, rowB.key].sort())
    expect(second.pending?.keys).toEqual([rowB.key])
  })

  it('reconcile drops keys the snapshot no longer lists', () => {
    const state = expirePendingRemoval(
      addPendingRemoval(
        EMPTY_PENDING_REMOVAL,
        [rowA.key, rowB.key],
        [rowA.title, rowB.title],
        [rowA, rowB]
      )
    )
    const reconciled = reconcilePendingRemoval(
      state,
      new Set([rowA.key, rowC.key])
    )
    expect(hidden(reconciled)).toEqual([rowA.key])
    expect(reconcilePendingRemoval(state, new Set([rowA.key, rowB.key]))).toBe(
      state
    )
  })

  it('fail restores the rows when the commit could not run', () => {
    const state = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key, rowB.key],
      [rowA.title, rowB.title],
      [rowA, rowB]
    )
    const failed = failPendingRemoval(expirePendingRemoval(state), [rowA.key, rowB.key])
    expect(hidden(failed)).toEqual([])
    expect(failed.pending).toBeNull()
  })

  it('labels one row by title and several by count', () => {
    expect(pendingRemovalLabel([rowA.title])).toBe(rowA.title)
    expect(pendingRemovalLabel([rowA.title, rowB.title])).toBe('2 downloads')
    expect(pendingRemovalLabel([])).toBe('download')
  })
})
