// Pure policy shared by the service worker, options page and tests.
//
// Automatic browser hand-off takes over an ordinary HTTP(S) download the way a
// download manager does: the browser already decided this is a download, so no
// extension allowlist is required. What is still never a candidate: an HTML
// page, an HLS/DASH manifest, a segment, a blob:/data: URL, a browser-internal
// or extension-created download, an unsafe or paused item and an excluded site.
// A direct media file (video/audio) is a normal download and is handed off too.

export const HANDOFF_FILE_EXTENSIONS = Object.freeze([
  '7z', 'apk', 'bin', 'bz2', 'csv', 'deb', 'dmg', 'doc', 'docx', 'epub',
  'exe', 'funscript', 'gz', 'img', 'iso', 'jar', 'json', 'md', 'msi', 'odp',
  'ods', 'odt', 'pkg', 'pdf', 'ppt', 'pptx', 'rar', 'rpm', 'sqlite', 'tar',
  'tgz', 'txt', 'whl', 'xls', 'xlsx', 'xz', 'zip', 'zst'
])

export const MEDIA_FILE_EXTENSIONS = Object.freeze([
  'aac', 'avi', 'flac', 'm3u8', 'm4a', 'm4s', 'm4v', 'mkv', 'mov', 'mp3',
  'mp4', 'mpd', 'mpeg', 'mpg', 'oga', 'ogg', 'ogv', 'opus', 'ts', 'wav',
  'webm'
])

/** Extensions that name a playlist/segment, never a downloadable file. */
export const MANIFEST_OR_SEGMENT_EXTENSIONS = Object.freeze([
  'm3u8', 'mpd', 'm4s', 'ts'
])

/** Minimum browser-reported size for an automatic hand-off (1 MB). */
export const DEFAULT_HANDOFF_MIN_BYTES = 1_000_000

const MAX_URL_LENGTH = 4096
const MAX_FILENAME_LENGTH = 180
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])
// HTML documents are pages, not downloads. An explicit download of a .html
// file is indistinguishable from a saved page, so it always stays in the
// browser.
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'shtml'])
const PAGE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml'
])
const MANIFEST_CONTENT_TYPES = new Set([
  'application/dash+xml',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
])

function extensionOf(value) {
  if (typeof value !== 'string') return null
  // A KVS-style URL may end in a trailing slash (`/1.mp4/`).
  const trimmed = value.trim().replace(/\/+$/, '')
  const match = /\.([a-z0-9]{1,12})$/i.exec(trimmed)
  return match ? match[1].toLowerCase() : null
}

export function isHandoffFile(value) {
  const extension = extensionOf(value)
  return extension !== null && HANDOFF_FILE_EXTENSIONS.includes(extension)
}

export function isMediaFile(value) {
  const extension = extensionOf(value)
  return extension !== null && MEDIA_FILE_EXTENSIONS.includes(extension)
}

export function isSegmentOrManifest(value) {
  const extension = extensionOf(value)
  return extension !== null && MANIFEST_OR_SEGMENT_EXTENSIONS.includes(extension)
}

/** HTML pages and manifest/segment names are never handed off. */
export function isPageOrManifestFile(value) {
  const extension = extensionOf(value)
  if (extension === null) return false
  return PAGE_EXTENSIONS.has(extension) || isSegmentOrManifest(extension)
}

/**
 * When the browser has not reported a total size yet, only hand off a URL that
 * plainly names a real file: a concrete media type, a known download extension
 * or a direct media extension. Pages, manifests and segments were already
 * rejected before this is asked.
 */
export function looksLikeRealFile(pathname, filename, mime) {
  const mediaType =
    typeof mime === 'string' ? mime.split(';')[0]?.trim().toLowerCase() ?? '' : ''
  // application/octet-stream is the browser's "unknown" type, so it proves
  // nothing on its own; the URL or file name has to name a real file.
  if (/^(?:video|audio|application\/(?:pdf|zip|x-7z-compressed|x-msdownload|x-iso9660-image|x-rar-compressed|vnd\.rar))/.test(mediaType)) {
    return true
  }
  return (
    isHandoffFile(pathname) ||
    isHandoffFile(filename) ||
    isMediaFile(pathname) ||
    isMediaFile(filename)
  )
}

/** Canonical origin for an exact web URL, or null. */
export function originFromPageUrl(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) return null
  if (!parsed.hostname || parsed.origin === 'null') return null
  if (parsed.username || parsed.password) return null
  return parsed.origin
}

