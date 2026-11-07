// Persistent user preferences and short-lived automatic hand-off bookkeeping.
// Settings are cosmetic/user choices; processed download IDs use storage.session
// so a suspended MV3 worker still sees them after it wakes.

import { originFromPageUrl } from './handoff-policy.js'

export const CAPTURE_SETTINGS_KEY = 'dondownloadCaptureSettings'
export const HANDOFF_STATE_KEY = 'dondownloadHandoffState'
export const NEEDS_LOGIN_STATE_KEY = 'dondownloadHandoffNeedsLogin'
export const OPTIONS_TARGET_KEY = 'dondownloadOptionsTarget'
export const MAX_HANDOFF_IDS = 300
export const MAX_EXCLUDED_ORIGINS = 100
export const MAX_COOKIE_HEADER_LENGTH = 8192

/** Allowed "only files larger than" values for automatic hand-off. */
export const HANDOFF_MIN_BYTES_OPTIONS = Object.freeze([0, 1_000_000, 10_000_000])

export const DEFAULT_CAPTURE_SETTINGS = Object.freeze({
  floatingTriggerEnabled: true,
  // "Use DonDownload on all sites" is always on: the http/https host permission
  // is granted at install, so there is no switch to turn on and no prompt.
  automaticFileHandoff: true,
  // Automatic browser downloads smaller than this stay in the browser. 1 MB
  // by default; 0 means any size the browser reports.
  handoffMinBytes: 1_000_000,
  handoffNotifications: true,
  networkObservation: false,
  mediaSniffing: true,
  detectAllSites: true,
  // Exact origins where the user explicitly allowed browser cookies for
  // detected media. Empty means no cookie is ever read.
  cookieOptInOrigins: [],
  excludedOrigins: []
})

function storageArea(chromeApi, area) {
  const storage = chromeApi && chromeApi.storage
  return storage && storage[area] ? storage[area] : null
}

function normalizeHandoffMinBytes(value) {
  return HANDOFF_MIN_BYTES_OPTIONS.includes(value) ? value : 1_000_000
}

export function normalizeCaptureSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const excludedOrigins = []
  if (Array.isArray(source.excludedOrigins)) {
    for (const candidate of source.excludedOrigins) {
      const origin = originFromPageUrl(candidate)
      if (origin === null || excludedOrigins.includes(origin)) continue
      excludedOrigins.push(origin)
      if (excludedOrigins.length >= MAX_EXCLUDED_ORIGINS) break
    }
  }
  const cookieOptInOrigins = []
  if (Array.isArray(source.cookieOptInOrigins)) {
    for (const candidate of source.cookieOptInOrigins) {
      const origin = originFromPageUrl(candidate)
      if (origin === null || cookieOptInOrigins.includes(origin)) continue
      cookieOptInOrigins.push(origin)
      if (cookieOptInOrigins.length >= MAX_EXCLUDED_ORIGINS) break
    }
  }
  return {
    floatingTriggerEnabled:
      source.floatingTriggerEnabled !== false,
    // Always on. A stored "off" from an older version is ignored on read and
    // rewritten as on by the next save, so the master switch cannot be off.
    automaticFileHandoff: true,
    handoffMinBytes: normalizeHandoffMinBytes(source.handoffMinBytes),
    handoffNotifications: source.handoffNotifications !== false,
    // Off unless the user has explicitly enabled it after granting the
    // optional webRequest permission. A stored true is not enough on its own.
    networkObservation: source.networkObservation === true,
    mediaSniffing: source.mediaSniffing !== false,
    detectAllSites: true,
    cookieOptInOrigins,
    excludedOrigins
  }
}

/**
 * Cookies are read only when the exact page origin is on the user's opt-in
 * list AND the optional cookies permission is granted. The result lives only
 * in the caller's message for one job; nothing is written to extension
 * storage. The cookie URL may be an embed/player URL reached from an
 * opted-in top page.
 */
export async function readOptInCookieHeader(chromeApi, pageUrl, cookieUrl) {
  const origin = originFromPageUrl(pageUrl)
  if (origin === null) return undefined
  return readCookieHeaderForOrigins(chromeApi, cookieUrl, [origin])
}

function cookiesForUrl(chromeApi, url) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (cookies) => {
      if (settled) return
      settled = true
      resolve(Array.isArray(cookies) ? cookies : [])
    }
    try {
      const result = chromeApi.cookies.getAll({ url }, (cookies) => {
        // Read lastError so a denied call does not surface as an unchecked error.
        void (chromeApi.runtime && chromeApi.runtime.lastError)
        finish(cookies)
      })
      if (result && typeof result.then === 'function') {
        result.then(finish).catch(() => finish([]))
      }
    } catch {
      finish([])
    }
  })
}

