import {
  MAX_GOFILE_FILES,
  parseGofileShareUrl,
  type GofileShareLink
} from '@shared/gofile'
import type { ScanGofileFile } from '@shared/scanBridge'

/**
 * Gofile support for the Smart Link Scanner.
 *
 * A `https://gofile.io/d/<id>` page is a JavaScript application, and Gofile's
 * own API requires a token the app must not scrape or create. The scanner
 * therefore keeps the share as a browser-only card, and the extension reports
 * the rows the user's own signed-in tab rendered. This module holds the pure
 * conversions between those two shapes; nothing here fetches, probes or logs.
 */

/** Canonical public share link for a URL, or null when it is not one. */
export function gofileShareOf(raw: string): GofileShareLink | null {
  return parseGofileShareUrl(raw)
}

/** True for a canonical public share link. */
export function isGofileShareUrl(raw: string): boolean {
  return gofileShareOf(raw) !== null
}

/**
 * Deduplicate and cap the reported files. The bridge already validated each
 * entry; this keeps the session's own limits independent of the message size.
 */
export function normalizeGofileFiles(
  files: readonly ScanGofileFile[]
): ScanGofileFile[] {
  const seen = new Set<string>()
  const kept: ScanGofileFile[] = []
  for (const file of files) {
    if (kept.length >= MAX_GOFILE_FILES) break
    if (seen.has(file.url)) continue
    seen.add(file.url)
    kept.push(file)
  }
  return kept
}
