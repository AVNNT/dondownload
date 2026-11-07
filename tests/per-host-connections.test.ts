import { describe, expect, it } from 'vitest'
import {
  PER_HOST_CONNECTION_STEPS,
  PER_HOST_MEMORY_TTL_MS,
  PER_HOST_STORM_THRESHOLD,
  PerHostConnectionMemory,
  effectivePerHostConnections,
  hostKeyFromUrl,
  isConnectionStorm,
  nextLowerConnectionCount,
  planHostBackoff,
  refusalKind
} from '../src/main/downloads/perHostConnections'

describe('per-host connection ladder', () => {
  it('walks 16 -> 8 -> 4 -> 1 and never goes below one connection', () => {
    expect(PER_HOST_CONNECTION_STEPS).toEqual([16, 8, 4, 1])
    expect(nextLowerConnectionCount(16)).toBe(8)
    expect(nextLowerConnectionCount(8)).toBe(4)
    expect(nextLowerConnectionCount(4)).toBe(1)
    expect(nextLowerConnectionCount(1)).toBe(1)
  })

  it('drops a value between rungs to the next rung below it', () => {
    expect(nextLowerConnectionCount(12)).toBe(8)
    expect(nextLowerConnectionCount(5)).toBe(4)
    expect(nextLowerConnectionCount(3)).toBe(1)
    expect(nextLowerConnectionCount(2)).toBe(1)
  })

  it('never returns more than the user setting used as the ceiling', () => {
    expect(nextLowerConnectionCount(16, 4)).toBe(4)
    expect(nextLowerConnectionCount(8, 2)).toBe(2)
    expect(nextLowerConnectionCount(4, 1)).toBe(1)
  })
})

describe('connection refusal detection', () => {
  it('treats HTTP 429, 503 and "Too many connections" as a hard limit', () => {
    expect(
      refusalKind({ errorCode: 22, errorMessage: 'The response status is 429' })
    ).toBe('limit')
    expect(
      refusalKind({ errorCode: 22, errorMessage: 'The response status is 503' })
    ).toBe('limit')
    expect(
      refusalKind({ errorCode: 1, errorMessage: 'Too many connections' })
    ).toBe('limit')
    // aria2 code 29: the remote server is temporarily overloaded.
    expect(refusalKind({ errorCode: 29 })).toBe('limit')
  })

  it('treats a refused or reset socket as a storm signal', () => {
    expect(
      refusalKind({ errorCode: 6, errorMessage: 'Connection refused' })
    ).toBe('storm')
    expect(
      refusalKind({ errorCode: 6, errorMessage: 'read error: Connection reset by peer' })
    ).toBe('storm')
    expect(isConnectionStorm({ errorCode: 6, errorMessage: 'ECONNRESET' })).toBe(
      true
    )
  })

  it('ignores failures that say nothing about connections', () => {
    for (const failure of [
      { errorCode: 3, errorMessage: 'Resource not found' },
      { errorCode: 9, errorMessage: 'Not enough disk space' },
      { errorCode: 24, errorMessage: 'HTTP authorization failed' },
      { errorCode: 1, errorMessage: '' }
    ]) {
      expect(refusalKind(failure)).toBeNull()
      expect(isConnectionStorm(failure)).toBe(false)
    }
  })
})

describe('host back-off plan', () => {
  it('lowers the count immediately for an explicit limit', () => {
    expect(
      planHostBackoff({
        failure: { errorCode: 22, errorMessage: 'status=429' },
        stormCount: 0
      })
    ).toEqual({ reduce: true, kind: 'limit' })
  })

  it('waits for a repeated refused/reset socket before lowering', () => {
    expect(PER_HOST_STORM_THRESHOLD).toBe(2)
    const failure = { errorCode: 6, errorMessage: 'Connection refused' }
    expect(planHostBackoff({ failure, stormCount: 1 })).toEqual({
      reduce: false,
      kind: 'storm'
    })
    expect(planHostBackoff({ failure, stormCount: 2 })).toEqual({
      reduce: true,
      kind: 'storm'
    })
  })

  it('never lowers the count for an unrelated failure', () => {
    expect(
      planHostBackoff({
        failure: { errorCode: 3, errorMessage: 'Resource not found' },
        stormCount: 5
      })
    ).toEqual({ reduce: false, kind: null })
  })
})

describe('effective per-download connection count', () => {
  it('uses the setting when nothing else applies', () => {
    expect(
      effectivePerHostConnections({
        setting: 16,
        perDownload: null,
        remembered: null
      })
    ).toBe(16)
  })

  it('lets a remembered back-off lower the setting', () => {
    expect(
      effectivePerHostConnections({
        setting: 16,
        perDownload: null,
        remembered: 4
      })
    ).toBe(4)
  })

  it('keeps an explicit per-download choice but still applies the back-off', () => {
    expect(
      effectivePerHostConnections({
        setting: 4,
        perDownload: 8,
        remembered: null
      })
    ).toBe(8)
    expect(
      effectivePerHostConnections({
        setting: 16,
        perDownload: 8,
        remembered: 4
      })
    ).toBe(4)
  })

  it('clamps values to the supported range', () => {
    expect(
      effectivePerHostConnections({
        setting: 16,
        perDownload: null,
        remembered: 0
      })
    ).toBe(1)
    expect(
      effectivePerHostConnections({
        setting: 99,
        perDownload: null,
        remembered: null
      })
    ).toBe(16)
  })
})

describe('host key', () => {
  it('normalises case and drops the port', () => {
    expect(hostKeyFromUrl('https://Example.COM:8443/a/b')).toBe('example.com')
    expect(hostKeyFromUrl('http://example.com/file.bin')).toBe('example.com')
  })

  it('returns null for a URL that cannot be parsed', () => {
    expect(hostKeyFromUrl('not a url')).toBeNull()
  })
})

describe('per-host connection memory', () => {
  it('remembers a reduced value per host only', () => {
    const memory = new PerHostConnectionMemory({ now: () => 1_000 })
    memory.remember('slow.example.com', 4)

    expect(memory.get('slow.example.com')).toBe(4)
    expect(memory.get('fast.example.com')).toBeNull()
    expect(memory.size).toBe(1)
  })

  it('expires an entry after the TTL', () => {
    let now = 0
    const memory = new PerHostConnectionMemory({ now: () => now })
    memory.remember('example.com', 8)
    expect(PER_HOST_MEMORY_TTL_MS).toBe(24 * 60 * 60 * 1000)

    now += PER_HOST_MEMORY_TTL_MS - 1
    expect(memory.get('example.com')).toBe(8)

    now += 1
    expect(memory.get('example.com')).toBeNull()
    expect(memory.size).toBe(0)
  })

  it('can forget one host and clear everything', () => {
    const memory = new PerHostConnectionMemory({ now: () => 0 })
    memory.remember('a.example.com', 8)
    memory.remember('b.example.com', 4)

    memory.forget('a.example.com')
    expect(memory.get('a.example.com')).toBeNull()
    expect(memory.get('b.example.com')).toBe(4)

    memory.clear()
    expect(memory.size).toBe(0)
  })

  it('clamps a remembered value into the supported range', () => {
    const memory = new PerHostConnectionMemory({ now: () => 0 })
    memory.remember('example.com', 0)
    expect(memory.get('example.com')).toBe(1)
    memory.remember('example.com', 99)
    expect(memory.get('example.com')).toBe(16)
  })
})