function normalizeExpectedBytes(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function normalizeExpectedContentType(value) {
  if (typeof value !== 'string') return undefined
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (
    mediaType.length === 0 ||
    mediaType.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(
      mediaType
    )
  ) {
    return undefined
  }
  return mediaType
}

function isPageOrManifestContentType(mediaType) {
  return (
    PAGE_CONTENT_TYPES.has(mediaType) || MANIFEST_CONTENT_TYPES.has(mediaType)
  )
}

/**
 * Validate one explicit hand-off file. No URL is logged by the caller.
 *
 * `options.allowAnyFile` is the automatic browser-download path: the browser
 * already decided the transfer is a download, so the extension allowlist does
 * not apply. Pages, manifests and segments are still rejected, and a
 * `requireMinimumBytes` threshold (when set) must be met by the known size.
 */
export function normalizeHandoffFile(rawUrl, rawFilename, rawExpected = {}, options = {}) {
  if (typeof rawUrl !== 'string') {
    return { ok: false, code: 'UNSUPPORTED_URL', message: 'No download URL is available.' }
  }
  const raw = rawUrl.trim()
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, code: 'UNSUPPORTED_URL', message: 'The download URL is not valid.' }
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, code: 'UNSUPPORTED_URL', message: 'The download URL is not valid.' }
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, code: 'MALFORMED_URL', message: 'That does not look like a valid URL.' }
  }
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_URL',
      message: 'Only http:// and https:// downloads can be handed off.'
    }
  }
  if (!url.hostname || url.username || url.password) {
    return { ok: false, code: 'UNSUPPORTED_URL', message: 'The download URL is not valid.' }
  }
  url.hash = ''

  let filename
  if (rawFilename !== undefined && rawFilename !== null) {
    if (
      typeof rawFilename !== 'string' ||
      rawFilename.trim().length === 0 ||
      rawFilename.length > MAX_FILENAME_LENGTH * 2 ||
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
      /[\u0000-\u001f\u007f]/.test(rawFilename) ||
      /[\\/]/.test(rawFilename)
    ) {
      return { ok: false, code: 'INVALID_FILENAME', message: 'The file name is not valid.' }
    }
    const cleaned = rawFilename
      .replace(/[<>:"|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+|[. ]+$/g, '')
    if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
      return { ok: false, code: 'INVALID_FILENAME', message: 'The file name is not valid.' }
    }
    filename = cleaned.slice(0, MAX_FILENAME_LENGTH)
  }

  const pathname = url.pathname || ''
  if (isPageOrManifestFile(pathname) || isPageOrManifestFile(filename)) {
    return {
      ok: false,
      code: 'HANDOFF_UNSUPPORTED_FILE',
      message: 'Pages, playlists and stream segments stay in the browser.'
    }
  }

  const expectedBytes = normalizeExpectedBytes(
    rawExpected && rawExpected.expectedBytes
  )
  const expectedContentType = normalizeExpectedContentType(
    rawExpected && rawExpected.expectedContentType
  )
  if (
    expectedContentType !== undefined &&
    isPageOrManifestContentType(expectedContentType)
  ) {
    return {
      ok: false,
      code: 'HANDOFF_UNSUPPORTED_FILE',
      message: 'Pages, playlists and stream segments stay in the browser.'
    }
  }

  const allowAnyFile = options.allowAnyFile === true
  if (
    !allowAnyFile &&
    (isMediaFile(pathname) ||
      isMediaFile(filename) ||
      (!isHandoffFile(pathname) && !isHandoffFile(filename)))
  ) {
    return {
      ok: false,
      code: 'HANDOFF_UNSUPPORTED_FILE',
      message: 'Automatic hand-off only accepts a supported non-media file.'
    }
  }

  const minimumBytes =
    Number.isSafeInteger(options.requireMinimumBytes) &&
    options.requireMinimumBytes > 0
      ? options.requireMinimumBytes
      : 0
  // An unknown size is not "too small": the caller decides whether the URL
  // names a real file (see automaticHandoffCandidate) and the desktop preflight
  // proves the size before anything is cancelled.
  if (minimumBytes > 0 && expectedBytes !== undefined && expectedBytes < minimumBytes) {
    return {
      ok: false,
      code: 'HANDOFF_TOO_SMALL',
      message: 'This download is smaller than the hand-off size limit.'
    }
  }

  return {
    ok: true,
    url: url.href,
    ...(filename === undefined ? {} : { filename }),
    ...(expectedBytes === undefined ? {} : { expectedBytes }),
    ...(expectedContentType === undefined ? {} : { expectedContentType })
  }
}

