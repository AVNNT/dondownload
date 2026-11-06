// Strict parsing for the `?grant=<origin>` onboarding link. Chromium closes the
// toolbar popup as soon as it shows an optional-permission prompt, so the popup
// opens the welcome page in a normal tab and the actual request happens there
// after a user click. The parameter must name one canonical http(s) origin; a
// path, query, fragment, credentials, wildcard or non-http scheme is rejected.

import { originToMatchPattern } from './site-policy.js'

export const GRANT_PARAM = 'grant'

/** Return the exact origin named by a grant parameter, or null. */
export function parseGrantParameter(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw.length === 0 || raw.length > 2048) return null
  // eslint-disable-next-line no-control-regex -- rejecting control characters and wildcards is the security intent here
  if (/[\s*?"'\u0000-\u001f\u007f]/.test(raw)) return null

  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.origin === 'null') return null
  if (url.username || url.password) return null
  // A canonical origin has no path, query, fragment or default-port spelling.
  if (url.origin !== raw) return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  return originToMatchPattern(url.origin) === null ? null : url.origin
}

/**
 * Read the grant parameter without losing the difference between "absent" and
 * "present but invalid", so the welcome page can show an honest message.
 */
export function readGrantParameter(search) {
  let params
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '')
  } catch {
    return { present: true, origin: null }
  }
  if (!params.has(GRANT_PARAM)) return { present: false, origin: null }
  return { present: true, origin: parseGrantParameter(params.get(GRANT_PARAM)) }
}

/** Build the welcome-page URL for one exact origin, or null when invalid. */
export function grantPageUrl(baseUrl, origin) {
  const exact = parseGrantParameter(origin)
  if (exact === null) return null
  try {
    const url = new URL(baseUrl)
    url.searchParams.set(GRANT_PARAM, exact)
    return url.href
  } catch {
    return null
  }
}
