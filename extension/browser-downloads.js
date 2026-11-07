// Shared "Use DonDownload on all sites" master switch (Neat Download Manager
// style). The switch itself is always on: the broad http/https host permission
// is a required manifest permission granted at install, so no page has to be
// requested and no UI can turn it off.
//
// What is left here is the one place that
// - migrates a stored "off" value from an older version to on,
// - asks the service worker to install the downloads listener, and
// - asks it to register the one all-sites overlay (and optionally inject it
//   into already-open tabs).
//
// The optional `downloads`, `cookies` and `webRequest` permissions stay
// optional, so the hand-off itself only runs once they are granted. The options
// page asks for them from a button; the switch never depends on them.

import {
  CAPTURE_SETTINGS_KEY,
  readCaptureSettings,
  writeCaptureSettings
} from './capture-settings.js'

/** The message the popup/options page sends to (re)register the overlay. */
export const ALL_SITES_OVERLAY_MESSAGE = 'dondownload:overlay-all-sites'

/**
 * The optional permission set the hand-off still needs. A permission the loaded
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
      optional === null ? wanted : wanted.filter((name) => optional.has(name))
  }
}

/**
 * Ask for the optional hand-off permissions. Must be called directly from a
 * user gesture: `permissions.request` runs before any await. Site access is not
 * requested because it is granted at install.
 */
export function requestBrowserDownloadAccess(chromeApi, onResult) {
  let details
  try {
    details = browserDownloadPermissions(chromeApi)
  } catch {
    onResult({ ok: false, error: 'The permissions could not be requested.' })
    return
  }
  try {
    chromeApi.permissions.request(details, (granted) => {
      const runtimeError = chromeApi.runtime.lastError
      if (runtimeError || granted !== true) {
        onResult({
          ok: false,
          error:
            'The permissions were not granted. Browser downloads stay in the browser.'
        })
        return
      }
      void (async () => {
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
      })()
    })
  } catch {
    onResult({ ok: false, error: 'The permissions could not be requested.' })
  }
}

/**
 * Ask the service worker to install the downloads listener. The worker also
 * reacts to permissions.onAdded, so this is a fast path for the case where the
 * API became visible only after the options page requested it.
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
 * Ask the service worker to register the all-sites overlay and, when asked,
 * inject it into open tabs. The worker also reconciles on settings change and
 * permissions.onAdded, so this is the fast path that avoids a page reload.
 */
export function requestOverlayReconcile(chromeApi, options = {}) {
  return new Promise((resolve) => {
    try {
      chromeApi.runtime.sendMessage(
        {
          type: ALL_SITES_OVERLAY_MESSAGE,
          injectOpenTabs: options.injectOpenTabs === true
        },
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

/**
 * Re-assert the always-on mode. Called on install, on startup and on every
 * service-worker wake: it rewrites a stored "off" from an older version, makes
 * sure the downloads listener is installed and that the one all-sites content
 * script registration exists.
 *
 * `options.reconcile` lets the service worker reconcile in-process instead of
 * messaging itself; UI pages leave it out and go through the worker message.
 */
export async function ensureAllSitesActive(chromeApi, options = {}) {
  await migrateAlwaysOnSettings(chromeApi)
  const reconcile =
    typeof options.reconcile === 'function'
      ? options.reconcile
      : () => requestOverlayReconcile(chromeApi, options)
  const [support, overlay] = await Promise.all([
    notifyDownloadsSupport(chromeApi),
    reconcile()
  ])
  return {
    ok: true,
    listener: support.listener,
    overlay: overlay.overlay,
    injected: overlay.injected
  }
}

/**
 * Write the always-on flags once when a profile still stores them as off. The
 * read path already normalizes them, so this only makes the stored value match
 * and never fails the caller.
 */
async function migrateAlwaysOnSettings(chromeApi) {
  try {
    const local = chromeApi.storage && chromeApi.storage.local
    if (!local) return
    const stored = await local.get(CAPTURE_SETTINGS_KEY)
    const current = stored && stored[CAPTURE_SETTINGS_KEY]
    if (
      current &&
      current.automaticFileHandoff === true &&
      current.detectAllSites === true
    ) {
      return
    }
    await writeCaptureSettings(chromeApi, await readCaptureSettings(chromeApi))
  } catch {
    // A profile that refuses the write still reads the switch as on.
  }
}

/** Popup/options copy for the always-on switch. */
export function browserDownloadStateCopy(state) {
  const minBytes =
    state && Number.isSafeInteger(state.minBytes) ? state.minBytes : 1_000_000
  const minimum =
    minBytes === 0
      ? 'any size'
      : minBytes >= 10_000_000
        ? '10 MB'
        : '1 MB'
  return {
    enabled: true,
    state: 'Active on all sites',
    hint: `Active on all sites. New browser downloads of ${minimum} or larger go to DonDownload with your browser cookies and sign-in, and the video overlay shows on every site. The browser copy is cancelled only after the app confirms it saved the download.`
  }
}
