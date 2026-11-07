/**
 * Gofile share-link policy, shared by the main process, the native bridge and
 * the renderer.
 *
 * A `https://gofile.io/d/<id>` page is a JavaScript application whose file list
 * only exists once the user's own signed-in browser rendered it. DonDownload
 * therefore never scrapes Gofile, never calls `api.gofile.io` and never creates
 * a guest account: the share is a browser-only card, the extension reads the
 * rendered rows from the user's tab, and the download URLs it reports require
 * the `accountToken` cookie the browser already holds.
 *
 * This module is pure: no Node, no DOM, no network.
 */

/** Gofile share ids are short URL-safe tokens, never a path. */
export const GOFILE_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/

/** One extraction never reports more files than this. */
export const MAX_GOFILE_FILES = 500
export const MAX_GOFILE_NAME_LENGTH = 240
export const MAX_GOFILE_SIZE_BYTES = 1e13
/** Subfolders rendered inside one share are followed at most this deep. */
export const MAX_GOFILE_DEPTH = 2
/** How long the content script waits for the rendered file list. */
export const GOFILE_LIST_WAIT_MS = 15_000

/** The stable, user-facing explanation on a browser-only share card. */
export const GOFILE_BROWSER_ONLY_REASON =
  'Gofile share links only work in your signed-in browser. Open it, then scan that tab with the DonDownload extension to list the files.'

/** The action label on a browser-only share card. */
export const GOFILE_OPEN_IN_BROWSER_ACTION = 'Open in browser to list files'

export const GOFILE_SHARE_NOT_FOUND_REASON =
  'This Gofile share could not be found. It may have been removed or the link is wrong.'

export const GOFILE_SHARE_PASSWORD_REASON =
  'This Gofile share is password protected. DonDownload does not guess or bypass share passwords.'

export const GOFILE_SHARE_PREMIUM_REASON =
  'This Gofile share is limited to premium accounts. DonDownload does not create accounts or bypass that limit.'

export const GOFILE_SHARE_EMPTY_REASON =
  'This Gofile share has no downloadable files.'

export const GOFILE_SHARE_TIMEOUT_REASON =
  'The Gofile page did not finish rendering its file list. Reload the share in your browser and scan it again.'

/**
 * A rendered row whose download URL the page never exposed. The real frontend
 * starts the transfer from a transient anchor, so the URL only exists inside the
 * browser download the row's button creates.
 */
export const GOFILE_ROW_UNRESOLVED_REASON =
  'The Gofile page did not expose a download link for this file. Reload the share and scan it again.'

/** What the extension reports about one share after reading the live page. */
export const GOFILE_SHARE_STATUSES = [
  'ok',
  'empty',
  'not-found',
  'password',
  'premium',
  'timeout'
] as const
export type GofileShareStatus = (typeof GOFILE_SHARE_STATUSES)[number]

export function isGofileShareStatus(value: unknown): value is GofileShareStatus {
  return (
    typeof value === 'string' &&
    (GOFILE_SHARE_STATUSES as readonly string[]).includes(value)
  )
}

/** `gofile.io`, `www.gofile.io` and every `store<N>.gofile.io` host. */
export function isGofileHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false
  const host = hostname.toLowerCase()
  return (
    host === 'gofile.io' ||
    host === 'www.gofile.io' ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.gofile\.io$/.test(host)
  )
}

/** Only the public share site itself, never a `store<N>` download host. */
export function isGofileShareHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false
  const host = hostname.toLowerCase()
  return host === 'gofile.io' || host === 'www.gofile.io'
}

export interface GofileShareLink {
  id: string
  /** Canonical public share link with no query, fragment or credentials. */
  canonicalUrl: string
}

/**
 * Parse a public share link. Only `https://gofile.io/d/<id>` (or the `www`
 * host) qualifies: credentials, another path shape, a query string or a
 * fragment are rejected instead of being normalized away.
 */
export function parseGofileShareUrl(raw: string): GofileShareLink | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (!isGofileShareHostname(parsed.hostname)) return null
  if (parsed.search !== '' || parsed.hash !== '') return null
  const match = /^\/d\/([^/]+)\/?$/.exec(parsed.pathname)
  if (match === null) return null
  const id = match[1]!
  if (!GOFILE_SHARE_ID_PATTERN.test(id)) return null
  return { id, canonicalUrl: `https://gofile.io/d/${id}` }
}

/**
 * A file download URL the rendered page exposed. It must be HTTPS and live on
 * `gofile.io` or one of its `store<N>` hosts, and its path must be a download
 * path. Anything else is rejected: the app never downloads from a foreign host
 * because a page said so.
 */
export function isGofileDownloadUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (!isGofileHostname(parsed.hostname)) return false
  return /^\/download\//.test(parsed.pathname)
}

/**
 * The one-job Gofile cookie was read for `gofile.io`, but the download itself is
 * served by `store<N>.gofile.io`. It is therefore scoped to the Gofile family
 * and to nothing else: never another site, never a lookalike domain.
 */
export function gofileCookieApplies(
  cookieHost: string,
  targetHost: string
): boolean {
  if (!isGofileHostname(cookieHost)) return false
  return isGofileHostname(targetHost)
}

/** The fixed, safe explanation for a share that could not be listed. */
export function gofileStatusReason(status: GofileShareStatus): string | null {
  switch (status) {
    case 'not-found':
      return GOFILE_SHARE_NOT_FOUND_REASON
    case 'password':
      return GOFILE_SHARE_PASSWORD_REASON
    case 'premium':
      return GOFILE_SHARE_PREMIUM_REASON
    case 'empty':
      return GOFILE_SHARE_EMPTY_REASON
    case 'timeout':
      return GOFILE_SHARE_TIMEOUT_REASON
    default:
      return null
  }
}
