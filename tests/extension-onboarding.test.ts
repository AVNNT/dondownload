import { afterEach, describe, expect, it } from 'vitest'
import {
  PROBE_MESSAGE_TYPE,
  NATIVE_HOST,
  probeNativeConnection
} from '../extension/bridge'
import {
  connectionView,
  popupConnectionLine,
  shouldOpenWelcome,
  siteEnableLabel,
  siteHostLabel
} from '../extension/onboarding'
import {
  enableAllSitesDetection,
  enableRecommendedCapture,
  recommendedCapturePermissions,
  requestExactOriginAccess,
  siteAccessGranted
} from '../extension/site-enable'
import {
  grantPageUrl,
  parseGrantParameter,
  readGrantParameter
} from '../extension/grant-parameter'

afterEach(() => {
  delete (globalThis as any).chrome
})

interface FakeNative {
  messages: Array<{ host: string; message: unknown }>
  response: unknown
  runtimeError: string | null
}

function installFakeNative(): FakeNative {
  const fake: FakeNative = { messages: [], response: null, runtimeError: null }
  const chrome: any = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(
        host: string,
        message: unknown,
        callback: (value: unknown) => void
      ) {
        fake.messages.push({ host, message })
        if (fake.runtimeError) {
          chrome.runtime.lastError = { message: fake.runtimeError }
        }
        callback(fake.response)
        chrome.runtime.lastError = undefined
      }
    }
  }
  ;(globalThis as any).chrome = chrome
  return fake
}

function installFakeChrome(options: { grant?: boolean } = {}): {
  chrome: any
  permissionRequests: any[]
  messages: any[]
  session: Record<string, unknown>
  local: Record<string, unknown>
} {
  const permissionRequests: any[] = []
  const messages: any[] = []
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}
  const chrome: any = {
    runtime: {
      lastError: undefined,
      getManifest() {
        return {
          optional_permissions: ['downloads', 'webRequest', 'cookies']
        }
      },
      sendMessage(message: any, callback: (value: unknown) => void) {
        messages.push(message)
        callback({ ok: true, granted: true, registered: true, injected: true })
      }
    },
    permissions: {
      request(details: any, callback: (granted: boolean) => void) {
        permissionRequests.push(details)
        callback(options.grant !== false)
      },
      async contains() {
        return options.grant !== false
      },
      remove() {}
    },
    storage: {
      session: {
        async get(key: string) {
          return key in session ? { [key]: session[key] } : {}
        },
        async set(value: Record<string, unknown>) {
          Object.assign(session, value)
        },
        async remove(key: string) {
          delete session[key]
        }
      },
      local: {
        async get(key: string) {
          return key in local ? { [key]: local[key] } : {}
        },
        async set(value: Record<string, unknown>) {
          Object.assign(local, value)
        }
      }
    }
  }
  ;(globalThis as any).chrome = chrome
  return { chrome, permissionRequests, messages, session, local }
}

