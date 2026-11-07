// Pure per-site permission and content-script registration policy for the
// optional video overlay. This module has no Chrome API calls so it can be
// tested directly and reused by the popup, background worker and tests.
//
// The overlay is never declared as an always-on content script. The manifest
// only *declares* optional HTTP(S) host patterns; the popup requests the exact
// origin of the active tab from a user click.

export const OVERLAY_SCRIPT_PREFIX = 'dondownload-overlay-'
export const OVERLAY_BOOTSTRAP_FILE = 'overlay-bootstrap.js'
export const OVERLAY_CORE_FILE = 'overlay-core.js'
export const OVERLAY_RUNTIME_FILE = 'overlay-runtime.js'
export const OVERLAY_UI_FILE = 'overlay-ui.js'
export const OVERLAY_QUALITIES_FILE = 'overlay-qualities.js'
export const OVERLAY_KVS_FILE = 'overlay-kvs.js'
export const OVERLAY_CAPTURE_FILE = 'overlay-capture.js'
export const OVERLAY_ENTRY_FILE = 'overlay.js'

// Order matters: core decisions, shared runtime state, then the feature files,
// and finally the entry point that starts the overlay.
export const OVERLAY_SCRIPT_FILES = Object.freeze([
  OVERLAY_CORE_FILE,
  OVERLAY_RUNTIME_FILE,
  OVERLAY_UI_FILE,
  OVERLAY_QUALITIES_FILE,
  OVERLAY_KVS_FILE,
  OVERLAY_CAPTURE_FILE,
  OVERLAY_ENTRY_FILE
])

export const OVERLAY_MESSAGE_TYPES = Object.freeze({
  ENABLE: 'dondownload:overlay-enable',
  SYNC: 'dondownload:overlay-sync',
  DISABLE: 'dondownload:overlay-disable',
  DISABLE_SITE: 'dondownload:overlay-disable-site',
  DISABLED: 'dondownload:overlay-disabled',
  READY: 'dondownload:overlay-ready',
  // The lightweight all-sites bootstrap asks the worker to load the full
  // overlay files only for a tab that actually uses the feature.
  ENSURE: 'dondownload:overlay-ensure'
})

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Parse a page URL that may receive the overlay. Embedded credentials are
 * rejected, matching the manual capture URL policy.
 */
export function parseSupportedPageUrl(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw.length === 0 || raw.length > 4096) return null
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null

  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) return null
  if (!url.hostname || url.origin === 'null') return null
  if (url.username || url.password) return null

  return { url: url.href, origin: url.origin }
}

/** Return the canonical origin for an HTTP(S) URL, or null. */
export function originFromUrl(value) {
  const parsed = parseSupportedPageUrl(value)
  return parsed ? parsed.origin : null
}

/**
 * Convert an exact origin into the narrowest Chrome match pattern for that
 * origin. Wildcards, paths, queries and fragments are rejected; callers must
 * pass a canonical `URL.origin` value.
 */
export function originToMatchPattern(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 2048) {
    return null
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\s*?\u0000-\u001f\u007f]/.test(origin)) return null

  let url
  try {
    url = new URL(origin)
  } catch {
    return null
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) return null
  if (!url.hostname || url.origin === 'null') return null
  if (url.username || url.password) return null
  if (url.origin !== origin) return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null

  return `${origin}/*`
}

/** Recover the exact origin from one of this extension's match patterns. */
export function matchPatternToOrigin(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return null
  if (!pattern.endsWith('/*')) return null
  const base = pattern.slice(0, -2)
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\s*?\u0000-\u001f\u007f]/.test(base)) return null
  const origin = originFromUrl(base)
  if (origin === null || origin !== base) return null
  return originToMatchPattern(origin) === pattern ? origin : null
}

/**
 * Deterministic content-script registration id for an origin. A stable id lets
 * the extension update or remove exactly one registration per opted-in site.
 */
export function overlayScriptId(origin) {
  if (originToMatchPattern(origin) === null) return null

  // FNV-1a 32-bit, encoded as unsigned hex.
  let hash = 0x811c9dc5
  for (let index = 0; index < origin.length; index += 1) {
    hash ^= origin.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${OVERLAY_SCRIPT_PREFIX}${hash.toString(16).padStart(8, '0')}`
}

/**
 * The only content-script registration this extension ever creates: one exact
 * origin, main frame, isolated world. There is no <all_urls> registration.
 */
export function overlayRegistrationForOrigin(origin) {
  const id = overlayScriptId(origin)
  const pattern = originToMatchPattern(origin)
  if (id === null || pattern === null) return null

  return {
    id,
    matches: [pattern],
    js: [...OVERLAY_SCRIPT_FILES],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
    world: 'ISOLATED'
  }
}

/** Fixed id of the one NDM-style "all sites" overlay registration. */
export const OVERLAY_ALL_SITES_ID = 'dondownload-overlay-all-sites'

/** The broad host patterns the all-sites overlay and detection need. */
export const OVERLAY_ALL_SITES_MATCHES = Object.freeze([
  'http://*/*',
  'https://*/*'
])

/**
 * The single persistent registration used when the user turns on "Use
 * DonDownload on all sites". It injects only the tiny bootstrap: the full
 * overlay files are loaded later, on demand, for a page that actually has or
 * hovers a video. Ordinary pages therefore pay for one small script instead of
 * the whole overlay, and no MutationObserver or timer runs there.
 *
 * The per-origin registration still uses the full file list because the user
 * explicitly enabled that exact site.
 */
export function overlayAllSitesRegistration() {
  return {
    id: OVERLAY_ALL_SITES_ID,
    matches: [...OVERLAY_ALL_SITES_MATCHES],
    js: [OVERLAY_BOOTSTRAP_FILE],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
    world: 'ISOLATED'
  }
}

/**
 * True only when all-sites mode should be active: the user turned on the
 * floating trigger and all-sites detection, and the broad host grant is present.
 */
export function allSitesOverlayWanted(settings, broadHostsGranted) {
  return Boolean(
    settings &&
      settings.floatingTriggerEnabled !== false &&
      settings.detectAllSites === true &&
      broadHostsGranted === true
  )
}

/** True for a stored registration that is exactly the all-sites one. */
export function isAllSitesRegistration(registration) {
  return Boolean(
    registration &&
      typeof registration === 'object' &&
      registration.id === OVERLAY_ALL_SITES_ID
  )
}

/** True only when the exact origin pattern is currently granted. */
export function hasExactOriginGrant(grantedOrigins, origin) {
  if (!Array.isArray(grantedOrigins)) return false
  const pattern = originToMatchPattern(origin)
  return pattern !== null && grantedOrigins.includes(pattern)
}

/**
 * Extract the origin from a stored registration, but only when the registration
 * has the canonical shape for that origin. Anything else is treated as orphaned
 * and can be removed by reconciliation.
 */
export function overlayOriginFromRegistration(registration) {
  if (!registration || typeof registration !== 'object') return null
  const id = typeof registration.id === 'string' ? registration.id : ''
  if (!id.startsWith(OVERLAY_SCRIPT_PREFIX)) return null
  const matches = Array.isArray(registration.matches) ? registration.matches : []
  if (matches.length !== 1) return null
  const origin = matchPatternToOrigin(matches[0])
  if (origin === null) return null
  if (overlayScriptId(origin) !== id) return null

  const js = Array.isArray(registration.js) ? registration.js : []
  if (
    js.length !== OVERLAY_SCRIPT_FILES.length ||
    js.some((file, index) => file !== OVERLAY_SCRIPT_FILES[index])
  ) {
    return null
  }
  return origin
}
