import { isObviousDirectFileUrl } from '@shared/scanner'
import { normalizeHttpUrl } from '@shared/validation'
import { isLikelyMediaUrl } from './dnd'

/**
 * Add-dialog link classification. One link field feeds everything, so the
 * parsed result decides which flow renders: a direct file download, media
 * qualities, a page to scan, or (several links) batch submission.
 */
export type AddLinkKind = 'file' | 'media' | 'page'

export interface ParsedAddLink {
  url: string
  kind: AddLinkKind
}

export interface ParsedAddInput {
  /** Valid, normalized http(s) links, deduplicated in input order. */
  links: ParsedAddLink[]
  /** Lines that could not be parsed as http(s) URLs, in input order. */
  invalid: string[]
}

export function classifyAddUrl(url: string): AddLinkKind {
  if (isObviousDirectFileUrl(url)) return 'file'
  if (isLikelyMediaUrl(url)) return 'media'
  return 'page'
}

/**
 * Parse the single link field. Lines are trimmed; blank lines are ignored;
 * each remaining line must be a full http(s) URL (same rule the batch form
 * used). Duplicated links collapse to their first occurrence.
 */
export function parseAddInput(text: string): ParsedAddInput {
  const links: ParsedAddLink[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let normalized: string
    try {
      normalized = normalizeHttpUrl(line)
    } catch {
      invalid.push(line)
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    links.push({ url: normalized, kind: classifyAddUrl(normalized) })
  }

  return { links, invalid }
}

/** True when several links were pasted, which submits as one batch. */
export function isBatchInput(parsed: ParsedAddInput): boolean {
  return parsed.links.length > 1
}

/** Footer summary for the primary action: how many download, how many scan. */
export function addPlanSummary(parsed: ParsedAddInput): {
  downloadCount: number
  scanCount: number
} {
  let downloadCount = 0
  let scanCount = 0
  for (const link of parsed.links) {
    if (link.kind === 'page') scanCount += 1
    else downloadCount += 1
  }
  return { downloadCount, scanCount }
}

/** File name inferred from a URL path, used as the display label. */
export function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (!last) return parsed.hostname
    return decodeURIComponent(last)
  } catch {
    return url
  }
}
