import {
  MAX_SCAN_NAME_LENGTH,
  type ScanCategory,
  type ScanItemKind
} from '@shared/scanner'
import { isMegaHost } from '@shared/urlFragment'
import { pathnameOf } from './extract/url'
import {
  hasSingleVideoRules,
  isKnownVideoHost,
  isSingleVideoPageUrl,
  isVideoHostVideoUrl
} from './videoHosts'

export interface ClassifyScanCandidateInput {
  url: string
  /** Visible anchor text, JSON-LD name or a similar safe hint. */
  nameHint?: string | null
  contentType?: string | null
  contentDisposition?: string | null
  /** An anchor explicitly asked for a file download. */
  downloadAttribute?: boolean
  /** Discourse/forum attachment anchor. */
  isAttachment?: boolean
  /** Found in an inline script (manifest or media URL). */
  fromScript?: boolean
  /** An iframe embed rather than a direct page anchor. */
  isEmbed?: boolean
}

export interface ClassifiedScanCandidate {
  category: ScanCategory
  kind: ScanItemKind
  /** Display name after sanitizing; bounded and never a full URL. */
  name: string
  /** Extension used for the guess, lower-case and without the dot. */
  extension: string | null
}

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'm4v',
  'mkv',
  'mov',
  'avi',
  'wmv',
  'flv',
  'ogv',
  'mpeg',
  'mpg',
  '3gp',
  'ts'
])
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'aiff'
])
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif'
])
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'odt',
  'rtf',
  'txt',
  'md',
  'csv',
  'xls',
  'xlsx',
  'ods',
  'ppt',
  'pptx',
  'odp',
  'epub',
  'json',
  'xml',
  'log',
  'srt',
  'vtt'
])
const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  'iso',
  'img',
  'dmg'
])
const PAGE_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'php',
  'asp',
  'aspx',
  'jsp',
  'cfm'
])
const SCRIPT_EXTENSIONS = new Set(['funscript'])
const STREAM_EXTENSIONS = new Set(['m3u8', 'mpd'])

/**
 * Path keywords that strongly suggest a single video/player page. The keyword
 * must be followed by an id-like segment (`/video/123`, `/v/abc`) or, for
 * `/watch`, carry a `v` query parameter. Listings (`/videos`, `/tags/…`),
 * random articles and direct file paths are deliberately rejected.
 */
const VIDEO_PAGE_SEGMENTS = new Set([
  'watch',
  'video',
  'videos',
  'v',
  'embed',
  'player',
  'clip',
  'clips',
  'movie',
  'movies',
  'episode',
  'episodes',
  'stream',
  'streams',
  'reel',
  'reels',
  'shorts'
])

const NON_VIDEO_PAGE_SEGMENTS = new Set([
  'tag',
  'tags',
  'category',
  'categories',
  'genre',
  'genres',
  'search',
  'login',
  'signin',
  'sign-in',
  'signup',
  'register',
  'account',
  'settings',
  'playlist',
  'playlists',
  'results',
  'feed',
  'user',
  'users',
  'profile'
])

/**
 * Hosts that only serve page assets: thumbnails, preview sprites and player
 * fragments. A URL on one of them is never a watchable page, even when its path
 * carries a video-looking segment such as `/videos/202310/23/…`.
 */
const CDN_ASSET_DOMAINS: readonly string[] = [
  'phncdn.com',
  'xvideos-cdn.com',
  'xnxx-cdn.com',
  'xhcdn.com',
  'eporner.com'
]

/** Label prefixes that mark an asset host (`static.`, `img.`, `thumb.`, `cdn.`). */
const CDN_ASSET_HOST_PREFIXES: readonly string[] = [
  'static.',
  'img.',
  'images.',
  'thumb.',
  'thumbs.',
  'cdn.'
]

function isCdnAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.length === 0) return false
  for (const domain of CDN_ASSET_DOMAINS) {
    if (!host.endsWith(`.${domain}`)) continue
    // eporner.com serves its videos from www; every other subdomain is an asset
    // host. The other domains are asset-only at every level.
    return domain === 'eporner.com' ? !host.startsWith('www.') : true
  }
  return CDN_ASSET_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))
}

