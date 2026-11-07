import type { RpcSubCall } from './rpc'

/**
 * The only aria2 status fields the download manager actually reads. Asking for
 * exactly these `keys` keeps every poll response small: `dir`, `bitfield`,
 * `connections`, `numPieces` and the various BitTorrent/Metalink fields are
 * never used by this app.
 */
export const ARIA2_STATUS_KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'downloadSpeed',
  'errorCode',
  'errorMessage',
  'files'
] as const

export interface Aria2PollPlanOptions {
  /**
   * `aria2.tellWaiting` is only useful while a local job can still be sitting
   * in aria2's queue. Active-only ticks skip it entirely.
   */
  includeWaiting: boolean
  /**
   * `aria2.getGlobalStat` is a tiny object that tells the scheduler whether
   * aria2 still has active/waiting work. It is batched with the list calls so
   * the adaptive interval costs no extra round trip.
   */
  includeGlobalStat: boolean
}

export interface Aria2PollPlan {
  calls: RpcSubCall[]
  activeIndex: number
  waitingIndex: number | null
  globalStatIndex: number | null
}

/**
 * Build the single `system.multicall` used for one observation tick.
 *
 * The stopped list is deliberately never requested: it is unbounded (aria2
 * keeps up to `--max-download-result` entries) and its `offset` is measured
 * from the oldest result, so finding recent completions would require an
 * extra `getGlobalStat` round trip plus a computed offset. A bounded
 * `tellStatus` fallback for the few GIDs that disappeared from the active and
 * waiting lists is smaller, exact and resolves completion/error in the same
 * tick.
 */
export function buildPollPlan(options: Aria2PollPlanOptions): Aria2PollPlan {
  const calls: RpcSubCall[] = [
    {
      methodName: 'aria2.tellActive',
      params: [[...ARIA2_STATUS_KEYS]]
    }
  ]

  let waitingIndex: number | null = null
  if (options.includeWaiting) {
    waitingIndex = calls.length
    calls.push({
      methodName: 'aria2.tellWaiting',
      // offset 0, num -1 (unlimited): the polite bound is the app's own queue.
      params: [0, -1, [...ARIA2_STATUS_KEYS]]
    })
  }

  let globalStatIndex: number | null = null
  if (options.includeGlobalStat) {
    globalStatIndex = calls.length
    // getGlobalStat has no `keys` parameter; the response is already tiny.
    calls.push({ methodName: 'aria2.getGlobalStat', params: [] })
  }

  return { calls, activeIndex: 0, waitingIndex, globalStatIndex }
}

export interface Aria2MulticallEntrySuccess {
  ok: true
  value: unknown
}

export interface Aria2MulticallEntryFault {
  ok: false
  message: string
}

export type Aria2MulticallEntry =
  | Aria2MulticallEntrySuccess
  | Aria2MulticallEntryFault

/** Decode one slot of a `system.multicall` result. */
export function parseMulticallEntry(entry: unknown): Aria2MulticallEntry {
  // aria2 wraps a successful sub-call result in a one-element array.
  if (Array.isArray(entry)) {
    return { ok: true, value: entry[0] }
  }
  if (typeof entry === 'object' && entry !== null) {
    const record = entry as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.length > 0) {
      return { ok: false, message: record.message }
    }
  }
  return { ok: false, message: 'aria2 returned no result for this call.' }
}

export interface Aria2PollOutcome {
  /** Latest raw status per GID. Active entries are overwritten by waiting. */
  statuses: Map<string, unknown>
  globalActive: number | null
  globalWaiting: number | null
}

function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function collectStatuses(
  entries: readonly unknown[],
  index: number | null,
  into: Map<string, unknown>
): void {
  if (index === null) return
  const entry = parseMulticallEntry(entries[index])
  if (!entry.ok || !Array.isArray(entry.value)) return
  for (const status of entry.value) {
    if (typeof status !== 'object' || status === null) continue
    const gid = (status as Record<string, unknown>).gid
    if (typeof gid === 'string' && gid.length > 0) {
      into.set(gid, status)
    }
  }
}

/**
 * Turn a `system.multicall` result into a GID -> status map plus the global
 * counters used by the adaptive poll interval. A fault in one list call only
 * removes that source; the caller falls back to a bounded `tellStatus` batch
 * for any GID it could not find.
 */
export function readPollBatch(
  plan: Aria2PollPlan,
  raw: unknown
): Aria2PollOutcome {
  const entries = Array.isArray(raw) ? raw : []
  const statuses = new Map<string, unknown>()

  collectStatuses(entries, plan.activeIndex, statuses)
  collectStatuses(entries, plan.waitingIndex, statuses)

  let globalActive: number | null = null
  let globalWaiting: number | null = null
  if (plan.globalStatIndex !== null) {
    const entry = parseMulticallEntry(entries[plan.globalStatIndex])
    if (
      entry.ok &&
      typeof entry.value === 'object' &&
      entry.value !== null &&
      !Array.isArray(entry.value)
    ) {
      const record = entry.value as Record<string, unknown>
      globalActive = asCount(record.numActive)
      globalWaiting = asCount(record.numWaiting)
    }
  }

  return { statuses, globalActive, globalWaiting }
}

/**
 * Bounded fallback for GIDs that are no longer active or waiting. Requesting
 * these by GID avoids downloading the whole (unbounded) stopped history.
 */
export function buildTellStatusCalls(gids: readonly string[]): RpcSubCall[] {
  return gids.map((gid) => ({
    methodName: 'aria2.tellStatus',
    params: [gid, [...ARIA2_STATUS_KEYS]]
  }))
}
