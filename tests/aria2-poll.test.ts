import { describe, expect, it } from 'vitest'
import {
  ARIA2_STATUS_KEYS,
  buildPollPlan,
  buildTellStatusCalls,
  parseMulticallEntry,
  readPollBatch
} from '../src/main/aria2/poll'

const status = (gid: string, state: string): Record<string, unknown> => ({
  gid,
  status: state,
  totalLength: '1000',
  completedLength: '250',
  downloadSpeed: '25',
  errorCode: '0',
  errorMessage: '',
  files: []
})

describe('aria2 poll plan', () => {
  it('asks for the active list with only the keys the app reads', () => {
    const plan = buildPollPlan({
      includeWaiting: false,
      includeGlobalStat: false
    })

    expect(plan.calls).toEqual([
      { methodName: 'aria2.tellActive', params: [[...ARIA2_STATUS_KEYS]] }
    ])
    expect(plan.activeIndex).toBe(0)
    expect(plan.waitingIndex).toBeNull()
    expect(plan.globalStatIndex).toBeNull()
    // Fields the manager never reads are not requested.
    expect(ARIA2_STATUS_KEYS).not.toContain('dir')
    expect(ARIA2_STATUS_KEYS).not.toContain('bitfield')
    expect(ARIA2_STATUS_KEYS).not.toContain('numPieces')
    expect(ARIA2_STATUS_KEYS).not.toContain('connections')
  })

  it('adds the waiting list and global counters to the same multicall', () => {
    const plan = buildPollPlan({
      includeWaiting: true,
      includeGlobalStat: true
    })

    expect(plan.calls.map((call) => call.methodName)).toEqual([
      'aria2.tellActive',
      'aria2.tellWaiting',
      'aria2.getGlobalStat'
    ])
    expect(plan.calls[1]?.params).toEqual([0, -1, [...ARIA2_STATUS_KEYS]])
    expect(plan.waitingIndex).toBe(1)
    expect(plan.globalStatIndex).toBe(2)
    // The stopped history is deliberately never fetched: it is unbounded and
    // a bounded tellStatus fallback covers the same GIDs.
    expect(plan.calls.some((call) => call.methodName === 'aria2.tellStopped')).toBe(
      false
    )
  })

  it('never requests extra fields in the bounded tellStatus fallback', () => {
    expect(buildTellStatusCalls(['0123456789abcdef'])).toEqual([
      {
        methodName: 'aria2.tellStatus',
        params: ['0123456789abcdef', [...ARIA2_STATUS_KEYS]]
      }
    ])
  })
})

describe('aria2 multicall decoding', () => {
  it('unwraps a successful one-element result and reports faults', () => {
    expect(parseMulticallEntry([{ gid: '0123456789abcdef' }])).toEqual({
      ok: true,
      value: { gid: '0123456789abcdef' }
    })
    expect(parseMulticallEntry({ code: 1, message: 'GID is not found.' })).toEqual({
      ok: false,
      message: 'GID is not found.'
    })
    expect(parseMulticallEntry(null)).toMatchObject({ ok: false })
  })

  it('merges active and waiting statuses and reads the global counters', () => {
    const plan = buildPollPlan({
      includeWaiting: true,
      includeGlobalStat: true
    })
    const active = status('aaaaaaaaaaaaaaaa', 'active')
    const waiting = status('bbbbbbbbbbbbbbbb', 'waiting')

    const outcome = readPollBatch(plan, [
      [[active]],
      [[waiting]],
      [{ numActive: '1', numWaiting: '2', numStopped: '5' }]
    ])

    expect(outcome.statuses.get('aaaaaaaaaaaaaaaa')).toEqual(active)
    expect(outcome.statuses.get('bbbbbbbbbbbbbbbb')).toEqual(waiting)
    expect(outcome.globalActive).toBe(1)
    expect(outcome.globalWaiting).toBe(2)
  })

  it('ignores a faulted list without losing the other list', () => {
    const plan = buildPollPlan({
      includeWaiting: true,
      includeGlobalStat: true
    })
    const waiting = status('bbbbbbbbbbbbbbbb', 'waiting')

    const outcome = readPollBatch(plan, [
      { code: 1, message: 'active list failed' },
      [[waiting]],
      { code: 1, message: 'global stat failed' }
    ])

    expect([...outcome.statuses.keys()]).toEqual(['bbbbbbbbbbbbbbbb'])
    expect(outcome.globalActive).toBeNull()
    expect(outcome.globalWaiting).toBeNull()
  })
})
