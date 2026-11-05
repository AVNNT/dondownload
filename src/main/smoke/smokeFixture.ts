import type { LookupFunction } from 'node:net'
import {
  defaultPublicTargetLookup,
  type PublicTargetLookup
} from '../net/publicTarget'
import {
  preflightPublicResource,
  type PublicResourcePreflightInput,
  type PublicResourcePreflightResult
} from '../net/publicPreflight'

export interface SmokeFixtureTarget {
  /** Exact host name the fixture URL uses. */
  hostname: string
  /** Address the fixture listener is actually bound to. */
  address: string
  /**
   * Address the policy validator sees. It must be globally routable so the
   * normal public-target check stays in force; the connection itself is pinned
   * to `address` by the injected preflight.
   */
  publicAddress: string
  family?: number
}

/**
 * Smoke-only fixture target lookup.
 *
 * The production bridge rejects loopback/private targets before it queues or
 * preflights a URL. A real-browser end-to-end check needs a deterministic,
 * Range-capable fixture on this machine. An explicitly opted-in interactive
 * smoke instance may therefore declare the exact fixture host name as a
 * public target; every validation in `preflightPublicResource` still runs and
 * the real connection is pinned to the local fixture.
 *
 * The host name must match exactly and only the isolated smoke process,
 * launched with the harness environment, can use it.
 */
export function createSmokeFixtureLookup(
  targets: readonly SmokeFixtureTarget[],
  fallback: PublicTargetLookup = defaultPublicTargetLookup
): PublicTargetLookup {
  const allowed = new Map(
    targets.map((target) => [
      target.hostname.toLowerCase(),
      { address: target.publicAddress, family: target.family ?? 4 }
    ])
  )
  return async (hostname, options) => {
    const match = allowed.get(hostname.toLowerCase())
    if (match) return [match]
    return fallback(hostname, options)
  }
}

/**
 * Run the real bounded anonymous preflight, but connect the exact fixture host
 * to its local listener instead of the declared public address. Any other host
 * (including a redirect target) fails closed.
 */
export function createSmokeFixturePreflight(
  targets: readonly SmokeFixtureTarget[]
): (
  input: PublicResourcePreflightInput,
  options?: { lookup?: PublicTargetLookup }
) => Promise<PublicResourcePreflightResult> {
  const allowed = new Map(
    targets.map((target) => [target.hostname.toLowerCase(), target])
  )
  const connectLookup: LookupFunction = (hostname, options, callback) => {
    const target = allowed.get(hostname.toLowerCase())
    if (!target) {
      callback(
        Object.assign(new Error('The preflight fixture host is not allowed.'), {
          code: 'ENOTFOUND'
        }),
        '',
        0
      )
      return
    }
    const family = target.family ?? 4
    if (options && options.all === true) {
      callback(null, [{ address: target.address, family }])
      return
    }
    callback(null, target.address, family)
  }

  return (input, options = {}) =>
    preflightPublicResource(input, {
      ...options,
      ...(options.lookup === undefined
        ? { lookup: createSmokeFixtureLookup(targets) }
        : {}),
      connectLookup
    })
}