// These patterns run once per candidate (hundreds on a large page); keeping
// them at module scope avoids recompiling the same expression in every call.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const COLLAPSE_WHITESPACE = /\s+/g
const PATH_EXTENSION = /\.([a-z0-9]{1,12})$/i
const TRAILING_SLASHES = /\/+$/
const CONTENT_DISPOSITION_ENCODED = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i
const CONTENT_DISPOSITION_PLAIN =
  /filename\s*=\s*("([^"]*)"|[^;]+)/i
const QUOTED_VALUE = /^"|"$/g
const PIXELDRAIN_FILE_PATH = /^\/u\/[A-Za-z0-9_-]{4,64}\/?$/
const MEGA_FILE_PATH = /^\/(?:embed\/)?file\/[A-Za-z0-9_-]{6,16}$/
const MEGA_FOLDER_PATH =
  /^\/folder\/[A-Za-z0-9_-]{6,16}(?:\/file\/[A-Za-z0-9_-]{6,16})?$/
const EXTENSION_HINT = /\.([a-z0-9]{1,12})$/i

function safeName(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(COLLAPSE_WHITESPACE, ' ')
    .trim()
  const bounded = Array.from(cleaned).slice(0, MAX_SCAN_NAME_LENGTH).join('').trim()
  return bounded.length > 0 ? bounded : fallback
}

function extensionOfPath(path: string): string | null {
  const trimmed = path.replace(TRAILING_SLASHES, '')
  const match = PATH_EXTENSION.exec(trimmed)
  return match ? match[1]!.toLowerCase() : null
}

export function extensionFromUrl(url: string): string | null {
  return extensionOfPath(pathnameOf(url))
}

/**
 * Parse the file name from a Content-Disposition header. Only the basename is
 * used; path separators are rejected so the value cannot escape a directory.
 */
export function filenameFromContentDisposition(
  value: string | null | undefined
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const encoded = CONTENT_DISPOSITION_ENCODED.exec(value)
  const plain = CONTENT_DISPOSITION_PLAIN.exec(value)
  let candidate = encoded?.[1] ?? plain?.[2] ?? plain?.[1] ?? null
  if (candidate === null) return null
  candidate = candidate.trim().replace(QUOTED_VALUE, '')
  if (candidate.length === 0 || candidate.length > 1024) return null
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  const base = candidate.split(/[\\/]/).pop() ?? ''
  return base.trim().length > 0 ? base : null
}

function categoryForExtension(extension: string | null): ScanCategory | null {
  if (extension === null) return null
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script'
  if (VIDEO_EXTENSIONS.has(extension) || STREAM_EXTENSIONS.has(extension)) {
    return 'video'
  }
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
  if (PAGE_EXTENSIONS.has(extension)) return 'page'
  return null
}

function categoryForContentType(contentType: string): ScanCategory | null {
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    return 'page'
  }
  if (
    mediaType === 'application/vnd.apple.mpegurl' ||
    mediaType === 'application/x-mpegurl' ||
    mediaType === 'application/mpegurl' ||
    mediaType === 'application/dash+xml'
  ) {
    return 'video'
  }
  if (mediaType.startsWith('video/')) return 'video'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType.startsWith('image/')) return 'image'
  if (
    mediaType === 'application/pdf' ||
    mediaType === 'application/msword' ||
    mediaType.startsWith('application/vnd.openxmlformats-officedocument.') ||
    mediaType === 'application/vnd.oasis.opendocument.text' ||
    mediaType === 'application/rtf' ||
    mediaType === 'text/plain' ||
    mediaType === 'text/markdown' ||
    mediaType === 'text/csv' ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'text/xml'
  ) {
    return 'document'
  }
  if (
    mediaType === 'application/zip' ||
    mediaType === 'application/x-zip-compressed' ||
    mediaType === 'application/x-rar-compressed' ||
    mediaType === 'application/vnd.rar' ||
    mediaType === 'application/x-7z-compressed' ||
    mediaType === 'application/gzip' ||
    mediaType === 'application/x-gzip' ||
    mediaType === 'application/x-tar' ||
    mediaType === 'application/x-bzip2' ||
    mediaType === 'application/zstd'
  ) {
    return 'archive'
  }
  return null
}

