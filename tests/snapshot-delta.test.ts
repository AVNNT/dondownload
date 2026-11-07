import { describe, expect, it } from 'vitest'
import {
  applySnapshotDelta,
  buildSnapshotDelta,
  type SnapshotClientState,
  type SnapshotDelta
} from '../src/shared/snapshotDelta'
import { SnapshotDeltaPublisher } from '../src/main/snapshotDeltaPublisher'
import { createSnapshotDeltaStore } from '../src/renderer/src/lib/snapshotDeltaStore'

interface Row {
  id: string
  value: number
  label: string
}

interface Fields {
  status: string
  note: string | null
}

const rowVersion = (row: Row): number => row.value
const payload = (
  rows: Row[],
  fields: Fields = { status: 'ready', note: null }
): { fields: Fields; rows: Row[] } => ({ fields, rows })

function applyAll(
  state: SnapshotClientState<Row, Fields> | null,
  deltas: SnapshotDelta<Row, Fields>[]
): SnapshotClientState<Row, Fields> | null {
  let current = state
  for (const delta of deltas) {
    const result = applySnapshotDelta(current, delta)
    if (result.status === 'resync') throw new Error('unexpected resync')
    current = result.state
  }
  return current
}

describe('snapshot deltas', () => {
  it('sends a full delta first and nothing when nothing changed', () => {
    const first = buildSnapshotDelta(null, payload([{ id: 'a', value: 1, label: 'A' }]), 1, {
      rowVersion
    })
    expect(first?.delta.kind).toBe('full')
    expect(first?.delta.revision).toBe(1)

    const unchanged = buildSnapshotDelta(
      first?.state ?? null,
      payload([{ id: 'a', value: 1, label: 'A' }]),
      2,
      { rowVersion }
    )
    expect(unchanged).toBeNull()
  })

  it('patches changed rows, removals, inserts and changed fields only', () => {
    const initial = buildSnapshotDelta(
      null,
      payload([
        { id: 'a', value: 1, label: 'A' },
        { id: 'b', value: 1, label: 'B' },
        { id: 'c', value: 1, label: 'C' }
      ]),
      1,
      { rowVersion }
    )
    expect(initial?.delta.kind).toBe('full')
    if (!initial) throw new Error('missing initial delta')

    const built = buildSnapshotDelta(
      initial.state,
      payload(
        [
          { id: 'b', value: 2, label: 'B2' },
          { id: 'c', value: 1, label: 'C' },
          { id: 'd', value: 1, label: 'D' }
        ],
        { status: 'error', note: 'boom' }
      ),
      2,
      { rowVersion }
    )
    expect(built?.delta.kind).toBe('patch')
    if (!built || built.delta.kind !== 'patch') throw new Error('missing patch')
    expect(built.delta.baseRevision).toBe(1)
    expect(built.delta.revision).toBe(2)
    expect(built.delta.upserted.map((row) => row.id)).toEqual(['b', 'd'])
    expect(built.delta.removedIds).toEqual(['a'])
    expect(built.delta.fields).toEqual({ status: 'error', note: 'boom' })
    expect(built.delta.order).toEqual(['b', 'c', 'd'])
  })

  it('applies patches with structural sharing for unchanged rows', () => {
    const rowA = { id: 'a', value: 1, label: 'A' }
    const rowB = { id: 'b', value: 1, label: 'B' }
    const rowC = { id: 'c', value: 1, label: 'C' }
    const initial = buildSnapshotDelta(null, payload([rowA, rowB, rowC]), 1, {
      rowVersion
    })
    const built = buildSnapshotDelta(
      initial?.state ?? null,
      payload([{ id: 'a', value: 1, label: 'A' }, { id: 'b', value: 2, label: 'B2' }, { id: 'c', value: 1, label: 'C' }]),
      2,
      { rowVersion }
    )
    if (!built || built.delta.kind !== 'patch') throw new Error('missing patch')

    const result = applySnapshotDelta(initial?.state ?? null, built.delta)
    expect(result.status).toBe('applied')
    if (result.state === null) throw new Error('missing state')
    const [nextA, nextB, nextC] = result.state.rows
    expect(nextA).toBe(rowA)
    expect(nextB?.id).toBe('b')
    expect(nextB?.label).toBe('B2')
    expect(nextC).toBe(rowC)
  })

  it('carries the new row order when rows only reorder', () => {
    const a = { id: 'a', value: 1, label: 'A' }
    const b = { id: 'b', value: 1, label: 'B' }
    const initial = buildSnapshotDelta(null, payload([a, b]), 1, {
      rowVersion
    })
    const built = buildSnapshotDelta(initial?.state ?? null, payload([b, a]), 2, {
      rowVersion
    })
    if (!built || built.delta.kind !== 'patch') throw new Error('missing patch')
    expect(built.delta.order).toEqual(['b', 'a'])
    const result = applySnapshotDelta(initial?.state ?? null, built.delta)
    expect(result.state?.rows.map((row) => row.id)).toEqual(['b', 'a'])
    expect(result.state?.rows[0]).toBe(b)
  })

  it('refuses a patch whose base revision does not match and asks for resync', () => {
    const initial = buildSnapshotDelta(
      null,
      payload([{ id: 'a', value: 1, label: 'A' }]),
      1,
      { rowVersion }
    )
    const delta: SnapshotDelta<Row, Fields> = {
      kind: 'patch',
      revision: 4,
      baseRevision: 3,
      fields: {},
      upserted: [{ id: 'a', value: 9, label: 'A9' }],
      removedIds: []
    }
    const result = applySnapshotDelta(initial?.state ?? null, delta)
    expect(result.status).toBe('resync')
    expect(result.state).toBe(initial?.state)
  })

  it('reacts to a revision gap and recovers from a subsequent full delta', () => {
    let state = applyAll(null, [
      {
        kind: 'full',
        revision: 1,
        ...payload([{ id: 'a', value: 1, label: 'A' }])
      }
    ])
    const gap = applySnapshotDelta(state, {
      kind: 'patch',
      revision: 5,
      baseRevision: 4,
      fields: {},
      upserted: [],
      removedIds: []
    })
    expect(gap.status).toBe('resync')

    const full: SnapshotDelta<Row, Fields> = {
      kind: 'full',
      revision: 6,
      ...payload([{ id: 'b', value: 2, label: 'B' }], {
        status: 'error',
        note: null
      })
    }
    state = applyAll(state, [full])
    expect(state?.revision).toBe(6)
    expect(state?.rows.map((row) => row.id)).toEqual(['b'])
    expect(state?.fields.status).toBe('error')
  })
})

