import { normalizeSupportedUrl } from './bridge.js'
import { originFromUrl, originToMatchPattern } from './site-policy.js'
import { readCaptureSettings } from './capture-settings.js'

/**
 * "Scan this page" and "Scan several links" always use the browser sign-in for
 * the exact page origin. Chrome only exposes cookies for origins the user
 * granted, so the first scan on a site opens the one-time permission prompt in
 * a normal tab (the prompt would close the toolbar popup). The page URLs wait
 * in storage.session (memory only, never synced) and the welcome page starts
 * the scans right after each grant. No cookie value is ever stored here.
 *
 * One shared list holds every site that still needs a grant. Taking one origin
 * removes only that origin's fresh URLs and leaves the other origins in place,
 * so a multi-site batch can walk through its grants one after another.
 */

export const PENDING_SCAN_KEY = 'dondownload:pending-scan'
export const PENDING_SCAN_TTL_MS = 5 * 60 * 1000
/** Total URLs kept across every pending origin. */
export const MAX_PENDING_SCANS = 10

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

/**
 * Normalize the stored value into fresh entries. The legacy single-URL shape
 * (`{ url, at }`) is still read so an in-flight grant survives an update.
 */
function storedEntries(stored, now) {
  if (!stored || typeof stored !== 'object') return []
  const raw =
    stored.entries !== undefined
      ? stored.entries
      : typeof stored.url === 'string' && typeof stored.at === 'number'
        ? [stored]
        : []
  if (!Array.isArray(raw)) return []
  const entries = []
  const seen = new Set()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.url !== 'string' || typeof entry.at !== 'number') continue
    if (now - entry.at < 0 || now - entry.at > PENDING_SCAN_TTL_MS) continue
    const normalized = normalizeSupportedUrl(entry.url)
    if (!normalized.ok || seen.has(normalized.url)) continue
    seen.add(normalized.url)
    entries.push({ url: normalized.url, at: entry.at })
    if (entries.length >= MAX_PENDING_SCANS) break
  }
  return entries
}

async function writeEntries(storage, entries) {
  try {
    if (entries.length === 0) {
      await storage.remove(PENDING_SCAN_KEY)
      return
    }
    await storage.set({ [PENDING_SCAN_KEY]: { entries } })
  } catch {
    // The grant still opens; only the automatic continuation is lost.
  }
}

/**
 * Replace the pending list with these URLs. Normalization, deduplication and
 * the shared cap keep the grant page from promising more than it can start.
 */
export async function rememberPendingScans(chromeApi, urls, now = Date.now()) {
  const storage = sessionStorage(chromeApi)
  if (storage === null || !Array.isArray(urls)) return false
  const entries = []
  const seen = new Set()
  for (const rawUrl of urls) {
    const normalized = normalizeSupportedUrl(rawUrl)
    if (!normalized.ok || seen.has(normalized.url)) continue
    seen.add(normalized.url)
    entries.push({ url: normalized.url, at: now })
    if (entries.length >= MAX_PENDING_SCANS) break
  }
  if (entries.length === 0) return false
  try {
    await storage.set({ [PENDING_SCAN_KEY]: { entries } })
    return true
  } catch {
    return false
  }
}

/** Single-URL compatibility wrapper; it now stores a one-entry list. */
export async function rememberPendingScan(chromeApi, rawUrl, now = Date.now()) {
  return rememberPendingScans(chromeApi, [rawUrl], now)
}

/**
 * Take exactly this origin's fresh URLs once. Other origins stay pending for
 * their own grant. Expired entries are dropped; the returned list is capped.
 */
export async function takePendingScans(chromeApi, origin, now = Date.now()) {
  const storage = sessionStorage(chromeApi)
  if (storage === null || typeof origin !== 'string') return []
  let entries
  try {
    const stored = await storage.get(PENDING_SCAN_KEY)
    entries = storedEntries(stored ? stored[PENDING_SCAN_KEY] : undefined, now)
  } catch {
    return []
  }

  const taken = []
  const remaining = []
  for (const entry of entries) {
    const normalized = normalizeSupportedUrl(entry.url)
    if (!normalized.ok) continue
    if (originFromUrl(normalized.url) === origin) {
      taken.push(normalized.url)
      continue
    }
    remaining.push(entry)
  }
  if (taken.length > 0 || remaining.length !== entries.length) {
    await writeEntries(storage, remaining)
  }
  return taken.slice(0, MAX_PENDING_SCANS)
}

/** Single-URL compatibility wrapper returning the first pending URL. */
export async function takePendingScan(chromeApi, origin, now = Date.now()) {
  const urls = await takePendingScans(chromeApi, origin, now)
  return urls.length > 0 ? urls[0] : null
}

/**
 * Fresh pending URLs grouped by origin, in first-seen order. Used by the
 * welcome page to offer the next site's grant after finishing the current one.
 */
export async function pendingScanGroups(chromeApi, now = Date.now()) {
  const storage = sessionStorage(chromeApi)
  if (storage === null) return []
  let entries
  try {
    const stored = await storage.get(PENDING_SCAN_KEY)
    entries = storedEntries(stored ? stored[PENDING_SCAN_KEY] : undefined, now)
  } catch {
    return []
  }
  const groups = []
  const byOrigin = new Map()
  for (const entry of entries) {
    const origin = originFromUrl(entry.url)
    if (origin === null) continue
    let group = byOrigin.get(origin)
    if (group === undefined) {
      group = { origin, urls: [] }
      byOrigin.set(origin, group)
      groups.push(group)
    }
    if (!group.urls.includes(entry.url)) group.urls.push(entry.url)
  }
  return groups
}