export function isVideoPageHost(hostname: string): boolean {
  return isKnownVideoHost(hostname)
}

/**
 * Conservative, network-free hint that a URL is a single video page rather
 * than an article or a direct file. It is used for video cards that cannot be
 * resolved (browser-only) and for deciding whether a followed link is worth a
 * bounded fetch. It never turns a URL into a direct file.
 *
 * A media or image extension, and an asset host, are checked before any path
 * rule: a CDN thumbnail or a preview sprite keeps a video-looking path such as
 * `/videos/202310/23/<id>/original/…` without ever being a watchable page.
 *
 * Hosts with an explicit single-video rule decide alone, so their listing,
 * channel, model, category and search pages never look like a video.
 */
export function isLikelyVideoPageUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false

  const path = pathnameOf(parsed.href).replace(/\/+$/, '')
  const extension = extensionOfPath(path)
  if (extension !== null && !PAGE_EXTENSIONS.has(extension)) return false
  if (isCdnAssetHost(parsed.hostname)) return false
  if (hasSingleVideoRules(parsed.hostname)) {
    return isSingleVideoPageUrl(parsed.href)
  }

  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase()
      } catch {
        return segment.toLowerCase()
      }
    })
  if (segments.length === 0) return false

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined || !VIDEO_PAGE_SEGMENTS.has(segment)) continue
    const next = segments[index + 1]
    if (next !== undefined) {
      // `/videos` and `/video/videos` are listings, not a single video.
      if (NON_VIDEO_PAGE_SEGMENTS.has(next)) continue
      if (VIDEO_PAGE_SEGMENTS.has(next)) continue
      if (next.length > 0 && next.length <= 128) return true
      continue
    }
    if (segment === 'watch' && hasNonEmptyQuery(parsed, 'v')) return true
    if (
      (segment === 'video' || segment === 'v') &&
      (hasNonEmptyQuery(parsed, 'v') || hasNonEmptyQuery(parsed, 'id'))
    ) {
      return true
    }
  }
  return false
}

function hasNonEmptyQuery(parsed: URL, key: string): boolean {
  const value = parsed.searchParams.get(key)
  return typeof value === 'string' && value.trim().length > 0
}

function displayNameFor(
  input: ClassifyScanCandidateInput,
  contentDispositionFilename: string | null,
  extension: string | null
): string {
  if (contentDispositionFilename !== null) {
    return safeName(contentDispositionFilename, 'download')
  }
  if (typeof input.nameHint === 'string' && input.nameHint.trim().length > 0) {
    return safeName(input.nameHint, 'download')
  }
  const path = pathnameOf(input.url)
  const segment = path.split('/').filter(Boolean).pop() ?? ''
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // Keep the raw segment if it is not valid percent-encoding.
  }
  if (decoded.length > 0) return safeName(decoded, 'download')

  let host = ''
  try {
    host = new URL(input.url).hostname
  } catch {
    host = 'download'
  }
  if (extension === null) return safeName(host, 'download')
  return safeName(`${host}.${extension}`, 'download')
}

/**
 * Guess a category without any network access. Every extension-only guess is
 * unverified; `verified` is owned by the bounded probe in the main process.
 */
