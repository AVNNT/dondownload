import { describe, expect, it } from 'vitest'
import {
  OVERLAY_PENDING_STORAGE_KEY,
  OVERLAY_PENDING_TTL_MS,
  clearPendingEnable,
  describeOverlayStatus,
  disableOverlayForOrigin,
  enableOverlayForTab,
  handleOverlayReady,
  handlePermissionsAdded,
  handlePermissionsRemoved,
  overlayRemovalConfirmed,
  readPendingEnable,
  rememberPendingEnable,
  syncOverlayForTab
} from '../extension/overlay-controller'
import {
  originToMatchPattern,
  overlayRegistrationForOrigin
} from '../extension/site-policy'

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
  verified?: boolean
  registrationSticks?: boolean
  unregisterFails?: boolean
  permissionRemoveFails?: boolean
  sendMessageFailsFor?: number[]
  /** Required manifest host patterns, as the real manifest now declares them. */
  hostPermissions?: string[]
}

interface FakeChrome {
  state: {
    granted: Set<string>
    tabs: Map<number, FakeTab>
    registrations: Map<string, Registration>
    session: Record<string, unknown>
    local: Map<string, unknown>
    registerCalls: Registration[][]
    updateCalls: Registration[][]
    unregisterCalls: string[]
    fileInjections: unknown[]
    funcInjections: unknown[]
    sentMessages: Array<{ tabId: number; message: unknown }>
    removedPermissions: string[]
  }
  api: Record<string, any>
}

function createFakeChrome(options: FakeOptions = {}): FakeChrome {
  const state: FakeChrome['state'] = {
    granted: new Set(options.granted ?? []),
    tabs: new Map((options.tabs ?? [{ id: 7, url: 'http://127.0.0.1:34526/' }]).map((tab) => [tab.id, tab])),
    registrations: new Map(),
    session: {},
    local: new Map(),
    registerCalls: [],
    updateCalls: [],
    unregisterCalls: [],
    fileInjections: [],
    funcInjections: [],
    sentMessages: [],
    removedPermissions: []
  }

  const verified = options.verified !== false
  const registrationSticks = options.registrationSticks !== false

  // Required manifest host patterns behave like Chrome: they cover narrower
  // origins, so `contains` is true and `remove` refuses.
  const requiredHosts = options.hostPermissions ?? []
  const covers = (pattern: string, origin: string) => {
    if (pattern === origin) return true
    const scheme = pattern.slice(0, pattern.indexOf('://'))
    return pattern === `${scheme}://*/*` && origin.startsWith(`${scheme}://`)
  }
  const grantedOrigin = (origin: string) =>
    [...state.granted].some((pattern) => covers(pattern, origin)) ||
    requiredHosts.some((pattern) => covers(pattern, origin))
  const requiredOrigin = (origin: string) =>
    requiredHosts.some((pattern) => covers(pattern, origin))

  const api = {
    permissions: {
      async contains({ origins }: { origins: string[] }) {
        return origins.every((origin) => grantedOrigin(origin))
      },
      async remove({ origins }: { origins: string[] }) {
        let removed = false
        for (const origin of origins) {
          state.removedPermissions.push(origin)
          if (options.permissionRemoveFails) continue
          // A required host permission cannot be revoked.
          if (requiredOrigin(origin)) continue
          removed = state.granted.delete(origin) || removed
        }
        return removed
      }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }: { ids?: string[] } = {}) {
        const all = [...state.registrations.values()]
        if (!ids) return all
        return all.filter((registration) => ids.includes(registration.id))
      },
      async registerContentScripts(registrations: Registration[]) {
        state.registerCalls.push(registrations)
        if (!registrationSticks) return
        for (const registration of registrations) {
          state.registrations.set(registration.id, { ...registration })
        }
      },
      async updateContentScripts(registrations: Registration[]) {
        state.updateCalls.push(registrations)
        if (!registrationSticks) return
        for (const registration of registrations) {
          state.registrations.set(registration.id, { ...registration })
        }
      },
      async unregisterContentScripts({ ids }: { ids: string[] }) {
        state.unregisterCalls.push(...ids)
        if (options.unregisterFails) throw new Error('unregister failed')
        let removed = false
        for (const id of ids) removed = state.registrations.delete(id) || removed
        if (!removed) throw new Error('No content script with the given id')
      },
      async executeScript(injection: any) {
        if (Array.isArray(injection.files)) {
          state.fileInjections.push(injection)
          return [{ result: undefined }]
        }
        state.funcInjections.push(injection)
        return [{ result: verified }]
      }
    },
    tabs: {
      async get(tabId: number) {
        const tab = state.tabs.get(tabId)
        if (!tab) throw new Error('No tab')
        return { ...tab }
      },
      async query({ url }: { url?: string }) {
        const base = typeof url === 'string' ? url.replace(/\*$/, '') : ''
        return [...state.tabs.values()].filter((tab) => tab.url.startsWith(base))
      },
      async sendMessage(tabId: number, message: unknown) {
        state.sentMessages.push({ tabId, message })
        if ((options.sendMessageFailsFor ?? []).includes(tabId)) {
          throw new Error('Could not establish connection')
        }
        return { ok: true }
      }
    },
    runtime: {
      getManifest() {
        return { host_permissions: options.hostPermissions ?? [] }
      }
    },
    storage: {
      session: {
        async get(key: string) {
          return { [key]: state.session[key] }
        },
        async set(values: Record<string, unknown>) {
          Object.assign(state.session, values)
        },
        async remove(key: string) {
          delete state.session[key]
        }
      },
      local: {
        async get(key: string) {
          return state.local.has(key) ? { [key]: state.local.get(key) } : {}
        },
        async set(values: Record<string, unknown>) {
          for (const [name, value] of Object.entries(values)) {
            state.local.set(name, value)
          }
        }
      }
    }
  }

  return { state, api }
}

