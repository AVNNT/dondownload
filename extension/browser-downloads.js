// Shared "Use DonDownload on all sites" master switch (Neat Download Manager
// style). The popup and the options page both use it so the permission set, the
// setting write and the service-worker notification exist in exactly one place.
//
// Turning it on asks for every optional grant in ONE permissions.request call:
// `downloads` (observe and cancel browser downloads), `cookies` (read the
// browser's cookies for exactly the download URL), `webRequest` (detect media
// responses) and the broad http/https host permission (overlay + detection on
// every site). The call must run synchronously inside the click handler because
// Chrome requires the user gesture.
//
// Turning it on sets automaticFileHandoff, detectAllSites, mediaSniffing and
// floatingTriggerEnabled, then asks the service worker to register the one
// all-sites overlay and inject it into already-open tabs, so the overlay shows
// on the open video tab without a reload. Turning it off clears
// automaticFileHandoff and detectAllSites and keeps the granted permissions and
// per-site enables.

import {
  readCaptureSettings,
  writeCaptureSettings
} from './capture-settings.js'

export const BROWSER_DOWNLOAD_HOST_ORIGINS = Object.freeze([
  'http://*/*',
  'https://*/*'
])

/** The message the popup/options page sends after the switch changes. */
export const ALL_SITES_OVERLAY_MESSAGE = 'dondownload:overlay-all-sites'

/**
 * The full optional permission set for the one switch. A permission the loaded
 * manifest does not declare as optional is left out so the request stays valid
 * if the manifest is tightened later.
 */
export function browserDownloadPermissions(chromeApi) {
  const wanted = ['downloads', 'cookies', 'webRequest']
  let optional = null
  try {
    const manifest = chromeApi.runtime.getManifest()
    if (manifest && Array.isArray(manifest.optional_permissions)) {
      optional = new Set(manifest.optional_permissions)
    }
  } catch {
    optional = null
  }
  return {
    permissions:
      optional === null ? wanted : wanted.filter((name) => optional.has(name)),
    origins: [...BROWSER_DOWNLOAD_HOST_ORIGINS]
  }
}

/**
 * True when the whole permission set is granted. The host patterns are checked
 * separately because `permissions.contains` treats a broad pattern as covering
 * a narrower one only in one direction; asking for the exact patterns keeps the
 * answer honest.
 */
export async function browserDownloadPermissionsGranted(chromeApi) {
  const details = browserDownloadPermissions(chromeApi)
  try {
    return (await chromeApi.permissions.contains(details)) === true
  } catch {
    return false
  }
}

/**
 * Turn the master switch on. Must be called directly from a user gesture:
 * `permissions.request` runs before any await.
 */
export function enableBrowserDownloadTakeover(chromeApi, onResult) {
  let details
  try {
    details = browserDownloadPermissions(chromeApi)
  } catch {
    onResult({
      ok: false,
      error: 'The permissions could not be requested.'
    })
    return
  }
  try {
    chromeApi.permissions.request(details, (granted) => {
      const runtimeError = chromeApi.runtime.lastError
      if (runtimeError || granted !== true) {
        onResult({
          ok: false,
          error:
            'The permissions were not granted. Downloads stay in the browser and no overlay is added.'
        })
        return
      }
      void (async () => {
        try {
          const settings = await readCaptureSettings(chromeApi)
          settings.automaticFileHandoff = true
          settings.detectAllSites = true
          settings.mediaSniffing = true
          settings.floatingTriggerEnabled = true
          const saved = await writeCaptureSettings(chromeApi, settings)
          if (!saved) {
            onResult({
              ok: false,
              error:
                'The permissions were granted, but the setting could not be saved in this browser profile.'
            })
            return
          }
          const [support, overlay] = await Promise.all([
            notifyDownloadsSupport(chromeApi),
            requestOverlayReconcile(chromeApi)
          ])
          onResult({
            ok: true,
            listener: support.listener,
            overlay: overlay.overlay,
            injected: overlay.injected
          })
        } catch {
          onResult({
            ok: false,
            error:
              'The permissions were granted, but the setting could not be saved in this browser profile.'
          })
        }
      })()
    })
  } catch {
    onResult({ ok: false, error: 'The permissions could not be requested.' })
  }
}

/**
 * Turn the master switch off. The granted permissions and the per-site enables
 * stay; only automatic browser download takeover and all-sites detection stop.
 */
export async function disableBrowserDownloadTakeover(chromeApi) {
  try {
    const settings = await readCaptureSettings(chromeApi)
    settings.automaticFileHandoff = false
    settings.detectAllSites = false
    const saved = await writeCaptureSettings(chromeApi, settings)
    if (!saved) return false
    await requestOverlayReconcile(chromeApi)
    return true
  } catch {
    return false
  }
}

/**
 * Ask the service worker to install the downloads listener right after a grant.
 * The worker also reacts to permissions.onAdded, so this is a fast path for the
 * case where the API became visible only after the popup requested it.
 */
export function notifyDownloadsSupport(chromeApi) {
  return new Promise((resolve) => {
    try {
      chromeApi.runtime.sendMessage(
        { type: 'dondownload:downloads-support' },
        (response) => {
          void chromeApi.runtime.lastError
          resolve({ listener: Boolean(response && response.listener === true) })
        }
      )
    } catch {
      resolve({ listener: false })
    }
  })
}

/**
 * Ask the service worker to register (or remove) the all-sites overlay and
 * inject it into open tabs. The worker also reconciles on settings change and
 * permissions.onAdded, so this is the fast path that avoids a page reload.
 */
export function requestOverlayReconcile(chromeApi) {
  return new Promise((resolve) => {
    try {
      chromeApi.runtime.sendMessage(
        { type: ALL_SITES_OVERLAY_MESSAGE },
        (response) => {
          void chromeApi.runtime.lastError
          resolve({
            overlay: Boolean(
              response && response.ok === true && response.registered === true
            ),
            injected: Array.isArray(response && response.injected)
              ? response.injected.length
              : 0
          })
        }
      )
    } catch {
      resolve({ overlay: false, injected: 0 })
    }
  })
}

/** Popup copy for the current switch state. */
export function browserDownloadStateCopy(state) {
  const enabled = state && state.enabled === true
  const minBytes =
    state && Number.isSafeInteger(state.minBytes) ? state.minBytes : 1_000_000
  const minimum =
    minBytes === 0
      ? 'any size'
      : minBytes >= 10_000_000
        ? '10 MB'
        : '1 MB'
  return {
    enabled,
    state: enabled ? 'On' : 'Off',
    hint: enabled
      ? `On. New browser downloads of ${minimum} or larger go to DonDownload with your browser cookies and sign-in, and the video overlay shows on every site. The browser copy is cancelled only after the app confirms it saved the download.`
      : 'Off. Browser downloads stay in the browser and the overlay is limited to sites you enable one by one. Turning this on asks once for the downloads, cookies, media detection and site access permissions.'
  }
}
