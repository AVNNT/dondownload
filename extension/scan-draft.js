// Draft persistence for the popup's "Scan several links" textarea. Chrome
// closes the popup as soon as it loses focus, so a pasted list would be lost
// while the user copies the next link. Chrome's session storage keeps the raw
// text in memory only: it is never written to disk and never synced.

import { normalizeSupportedUrl } from './bridge.js'
import { MAX_SCAN_URLS, parseScanUrlList } from './scan-urls.js'

export const SCAN_DRAFT_KEY = 'dondownload:scan-links-draft'
/** A little over 10 long links, well below any storage quota concern. */
export const MAX_SCAN_DRAFT_LENGTH = 8 * 1024

function sessionStorage(chromeApi) {
  const storage = chromeApi && chromeApi.storage
  return storage && storage.session ? storage.session : null
}

function capDraft(value) {
  return typeof value === 'string' ? value.slice(0, MAX_SCAN_DRAFT_LENGTH) : ''
}

/** Read the stored draft. Missing session storage reads as an empty draft. */
export async function readScanDraft(chromeApi) {
  const storage = sessionStorage(chromeApi)
  if (storage === null) return ''
  try {
    const stored = await storage.get(SCAN_DRAFT_KEY)
    return capDraft(stored ? stored[SCAN_DRAFT_KEY] : '')
  } catch {
    return ''
  }
}

/** Store the raw text. An empty value removes the key instead of storing "". */
export async function saveScanDraft(chromeApi, value) {
  const storage = sessionStorage(chromeApi)
  if (storage === null) return false
  const text = capDraft(value)
  try {
    if (text.length === 0) await storage.remove(SCAN_DRAFT_KEY)
    else await storage.set({ [SCAN_DRAFT_KEY]: text })
    return true
  } catch {
    return false
  }
}

/** Forget the draft after a successful send or an explicit Clear. */
export async function clearScanDraft(chromeApi) {
  const storage = sessionStorage(chromeApi)
  if (storage === null) return false
  try {
    await storage.remove(SCAN_DRAFT_KEY)
    return true
  } catch {
    return false
  }
}

/**
 * Append the active tab URL to the raw textarea value.
 *
 * Pure so the popup and tests share exactly one rule: only a supported http(s)
 * URL is added, an already-listed URL is ignored, and the list never grows past
 * the same 10-link cap the parser and the desktop Scan tab enforce.
 */
export function appendScanTabUrl(value, rawUrl, maximum = MAX_SCAN_URLS) {
  const text = typeof value === 'string' ? value : ''
  const normalized = normalizeSupportedUrl(rawUrl)
  if (!normalized.ok) {
    return { text, added: false, reason: 'unsupported' }
  }

  const limit = Math.max(1, Math.min(maximum, MAX_SCAN_URLS))
  const parsed = parseScanUrlList(text, limit)
  if (parsed.urls.includes(normalized.url)) {
    return { text, added: false, reason: 'duplicate' }
  }
  if (parsed.urls.length >= limit) {
    return { text, added: false, reason: 'limit' }
  }

  const trimmed = text.replace(/\s+$/, '')
  const next = trimmed.length === 0 ? normalized.url : `${trimmed}\n${normalized.url}`
  return { text: next, added: true, reason: 'added' }
}