const ORIGIN = 'http://127.0.0.1:34526'
const PATTERN = originToMatchPattern(ORIGIN) as string

describe('overlay enable lifecycle', () => {
  it('refuses to register or inject without the exact origin grant', async () => {
    const fake = createFakeChrome({ granted: [] })
    const result = await enableOverlayForTab(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('PERMISSION_REQUIRED')
    expect(fake.state.registerCalls).toHaveLength(0)
    expect(fake.state.fileInjections).toHaveLength(0)
    expect(fake.state.registrations.size).toBe(0)
  })

  it('keeps a non-default localhost port in the persistent registration', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    const result = await enableOverlayForTab(fake.api, ORIGIN, 7)

    expect(result).toMatchObject({
      ok: true,
      granted: true,
      registered: true,
      injected: true
    })

    const expected = overlayRegistrationForOrigin(ORIGIN)
    const stored = [...fake.state.registrations.values()][0]
    expect(stored).toBeDefined()
    expect(stored?.matches).toEqual(['http://127.0.0.1:34526/*'])
    expect(stored?.js).toEqual(expected?.js)
    expect(stored?.persistAcrossSessions).toBe(true)
    expect(stored?.allFrames).toBe(false)
    expect(stored?.world).toBe('ISOLATED')
    expect(fake.state.fileInjections).toHaveLength(1)
    expect(fake.state.funcInjections).toHaveLength(1)
  })

  it('does not claim success when the page-side verification fails', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], verified: false })
    const result = await enableOverlayForTab(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(true)
    expect(result.granted).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.injected).toBe(false)
    expect(result.reason).toBe('INJECTION_NOT_VERIFIED')

    const status = describeOverlayStatus({
      available: true,
      granted: true,
      ready: result.injected === true,
      site: '127.0.0.1:34526'
    })
    expect(status.state).toBe('attention')
    expect(status.label).toBe('Not ready')
    expect(status.hint).not.toContain('Overlay is on for')
  })

  it('fails visibly when the registration does not persist', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], registrationSticks: false })
    const result = await enableOverlayForTab(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('REGISTRATION_FAILED')
    expect(result.granted).toBe(true)
    expect(fake.state.fileInjections).toHaveLength(0)
  })

  it('still saves the registration when the tab navigated away', async () => {
    const fake = createFakeChrome({
      granted: [PATTERN],
      tabs: [{ id: 7, url: 'https://example.com/' }]
    })

    const result = await enableOverlayForTab(fake.api, ORIGIN, 7)
    expect(result.ok).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.injected).toBe(false)
    expect(result.reason).toBe('ORIGIN_MISMATCH')
    expect(fake.state.fileInjections).toHaveLength(0)
    expect(fake.state.registrations.size).toBe(1)
  })

  it('syncs an existing grant when the popup reopens', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    const result = await syncOverlayForTab(fake.api, ORIGIN, 7)
    expect(result).toMatchObject({ ok: true, granted: true, registered: true, injected: true })
  })

  it('does not inject anything when syncing a site without a grant', async () => {
    const fake = createFakeChrome({ granted: [] })
    const result = await syncOverlayForTab(fake.api, ORIGIN, 7)

    expect(result).toMatchObject({ ok: true, granted: false, registered: false, injected: false })
    expect(fake.state.registerCalls).toHaveLength(0)
    expect(fake.state.fileInjections).toHaveLength(0)
  })
})