describe('extension welcome onboarding', () => {
  it('opens only for a fresh install', () => {
    expect(shouldOpenWelcome({ reason: 'install' })).toBe(true)
    expect(shouldOpenWelcome({ reason: 'update' })).toBe(false)
    expect(shouldOpenWelcome(undefined)).toBe(false)
  })

  it('builds a prominent exact-host enable label', () => {
    expect(siteHostLabel('https://example.com/watch')).toBe('example.com')
    expect(siteHostLabel('http://127.0.0.1:34526/page')).toBe('127.0.0.1:34526')
    expect(siteHostLabel('chrome://extensions')).toBeNull()
    expect(siteEnableLabel('https://example.com/watch')).toBe(
      'Enable on example.com'
    )
    expect(siteEnableLabel('chrome://extensions')).toBe('Enable on this site')
  })

  it('reports a connected probe without fix steps', () => {
    const view = connectionView({ ok: true })
    expect(view.connected).toBe(true)
    expect(view.tone).toBe('on')
    expect(view.steps).toEqual([])
    expect(popupConnectionLine({ ok: true })).toContain('Connected')
  })

  it('gives ordered fix steps for a missing registration and a stopped app', () => {
    const missing = connectionView({
      ok: false,
      error: { code: 'NATIVE_HOST_NOT_REGISTERED', message: 'missing' }
    })
    expect(missing.connected).toBe(false)
    expect(missing.tone).toBe('error')
    expect(missing.steps[0]).toContain('Open DonDownload')
    expect(missing.steps.join(' ')).toContain('Repair browser connection')

    const stopped = connectionView({
      ok: false,
      error: { code: 'APP_UNAVAILABLE', message: 'stopped' }
    })
    expect(stopped.tone).toBe('off')
    expect(stopped.steps.join(' ')).toContain('tray icon')
    expect(popupConnectionLine({ ok: false, error: { code: 'APP_UNAVAILABLE' } }))
      .toContain('Open DonDownload')
  })

  it('sends the read-only probe envelope and validates the response', async () => {
    const fake = installFakeNative()
    fake.response = { ok: true, operation: PROBE_MESSAGE_TYPE }
    expect(await probeNativeConnection()).toEqual({ ok: true })
    expect(fake.messages).toEqual([
      { host: NATIVE_HOST, message: { type: PROBE_MESSAGE_TYPE } }
    ])

    fake.response = { ok: true, operation: 'queue-download' }
    const invalid = await probeNativeConnection()
    expect(invalid.ok).toBe(false)
    if (invalid.ok) throw new Error('expected failure')
    expect(invalid.error.code).toBe('NATIVE_RESPONSE_INVALID')

    fake.response = null
    fake.runtimeError = 'Specified native messaging host not found.'
    const missing = await probeNativeConnection()
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected failure')
    expect(missing.error.code).toBe('NATIVE_HOST_NOT_REGISTERED')
  })
})

describe('popup exact-site enable', () => {
  it('requests exactly the current origin and reuses the overlay message', async () => {
    const fake = installFakeChrome()
    const results: any[] = []
    requestExactOriginAccess(
      fake.chrome,
      { origin: 'https://example.com', tabId: 7 },
      (result) => results.push(result)
    )

    expect(fake.permissionRequests).toEqual([
      { origins: ['https://example.com/*'] }
    ])
    expect(fake.messages).toEqual([
      {
        type: 'dondownload:overlay-enable',
        origin: 'https://example.com',
        tabId: 7
      }
    ])
    expect(results[0]).toMatchObject({ ok: true })
    expect(typeof fake.session.dondownloadOverlayPendingEnable).toBe('object')
  })

  it('reports a denied prompt without sending the enable message', () => {
    const fake = installFakeChrome({ grant: false })
    const results: any[] = []
    requestExactOriginAccess(
      fake.chrome,
      { origin: 'https://example.com', tabId: 7 },
      (result) => results.push(result)
    )
    expect(fake.messages).toEqual([])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/not granted/i)
  })

  it('reads the exact-origin grant for the popup state', async () => {
    installFakeChrome({ grant: true })
    expect(await siteAccessGranted((globalThis as any).chrome, 'https://example.com')).toBe(true)
    installFakeChrome({ grant: false })
    expect(await siteAccessGranted((globalThis as any).chrome, 'https://example.com')).toBe(false)
  })

  it('enables all-site detection by requesting the optional grants and saving the existing option', async () => {
    const fake = installFakeChrome()
    const result = await new Promise<any>((resolve) => {
      enableAllSitesDetection(fake.chrome, resolve)
    })

    expect(fake.permissionRequests).toEqual([
      {
        permissions: ['webRequest'],
        origins: ['http://*/*', 'https://*/*']
      }
    ])
    expect(result).toEqual({ ok: true })
    const saved = fake.local.dondownloadCaptureSettings as any
    expect(saved.detectAllSites).toBe(true)
    expect(saved.mediaSniffing).toBe(true)
  })
})

