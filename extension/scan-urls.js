// Popup-side parsing for "Scan several links". A multi-line paste is trimmed,
// deduplicated and capped exactly like the desktop Scan tab. The desktop
// validates everything again; this copy exists for clear popup feedback and to
// group URLs by their exact origin before a cookie is ever read.

import { normalizeSupportedUrl } from './bridge.js'
import { originFromUrl } from './site-policy.js'

export const MAX_SCAN_URLS = 10

/**
 * Parse one URL per line. Empty lines are ignored; URLs are normalized and
 * deduplicated, and only the first `maximum` survive. Invalid lines are
 * reported (display-only) instead of being silently dropped.
 */
export function parseScanUrlList(value, maximum = MAX_SCAN_URLS) {
  const limit = Math.max(1, Math.min(maximum, MAX_SCAN_URLS))
  const urls = []
  const seen = new Set()
  const invalid = []
  let duplicates = 0
  const text = typeof value === 'string' ? value : ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const normalized = normalizeSupportedUrl(line)
    if (!normalized.ok) {
      invalid.push(line.slice(0, 400))
      continue
    }
    if (seen.has(normalized.url)) {
      duplicates += 1
      continue
    }
    seen.add(normalized.url)
    urls.push(normalized.url)
  }
  const kept = urls.slice(0, limit)
  return {
    urls: kept,
    duplicates,
    invalid,
    overLimit: urls.length - kept.length
  }
}

/**
 * Group normalized URLs by exact origin, preserving first-seen order. A URL
 * whose origin cannot be read is dropped rather than guessed.
 */
export function groupScanUrlsByOrigin(urls) {
  const groups = []
  const byOrigin = new Map()
  for (const url of Array.isArray(urls) ? urls : []) {
    const origin = originFromUrl(url)
    if (origin === null) continue
    let group = byOrigin.get(origin)
    if (group === undefined) {
      group = { origin, urls: [] }
      byOrigin.set(origin, group)
      groups.push(group)
    }
    if (!group.urls.includes(url)) group.urls.push(url)
  }
  return groups
}

/**
 * Build one native scan message per URL. The origin recorded when the cookie
 * was read must still match the URL's origin, so a cookie can never be sent
 * with a URL of another site even if a caller passes a mixed entry.
 */
export function buildScanSends(entries) {
  const sends = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const url = typeof entry.url === 'string' ? entry.url : ''
    const origin = typeof entry.origin === 'string' ? entry.origin : null
    if (origin === null || originFromUrl(url) !== origin) continue
    sends.push({
      url,
      ...(typeof entry.cookie === 'string' ? { cookie: entry.cookie } : {})
    })
  }
  return sends
}
