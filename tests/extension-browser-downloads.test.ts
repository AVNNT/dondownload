import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_DOWNLOAD_HOST_ORIGINS,
  browserDownloadPermissions,
  browserDownloadPermissionsGranted,
  browserDownloadStateCopy,
  disableBrowserDownloadTakeover,
  enableBrowserDownloadTakeover
} from '../extension/browser-downloads.js'
import { readCaptureSettings } from '../extension/capture-settings.js'

afterEach(() => {
  delete (globalThis as any).chrome
})

interface FakeOptions {
  grant?: boolean
  granted?: string[]
  runtimeError?: string
}

function createFake(options: FakeOptions = {}) {
  const permissionRequests: Array<Record<string, unknown>> = []
  const messages: unknown[] = []
  const local = new Map<string, unknown>()
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

function run(chrome: any): Promise<{ ok: boolean; error?: string; listener?: boolean }> {
  return new Promise((resolve) => {
    enableBrowserDownloadTakeover(chrome, resolve)
  })
}

describe('popup browser download takeover switch', () => {
  it('requests downloads, cookies, webRequest and the host permission in one call', async () => {
    const fake = createFake()
    expect(browserDownloadPermissions(fake.chrome)).toEqual({
      permissions: ['downloads', 'cookies', 'webRequest'],
      origins: [...BROWSER_DOWNLOAD_HOST_ORIGINS]
    })

    const result = await run(fake.chrome)
    expect(result).toMatchObject({ ok: true, overlay: true, injected: 1 })
    expect(fake.permissionRequests).toEqual([
      {
        permissions: ['downloads', 'cookies', 'webRequest'],
        origins: ['http://*/*', 'https://*/*']
      }
    ])
    // The user gesture request happens synchronously, before any await.
    expect(fake.permissionRequests).toHaveLength(1)

    const settings = await readCaptureSettings(fake.chrome)
    // One switch turns on takeover AND the all-sites overlay.
    expect(settings.automaticFileHandoff).toBe(true)
    expect(settings.detectAllSites).toBe(true)
    expect(settings.mediaSniffing).toBe(true)
    expect(settings.floatingTriggerEnabled).toBe(true)
    // The service worker is told to install the downloads listener and to
    // register + inject the all-sites overlay right away.
    expect(fake.messages).toEqual([
      { type: 'dondownload:downloads-support' },
      { type: 'dondownload:overlay-all-sites' }
    ])
    expect(result.listener).toBe(true)
  })

  it('leaves the setting off when the user denies the prompt', async () => {
    const fake = createFake({ grant: false })
    const result = await run(fake.chrome)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not granted/i)
    const settings = await readCaptureSettings(fake.chrome)
    expect(settings.automaticFileHandoff).toBe(false)
    expect(fake.messages).toEqual([])
  })

  it('reports a runtime error without saving anything', async () => {
    const fake = createFake({ runtimeError: 'permission denied' })
    const result = await run(fake.chrome)
    expect(result.ok).toBe(false)
    expect(fake.local.size).toBe(0)
  })

  it('turns off without removing the granted permissions', async () => {
    const fake = createFake({
      granted: ['downloads', 'cookies', 'webRequest', 'http://*/*', 'https://*/*']
    })
    await run(fake.chrome)
    expect(await browserDownloadPermissionsGranted(fake.chrome)).toBe(true)

    fake.messages.length = 0
    expect(await disableBrowserDownloadTakeover(fake.chrome)).toBe(true)
    const settings = await readCaptureSettings(fake.chrome)
    expect(settings.automaticFileHandoff).toBe(false)
    expect(settings.detectAllSites).toBe(false)
    // Per-site overlay enables and the granted permissions stay.
    expect(settings.floatingTriggerEnabled).toBe(true)
    expect(fake.granted.has('downloads')).toBe(true)
    expect(fake.granted.has('cookies')).toBe(true)
    expect(fake.granted.has('webRequest')).toBe(true)
    expect(fake.granted.has('http://*/*')).toBe(true)
    // The worker reconciles: the broad overlay registration is removed.
    expect(fake.messages).toEqual([{ type: 'dondownload:overlay-all-sites' }])
  })

  it('reports the current state for the popup', () => {
    expect(browserDownloadStateCopy({ enabled: false, minBytes: 1_000_000 })).toMatchObject({
      enabled: false,
      state: 'Off'
    })
    const on = browserDownloadStateCopy({ enabled: true, minBytes: 10_000_000 })
    expect(on.enabled).toBe(true)
    expect(on.state).toBe('On')
    expect(on.hint).toContain('10 MB')
    expect(on.hint).toContain('every site')
  })
})