describe('welcome recommended capture setup', () => {
  it('requests the all-sites host grant plus optional downloads, then saves both options', async () => {
    const fake = installFakeChrome()
    expect(recommendedCapturePermissions(fake.chrome)).toEqual({
      permissions: ['downloads', 'webRequest', 'cookies'],
      origins: ['http://*/*', 'https://*/*']
    })

    const result = await new Promise<any>((resolve) => {
      enableRecommendedCapture(fake.chrome, resolve)
    })

    expect(fake.permissionRequests).toEqual([
      {
        permissions: ['downloads', 'webRequest', 'cookies'],
        origins: ['http://*/*', 'https://*/*']
      }
    ])
    expect(result).toEqual({ ok: true })
    const saved = fake.local.dondownloadCaptureSettings as any
    expect(saved.detectAllSites).toBe(true)
    expect(saved.mediaSniffing).toBe(true)
    expect(saved.automaticFileHandoff).toBe(true)
  })

  it('leaves downloads out when the manifest does not declare it optional', () => {
    const fake = installFakeChrome()
    fake.chrome.runtime.getManifest = () => ({
      optional_permissions: ['webRequest', 'cookies']
    })
    expect(recommendedCapturePermissions(fake.chrome)).toEqual({
      permissions: ['webRequest', 'cookies'],
      origins: ['http://*/*', 'https://*/*']
    })
  })

  it('writes nothing before the grant succeeds and nothing on denial', async () => {
    const fake = installFakeChrome()
    let decide: ((granted: boolean) => void) | null = null
    fake.chrome.permissions.request = (
      details: unknown,
      callback: (granted: boolean) => void
    ) => {
      fake.permissionRequests.push(details)
      decide = callback
    }

    const result = new Promise<any>((resolve) => {
      enableRecommendedCapture(fake.chrome, resolve)
    })
    expect(fake.local.dondownloadCaptureSettings).toBeUndefined()
    decide!(false)
    expect(await result).toMatchObject({ ok: false })
    expect(fake.local.dondownloadCaptureSettings).toBeUndefined()

    const denied = installFakeChrome({ grant: false })
    expect(
      await new Promise<any>((resolve) => {
        enableRecommendedCapture(denied.chrome, resolve)
      })
    ).toMatchObject({ ok: false })
    expect(denied.local.dondownloadCaptureSettings).toBeUndefined()
  })
})

describe('grant parameter validation', () => {
  it('accepts only a canonical exact http(s) origin', () => {
    expect(parseGrantParameter('https://example.com')).toBe('https://example.com')
    expect(parseGrantParameter('http://127.0.0.1:34526')).toBe(
      'http://127.0.0.1:34526'
    )
    expect(parseGrantParameter('https://sub.example.co.uk')).toBe(
      'https://sub.example.co.uk'
    )
  })

  it('rejects paths, queries, fragments, credentials, wildcards and non-http schemes', () => {
    for (const value of [
      'https://example.com/path',
      'https://example.com/',
      'https://example.com?x=1',
      'https://example.com#fragment',
      'https://user:pass@example.com',
      'https://user@example.com',
      'https://*.example.com',
      'https://example.com:443',
      'ftp://example.com',
      'file:///C:/secret.txt',
      'chrome://extensions',
      'javascript:alert(1)',
      '*',
      'https://exa mple.com',
      'not a url',
      ''
    ]) {
      expect(parseGrantParameter(value)).toBeNull()
    }
    expect(parseGrantParameter(null)).toBeNull()
    expect(parseGrantParameter(42)).toBeNull()
    expect(parseGrantParameter({ origin: 'https://example.com' })).toBeNull()
  })

  it('distinguishes a missing parameter from an invalid one', () => {
    expect(readGrantParameter('')).toEqual({
      present: false,
      origin: null,
      cookies: false
    })
    expect(readGrantParameter('?other=1')).toEqual({
      present: false,
      origin: null,
      cookies: false
    })
    expect(readGrantParameter('?grant=https%3A%2F%2Fexample.com')).toEqual({
      present: true,
      origin: 'https://example.com',
      cookies: false
    })
    expect(
      readGrantParameter('?grant=https%3A%2F%2Fexample.com%2Fpath')
    ).toEqual({
      present: true,
      origin: null,
      cookies: false
    })
    expect(
      readGrantParameter('?grant=https%3A%2F%2Fexample.com&cookies=1')
    ).toEqual({
      present: true,
      origin: 'https://example.com',
      cookies: true
    })
  })

  it('builds a welcome URL only for an exact origin', () => {
    expect(
      grantPageUrl('chrome-extension://abc/welcome.html', 'https://example.com')
    ).toBe('chrome-extension://abc/welcome.html?grant=https%3A%2F%2Fexample.com')
    expect(
      grantPageUrl('chrome-extension://abc/welcome.html', 'https://example.com', {
        cookies: true
      })
    ).toBe(
      'chrome-extension://abc/welcome.html?grant=https%3A%2F%2Fexample.com&cookies=1'
    )
    expect(
      grantPageUrl('chrome-extension://abc/welcome.html', 'https://example.com/x')
    ).toBeNull()
  })
})
