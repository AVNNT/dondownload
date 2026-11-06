import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING_SCANS,
  PENDING_SCAN_KEY,
  PENDING_SCAN_TTL_MS,
  pendingScanGroups,
  rememberPendingScan,
  rememberPendingScans,
  scanCookiesReady,
  takePendingScan,
  takePendingScans
} from '../extension/scan-pending.js'
import { CAPTURE_SETTINGS_KEY } from '../extension/capture-settings.js'

const ORIGIN = 'https://discuss.eroscripts.com'
const PAGE = `${ORIGIN}/t/fancam-mix/346779`
const OTHER_ORIGIN = 'https://forum.example'
const OTHER_PAGE = `${OTHER_ORIGIN}/t/topic/1`

function area() {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
    },
    remove: async (key: string) => {
      delete data[key]
    }
  }
}

function chromeMock(options: { granted?: boolean; optIn?: string[] } = {}) {
  const local = area()
  const session = area()
  if (options.optIn) {
    local.data[CAPTURE_SETTINGS_KEY] = { cookieOptInOrigins: options.optIn }
  }
  const containsCalls: unknown[] = []
  return {
    containsCalls,
    session,
    api: {
      runtime: { lastError: undefined },
      storage: { local, session },
      permissions: {
        contains: (query: unknown, callback: (value: boolean) => void) => {
          containsCalls.push(query)
          callback(options.granted === true)
        }
      }
    }
  }
}

describe('scan cookies readiness', () => {
  it('is ready only when Chrome granted cookies for the exact origin and it is opted in', async () => {
    const ready = chromeMock({ granted: true, optIn: [ORIGIN] })
    expect(await scanCookiesReady(ready.api, ORIGIN)).toBe(true)
    expect(ready.containsCalls).toEqual([
      { permissions: ['cookies'], origins: [`${ORIGIN}/*`] }
    ])

    expect(await scanCookiesReady(chromeMock({ granted: false, optIn: [ORIGIN] }).api, ORIGIN)).toBe(false)
    expect(await scanCookiesReady(chromeMock({ granted: true, optIn: [] }).api, ORIGIN)).toBe(false)
  })
})

describe('pending scan after the one-time grant', () => {
  it('hands the page URL to the grant page once, for the same origin only', async () => {
    const mock = chromeMock()
    expect(await rememberPendingScan(mock.api, PAGE, 1_000)).toBe(true)
    expect(await takePendingScan(mock.api, ORIGIN, 2_000)).toBe(PAGE)
    // Consumed: a second grant cannot start another scan.
    expect(await takePendingScan(mock.api, ORIGIN, 2_000)).toBeNull()
  })

  it('never starts a scan for a different origin and keeps the entry', async () => {
    const mock = chromeMock()
    await rememberPendingScan(mock.api, PAGE, 1_000)
    expect(await takePendingScan(mock.api, 'https://evil.example', 2_000)).toBeNull()
    // Another origin's grant never consumes this site's pending scan.
    expect(await takePendingScan(mock.api, ORIGIN, 2_000)).toBe(PAGE)
  })

  it('expires stale entries and rejects non-http URLs', async () => {
    const mock = chromeMock()
    await rememberPendingScan(mock.api, PAGE, 1_000)
    expect(await takePendingScan(mock.api, ORIGIN, 1_000 + PENDING_SCAN_TTL_MS + 1)).toBeNull()
    expect(await rememberPendingScan(mock.api, 'javascript:alert(1)', 1_000)).toBe(false)
  })

  it('never stores a cookie value', async () => {
    const mock = chromeMock()
    await rememberPendingScan(mock.api, PAGE, 1_000)
    const stored = mock.session.data[PENDING_SCAN_KEY] as {
      entries: Array<{ url: string; at: number }>
    }
    expect(Object.keys(stored)).toEqual(['entries'])
    expect(Object.keys(stored.entries[0] ?? {}).sort()).toEqual(['at', 'url'])
    expect(JSON.stringify(stored)).not.toMatch(/cookie/i)
  })
})

describe('pending scan list for several origins', () => {
  it('takes only the requested origin once and leaves the others pending', async () => {
    const mock = chromeMock()
    const ours = [`${ORIGIN}/t/a`, `${ORIGIN}/t/b`]
    expect(
      await rememberPendingScans(mock.api, [...ours, OTHER_PAGE], 1_000)
    ).toBe(true)

    expect(await takePendingScans(mock.api, ORIGIN, 2_000)).toEqual(ours)
    // One-shot per origin.
    expect(await takePendingScans(mock.api, ORIGIN, 2_000)).toEqual([])
    expect(await takePendingScans(mock.api, OTHER_ORIGIN, 2_000)).toEqual([
      OTHER_PAGE
    ])
  })

  it('returns only fresh same-origin URLs and expires stale ones', async () => {
    const mock = chromeMock()
    await rememberPendingScans(mock.api, [PAGE, OTHER_PAGE], 1_000)
    expect(
      await takePendingScans(mock.api, ORIGIN, 1_000 + PENDING_SCAN_TTL_MS + 1)
    ).toEqual([])
    expect(
      await takePendingScans(mock.api, OTHER_ORIGIN, 1_000 + PENDING_SCAN_TTL_MS + 1)
    ).toEqual([])
  })

  it('deduplicates and caps the whole list at ten URLs', async () => {
    const mock = chromeMock()
    const urls = Array.from(
      { length: MAX_PENDING_SCANS + 3 },
      (_value, index) => `${ORIGIN}/t/${index}`
    )
    expect(await rememberPendingScans(mock.api, [...urls, urls[0]], 1_000)).toBe(
      true
    )
    const stored = mock.session.data[PENDING_SCAN_KEY] as {
      entries: Array<{ url: string }>
    }
    expect(stored.entries).toHaveLength(MAX_PENDING_SCANS)
    const taken = await takePendingScans(mock.api, ORIGIN, 2_000)
    expect(taken).toHaveLength(MAX_PENDING_SCANS)
    expect(new Set(taken).size).toBe(taken.length)
  })

  it('groups the remaining pending URLs by origin for the next grant', async () => {
    const mock = chromeMock()
    await rememberPendingScans(
      mock.api,
      [PAGE, OTHER_PAGE, `${OTHER_ORIGIN}/t/topic/2`],
      1_000
    )
    expect(await pendingScanGroups(mock.api, 2_000)).toEqual([
      { origin: ORIGIN, urls: [PAGE] },
      { origin: OTHER_ORIGIN, urls: [OTHER_PAGE, `${OTHER_ORIGIN}/t/topic/2`] }
    ])
    // Reading the groups never consumes them.
    expect(await pendingScanGroups(mock.api, 2_000)).toHaveLength(2)
  })

  it('reads the legacy single-entry shape', async () => {
    const mock = chromeMock()
    mock.session.data[PENDING_SCAN_KEY] = { url: PAGE, at: 1_000 }
    expect(await takePendingScan(mock.api, ORIGIN, 2_000)).toBe(PAGE)
    expect(await takePendingScan(mock.api, ORIGIN, 2_000)).toBeNull()
  })
})