describe('permission prompt closing the action popup', () => {
  it('finishes registration and injection from the pending request after the grant', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    const remembered = await rememberPendingEnable(fake.api, ORIGIN, 7)
    expect(remembered).toBe(true)

    const result = await handlePermissionsAdded(fake.api, { origins: [PATTERN] })

    expect(result).toMatchObject({
      ok: true,
      granted: true,
      registered: true,
      injected: true
    })
    expect(fake.state.registrations.size).toBe(1)
    expect(fake.state.fileInjections).toHaveLength(1)
    expect(await readPendingEnable(fake.api)).toBeNull()
  })

  it('ignores an unrelated permission grant and keeps the pending request', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    await rememberPendingEnable(fake.api, ORIGIN, 7)

    const result = await handlePermissionsAdded(fake.api, {
      origins: ['https://unrelated.example/*']
    })

    expect(result).toBeNull()
    expect(fake.state.registrations.size).toBe(0)
    expect(await readPendingEnable(fake.api)).not.toBeNull()
  })

  it('expires a stale pending request instead of reviving an old grant', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    await rememberPendingEnable(fake.api, ORIGIN, 7)
    const stored = fake.state.session[OVERLAY_PENDING_STORAGE_KEY] as { createdAt: number }
    stored.createdAt = Date.now() - OVERLAY_PENDING_TTL_MS - 1

    expect(await readPendingEnable(fake.api)).toBeNull()
    expect(fake.state.session[OVERLAY_PENDING_STORAGE_KEY]).toBeUndefined()
    expect(fake.state.registrations.size).toBe(0)
  })

  it('clears pending state on demand', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    await rememberPendingEnable(fake.api, ORIGIN, 7)
    expect(await clearPendingEnable(fake.api)).toBe(true)
    expect(fake.state.session[OVERLAY_PENDING_STORAGE_KEY]).toBeUndefined()
  })
})

