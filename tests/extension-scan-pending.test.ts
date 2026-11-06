import { describe, expect, it } from 'vitest'
import {
  PENDING_SCAN_KEY,
  PENDING_SCAN_TTL_MS,
  rememberPendingScan,
  scanCookiesReady,
  takePendingScan
} from '../extension/scan-pending.js'
import { CAPTURE_SETTINGS_KEY } from '../extension/capture-settings.js'

const ORIGIN = 'https://discuss.eroscripts.com'
const PAGE = `${ORIGIN}/t/fancam-mix/346779`

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

  it('never starts a scan for a different origin and clears the entry', async () => {
    const mock = chromeMock()
    await rememberPendingScan(mock.api, PAGE, 1_000)
    expect(await takePendingScan(mock.api, 'https://evil.example', 2_000)).toBeNull()
    expect(mock.session.data[PENDING_SCAN_KEY]).toBeUndefined()
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
    expect(Object.keys(mock.session.data[PENDING_SCAN_KEY] as object).sort()).toEqual(['at', 'url'])
  })
})
