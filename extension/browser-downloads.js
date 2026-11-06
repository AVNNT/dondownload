// Shared "Download browser files with DonDownload" switch. The popup and the
// options page both use it so the permission set, the setting write and the
// service-worker notification exist in exactly one place.
//
// Turning it on asks for every optional grant in ONE permissions.request call:
// `downloads` (observe and cancel browser downloads), `cookies` (read the
// browser's cookies for exactly the download URL) and the broad http/https
// host permission. The call must run synchronously inside the click handler
// because Chrome requires the user gesture.

import {
  readCaptureSettings,
  writeCaptureSettings
} from './capture-settings.js'

export const BROWSER_DOWNLOAD_HOST_ORIGINS = Object.freeze([
  'http://*/*',
  'https://*/*'
])

/**
 * The full optional permission set for browser download takeover. A permission
 * the loaded manifest does not declare as optional is left out so the request
 * stays valid if the manifest is tightened later.
 */
export function browserDownloadPermissions(chromeApi) {
  const wanted = ['downloads', 'cookies']
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

/** True when the whole browser-download permission set is already granted. */
export async function browserDownloadPermissionsGranted(chromeApi) {
  const details = browserDownloadPermissions(chromeApi)
  try {
    return (await chromeApi.permissions.contains(details)) === true
  } catch {
    return false
  }
}

/**
 * Turn browser download takeover on. Must be called directly from a user
 * gesture: `permissions.request` runs before any await.
 */
export function enableBrowserDownloadTakeover(chromeApi, onResult) {
  let details
  try {
    details = browserDownloadPermissions(chromeApi)
  } catch {
    onResult({ ok: false, error: 'The browser download permission could not be requested.' })
    return
  }
  try {
    chromeApi.permissions.request(details, (granted) => {
      const runtimeError = chromeApi.runtime.lastError
      if (runtimeError || granted !== true) {
        onResult({
          ok: false,
          error: 'The browser download permission was not granted. Downloads stay in the browser.'
        })
        return
      }
      void (async () => {
        try {
          const settings = await readCaptureSettings(chromeApi)
          settings.automaticFileHandoff = true
          const saved = await writeCaptureSettings(chromeApi, settings)
          if (!saved) {
            onResult({
              ok: false,
              error:
                'The permission was granted, but the setting could not be saved in this browser profile.'
            })
            return
          }
          onResult({ ok: true, ...(await notifyDownloadsSupport(chromeApi)) })
        } catch {
          onResult({
            ok: false,
            error:
              'The permission was granted, but the setting could not be saved in this browser profile.'
          })
        }
      })()
    })
  } catch {
    onResult({ ok: false, error: 'The browser download permission could not be requested.' })
  }
}

/** Turn takeover off and keep the granted permissions. */
export async function disableBrowserDownloadTakeover(chromeApi) {
  try {
    const settings = await readCaptureSettings(chromeApi)
    settings.automaticFileHandoff = false
    return await writeCaptureSettings(chromeApi, settings)
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
      ? `New browser downloads of ${minimum} or larger go to DonDownload with your browser cookies and sign-in. The browser copy is cancelled only after the app confirms it saved the download.`
      : 'Off. Browser downloads stay in the browser. Turning this on asks for the downloads, cookies and site access permissions once. Files whose size the browser does not report are handed off when the link names a real file; nothing is cancelled until DonDownload confirms it saved the file.'
  }
}