describe('overlay disable and external revoke', () => {
  it('removes the registration, the grant and the in-page overlay', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    await enableOverlayForTab(fake.api, ORIGIN, 7)

    const result = await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    expect(result).toMatchObject({
      ok: true,
      granted: false,
      registered: false,
      registrationRemoved: true,
      permissionRemoved: true,
      notifiedTabs: 1,
      failedNotifications: 0
    })
    expect(overlayRemovalConfirmed(result)).toBe(true)
    expect(fake.state.registrations.size).toBe(0)
    expect(fake.state.granted.size).toBe(0)
    expect(fake.state.sentMessages).toContainEqual({
      tabId: 7,
      message: { type: 'dondownload:overlay-disabled', origin: ORIGIN }
    })
  })

  it('does not claim success when unregistering the registration fails', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], unregisterFails: true })
    await enableOverlayForTab(fake.api, ORIGIN, 7)

    const result = await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('OVERLAY_DISABLE_INCOMPLETE')
    expect(result.registrationRemoved).toBe(false)
    expect(result.permissionRemoved).toBe(true)
    expect(result.registered).toBe(true)
    expect(result.granted).toBe(false)
    expect(overlayRemovalConfirmed(result)).toBe(false)
    expect(fake.state.registrations.size).toBe(1)
    expect(fake.state.granted.size).toBe(0)
  })

  it('does not claim success when the permission removal fails', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], permissionRemoveFails: true })
    await enableOverlayForTab(fake.api, ORIGIN, 7)

    const result = await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('OVERLAY_DISABLE_INCOMPLETE')
    expect(result.registrationRemoved).toBe(true)
    expect(result.permissionRemoved).toBe(false)
    expect(result.registered).toBe(false)
    expect(result.granted).toBe(true)
    expect(overlayRemovalConfirmed(result)).toBe(false)
    expect(fake.state.registrations.size).toBe(0)
    expect(fake.state.granted.size).toBe(1)
  })

  it('remains successful when a concurrent onRemoved listener already removed the state', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })
    await enableOverlayForTab(fake.api, ORIGIN, 7)

    // Simulate the background listener finishing first: unregister now throws,
    // and permissions.remove reports false because the grant is already gone.
    fake.state.registrations.clear()
    fake.state.granted.delete(PATTERN)

    const result = await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(true)
    expect(result.registrationRemoved).toBe(true)
    expect(result.permissionRemoved).toBe(true)
    expect(overlayRemovalConfirmed(result)).toBe(true)
  })

  it('keeps verified removal successful even when best-effort tab notification fails', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], sendMessageFailsFor: [7] })
    await enableOverlayForTab(fake.api, ORIGIN, 7)

    const result = await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    expect(result.ok).toBe(true)
    expect(overlayRemovalConfirmed(result)).toBe(true)
    expect(result.notifiedTabs).toBe(0)
    expect(result.failedNotifications).toBe(1)
  })

  it('drops the registration and notifies tracked same-origin tabs on external revoke', async () => {
    const otherOrigin = 'https://example.com'
    const otherPattern = originToMatchPattern(otherOrigin) as string
    const fake = createFakeChrome({
      granted: [PATTERN, otherPattern],
      tabs: [
        { id: 7, url: `${ORIGIN}/one` },
        { id: 8, url: `${ORIGIN}/two` },
        { id: 9, url: `${otherOrigin}/other` }
      ]
    })
    await enableOverlayForTab(fake.api, ORIGIN, 7)
    await enableOverlayForTab(fake.api, ORIGIN, 8)
    await enableOverlayForTab(fake.api, otherOrigin, 9)

    // The grant is already gone when permissions.onRemoved fires.
    fake.state.granted.delete(PATTERN)
    fake.state.sentMessages.length = 0

    const removed = await handlePermissionsRemoved(fake.api, { origins: [PATTERN] })

    expect(removed).toEqual([ORIGIN])
    expect(fake.state.sentMessages).toEqual([
      {
        tabId: 7,
        message: { type: 'dondownload:overlay-disabled', origin: ORIGIN }
      },
      {
        tabId: 8,
        message: { type: 'dondownload:overlay-disabled', origin: ORIGIN }
      }
    ])
    expect(fake.state.registrations.size).toBe(1)
    const remaining = [...fake.state.registrations.values()][0]
    expect(remaining?.matches).toEqual([otherPattern])
  })

  it('tracks a tab that announces itself after a reload and tears it down on revoke', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })

    const tracked = await handleOverlayReady(
      fake.api,
      { type: 'dondownload:overlay-ready', origin: ORIGIN },
      { tab: { id: 12, url: `${ORIGIN}/page` }, frameId: 0 }
    )
    expect(tracked).toBe(true)

    fake.state.granted.delete(PATTERN)
    await handlePermissionsRemoved(fake.api, { origins: [PATTERN] })

    expect(fake.state.sentMessages).toContainEqual({
      tabId: 12,
      message: { type: 'dondownload:overlay-disabled', origin: ORIGIN }
    })
  })

  it('tears down a late-ready content script whose grant was already revoked', async () => {
    const fake = createFakeChrome({ granted: [] })

    const tracked = await handleOverlayReady(
      fake.api,
      { type: 'dondownload:overlay-ready', origin: ORIGIN },
      { tab: { id: 13, url: `${ORIGIN}/page` }, frameId: 0 }
    )

    expect(tracked).toBe(false)
    expect(fake.state.sentMessages).toContainEqual({
      tabId: 13,
      message: { type: 'dondownload:overlay-disabled', origin: ORIGIN }
    })
  })

  it('rejects a ready announcement from a tab on a different origin', async () => {
    const fake = createFakeChrome({ granted: [PATTERN] })

    const tracked = await handleOverlayReady(
      fake.api,
      { type: 'dondownload:overlay-ready', origin: ORIGIN },
      { tab: { id: 14, url: 'https://example.com/page' }, frameId: 0 }
    )

    expect(tracked).toBe(false)
    expect(fake.state.sentMessages).toEqual([])
    expect(fake.state.session.dondownloadOverlayTabs).toBeUndefined()
  })
})