/**
 * Hand-off variant: either the download URL origin or the referring page
 * origin may be opted in. The Cookie is still read for the exact download URL,
 * so a different host never receives another site's cookies.
 */
export async function readCookieHeaderForOrigins(
  chromeApi,
  cookieUrl,
  allowedOrigins
) {
  try {
    const settings = await readCaptureSettings(chromeApi)
    const origins = Array.isArray(allowedOrigins)
      ? allowedOrigins
          .map((value) => originFromPageUrl(value))
          .filter((value) => value !== null)
      : []
    if (
      origins.length === 0 ||
      !origins.some((origin) => settings.cookieOptInOrigins.includes(origin))
    ) {
      return undefined
    }
    return readCookieHeaderForUrl(chromeApi, cookieUrl)
  } catch {
    return undefined
  }
}

/**
 * Automatic browser hand-off variant. The user already switched on "Download
 * browser files with DonDownload" and granted the optional cookies permission
 * for that, so the browser's cookies for exactly this download URL are read
 * without a per-site opt-in. The header travels in one native message only:
 * it is never written to extension storage and never logged. The per-site
 * opt-in above still governs the overlay and detected-media paths.
 */
export async function readHandoffCookieHeader(chromeApi, cookieUrl) {
  try {
    if (originFromPageUrl(cookieUrl) === null) return undefined
    return readCookieHeaderForUrl(chromeApi, cookieUrl)
  } catch {
    return undefined
  }
}

/** Read and join the cookies for one exact URL, bounded by MAX_COOKIE_HEADER_LENGTH. */
async function readCookieHeaderForUrl(chromeApi, cookieUrl) {
  try {
    if (
      (await chromeApi.permissions.contains({ permissions: ['cookies'] })) !==
      true
    ) {
      return undefined
    }
    if (!chromeApi.cookies || typeof chromeApi.cookies.getAll !== 'function') {
      return undefined
    }
    const cookies = await cookiesForUrl(chromeApi, cookieUrl)
    if (!Array.isArray(cookies) || cookies.length === 0) return undefined
    const parts = []
    for (const cookie of cookies.slice(0, 100)) {
      if (
        !cookie ||
        typeof cookie.name !== 'string' ||
        cookie.name.length === 0 ||
        typeof cookie.value !== 'string' ||
        /[\r\n]/.test(cookie.name) ||
        /[\r\n]/.test(cookie.value)
      ) {
        continue
      }
      parts.push(`${cookie.name}=${cookie.value}`)
    }
    if (parts.length === 0) return undefined
    const header = parts.join('; ')
    return header.length > 0 && header.length <= MAX_COOKIE_HEADER_LENGTH
      ? header
      : undefined
  } catch {
    return undefined
  }
}

/**
 * "This one needs your login" is a short-lived, session-only record. It holds
 * the exact page origin and its visible host, never a cookie or a full URL.
 */
export function normalizeNeedsLoginState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const origin = originFromPageUrl(value.origin)
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  if (
    origin === null ||
    host.length === 0 ||
    host.length > 255 ||
    !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)
  ) {
    return null
  }
  const at = Number.isSafeInteger(value.at) && value.at > 0 ? value.at : Date.now()
  return { origin, host, at }
}

export async function readNeedsLoginState(chromeApi) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return null
  try {
    const stored = await session.get(NEEDS_LOGIN_STATE_KEY)
    return normalizeNeedsLoginState(stored && stored[NEEDS_LOGIN_STATE_KEY])
  } catch {
    return null
  }
}

export async function recordNeedsLoginState(chromeApi, value) {
  const state = normalizeNeedsLoginState(value)
  const session = storageArea(chromeApi, 'session')
  if (state === null || session === null) return false
  try {
    await session.set({ [NEEDS_LOGIN_STATE_KEY]: state })
    return true
  } catch {
    return false
  }
}

export async function clearNeedsLoginState(chromeApi) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return false
  try {
    await session.remove(NEEDS_LOGIN_STATE_KEY)
    return true
  } catch {
    return false
  }
}

/** Plain popup copy; the host is already validated by the state parser. */
export function needsLoginCopy(host) {
  const safe = typeof host === 'string' && host.length > 0 ? host : 'this site'
  return {
    message: `This download stayed in your browser because it needs your login on ${safe}.`,
    button: `Let DonDownload use my login on ${safe}`
  }
}

