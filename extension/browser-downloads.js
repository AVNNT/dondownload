// Shared "Use DonDownload on all sites" master switch (Neat Download Manager
// style). The switch itself is always on: the broad http/https host permission
// is a required manifest permission granted at install, so no page has to be
// requested and no UI can turn it off.
//
// What is left here is the one place that
// - migrates a stored "off" value from an older version to on, and
// - asks the service worker to register the one all-sites overlay (and
//   optionally inject it into already-open tabs).
//
// The `downloads` permission is required, so the hand-off works as soon as the
// extension is installed and no button has to be pressed for it. Only
// `webRequest` and `cookies` stay optional, and the switch never depends on
// them.

import {
  CAPTURE_SETTINGS_KEY,
  readCaptureSettings,
  writeCaptureSettings
} from './capture-settings.js'

/** The message the popup/options page sends to (re)register the overlay. */
export const ALL_SITES_OVERLAY_MESSAGE = 'dondownload:overlay-all-sites'

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
 * service-worker wake: it rewrites a stored "off" from an older version and
 * makes sure the one all-sites content script registration exists. The
 * downloads listener is installed by the worker itself, because `downloads` is
 * a required permission.
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
  const overlay = await reconcile()
  return {
    ok: true,
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
