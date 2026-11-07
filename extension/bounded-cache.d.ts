export interface BoundedTtlCache<T> {
  get(key: string): T | undefined
  has(key: string): boolean
  set(key: string, value: T): T
  delete(key: string): boolean
  clear(): void
  size(): number
  prune(now?: number): void
}

export function createBoundedTtlCache<T = unknown>(options?: {
  max?: number
  ttlMs?: number
  now?: () => number
}): BoundedTtlCache<T>