export async function readCaptureSettings(chromeApi) {
  const local = storageArea(chromeApi, 'local')
  if (local === null) return { ...DEFAULT_CAPTURE_SETTINGS, excludedOrigins: [] }
  try {
    const stored = await local.get(CAPTURE_SETTINGS_KEY)
    return normalizeCaptureSettings(stored && stored[CAPTURE_SETTINGS_KEY])
  } catch {
    return { ...DEFAULT_CAPTURE_SETTINGS, excludedOrigins: [] }
  }
}

export async function writeCaptureSettings(chromeApi, value) {
  const local = storageArea(chromeApi, 'local')
  if (local === null) return false
  try {
    await local.set({ [CAPTURE_SETTINGS_KEY]: normalizeCaptureSettings(value) })
    return true
  } catch {
    return false
  }
}

export async function readHandoffState(chromeApi) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) throw new Error('Session storage is unavailable.')
  const stored = await session.get(HANDOFF_STATE_KEY)
  return normalizeHandoffState(stored && stored[HANDOFF_STATE_KEY])
}

export function normalizeHandoffState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}

  function ids(input) {
    const result = []
    if (!Array.isArray(input)) return result
    for (const candidate of input) {
      if (
        Number.isSafeInteger(candidate) &&
        candidate > 0 &&
        !result.includes(candidate)
      ) {
        result.push(candidate)
      }
      if (result.length >= MAX_HANDOFF_IDS) break
    }
    return result
  }

  return {
    processed: ids(source.processed),
    pending: ids(source.pending)
  }
}

async function writeHandoffState(chromeApi, state) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return false
  try {
    await session.set({ [HANDOFF_STATE_KEY]: normalizeHandoffState(state) })
    return true
  } catch {
    return false
  }
}

/**
 * Reserve one browser download before any native call. If this cannot be
 * persisted, the caller must leave the browser download alone: without the
 * session record a respawned worker could hand off the same ID twice.
 */
const stateWrites = new WeakMap()

function updateHandoffState(chromeApi, update, fallback) {
  const previous = stateWrites.get(chromeApi) || Promise.resolve()
  const next = previous.catch(() => undefined).then(update).catch(() => fallback)
  stateWrites.set(chromeApi, next)
  return next
}

export function claimHandoffDownload(chromeApi, downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 1) {
    return Promise.resolve({ ok: false, reason: 'invalid-id' })
  }
  return updateHandoffState(chromeApi, async () => {
    const state = await readHandoffState(chromeApi)
    if (state.processed.includes(downloadId) || state.pending.includes(downloadId)) {
      return { ok: false, reason: 'duplicate' }
    }
    if (state.pending.length >= MAX_HANDOFF_IDS) {
      return { ok: false, reason: 'capacity' }
    }
    state.pending.push(downloadId)
    if (!(await writeHandoffState(chromeApi, state))) {
      return { ok: false, reason: 'storage-unavailable' }
    }
    return { ok: true }
  }, { ok: false, reason: 'storage-unavailable' })
}

/**
 * Mark an ID processed, optionally with an outcome. A failed write leaves the
 * pending reservation in place, which deliberately prevents retrying an
 * uncertain hand-off after the worker suspends.
 */
export function finishHandoffDownload(chromeApi, downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 1) return Promise.resolve(false)
  return updateHandoffState(chromeApi, async () => {
    const state = await readHandoffState(chromeApi)
    state.pending = state.pending.filter((id) => id !== downloadId)
    state.processed = [...state.processed.filter((id) => id !== downloadId), downloadId].slice(
      -MAX_HANDOFF_IDS
    )
    return writeHandoffState(chromeApi, state)
  }, false)
}

export async function rememberOptionsTarget(chromeApi, target) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return false
  const tabId =
    target && Number.isInteger(target.tabId) && target.tabId >= 0
      ? target.tabId
      : null
  const origin = originFromPageUrl(target && target.origin)
  if (tabId === null || origin === null) return false
  try {
    await session.set({ [OPTIONS_TARGET_KEY]: { tabId, origin } })
    return true
  } catch {
    return false
  }
}

export async function readOptionsTarget(chromeApi) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return null
  try {
    const stored = await session.get(OPTIONS_TARGET_KEY)
    const target = stored && stored[OPTIONS_TARGET_KEY]
    if (!target || !Number.isInteger(target.tabId) || target.tabId < 0) return null
    const origin = originFromPageUrl(target.origin)
    if (origin === null) return null
    return { tabId: target.tabId, origin }
  } catch {
    return null
  }
}
