// Pure policy shared by the service worker, options page and tests.
// Automatic browser hand-off is intentionally narrow: only an ordinary HTTP(S)
// download that the browser started itself, with a supported non-media file
// extension, may be handed to DonDownload. A media element, manifest, segment,
// browser-internal or extension-created download is never a candidate.

export const HANDOFF_FILE_EXTENSIONS = Object.freeze([
  '7z', 'apk', 'bin', 'bz2', 'csv', 'deb', 'dmg', 'doc', 'docx', 'epub',
  'exe', 'gz', 'img', 'iso', 'jar', 'json', 'md', 'msi', 'odp', 'ods', 'odt',
  'pkg', 'pdf', 'ppt', 'pptx', 'rar', 'rpm', 'sqlite', 'tar', 'tgz', 'txt',
  'whl', 'xls', 'xlsx', 'xz', 'zip', 'zst'
])

export const MEDIA_FILE_EXTENSIONS = Object.freeze([
  'aac', 'avi', 'flac', 'm3u8', 'm4a', 'm4s', 'm4v', 'mkv', 'mov', 'mp3',
  'mp4', 'mpd', 'mpeg', 'mpg', 'oga', 'ogg', 'ogv', 'opus', 'ts', 'wav',
  'webm'
])

const MAX_URL_LENGTH = 4096
const MAX_FILENAME_LENGTH = 180
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])

function extensionOf(value) {
  if (typeof value !== 'string') return null
  const match = /\.([a-z0-9]{1,8})$/i.exec(value.trim())
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
  return (
    extension !== null &&
    MEDIA_FILE_EXTENSIONS.includes(extension) &&
    ['m3u8', 'mpd', 'm4s', 'ts'].includes(extension)
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

/** Validate one explicit hand-off file. No URL is logged by the caller. */
export function normalizeHandoffFile(rawUrl, rawFilename, rawExpected = {}) {
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
  if (
    isMediaFile(pathname) ||
    isMediaFile(filename) ||
    (!isHandoffFile(pathname) && !isHandoffFile(filename))
  ) {
    return {
      ok: false,
      code: 'HANDOFF_UNSUPPORTED_FILE',
      message: 'Automatic hand-off only accepts a supported non-media file.'
    }
  }

  const expectedBytes = normalizeExpectedBytes(
    rawExpected && rawExpected.expectedBytes
  )
  const expectedContentType = normalizeExpectedContentType(
    rawExpected && rawExpected.expectedContentType
  )
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
 */
export function automaticHandoffCandidate(item, excludedOrigins) {
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
  if (typeof item.mime === 'string' && /^(?:video\/|audio\/|text\/html|application\/(?:dash\+xml|vnd\.apple\.mpegurl|x-mpegurl))/i.test(item.mime)) {
    return { ok: false, reason: 'media-or-page' }
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

  let pathname = ''
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
  const normalized = normalizeHandoffFile(rawUrl, rawFilename, {
    expectedBytes: item.totalBytes,
    expectedContentType: item.mime
  })
  if (!normalized.ok) return { ok: false, reason: 'unsupported-file' }
  if (normalized.expectedBytes === undefined) {
    // Without the browser's exact total, the anonymous preflight cannot
    // establish that it is seeing the same file. Leave this transfer intact.
    return { ok: false, reason: 'size-unavailable' }
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
