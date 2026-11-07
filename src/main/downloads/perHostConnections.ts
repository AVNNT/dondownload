import {
  MAX_PER_HOST_CONNECTIONS,
  MIN_PER_HOST_CONNECTIONS
} from '@shared/settings'

/**
 * Pure per-host connection policy.
 *
 * The app downloads with as many connections per server as the user allows
 * (16 by default, aria2's hard cap). Some servers refuse that many parallel
 * connections with 429/503 or by refusing/resetting the extra sockets. Instead
 * of failing the download, the connection count for that one host is lowered
 * along the ladder below and the job is retried. Other hosts keep their own
 * value and the user's setting is always the upper bound.
 *
 * Nothing here touches cookies, URLs or the disk: the memory is a plain
 * in-memory map keyed by host name.
 */

/** Ladder walked downwards when a server refuses parallel connections. */
export const PER_HOST_CONNECTION_STEPS: readonly number[] = [16, 8, 4, 1]

/**
 * How long a reduced per-host value is remembered. Memory-only for the session
 * by default; the TTL exists so an optional persisted copy cannot outlive a
 * day of the server behaving normally again.
 */
export const PER_HOST_MEMORY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A refused/reset socket on its own is ambiguous (a flaky network looks the
 * same), so a storm must repeat before the connection count is lowered.
 */
export const PER_HOST_STORM_THRESHOLD = 2

/** aria2 code 29: the remote server is temporarily overloaded. */
const ARIA2_SERVER_OVERLOADED = 29

/** Messages that already prove the server refused parallel connections. */
const LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /\b503\b/,
  /too many connections/i,
  /too many requests/i,
  /server overloaded/i
]

/** Messages that only count once they repeat for the same host. */
const STORM_PATTERNS: readonly RegExp[] = [
  /connection refused/i,
  /connection reset/i,
  /connection aborted/i,
  /\bECONNREFUSED\b/i,
  /\bECONNRESET\b/i
]

/** The aria2 failure fields this policy reads. */
export interface Aria2Failure {
  errorCode: number
  errorMessage?: string
}

/**
 * `limit` is an explicit refusal of parallel connections, `storm` is a
 * refused/reset socket that only matters when it repeats.
 */
export type ConnectionRefusalKind = 'limit' | 'storm'

/** Classify one aria2 failure, or null when it says nothing about connections. */
export function refusalKind(failure: Aria2Failure): ConnectionRefusalKind | null {
  const message = failure.errorMessage ?? ''
  if (LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return 'limit'
  if (failure.errorCode === ARIA2_SERVER_OVERLOADED) return 'limit'
  if (STORM_PATTERNS.some((pattern) => pattern.test(message))) return 'storm'
  return null
}

/** True when this failure is a refused/reset socket rather than a hard limit. */
export function isConnectionStorm(failure: Aria2Failure): boolean {
  return refusalKind(failure) === 'storm'
}

export interface HostBackoffPlan {
  /** Lower the connection count for this host before retrying. */
  reduce: boolean
  /** Why the failure was classified as a connection problem, if it was. */
  kind: ConnectionRefusalKind | null
}

/**
 * Decide whether one failure should lower the connections for its host.
 * `stormCount` is the number of refused/reset failures already seen for the
 * host including this one.
 */
export function planHostBackoff(input: {
  failure: Aria2Failure
  stormCount: number
}): HostBackoffPlan {
  const kind = refusalKind(input.failure)
  if (kind === null) return { reduce: false, kind: null }
  if (kind === 'limit') return { reduce: true, kind }
  return { reduce: input.stormCount >= PER_HOST_STORM_THRESHOLD, kind }
}

function clampConnections(value: number): number {
  if (!Number.isFinite(value)) return MIN_PER_HOST_CONNECTIONS
  const whole = Math.trunc(value)
  if (whole < MIN_PER_HOST_CONNECTIONS) return MIN_PER_HOST_CONNECTIONS
  if (whole > MAX_PER_HOST_CONNECTIONS) return MAX_PER_HOST_CONNECTIONS
  return whole
}

/**
 * Next lower rung for a host: 16 -> 8 -> 4 -> 1. A value between rungs (for
 * example a per-download 5) drops to the next rung below it. The result never
 * exceeds `ceiling`, which is the user's setting.
 */
export function nextLowerConnectionCount(
  current: number,
  ceiling: number = MAX_PER_HOST_CONNECTIONS
): number {
  const bound = clampConnections(current)
  const limit = clampConnections(ceiling)
  const next = PER_HOST_CONNECTION_STEPS.find((step) => step < bound)
  const value = next ?? MIN_PER_HOST_CONNECTIONS
  return Math.max(MIN_PER_HOST_CONNECTIONS, Math.min(value, limit))
}

/**
 * Connections actually used for one download. An explicit per-download choice
 * wins over the global setting (it is the user's decision for that one job),
 * the setting is the upper bound when the download inherits it, and a
 * remembered back-off for the host always lowers the result.
 */
export function effectivePerHostConnections(input: {
  /** The global `perHostConnections` setting. */
  setting: number
  /** Explicit per-download choice, or null to inherit the setting. */
  perDownload: number | null
  /** Remembered back-off value for the host, or null when none applies. */
  remembered: number | null
}): number {
  const base = clampConnections(
    input.perDownload === null ? input.setting : input.perDownload
  )
  if (input.remembered === null) return base
  return Math.min(base, clampConnections(input.remembered))
}

/**
 * Host key for the per-host memory: lower-case host name without a port, so
 * `https://example.com:8443/a` and `https://EXAMPLE.com/b` share one value.
 * Returns null for a URL that cannot be parsed.
 */
export function hostKeyFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

interface RememberedConnections {
  connections: number
  expiresAt: number
}

/**
 * Session memory of reduced per-host connection counts. Values expire after
 * `ttlMs` so a server that recovers is not punished forever. Holds host names
 * and numbers only — never a URL, header or cookie.
 */
export class PerHostConnectionMemory {
  private readonly entries = new Map<string, RememberedConnections>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PER_HOST_MEMORY_TTL_MS
  }

  /** Remembered connections for a host, or null when absent or expired. */
  get(host: string): number | null {
    const entry = this.entries.get(host)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(host)
      return null
    }
    return entry.connections
  }

  /** Store a reduced value for one host. */
  remember(host: string, connections: number): void {
    this.entries.set(host, {
      connections: clampConnections(connections),
      expiresAt: this.now() + this.ttlMs
    })
  }

  forget(host: string): void {
    this.entries.delete(host)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Number of live entries; expired ones are pruned first. */
  get size(): number {
    for (const host of [...this.entries.keys()]) this.get(host)
    return this.entries.size
  }
}
