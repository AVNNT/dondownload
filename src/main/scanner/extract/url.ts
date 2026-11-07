/**
 * Canonical URL handling for the link scanner. Normalization is deliberately
 * conservative: it only removes values that cannot identify a different file
 * and never rewrites the path.
 */

import { keepsUrlFragment } from '@shared/urlFragment'

const TRACKING_PARAMETERS = new Set(['fbclid'])

function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower) || lower === 'si'
}

/** Return a stable dedupe key. Throws for a non-HTTP(S) or malformed URL. */
export function normalizeScanUrl(raw: string): string {
  const trimmed = raw.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > 4096 ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new Error('The URL is not valid.')
  }

  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) links are supported.')
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error('The URL is not valid.')
  }

  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')

  // A fragment is a client-side anchor for every normal host, but a public MEGA
  // key lives there: dropping it would make a valid link unusable. The full
  // link stays in main-process state only and is redacted before it is logged
  // or published.
  if (!keepsUrlFragment(parsed.hostname)) parsed.hash = ''

  const entries: Array<[string, string]> = []
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParameter(name)) entries.push([name, value])
  }
  entries.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0
  )

  const search = new URLSearchParams()
  for (const [name, value] of entries) search.append(name, value)
  parsed.search = search.toString()

  return parsed.href
}

/** Resolve an extracted link against a document/base URL; HTTP(S) only. */
export function resolveScanUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('#')
  ) {
    return null
  }
  try {
    const resolved = new URL(trimmed, baseUrl)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null
    }
    if (resolved.username || resolved.password) return null
    return normalizeScanUrl(resolved.href)
  } catch {
    return null
  }
}

export function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function pathnameOf(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return ''
  }
}
