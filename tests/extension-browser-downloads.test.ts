import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  browserDownloadPermissions,
  browserDownloadStateCopy,
  ensureAllSitesActive,
  requestBrowserDownloadAccess
} from '../extension/browser-downloads.js'
import {
  DEFAULT_CAPTURE_SETTINGS,
  readCaptureSettings,
  writeCaptureSettings
} from '../extension/capture-settings.js'

afterEach(() => {
  delete (globalThis as any).chrome
})

interface FakeOptions {
  grant?: boolean
  granted?: string[]
  runtimeError?: string
  stored?: Record<string, unknown>
}

function createFake(options: FakeOptions = {}) {
  const permissionRequests: Array<Record<string, unknown>> = []
  const messages: unknown[] = []
  const local = new Map<string, unknown>()
  if (options.stored) local.set('dondownloadCaptureSettings', options.stored)
  const granted = new Set(options.granted ?? [])
  const chrome: any = {
    runtime: {
      lastError: undefined,
      getManifest() {
        return { optional_permissions: ['downloads', 'webRequest', 'cookies'] }
      },
      sendMessage(message: any, callback: (value: unknown) => void) {
        messages.push(message)
        if (message && message.type === 'dondownload:overlay-all-sites') {
          callback({ ok: true, registered: true, injected: [7] })
          return
        }
        callback({ ok: true, listener: true })
      }
    },
    permissions: {
      request(details: Record<string, unknown>, callback: (value: boolean) => void) {
        permissionRequests.push(details)
        if (options.runtimeError) {
          chrome.runtime.lastError = { message: options.runtimeError }
          callback(false)
          chrome.runtime.lastError = undefined
          return
        }
        const allowed = options.grant !== false
        if (allowed) {
          for (const name of (details.permissions as string[]) ?? []) granted.add(name)
          for (const origin of (details.origins as string[]) ?? []) granted.add(origin)
        }
        callback(allowed)
      },
      async contains(details: {
        permissions?: string[]
        origins?: string[]
      }) {
        const all = [
          ...((details && details.permissions) ?? []),
          ...((details && details.origins) ?? [])
        ]
        return all.every((name) => granted.has(name))
      }
    },
    storage: {
      local: {
        async get(key: string) {
          return local.has(key) ? { [key]: local.get(key) } : {}
        },
        async set(value: Record<string, unknown>) {
          for (const [name, entry] of Object.entries(value)) local.set(name, entry)
        }
      }
    }
  }
  ;(globalThis as any).chrome = chrome
  return { chrome, permissionRequests, messages, local, granted }
}

function request(chrome: any): Promise<{ ok: boolean; error?: string; listener?: boolean }> {
  return new Promise((resolve) => {
    requestBrowserDownloadAccess(chrome, resolve)
  })
}

