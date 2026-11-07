import { afterEach, describe, expect, it } from 'vitest'
import {
  allSitesHostsGranted,
  allSitesOverlayWantedFromSettings,
  handlePermissionsRemoved,
  injectAllSitesIntoOpenTabs,
  reconcileOverlayMode
} from '../extension/overlay-controller'
import {
  OVERLAY_ALL_SITES_ID,
  overlayAllSitesRegistration,
  overlayRegistrationForOrigin
} from '../extension/site-policy'
import { writeCaptureSettings } from '../extension/capture-settings'

afterEach(() => {
  delete (globalThis as any).chrome
})

interface Registration {
  id: string
  matches: string[]
  js: string[]
  runAt?: string
  allFrames?: boolean
  persistAcrossSessions?: boolean
  world?: string
}

interface FakeTab {
  id: number
  url: string
}

interface FakeOptions {
  granted?: string[]
  tabs?: FakeTab[]
  /** When true the probe reports an overlay already present in every tab. */
  overlayPresent?: boolean
}

function urlMatchesPattern(url: string, pattern: string) {
  // Good enough for the broad patterns used here ('http://*/*').
  const wildcard = pattern.indexOf('*')
  const base = wildcard === -1 ? pattern : pattern.slice(0, wildcard)
  return url.startsWith(base)
}

function createFake(options: FakeOptions = {}) {
  const granted = new Set(options.granted ?? [])
  const tabs = new Map<number, FakeTab>()
  for (const tab of options.tabs ?? []) tabs.set(tab.id, { ...tab })
  const registrations = new Map<string, Registration>()
  const session: Record<string, unknown> = {}
  const local = new Map<string, unknown>()
  const fileInjections: unknown[] = []
  const funcInjections: unknown[] = []
  const registerCalls: Registration[][] = []
  const unregisterCalls: string[] = []

  const chrome: any = {
    permissions: {
      async contains(details: { permissions?: string[]; origins?: string[] }) {
        const names = [...((details && details.permissions) ?? []), ...((details && details.origins) ?? [])]
        return names.every((name) => granted.has(name))
      },
      async remove(details: { origins?: string[] }) {
        for (const origin of details.origins ?? []) granted.delete(origin)
      }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }: { ids?: string[] } = {}) {
        const all = [...registrations.values()]
        if (!ids) return all
        return all.filter((registration) => ids.includes(registration.id))
      },
      async registerContentScripts(list: Registration[]) {
        registerCalls.push(list)
        for (const registration of list) registrations.set(registration.id, { ...registration })
      },
      async updateContentScripts(list: Registration[]) {
        for (const registration of list) registrations.set(registration.id, { ...registration })
      },
      async unregisterContentScripts({ ids }: { ids: string[] }) {
        let removed = false
        for (const id of ids) removed = registrations.delete(id) || removed
        if (!removed) throw new Error('No content script with the given id')
        unregisterCalls.push(...ids)
      },
      async executeScript(injection: any) {
        if (Array.isArray(injection.files)) {
          fileInjections.push(injection)
          return [{ result: undefined }]
        }
        funcInjections.push(injection)
        return [{ result: options.overlayPresent === true }]
      }
    },
    tabs: {
      async query({ url }: { url?: string[] }) {
        const patterns = Array.isArray(url) ? url : url ? [url] : []
        return [...tabs.values()].filter((tab) =>
          patterns.some((pattern) => urlMatchesPattern(tab.url, pattern))
        )
      }
    },
    storage: {
      local: {
        async get(key: string) {
          return local.has(key) ? { [key]: local.get(key) } : {}
        },
        async set(values: Record<string, unknown>) {
          for (const [name, value] of Object.entries(values)) local.set(name, value)
        }
      },
      session: {
        async get(key: string) {
          return { [key]: session[key] }
        },
        async set(values: Record<string, unknown>) {
          Object.assign(session, values)
        },
        async remove(key: string) {
          delete session[key]
        }
      }
    }
  }
  ;(globalThis as any).chrome = chrome
  return { chrome, granted, tabs, registrations, session, local, fileInjections, funcInjections, registerCalls, unregisterCalls }
}

function allSitesOn(fake: ReturnType<typeof createFake>) {
  return writeCaptureSettings(fake.chrome, {
    detectAllSites: true,
    floatingTriggerEnabled: true
  })
}

const YT = { id: 1, url: 'https://www.youtube.com/watch?v=abc' }
const TWITCH = { id: 2, url: 'https://www.twitch.tv/videos/123' }

