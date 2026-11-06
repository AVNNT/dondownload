import { describe, expect, it } from 'vitest'
import { createCountdown } from '../src/renderer/src/lib/countdown'
import {
  EMPTY_PENDING_REMOVAL,
  addPendingRemoval,
  reconcilePendingRemoval,
  type PendingRemovalState
} from '../src/renderer/src/lib/pendingRemoval'

const rowA = { key: 'download:a', title: 'Alpha.iso' }
const rowB = { key: 'media:b', title: 'Beta video' }

function hidden(state: PendingRemovalState): string[] {
  return [...state.hidden].sort()
}

describe('undo countdown', () => {
  it('counts down in real time instead of compounding', () => {
    const countdown = createCountdown({ durationMs: 6000, now: 0 })
    expect(countdown.remaining(0)).toBe(6000)
    expect(countdown.remaining(3000)).toBe(3000)
    expect(countdown.remaining(6000)).toBe(0)
    expect(countdown.expired(6000)).toBe(true)
  })

  it('repeated reads do not advance the clock', () => {
    const countdown = createCountdown({ durationMs: 6000, now: 0 })
    // Simulates the 100 ms tick loop reading the same deadline many times.
    for (let i = 0; i < 50; i += 1) {
      expect(countdown.remaining(1000)).toBe(5000)
    }
  })

  it('pause keeps the remainder and resume continues from it', () => {
    const countdown = createCountdown({ durationMs: 6000, now: 0 })
    countdown.pause(3000)
    expect(countdown.paused()).toBe(true)
    expect(countdown.remaining(3000)).toBe(3000)
    // Time passing while paused does not consume the window.
    expect(countdown.remaining(9000)).toBe(3000)
    countdown.resume(10000)
    expect(countdown.paused()).toBe(false)
    expect(countdown.remaining(10000)).toBe(3000)
    expect(countdown.remaining(12000)).toBe(1000)
    expect(countdown.remaining(13000)).toBe(0)
  })

  it('never reports a negative remainder', () => {
    const countdown = createCountdown({ durationMs: 1000, now: 0 })
    expect(countdown.remaining(999999)).toBe(0)
    expect(countdown.expired(999999)).toBe(true)
    countdown.pause(999999)
    countdown.resume(1000000)
    expect(countdown.remaining(2000000)).toBe(0)
  })

  it('handles a zero-length window', () => {
    const countdown = createCountdown({ durationMs: 0, now: 0 })
    expect(countdown.remaining(0)).toBe(0)
    expect(countdown.expired(0)).toBe(true)
  })

  it('pause and resume are idempotent', () => {
    const countdown = createCountdown({ durationMs: 6000, now: 0 })
    countdown.pause(1000)
    countdown.pause(2000)
    expect(countdown.remaining(5000)).toBe(5000)
    countdown.resume(5000)
    countdown.resume(9000)
    expect(countdown.remaining(5000)).toBe(5000)
  })
})

describe('reconcile against the backend snapshot', () => {
  it('keeps keys that are still in the snapshot hidden', () => {
    const state = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key],
      [rowA.title],
      [rowA]
    )
    // The snapshot still lists the row, so it must stay hidden while the
    // toast is up (regression: reconciling against the filtered list dropped it).
    const reconciled = reconcilePendingRemoval(
      state,
      new Set([rowA.key, rowB.key])
    )
    expect(reconciled).toBe(state)
    expect(hidden(reconciled)).toEqual([rowA.key])
    expect(reconciled.pending?.keys).toEqual([rowA.key])
  })

  it('drops keys only once the snapshot no longer lists them', () => {
    const state = addPendingRemoval(
      EMPTY_PENDING_REMOVAL,
      [rowA.key, rowB.key],
      [rowA.title, rowB.title],
      [rowA, rowB]
    )
    const reconciled = reconcilePendingRemoval(state, new Set([rowA.key]))
    expect(hidden(reconciled)).toEqual([rowA.key])
  })
})
