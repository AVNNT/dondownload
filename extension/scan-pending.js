import { normalizeSupportedUrl } from './bridge.js'
import { originFromUrl, originToMatchPattern } from './site-policy.js'
import { readCaptureSettings } from './capture-settings.js'

/**
 * "Scan this page" always uses the browser sign-in for the exact page origin.
 * Chrome only exposes cookies for origins the user granted, so the first scan
 * on a site opens the one-time permission prompt in a normal tab (the prompt
 * would close the toolbar popup). The page URL waits in storage.session (memory
 * only, never synced) and the welcome page starts the scan right after the
 * grant. No cookie value is ever stored here.
 */

export const PENDING_SCAN_KEY = 'dondownload:pending-scan'
export const PENDING_SCAN_TTL_MS = 5 * 60 * 1000

function sessionStorage(chromeApi) {
  const storage = chromeApi && chromeApi.storage
  return storage && storage.session ? storage.session : null
}

/** True when Chrome granted cookies for this origin and it is on the list. */
export async function scanCookiesReady(chromeApi, origin) {
  const pattern = originToMatchPattern(origin)
  if (pattern === null) return false
  const granted = await new Promise((resolve) => {
    try {
      const result = chromeApi.permissions.contains(
        { permissions: ['cookies'], origins: [pattern] },
        (value) => {
          void (chromeApi.runtime && chromeApi.runtime.lastError)
          resolve(value === true)
        }
      )
      if (result && typeof result.then === 'function') {
        result.then((value) => resolve(value === true)).catch(() => resolve(false))
      }
    } catch {
      resolve(false)
    }
  })
  if (!granted) return false
  try {
    const settings = await readCaptureSettings(chromeApi)
    return settings.cookieOptInOrigins.includes(origin)
  } catch {
    return false
  }
}

export async function rememberPendingScan(chromeApi, rawUrl, now = Date.now()) {
  const storage = sessionStorage(chromeApi)
  const normalized = normalizeSupportedUrl(rawUrl)
  if (storage === null || !normalized.ok) return false
  try {
    await storage.set({ [PENDING_SCAN_KEY]: { url: normalized.url, at: now } })
    return true
  } catch {
    return false
  }
}

/**
 * Returns the pending page URL only when it belongs to exactly `origin` and is
 * still fresh. The entry is always cleared, so it can start at most one scan.
 */
export async function takePendingScan(chromeApi, origin, now = Date.now()) {
  const storage = sessionStorage(chromeApi)
  if (storage === null || typeof origin !== 'string') return null
  let entry
  try {
    const stored = await storage.get(PENDING_SCAN_KEY)
    entry = stored ? stored[PENDING_SCAN_KEY] : undefined
    await storage.remove(PENDING_SCAN_KEY)
  } catch {
    return null
  }
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.url !== 'string' ||
    typeof entry.at !== 'number' ||
    now - entry.at < 0 ||
    now - entry.at > PENDING_SCAN_TTL_MS
  ) {
    return null
  }
  const normalized = normalizeSupportedUrl(entry.url)
  if (!normalized.ok || originFromUrl(normalized.url) !== origin) return null
  return normalized.url
}
