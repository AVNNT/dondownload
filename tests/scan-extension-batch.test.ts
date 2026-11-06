import { describe, expect, it } from 'vitest'
import {
  EXTENSION_SCAN_BATCH_WINDOW_MS,
  groupExtensionScan
} from '../src/renderer/src/lib/extensionScanBatch'

describe('extension scan batching', () => {
  it('starts a batch on the first extension scan', () => {
    const decision = groupExtensionScan(null, 'scan_a', 1_000)
    expect(decision.isContinuation).toBe(false)
    expect(decision.batch.sessionIds).toEqual(['scan_a'])
  })

  it('groups several URL sessions that arrive in the same window', () => {
    let state = groupExtensionScan(null, 'scan_a', 1_000).batch
    for (const [index, id] of ['scan_b', 'scan_c'].entries()) {
      const decision = groupExtensionScan(state, id, 2_000 + index * 500)
      expect(decision.isContinuation).toBe(true)
      state = decision.batch
    }
    expect(state.sessionIds).toEqual(['scan_a', 'scan_b', 'scan_c'])
  })

  it('does not re-order or extend the window on progress updates', () => {
    const first = groupExtensionScan(null, 'scan_a', 1_000).batch
    const second = groupExtensionScan(first, 'scan_b', 2_000).batch
    const progress = groupExtensionScan(
      second,
      'scan_a',
      2_000 + EXTENSION_SCAN_BATCH_WINDOW_MS + 1
    )
    expect(progress.isContinuation).toBe(true)
    expect(progress.batch).toBe(second)
    expect(progress.batch.updatedAt).toBe(2_000)
    expect(progress.batch.sessionIds).toEqual(['scan_a', 'scan_b'])
  })

  it('starts a new batch after the window', () => {
    const first = groupExtensionScan(null, 'scan_a', 1_000).batch
    const next = groupExtensionScan(
      first,
      'scan_b',
      1_000 + EXTENSION_SCAN_BATCH_WINDOW_MS + 1
    )
    expect(next.isContinuation).toBe(false)
    expect(next.batch.sessionIds).toEqual(['scan_b'])
  })
})