describe('all-sites overlay registration', () => {
  it('is on by default and only needs the broad host grant', async () => {
    const fake = createFake()
    expect(await allSitesHostsGranted(fake.chrome)).toBe(false)
    // The switch is always on, so the default settings already want it.
    expect(await allSitesOverlayWantedFromSettings(fake.chrome)).toBe(false)

    fake.granted.add('http://*/*')
    fake.granted.add('https://*/*')
    expect(await allSitesOverlayWantedFromSettings(fake.chrome)).toBe(true)

    // A stored "off" from an older version is ignored.
    await writeCaptureSettings(fake.chrome, { detectAllSites: false })
    expect(await allSitesOverlayWantedFromSettings(fake.chrome)).toBe(true)

    // The floating trigger stays a per-site overlay preference.
    await writeCaptureSettings(fake.chrome, { floatingTriggerEnabled: false })
    expect(await allSitesOverlayWantedFromSettings(fake.chrome)).toBe(false)
  })

  it('registers one broad registration, drops per-origin ones and injects open tabs', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT, TWITCH]
    })
    await allSitesOn(fake)
    // A leftover per-origin registration would inject the overlay twice.
    const perOrigin = overlayRegistrationForOrigin('http://example.com')!
    fake.registrations.set(perOrigin.id, perOrigin)

    const result = await reconcileOverlayMode(fake.chrome, { injectOpenTabs: true })

    expect(result).toMatchObject({ ok: true, mode: 'all-sites', registered: true })
    expect(result.injected.sort()).toEqual([YT.id, TWITCH.id])
    const stored = fake.registrations.get(OVERLAY_ALL_SITES_ID)
    expect(stored).toEqual(overlayAllSitesRegistration())
    // Every per-origin registration (one id per origin) was removed.
    expect(fake.unregisterCalls).toEqual([perOrigin.id])
    // Each tab got exactly one file injection, preceded by the presence probe.
    expect(fake.fileInjections).toHaveLength(2)
    expect(fake.funcInjections).toHaveLength(2)
  })

  it('injects an already-open tab only once: presence probe short-circuits', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT, TWITCH],
      overlayPresent: true
    })
    await allSitesOn(fake)

    const result = await reconcileOverlayMode(fake.chrome, { injectOpenTabs: true })

    expect(result.registered).toBe(true)
    // The registration is (re)written but no tab is touched again.
    expect(fake.fileInjections).toHaveLength(0)
    expect(result.injected).toEqual([])
  })

  it('skips excluded origins in the registration handles and the injection sweep', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT, TWITCH]
    })
    await writeCaptureSettings(fake.chrome, {
      detectAllSites: true,
      floatingTriggerEnabled: true,
      excludedOrigins: ['https://www.twitch.tv']
    })

    const result = await reconcileOverlayMode(fake.chrome, { injectOpenTabs: true })

    expect(result.injected).toEqual([YT.id])
    const injectedTabs = fake.fileInjections.map((injection: any) => injection.target.tabId)
    expect(injectedTabs).toEqual([YT.id])
  })

  it('keeps the broad registration on even when a stored detectAllSites is off', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT]
    })
    await allSitesOn(fake)
    await reconcileOverlayMode(fake.chrome)
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(true)

    await writeCaptureSettings(fake.chrome, {
      detectAllSites: false,
      floatingTriggerEnabled: true
    })
    const result = await reconcileOverlayMode(fake.chrome)

    expect(result.mode).toBe('all-sites')
    expect(result.registered).toBe(true)
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(true)
  })

  it('unregisters the broad registration when the floating trigger is off', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT]
    })
    await allSitesOn(fake)
    await reconcileOverlayMode(fake.chrome)
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(true)

    await writeCaptureSettings(fake.chrome, { floatingTriggerEnabled: false })
    const result = await reconcileOverlayMode(fake.chrome)

    expect(result.mode).toBe('per-origin')
    expect(result.registered).toBe(false)
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(false)
  })

  it('unregisters the broad registration when the broad permission is removed', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT]
    })
    await allSitesOn(fake)
    await reconcileOverlayMode(fake.chrome)
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(true)

    const removed = await handlePermissionsRemoved(fake.chrome, {
      origins: ['https://*/*']
    })

    expect(removed).toEqual([])
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(false)
  })

  it('registers on the default settings because the switch is always on', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT]
    })

    const result = await reconcileOverlayMode(fake.chrome, { injectOpenTabs: true })

    expect(result.mode).toBe('all-sites')
    expect(result.registered).toBe(true)
    expect(fake.registrations.has(OVERLAY_ALL_SITES_ID)).toBe(true)
    expect(result.injected).toEqual([YT.id])
  })

  it('does not register anything when the broad host grant is missing', async () => {
    const fake = createFake({ tabs: [YT] })

    const result = await reconcileOverlayMode(fake.chrome, { injectOpenTabs: true })

    expect(result.mode).toBe('per-origin')
    expect(result.registered).toBe(false)
    expect(fake.registrations.size).toBe(0)
    expect(fake.fileInjections).toHaveLength(0)
  })
})

describe('all-sites injection sweep', () => {
  it('reports failed tabs and skips non-http origins', async () => {
    const fake = createFake({
      granted: ['http://*/*', 'https://*/*'],
      tabs: [YT, { id: 9, url: 'chrome://settings/' }]
    })
    await allSitesOn(fake)
    // Make the injection into the YouTube tab fail.
    fake.chrome.scripting.executeScript = async (injection: any) => {
      if (Array.isArray(injection.files)) throw new Error('Cannot access tab')
      return [{ result: false }]
    }

    const result = await injectAllSitesIntoOpenTabs(fake.chrome)

    expect(result.ok).toBe(true)
    // The YouTube injection failed; the chrome:// tab never matches the
    // query (Chrome itself filters it out), so nothing was skipped.
    expect(result.failed).toEqual([YT.id])
    expect(result.skipped).toEqual([])
  })
})