/**
 * Decide whether a chrome.downloads.onCreated item may be handed off.
 * `item.id` is the only stable identity; a URL is never used as a key.
 *
 * `options.minBytes` is the user's "only files larger than" threshold. The
 * browser's exact total must be known and at least that large; an unknown size
 * always stays in the browser.
 */
export function automaticHandoffCandidate(item, excludedOrigins, options = {}) {
  if (!item || typeof item !== 'object') {
    return { ok: false, reason: 'invalid-item' }
  }
  if (typeof item.id !== 'number' || !Number.isFinite(item.id) || item.id < 1) {
    return { ok: false, reason: 'invalid-id' }
  }
  if (item.state !== undefined && item.state !== 'in_progress') {
    return { ok: false, reason: 'not-in-progress' }
  }
  if (item.paused === true || item.danger !== 'safe') {
    return { ok: false, reason: 'unsafe-or-paused' }
  }
  if (
    typeof item.mime === 'string' &&
    (PAGE_CONTENT_TYPES.has(item.mime.split(';')[0]?.trim().toLowerCase() ?? '') ||
      MANIFEST_CONTENT_TYPES.has(item.mime.split(';')[0]?.trim().toLowerCase() ?? ''))
  ) {
    return { ok: false, reason: 'page-or-manifest' }
  }
  // Extension-created downloads are a different subsystem; never recurse into
  // our own or another extension's transfer.
  if (typeof item.byExtensionId === 'string' && item.byExtensionId.length > 0) {
    return { ok: false, reason: 'extension-download' }
  }
  if (typeof item.byExtensionName === 'string' && item.byExtensionName.length > 0) {
    return { ok: false, reason: 'extension-download' }
  }

  const rawUrl =
    typeof item.finalUrl === 'string' && item.finalUrl.length > 0
      ? item.finalUrl
      : typeof item.url === 'string'
        ? item.url
        : ''
  const origin = originFromPageUrl(rawUrl)
  if (origin === null) return { ok: false, reason: 'unsupported-url' }
  if (Array.isArray(excludedOrigins) && [origin, originFromPageUrl(item.url), originFromPageUrl(item.referrer)].some((value) => value && excludedOrigins.includes(value))) {
    return { ok: false, reason: 'excluded-origin' }
  }

  let pathname
  try {
    pathname = new URL(rawUrl).pathname
  } catch {
    return { ok: false, reason: 'unsupported-url' }
  }
  if (isSegmentOrManifest(pathname)) return { ok: false, reason: 'segment-or-manifest' }

  const rawFilename =
    typeof item.filename === 'string' && item.filename.length > 0
      ? item.filename.split(/[\\/]/).pop()
      : undefined
  if (isPageOrManifestFile(rawFilename)) {
    return { ok: false, reason: 'page-or-manifest' }
  }
  const minBytes =
    Number.isSafeInteger(options.minBytes) && options.minBytes >= 0
      ? options.minBytes
      : DEFAULT_HANDOFF_MIN_BYTES
  const normalized = normalizeHandoffFile(
    rawUrl,
    rawFilename,
    {
      expectedBytes: item.totalBytes,
      expectedContentType: item.mime
    },
    { allowAnyFile: true, requireMinimumBytes: minBytes }
  )
  if (!normalized.ok) {
    // A known small file (or an unknown total) stays in the browser.
    if (normalized.code === 'HANDOFF_TOO_SMALL') {
      return {
        ok: false,
        reason:
          normalizeExpectedBytes(item.totalBytes) === undefined
            ? 'size-unavailable'
            : 'below-minimum'
      }
    }
    return { ok: false, reason: 'unsupported-file' }
  }
  if (normalized.expectedBytes === undefined) {
    // The browser has not reported a total yet. The hand-off still goes ahead
    // when the URL or media type names a real file (a media type, a known
    // download extension or a direct media extension); the desktop preflight
    // then proves the size before the browser copy is cancelled.
    if (!looksLikeRealFile(pathname, rawFilename, item.mime)) {
      return { ok: false, reason: 'size-unavailable' }
    }
  }
  return {
    ok: true,
    url: normalized.url,
    ...(normalized.filename === undefined ? {} : { filename: normalized.filename }),
    ...(normalized.expectedBytes === undefined
      ? {}
      : { expectedBytes: normalized.expectedBytes }),
    ...(normalized.expectedContentType === undefined
      ? {}
      : { expectedContentType: normalized.expectedContentType }),
    origin
  }
}