export function classifyScanCandidate(
  input: ClassifyScanCandidateInput
): ClassifiedScanCandidate {
  let hostname = ''
  try {
    hostname = new URL(input.url).hostname.toLowerCase()
  } catch {
    hostname = ''
  }

  const contentDispositionFilename = filenameFromContentDisposition(
    input.contentDisposition
  )
  const pathExtension = extensionFromUrl(input.url)
  const hintedExtension =
    contentDispositionFilename !== null
      ? extensionOfPath(contentDispositionFilename)
      : null
  const extension =
    hintedExtension ?? pathExtension ?? extensionOfExtensionHint(input.nameHint)
  const name = displayNameFor(
    input,
    contentDispositionFilename,
    extension
  )

  const contentTypeCategory =
    typeof input.contentType === 'string' && input.contentType.length > 0
      ? categoryForContentType(input.contentType)
      : null

  // An HTML response is a page even when the path ends in .mp4. The probe owns
  // the final reclassification after it observes the real response.
  if (contentTypeCategory === 'page' && extension !== 'funscript') {
    return { category: 'page', kind: 'page-link', name, extension }
  }

  // A JSON or octet-stream response for a .funscript is a valid script file.
  if (extension !== null && SCRIPT_EXTENSIONS.has(extension)) {
    return { category: 'script', kind: 'file', name, extension }
  }

  // Linked video pages are listed as page links and resolved by a later phase.
  // An unknown host is trusted only for a conservative single-video path.
  if (
    hostname.length > 0 &&
    (isVideoHostVideoUrl(input.url) || isLikelyVideoPageUrl(input.url)) &&
    (pathExtension === null || !VIDEO_EXTENSIONS.has(pathExtension))
  ) {
    return { category: 'video', kind: 'page-link', name, extension }
  }

  if (input.isEmbed === true) {
    return isVideoHostVideoUrl(input.url)
      ? { category: 'video', kind: 'page-link', name, extension }
      : { category: 'page', kind: 'page-link', name, extension }
  }

  if (contentTypeCategory !== null) {
    return {
      category: contentTypeCategory,
      kind: contentTypeCategory === 'page' ? 'page-link' : 'file',
      name,
      extension
    }
  }

  const extensionCategory = categoryForExtension(extension)
  if (extensionCategory === 'page') {
    return { category: 'page', kind: 'page-link', name, extension }
  }
  if (extensionCategory !== null) {
    return { category: extensionCategory, kind: 'file', name, extension }
  }

  // Pixeldrain's extensionless /u/<id> endpoint is a direct file. The existing
  // batch manager already resolves it to the real download URL at queue time.
  if (
    (hostname === 'pixeldrain.com' || hostname === 'www.pixeldrain.com') &&
    PIXELDRAIN_FILE_PATH.test(pathnameOf(input.url))
  ) {
    return { category: 'other', kind: 'file', name, extension }
  }

  // A public MEGA link is a JavaScript application page, but it identifies one
  // file (or a folder of files) and carries its own key. The scanner resolves
  // the real name and size through the public adapter, so it is never queued as
  // a page. A folder link is expanded into one card per file. A MEGA URL without
  // its key fragment cannot be resolved and stays a page.
  if (
    hostname.length > 0 &&
    isMegaHost(hostname) &&
    hasUrlFragment(input.url) &&
    isMegaLinkPath(pathnameOf(input.url))
  ) {
    return { category: 'other', kind: 'file', name, extension }
  }

  if (input.fromScript === true) {
    return { category: 'other', kind: 'file', name, extension }
  }
  if (input.isAttachment === true || input.downloadAttribute === true) {
    return { category: 'other', kind: 'file', name, extension }
  }

  // A link with no recognisable extension and no download intent is treated as
  // another page: it is visible but can never be queued as a file.
  return { category: 'page', kind: 'page-link', name, extension }
}

function extensionOfExtensionHint(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = EXTENSION_HINT.exec(value.trim())
  return match ? match[1]!.toLowerCase() : null
}

/**
 * Path shapes a public MEGA link can have. The legacy `/#!id!key` form has no
 * path at all, so an empty or `/` path is accepted too.
 */
function isMegaLinkPath(path: string): boolean {
  const trimmed = path.replace(TRAILING_SLASHES, '')
  if (trimmed.length === 0) return true
  return MEGA_FILE_PATH.test(trimmed) || MEGA_FOLDER_PATH.test(trimmed)
}

/** True when the URL carries a non-empty fragment (a MEGA key). */
function hasUrlFragment(value: string): boolean {
  try {
    return new URL(value).hash.length > 1
  } catch {
    return false
  }
}