describe('renderer snapshot store', () => {
  it('coalesces a burst into one update and keeps unchanged row identity', () => {
    const scheduled: Array<() => void> = []
    let resyncs = 0
    let updates = 0
    const rowA = { id: 'a', value: 1, label: 'A' }
    const rowB = { id: 'b', value: 1, label: 'B' }
    const store = createSnapshotDeltaStore<Row, Fields>({
      rowVersion,
      onChange: () => {
        updates += 1
      },
      requestResync: () => {
        resyncs += 1
      },
      schedule: (flush) => {
        scheduled.push(flush)
        return () => {
          const index = scheduled.indexOf(flush)
          if (index >= 0) scheduled.splice(index, 1)
        }
      }
    })

    store.applyDelta({
      kind: 'full',
      revision: 1,
      ...payload([rowA, rowB])
    })
    store.applyDelta({
      kind: 'patch',
      revision: 2,
      baseRevision: 1,
      fields: {},
      upserted: [{ id: 'b', value: 2, label: 'B2' }],
      removedIds: []
    })
    expect(scheduled).toHaveLength(1)
    expect(updates).toBe(0)

    scheduled.shift()?.()
    expect(updates).toBe(1)
    const state = store.getState()
    expect(state?.revision).toBe(2)
    expect(state?.rows[0]).toBe(rowA)
    expect(state?.rows[1]?.label).toBe('B2')

    // A gap requests exactly one resync until a full delta arrives.
    store.applyDelta({
      kind: 'patch',
      revision: 9,
      baseRevision: 8,
      fields: {},
      upserted: [],
      removedIds: []
    })
    store.applyDelta({
      kind: 'patch',
      revision: 11,
      baseRevision: 10,
      fields: {},
      upserted: [],
      removedIds: []
    })
    expect(resyncs).toBe(1)

    store.applyDelta({
      kind: 'full',
      revision: 12,
      ...payload([rowA])
    })
    store.applyDelta({
      kind: 'patch',
      revision: 14,
      baseRevision: 13,
      fields: {},
      upserted: [],
      removedIds: []
    })
    expect(resyncs).toBe(2)
    store.dispose()
  })
})

describe('SnapshotDeltaPublisher hidden window handling', () => {
  function publisher(visible: boolean): {
    publisher: SnapshotDeltaPublisher<Row, Fields>
    sent: SnapshotDelta<Row, Fields>[]
    setWindowVisible: (visible: boolean) => void
  } {
    const sent: SnapshotDelta<Row, Fields>[] = []
    let windowVisible = visible
    const instance = new SnapshotDeltaPublisher<Row, Fields>({
      send: (delta) => sent.push(delta),
      isVisible: () => windowVisible,
      rowVersion
    })
    return {
      publisher: instance,
      sent,
      setWindowVisible: (next) => {
        windowVisible = next
        instance.setVisible(next)
      }
    }
  }

  it('keeps tracking while hidden and sends one catch-up patch when shown', () => {
    const { publisher: instance, sent, setWindowVisible } = publisher(true)
    instance.publish(payload([{ id: 'a', value: 1, label: 'A' }]))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.kind).toBe('full')

    setWindowVisible(false)
    instance.publish(payload([{ id: 'a', value: 2, label: 'A2' }]))
    instance.publish(
      payload([
        { id: 'a', value: 3, label: 'A3' },
        { id: 'b', value: 1, label: 'B' }
      ])
    )
    expect(sent).toHaveLength(1)

    setWindowVisible(true)
    expect(sent).toHaveLength(2)
    const catchUp = sent[1]
    expect(catchUp?.kind).toBe('patch')
    if (catchUp?.kind !== 'patch') throw new Error('missing catch-up')
    expect(catchUp.baseRevision).toBe(1)
    expect(catchUp.revision).toBe(2)
    expect(catchUp.upserted.map((row) => row.id)).toEqual(['a', 'b'])
  })

  it('does not send anything when re-shown with no changes', () => {
    const { publisher: instance, sent, setWindowVisible } = publisher(true)
    instance.publish(payload([{ id: 'a', value: 1, label: 'A' }]))
    setWindowVisible(false)
    setWindowVisible(true)
    expect(sent).toHaveLength(1)
  })

  it('waits for the first show before sending a full snapshot', () => {
    const { publisher: instance, sent, setWindowVisible } = publisher(false)
    instance.publish(payload([{ id: 'a', value: 1, label: 'A' }]))
    expect(sent).toHaveLength(0)
    setWindowVisible(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.kind).toBe('full')
  })

  it('forces a full delta on a resync request', () => {
    const { publisher: instance, sent } = publisher(true)
    instance.publish(payload([{ id: 'a', value: 1, label: 'A' }]))
    instance.requestFull()
    expect(sent).toHaveLength(2)
    expect(sent[1]?.kind).toBe('full')
    expect(sent[1]?.revision).toBe(2)
  })
})
