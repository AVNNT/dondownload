import { describe, expect, it } from 'vitest'
import { createBoundedTtlCache } from '../extension/bounded-cache'

describe('bounded TTL cache', () => {
  it('evicts the oldest insertion at the hard cap', () => {
    const cache = createBoundedTtlCache({ max: 3, ttlMs: 1_000, now: () => 0 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)
    expect(cache.size()).toBe(3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('d')).toBe(4)
    // Refreshing a key moves it to the newest slot.
    cache.set('b', 22)
    cache.set('e', 5)
    expect(cache.has('c')).toBe(false)
    expect(cache.get('b')).toBe(22)
  })

  it('expires entries after the TTL and never grows past the cap', () => {
    let clock = 1_000
    const cache = createBoundedTtlCache({
      max: 2,
      ttlMs: 100,
      now: () => clock
    })
    cache.set('tab:1', { allowed: true })
    clock += 50
    cache.set('tab:2', { allowed: true })
    expect(cache.get('tab:1')).toEqual({ allowed: true })

    clock += 60
    // tab:1 is now 110ms old and expired; tab:2 is 60ms old.
    expect(cache.get('tab:1')).toBeUndefined()
    expect(cache.get('tab:2')).toEqual({ allowed: true })

    for (let tabId = 3; tabId < 100; tabId += 1) {
      cache.set(`tab:${tabId}`, { allowed: true })
      expect(cache.size()).toBeLessThanOrEqual(2)
    }
    clock += 100
    expect(cache.size()).toBe(0)
  })
})
