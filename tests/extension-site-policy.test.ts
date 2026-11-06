import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasExactOriginGrant,
  matchPatternToOrigin,
  originFromUrl,
  originToMatchPattern,
  overlayOriginFromRegistration,
  overlayRegistrationForOrigin,
  overlayScriptId,
  parseSupportedPageUrl
} from '../extension/site-policy'

describe('per-site overlay permission policy', () => {
  it('normalizes only credential-free HTTP(S) page origins', () => {
    expect(originFromUrl('https://Example.com:443/path?q=1#fragment')).toBe(
      'https://example.com'
    )
    expect(originFromUrl('http://127.0.0.1:8080/page.html')).toBe(
      'http://127.0.0.1:8080'
    )
    expect(originFromUrl('https://[::1]:8443/video')).toBe('https://[::1]:8443')

    for (const unsupported of [
      'file:///C:/video.mp4',
      'chrome-extension://efakbfgkcnfjpomeejapmhpaihompngo/popup.html',
      'chrome://extensions',
      'edge://settings',
      'ftp://example.com/video.mp4',
      'data:text/html,hello',
      'javascript:alert(1)',
      'https://user:secret@example.com/video',
      'not a url',
      '',
      'https://example.com/\u0000'
    ]) {
      expect(originFromUrl(unsupported)).toBeNull()
    }

    expect(parseSupportedPageUrl('https://example.com/watch?v=1')).toEqual({
      url: 'https://example.com/watch?v=1',
      origin: 'https://example.com'
    })
  })

  it('requests exactly one canonical origin pattern, never a wildcard', () => {
    expect(originToMatchPattern('https://example.com')).toBe('https://example.com/*')
    expect(originToMatchPattern('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/*'
    )
    expect(originToMatchPattern('https://[::1]:8443')).toBe('https://[::1]:8443/*')

    for (const invalid of [
      'https://*.example.com',
      '*://example.com',
      '<all_urls>',
      'https://example.com/',
      'https://example.com/path',
      'https://example.com?x=1',
      'https://user@example.com',
      'null',
      'file:///C:/'
    ]) {
      expect(originToMatchPattern(invalid)).toBeNull()
    }
  })

  it('round-trips an exact match pattern and rejects broader patterns', () => {
    expect(matchPatternToOrigin('https://example.com/*')).toBe('https://example.com')
    expect(matchPatternToOrigin('http://localhost:5173/*')).toBe('http://localhost:5173')

    for (const invalid of [
      'https://*.example.com/*',
      '*://*/*',
      'https://example.com/path/*',
      'https://example.com',
      'https://example.com/*/more',
      'http://example.com:80/*'
    ]) {
      expect(matchPatternToOrigin(invalid)).toBeNull()
    }
  })

  it('keeps an exact non-default localhost port for permission and registration', () => {
    expect(originToMatchPattern('http://127.0.0.1:34526')).toBe(
      'http://127.0.0.1:34526/*'
    )
    expect(matchPatternToOrigin('http://127.0.0.1:34526/*')).toBe(
      'http://127.0.0.1:34526'
    )
    const registration = overlayRegistrationForOrigin('http://127.0.0.1:34526')
    expect(registration?.matches).toEqual(['http://127.0.0.1:34526/*'])
    expect(registration?.id).toBe(overlayScriptId('http://127.0.0.1:34526'))
  })

  it('derives one stable, origin-specific registration id', () => {
    const first = overlayScriptId('https://example.com')
    const second = overlayScriptId('https://example.com')
    expect(first).toBe(second)
    expect(first).toMatch(/^dondownload-overlay-[0-9a-f]{8}$/)
    expect(overlayScriptId('https://other.example')).not.toBe(first)
    expect(overlayScriptId('https://*.example.com')).toBeNull()
  })

  it('registers only the exact origin in the top frame of the isolated world', () => {
    const registration = overlayRegistrationForOrigin('https://example.com')
    expect(registration).toEqual({
      id: overlayScriptId('https://example.com'),
      matches: ['https://example.com/*'],
      js: [
        'overlay-core.js',
        'overlay-runtime.js',
        'overlay-ui.js',
        'overlay-qualities.js',
        'overlay-kvs.js',
        'overlay-capture.js',
        'overlay.js'
      ],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
      world: 'ISOLATED'
    })
    expect(registration?.matches).not.toContain('<all_urls>')
    expect(overlayRegistrationForOrigin('https://*.example.com')).toBeNull()
  })

  it('recognizes only an exact granted origin pattern', () => {
    const pattern = 'https://example.com/*'
    expect(hasExactOriginGrant([pattern], 'https://example.com')).toBe(true)
    expect(hasExactOriginGrant([pattern], 'https://sub.example.com')).toBe(false)
    expect(hasExactOriginGrant(['https://*/*'], 'https://example.com')).toBe(false)
    expect(hasExactOriginGrant(['https://example.com/path/*'], 'https://example.com')).toBe(
      false
    )
    expect(hasExactOriginGrant(undefined, 'https://example.com')).toBe(false)
  })

  it('accepts only canonical stored registrations and treats everything else as orphaned', () => {
    const registration = overlayRegistrationForOrigin('https://example.com')
    expect(overlayOriginFromRegistration(registration)).toBe('https://example.com')

    expect(
      overlayOriginFromRegistration({
        ...registration,
        matches: ['https://*/*']
      })
    ).toBeNull()
    expect(
      overlayOriginFromRegistration({
        ...registration,
        id: overlayScriptId('https://other.example')
      })
    ).toBeNull()
    expect(
      overlayOriginFromRegistration({
        ...registration,
        js: ['overlay.js']
      })
    ).toBeNull()
    expect(overlayOriginFromRegistration(null)).toBeNull()
  })
})

describe('extension wiring guardrails', () => {
  const extensionDir = path.join(process.cwd(), 'extension')
  const background = readFileSync(path.join(extensionDir, 'background.js'), 'utf8')
  const popup = readFileSync(path.join(extensionDir, 'popup.js'), 'utf8')
  const options = readFileSync(path.join(extensionDir, 'options.js'), 'utf8')
  const overlay = readFileSync(path.join(extensionDir, 'overlay.js'), 'utf8')
  const controller = readFileSync(
    path.join(extensionDir, 'overlay-controller.js'),
    'utf8'
  )
  const siteEnable = readFileSync(
    path.join(extensionDir, 'site-enable.js'),
    'utf8'
  )

  it('registers and removes only the exact origin chosen for the site', () => {
    for (const source of [background, popup, options, overlay, controller, siteEnable]) {
      expect(source).not.toContain('<all_urls>')
      expect(source).not.toContain('*://*/*')
    }

    // The popup hands the active tab's exact origin to the shared enable
    // helper and never requests an origin itself. Its one permission request
    // is the browser-download takeover set, made through the shared helper.
    expect(popup).toContain(
      'rememberOptionsTarget(chrome, { tabId: activeTabId, origin: pageOrigin })'
    )
    expect(popup).toContain('requestExactOriginAccess')
    expect(popup).toContain('enableBrowserDownloadTakeover')
    expect(popup).not.toContain('chrome.permissions.request')
    // The options page and popup share one exact-origin request implementation.
    expect(options).toContain('requestExactOriginAccess')
    expect(options).not.toContain('chrome.permissions.request({ origins: [pattern] }')
    expect(siteEnable).toContain('originToMatchPattern(origin)')
    expect(siteEnable).toContain('origins: [pattern]')
    expect(siteEnable).toContain('permissions: [\'cookies\']')
    expect(siteEnable).toContain('rememberPendingEnable(chromeApi, origin, tabId)')
    expect(controller).toContain('overlayRegistrationForOrigin(origin)')
    expect(controller).toContain('chromeApi.scripting.registerContentScripts')
    expect(controller).toContain('chromeApi.scripting.unregisterContentScripts')
    expect(controller).toContain('chromeApi.permissions.remove')
    // The permission prompt can close the originating page, so the grant is
    // finished from a top-level permissions.onAdded listener in the worker.
    expect(background).toContain('chrome.permissions.onAdded.addListener')
    expect(background).toContain('handlePermissionsAdded(chrome, permissions)')
    expect(background).toContain('handleOverlayReady(chrome, message, sender)')
    expect(background).toContain('chrome.tabs.onRemoved.addListener')
    // Success requires both the registration and the verified page overlay.
    expect(options).toContain('response.registered === true')
    expect(options).toContain('response.injected === true')
    // Disable success requires verified removal of both the grant and the
    // registration, not just a resolved message.
    expect(options).toContain('overlayRemovalConfirmed(response)')
    expect(controller).toContain('registrationIsAbsent')
    expect(controller).toContain('permissions.contains({ origins: [pattern] })')
    // External revoke teardown is origin-scoped on both sides.
    expect(controller).toContain('type: OVERLAY_MESSAGE_TYPES.DISABLED')
    expect(overlay).toContain('message.origin === location.origin')
  })

  it('keeps page-facing code off download/network/cookie APIs and gates cookies behind the exact-origin opt-in', () => {
    // The optional response-evidence and media-sniffer listeners live in the
    // background/worker modules and run only after the user grants webRequest.
    // The page-facing overlay, popup and options page still never touch those
    // APIs: the popup asks for the browser-download permission set through the
    // shared browser-downloads helper instead.
    for (const source of [popup, overlay, controller, options]) {
      for (const forbidden of [
        'chrome.downloads',
        'chrome.cookies',
        'chrome.history',
        'chrome.tabs.captureVisibleTab'
      ]) {
        expect(source).not.toContain(forbidden)
      }
    }
    // Only the shared helper asks for webRequest; the popup never does.
    expect(popup).not.toContain('webRequest')
    for (const forbidden of [
      'chrome.history',
      'chrome.tabs.captureVisibleTab'
    ]) {
      expect(background).not.toContain(forbidden)
    }
    // A cookie is read only after the exact origin is on the user's opt-in list
    // and the optional cookies permission is present. The single helper now
    // lives in capture-settings and both background and media-bridge call it.
    // The automatic browser-download path has its own explicit reader.
    const cookieHelper = readFileSync(
      path.join(process.cwd(), 'extension', 'capture-settings.js'),
      'utf8'
    )
    expect(cookieHelper).toContain('cookieOptInOrigins.includes(origin)')
    expect(cookieHelper).toContain(
      "permissions.contains({ permissions: ['cookies'] })"
    )
    expect(cookieHelper.indexOf('cookieOptInOrigins.includes(origin)')).toBeLessThan(
      cookieHelper.indexOf('chromeApi.cookies.getAll')
    )
    expect(cookieHelper).toContain('export async function readHandoffCookieHeader')
    expect(background).toContain('readOptInCookieHeader')
    expect(background).not.toContain('chrome.cookies.getAll')
  })
})
