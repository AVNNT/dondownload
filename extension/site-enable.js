// Shared exact-origin grant and all-site detection requests. The popup,
// welcome page and options page all use these functions so the permission
// lifecycle, pending-enable bookkeeping and service-worker message shape exist
// in exactly one place.

import { originToMatchPattern } from './site-policy.js'
import {
  clearPendingEnable,
  rememberPendingEnable
} from './overlay-controller.js'
import { readCaptureSettings, writeCaptureSettings } from './capture-settings.js'

function errorText(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

async function rememberCookieOptIn(chromeApi, origin) {
  try {
    const settings = await readCaptureSettings(chromeApi)
    if (!settings.cookieOptInOrigins.includes(origin)) {
      settings.cookieOptInOrigins.push(origin)
    }
    return await writeCaptureSettings(chromeApi, settings)
  } catch {
    return false
  }
}

/** Read the exact-origin overlay grant for one page origin. */
export async function siteAccessGranted(chromeApi, origin) {
  const pattern = originToMatchPattern(origin)
  if (pattern === null) return false
  try {
    return (await chromeApi.permissions.contains({ origins: [pattern] })) === true
  } catch {
    return false
  }
}

/**
 * Grant exactly one origin and ask the service worker to register and verify
 * the overlay. Must be called directly from a user gesture: the
 * `permissions.request` call happens synchronously before any promise work.
 */
export function requestExactOriginAccess(chromeApi, site, onResult) {
  const origin = site && typeof site.origin === 'string' ? site.origin : null
  const tabId =
    site && Number.isInteger(site.tabId) && site.tabId >= 0 ? site.tabId : null
  const requestCookies = site && site.cookies === true
  const pattern = originToMatchPattern(origin)
  if (origin === null || pattern === null) {
    onResult({ ok: false, error: 'This origin is not supported.' })
    return
  }

  void rememberPendingEnable(chromeApi, origin, tabId)
  try {
    chromeApi.permissions.request(
      {
        origins: [pattern],
        ...(requestCookies ? { permissions: ['cookies'] } : {})
      },
      (granted) => {
        const permissionError = chromeApi.runtime.lastError
        if (permissionError || granted !== true) {
          void clearPendingEnable(chromeApi)
          onResult({
            ok: false,
            error: requestCookies
              ? 'The cookies permission was not granted. No cookie is read.'
              : 'Site access was not granted. Nothing on the page changed.'
          })
          return
        }

        const finish = (cookieSaved) => {
          if (!cookieSaved) {
            onResult({
              ok: false,
              error:
                'The permission was granted, but the cookie opt-in could not be saved in this browser profile.'
            })
            return
          }
          try {
            chromeApi.runtime.sendMessage(
              { type: 'dondownload:overlay-enable', origin, tabId },
              (response) => {
                const messageError = chromeApi.runtime.lastError
                if (messageError) {
                  onResult({
                    ok: false,
                    error: 'The overlay request could not be completed.'
                  })
                  return
                }
                const failed = !response || response.ok === false
                onResult({
                  ok: !failed,
                  response: response || null,
                  error: failed
                    ? errorText(
                        response && response.error && response.error.message,
                        'The overlay could not be enabled on this site.'
                      )
                    : null
                })
              }
            )
          } catch {
            onResult({
              ok: false,
              error: 'The overlay request could not be completed.'
            })
          }
        }

        if (requestCookies) {
          void rememberCookieOptIn(chromeApi, origin).then(finish)
          return
        }
        finish(true)
      }
    )
  } catch {
    void clearPendingEnable(chromeApi)
    onResult({ ok: false, error: 'Site access could not be requested.' })
  }
}

/**
 * Optional permissions the recommended welcome action asks for. `downloads`
 * is included only when the loaded manifest actually declares it as optional,
 * so the request stays valid if the manifest is tightened later.
 */
export function recommendedCapturePermissions(chromeApi) {
  const permissions = ['webRequest']
  let optional = null
  try {
    const manifest = chromeApi.runtime.getManifest()
    if (manifest && Array.isArray(manifest.optional_permissions)) {
      optional = new Set(manifest.optional_permissions)
    }
  } catch {
    optional = null
  }
  if (optional === null || optional.has('downloads')) {
    permissions.unshift('downloads')
  }
  return {
    permissions,
    origins: ['http://*/*', 'https://*/*']
  }
}

/**
 * Welcome-page recommended setup: one user gesture requests the broad site
 * grant used by all-site media detection plus optional `downloads`, then turns
 * on detection and automatic browser hand-off only after the grant succeeds.
 */
export function enableRecommendedCapture(chromeApi, onResult) {
  let details
  try {
    details = recommendedCapturePermissions(chromeApi)
  } catch {
    onResult({ ok: false, error: 'Capture permissions could not be requested.' })
    return
  }
  try {
    chromeApi.permissions.request(details, (granted) => {
      const runtimeError = chromeApi.runtime.lastError
      if (runtimeError || granted !== true) {
        onResult({
          ok: false,
          error: 'Broad site access was not granted. Capture stays off.'
        })
        return
      }
      void (async () => {
        try {
          const settings = await readCaptureSettings(chromeApi)
          settings.detectAllSites = true
          settings.mediaSniffing = true
          settings.automaticFileHandoff = true
          const saved = await writeCaptureSettings(chromeApi, settings)
          onResult(
            saved
              ? { ok: true }
              : {
                  ok: false,
                  error:
                    'The permissions were granted, but the capture setting could not be saved in this browser profile.'
                }
          )
        } catch {
          onResult({
            ok: false,
            error:
              'The permissions were granted, but the capture setting could not be saved in this browser profile.'
          })
        }
      })()
    })
  } catch {
    onResult({ ok: false, error: 'Capture permissions could not be requested.' })
  }
}

/** Turn on the existing all-sites detection option with its optional grants. */
export function enableAllSitesDetection(chromeApi, onResult) {
  try {
    chromeApi.permissions.request(
      {
        permissions: ['webRequest'],
        origins: ['http://*/*', 'https://*/*']
      },
      (granted) => {
        const runtimeError = chromeApi.runtime.lastError
        if (runtimeError || granted !== true) {
          onResult({
            ok: false,
            error: 'Broad site access was not granted. All-site detection stays off.'
          })
          return
        }
        void (async () => {
          try {
            const settings = await readCaptureSettings(chromeApi)
            settings.detectAllSites = true
            settings.mediaSniffing = true
            const saved = await writeCaptureSettings(chromeApi, settings)
            onResult(
              saved
                ? { ok: true }
                : {
                    ok: false,
                    error: 'The setting could not be saved in this browser profile.'
                  }
            )
          } catch {
            onResult({
              ok: false,
              error: 'The setting could not be saved in this browser profile.'
            })
          }
        })()
      }
    )
  } catch {
    onResult({ ok: false, error: 'Broad site access could not be requested.' })
  }
}
