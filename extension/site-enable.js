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
  const pattern = originToMatchPattern(origin)
  if (origin === null || pattern === null) {
    onResult({ ok: false, error: 'This origin is not supported.' })
    return
  }

  void rememberPendingEnable(chromeApi, origin, tabId)
  try {
    chromeApi.permissions.request({ origins: [pattern] }, (granted) => {
      const permissionError = chromeApi.runtime.lastError
      if (permissionError || granted !== true) {
        void clearPendingEnable(chromeApi)
        onResult({
          ok: false,
          error: 'Site access was not granted. Nothing on the page changed.'
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
    })
  } catch {
    void clearPendingEnable(chromeApi)
    onResult({ ok: false, error: 'Site access could not be requested.' })
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