describe('popup overlay status copy', () => {
  it('reports Off for a site without a grant', () => {
    const status = describeOverlayStatus({ available: true, granted: false, ready: false, site: 'example.com' })
    expect(status.state).toBe('off')
    expect(status.label).toBe('Off')
    expect(status.hint).not.toContain('Overlay is on for')
    expect(status.hint).toContain('Analyze')
    expect(status.hint).toContain('verified options')
    expect(status.hint).toContain('reported file sizes')
    expect(status.hint).toContain('only when you pick one')
    expect(status.hint).toContain('exact origin')
    expect(status.hint).not.toMatch(/does not download|no download|no format|milestone/i)
  })

  it('reports On only when the registration and the page overlay are both verified', () => {
    const status = describeOverlayStatus({
      available: true,
      granted: true,
      ready: true,
      site: 'example.com',
      // The browser shortcut is user-configurable, so the caller supplies the
      // value that is actually configured for this profile.
      shortcut: 'Alt+Shift+D'
    })
    expect(status.state).toBe('on')
    expect(status.label).toBe('On')
    expect(status.hint).toContain('Overlay is on for example.com')
    expect(status.hint).toContain('Alt+Shift+D')
    expect(status.hint).toContain('Analyze')
    expect(status.hint).toContain('verified options')
    expect(status.hint).toContain('reported file sizes')
    expect(status.hint).toContain('only when you pick one')
    expect(status.hint).toContain('exact origin')
    expect(status.hint).not.toMatch(/does not download|no download|no format|milestone/i)
  })

  it('points at the browser shortcut settings when none is configured', () => {
    const status = describeOverlayStatus({ available: true, granted: true, ready: true, site: 'example.com' })
    expect(status.state).toBe('on')
    expect(status.hint).toContain('chrome://extensions/shortcuts')
    expect(status.hint).not.toContain('Alt+Shift+D')
  })

  it('never turns a bare permission grant into success', () => {
    const status = describeOverlayStatus({ available: true, granted: true, ready: false, site: 'example.com' })
    expect(status.state).toBe('attention')
    expect(status.tone).toBe('error')
    expect(status.hint).toContain('Reload the page')
    expect(status.hint).not.toContain('Overlay is on for')
    expect(status.hint).not.toContain('Hover a video')
  })

  it('reports unsupported pages as unavailable and unchanged', () => {
    const status = describeOverlayStatus({ available: false, granted: false, ready: false })
    expect(status.state).toBe('unavailable')
    expect(status.hint).toContain('This page was not changed')
  })
})

describe('per-site off with the always-on broad grant', () => {
  const BROAD = ['http://*/*', 'https://*/*']

  function excludedOrigins(fake: FakeChrome) {
    const stored = fake.state.local.get('dondownloadCaptureSettings') as
      | { excludedOrigins?: string[] }
      | undefined
    return stored?.excludedOrigins ?? []
  }

  it('turns one site off by excluding it, because the broad grant cannot be revoked', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], hostPermissions: BROAD })
    await enableOverlayForTab(fake.api, ORIGIN, 7)

    const result = await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    expect(result).toMatchObject({
      ok: true,
      granted: false,
      registrationRemoved: true,
      permissionRemoved: true,
      excluded: true
    })
    expect(overlayRemovalConfirmed(result)).toBe(true)
    expect(excludedOrigins(fake)).toEqual([ORIGIN])
    // The broad grant itself is untouched.
    expect(fake.state.granted.has(PATTERN)).toBe(true)
  })

  it('keeps the site off when the popup re-syncs it', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], hostPermissions: BROAD })
    await disableOverlayForOrigin(fake.api, ORIGIN, 7)

    const synced = await syncOverlayForTab(fake.api, ORIGIN, 7)

    expect(synced).toMatchObject({
      ok: true,
      granted: false,
      registered: false,
      injected: false,
      reason: 'EXCLUDED'
    })
    expect(fake.state.fileInjections).toHaveLength(0)
  })

  it('lifts the exclusion on an explicit enable', async () => {
    const fake = createFakeChrome({ granted: [PATTERN], hostPermissions: BROAD })
    await disableOverlayForOrigin(fake.api, ORIGIN, 7)
    expect(excludedOrigins(fake)).toEqual([ORIGIN])

    const enabled = await enableOverlayForTab(fake.api, ORIGIN, 7)

    expect(enabled).toMatchObject({ ok: true, granted: true, registered: true })
    expect(excludedOrigins(fake)).toEqual([])
  })
})