describe('always-on DonDownload switch', () => {
  it('defaults the switch to on and ignores a stored off value', async () => {
    expect(DEFAULT_CAPTURE_SETTINGS.automaticFileHandoff).toBe(true)
    expect(DEFAULT_CAPTURE_SETTINGS.detectAllSites).toBe(true)

    const fake = createFake({
      stored: { automaticFileHandoff: false, detectAllSites: false }
    })
    const settings = await readCaptureSettings(fake.chrome)
    expect(settings.automaticFileHandoff).toBe(true)
    expect(settings.detectAllSites).toBe(true)
  })

  it('migrates a stored off value and re-registers on every wake', async () => {
    const fake = createFake({
      stored: { automaticFileHandoff: false, detectAllSites: false }
    })

    const result = await ensureAllSitesActive(fake.chrome)

    expect(result).toMatchObject({ ok: true, listener: true, overlay: true })
    const stored = fake.local.get('dondownloadCaptureSettings') as any
    expect(stored.automaticFileHandoff).toBe(true)
    expect(stored.detectAllSites).toBe(true)
    // The downloads listener and the all-sites registration are both re-asserted.
    expect(fake.messages).toEqual([
      { type: 'dondownload:downloads-support' },
      { type: 'dondownload:overlay-all-sites', injectOpenTabs: false }
    ])
  })

  it('does not rewrite settings that are already on', async () => {
    const fake = createFake({
      stored: { automaticFileHandoff: true, detectAllSites: true }
    })
    const before = fake.local.get('dondownloadCaptureSettings')

    await ensureAllSitesActive(fake.chrome)

    expect(fake.local.get('dondownloadCaptureSettings')).toBe(before)
  })

  it('reconciles in-process when the service worker passes a reconcile function', async () => {
    const fake = createFake()
    const calls: boolean[] = []

    const result = await ensureAllSitesActive(fake.chrome, {
      injectOpenTabs: true,
      reconcile: async () => {
        calls.push(true)
        return { overlay: true, injected: 3 }
      }
    })

    expect(calls).toEqual([true])
    expect(result).toMatchObject({ ok: true, overlay: true, injected: 3 })
    // No overlay message is sent when the worker reconciles itself; only the
    // downloads-support fast path remains.
    expect(fake.messages).toEqual([{ type: 'dondownload:downloads-support' }])
  })

  it('injects open tabs only when the lifecycle asks for it', async () => {
    const fake = createFake()

    const result = await ensureAllSitesActive(fake.chrome, { injectOpenTabs: true })

    expect(result.injected).toBe(1)
    expect(fake.messages).toContainEqual({
      type: 'dondownload:overlay-all-sites',
      injectOpenTabs: true
    })
  })

  it('requests only the optional hand-off permissions, never site access', async () => {
    const fake = createFake()
    expect(browserDownloadPermissions(fake.chrome)).toEqual({
      permissions: ['downloads', 'cookies', 'webRequest']
    })

    const result = await request(fake.chrome)

    expect(result).toMatchObject({ ok: true, overlay: true, injected: 1 })
    expect(fake.permissionRequests).toEqual([
      { permissions: ['downloads', 'cookies', 'webRequest'] }
    ])
    // The user gesture request happens synchronously, before any await.
    expect(fake.permissionRequests).toHaveLength(1)
    expect(fake.messages).toEqual([
      { type: 'dondownload:downloads-support' },
      { type: 'dondownload:overlay-all-sites', injectOpenTabs: false }
    ])
    expect(result.listener).toBe(true)
    // The switch stays on whether or not the optional grant is accepted.
    const settings = await readCaptureSettings(fake.chrome)
    expect(settings.automaticFileHandoff).toBe(true)
    expect(settings.detectAllSites).toBe(true)
  })

  it('leaves the switch on when the user denies the optional prompt', async () => {
    const fake = createFake({ grant: false })
    await writeCaptureSettings(fake.chrome, { handoffMinBytes: 10_000_000 })

    const result = await request(fake.chrome)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not granted/i)
    expect(fake.messages).toEqual([])
    const settings = await readCaptureSettings(fake.chrome)
    expect(settings.automaticFileHandoff).toBe(true)
    expect(settings.detectAllSites).toBe(true)
    expect(settings.handoffMinBytes).toBe(10_000_000)
  })

  it('reports a runtime error without saving anything', async () => {
    const fake = createFake({ runtimeError: 'permission denied' })
    const result = await request(fake.chrome)
    expect(result.ok).toBe(false)
    expect(fake.local.size).toBe(0)
  })

  it('always describes the switch as active on all sites', () => {
    const copy = browserDownloadStateCopy({ minBytes: 10_000_000 })
    expect(copy.enabled).toBe(true)
    expect(copy.state).toBe('Active on all sites')
    expect(copy.hint).toContain('10 MB')
    expect(copy.hint).toContain('every site')
    // There is no "off" copy left: the switch cannot be turned off.
    expect(browserDownloadStateCopy({ enabled: false }).state).toBe(
      'Active on all sites'
    )
  })
})

describe('service worker wiring', () => {
  const background = readFileSync(
    path.join(process.cwd(), 'extension', 'background.js'),
    'utf8'
  )

  it('re-asserts the always-on all-sites mode on install, startup and every wake', () => {
    // Install and startup go through the lifecycle listeners with the open-tab
    // injection, and the module body covers every service-worker wake.
    expect(background).toContain('void ensureAllSitesMode(true).catch(() => undefined)')
    expect(background).toContain('void ensureAllSitesMode(false).catch(() => undefined)')
    expect(background).toContain('chrome.runtime.onInstalled.addListener(installLifecycleListeners)')
    expect(background).toContain('chrome.runtime.onStartup.addListener(installLifecycleListeners)')
    // The worker reconciles in-process instead of messaging itself.
    expect(background).toContain('await reconcileOverlayMode(chrome, { injectOpenTabs })')
  })

  it('honours the injectOpenTabs flag of the overlay registration message', () => {
    expect(background).toContain("message.type === 'dondownload:overlay-all-sites'")
    expect(background).toContain('injectOpenTabs: message.injectOpenTabs === true')
  })
})
