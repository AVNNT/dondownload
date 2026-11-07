// Small bounded caches for the service worker.
//
// MV3 workers are woken for many unrelated events, and anything keyed by a tab
// or a request must not grow for the lifetime of the browser session. These
// helpers combine a hard entry cap with a time-to-live: expired entries are
// dropped on access and the oldest insertion is evicted when a write would
// exceed the cap. Values are opaque, so an in-flight promise can be cached.

/**
 * @param {{
 *   max?: number,
 *   ttlMs?: number,
 *   now?: () => number
 * }} [options]
 */
export function createBoundedTtlCache(options = {}) {
  const maximum =
    Number.isSafeInteger(options.max) && options.max > 0 ? options.max : 100
  const ttl =
    Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : 5 * 60 * 1000
  const now = typeof options.now === 'function' ? options.now : Date.now
  const entries = new Map()

  function prune(current = now()) {
    for (const [key, entry] of entries) {
      if (current - entry.at >= ttl) entries.delete(key)
    }
    while (entries.size > maximum) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  function get(key) {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (now() - entry.at >= ttl) {
      entries.delete(key)
      return undefined
    }
    return entry.value
  }

  function has(key) {
    return get(key) !== undefined
  }

  function set(key, value) {
    // Delete first so a refreshed key moves to the newest insertion slot.
    entries.delete(key)
    entries.set(key, { value, at: now() })
    prune()
    return value
  }

  function remove(key) {
    return entries.delete(key)
  }

  function clear() {
    entries.clear()
  }

  function size() {
    prune()
    return entries.size
  }

  return { get, has, set, delete: remove, clear, size, prune }
}
