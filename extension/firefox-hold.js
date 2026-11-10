// Firefox download hold.
//
// Firefox has no chrome.downloads.onDeterminingFilename, so the hand-off used
// to run only from downloads.onCreated. A small or fast file then finished in
// the browser before the native receipt arrived, and the browser kept its own
// copy. A blocking webRequest.onHeadersReceived listener gives the same hold as
// Chromium: while its Promise is pending Firefox does not start the download,
// { cancel: true } drops it, and {} lets the browser download normally.
//
// The listener is installed only when the browser has no
// onDeterminingFilename (Firefox) and the user granted the blocking webRequest
// permission. The actual hand-off lives in handoff.js and is shared with the
// Chromium paths. This module never logs a URL or a cookie.

import { handoffHeldRequest, HANDOFF_SUGGEST_TIMEOUT_MS } from './handoff.js'

/** Synthetic download ids start here so they never collide with a real id. */
export const FIREFOX_HOLD_FIRST_ID = 1_000_000_000

const MAX_FILENAME_LENGTH = 180
const HOLD_URL_FILTERS = Object.freeze(['http://*/*', 'https://*/*'])
const HOLD_TYPES = Object.freeze(['main_frame', 'sub_frame'])
const HOLD_EXTRA_INFO = Object.freeze(['blocking', 'responseHeaders'])

/**
 * Response media types a browser downloads instead of displaying. Anything
 * displayable (video, audio, image, HTML, text, JSON, PDF) is only a download
 * when Content-Disposition says `attachment`.
 */
export const DOWNLOAD_MEDIA_TYPES = Object.freeze([
  'application/octet-stream',
  'binary/octet-stream',
  'application/force-download',
  'application/x-download',
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-msdownload',
  'application/x-msi',
  'application/vnd.android.package-archive',
  'application/x-iso9660-image',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar'
])

// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

function headerValue(headers, name) {
  if (!Array.isArray(headers) || typeof name !== 'string') return ''
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (
      !header ||
      typeof header.name !== 'string' ||
      typeof header.value !== 'string'
    ) {
      continue
    }
    if (header.name.toLowerCase() === wanted) return header.value
  }
  return ''
}

/** Media type only, lower-cased: `text/html; charset=utf-8` -> `text/html`. */
export function mediaTypeOf(value) {
  if (typeof value !== 'string') return ''
  return value.split(';')[0]?.trim().toLowerCase() ?? ''
}

/** True when Content-Disposition's disposition type is `attachment`. */
export function isAttachmentDisposition(value) {
  return mediaTypeOf(value) === 'attachment'
}

function decodeExtendedFilename(raw) {
  // RFC 5987: charset'language'percent-encoded-value
  const match = /^([^']*)'([^']*)'(.*)$/.exec(raw)
  const charset = match ? match[1]?.trim().toLowerCase() ?? '' : ''
  const encoded = match ? match[3] ?? '' : raw
  // Only UTF-8 is decoded; any other charset falls back to plain filename=.
  if (charset.length > 0 && charset !== 'utf-8' && charset !== 'utf8') {
    return null
  }
  try {
    const decoded = decodeURIComponent(encoded)
    return decoded.length > 0 ? decoded : null
  } catch {
    return encoded.length > 0 ? encoded : null
  }
}

/**
 * Extract the file name from a Content-Disposition header. `filename*`
 * (RFC 5987, UTF-8) wins over a plain `filename=`, quoted or not.
 */
export function parseContentDispositionFilename(value) {
  if (typeof value !== 'string') return null
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value)
  if (extended && extended[1]) {
    const decoded = decodeExtendedFilename(extended[1].trim().replace(/^"|"$/g, ''))
    if (decoded !== null) return decoded
  }
  const plain = /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i.exec(value)
  if (!plain || !plain[1]) return null
  let filename = plain[1].trim()
  if (filename.length >= 2 && filename.startsWith('"') && filename.endsWith('"')) {
    filename = filename.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return filename.length > 0 ? filename : null
}

/** A bare, safe file name: no directory part, no reserved or control chars. */
export function sanitizeBasename(value) {
  if (typeof value !== 'string') return ''
  const base = value.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(CONTROL_CHARACTERS, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
  return cleaned.slice(0, MAX_FILENAME_LENGTH)
}

/** Last URL path segment, percent-decoded and sanitized, or ''. */
export function filenameFromUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const pathname = new URL(value).pathname
    const segment = pathname.split('/').filter((part) => part.length > 0).pop() ?? ''
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      decoded = segment
    }
    return sanitizeBasename(decoded)
  } catch {
    return ''
  }
}

/**
 * True when this response is a download the browser would otherwise start:
 * a 2xx GET whose Content-Disposition is `attachment`, or whose media type is
 * one browsers save rather than display.
 */
export function isDownloadResponse(details) {
  if (!details || typeof details !== 'object') return false
  const status = details.statusCode
  if (typeof status !== 'number' || status < 200 || status > 299) return false
  if (details.method !== 'GET') return false
  const headers = details.responseHeaders
  if (isAttachmentDisposition(headerValue(headers, 'content-disposition'))) {
    return true
  }
  return DOWNLOAD_MEDIA_TYPES.includes(
    mediaTypeOf(headerValue(headers, 'content-type'))
  )
}

/**
 * Build the item shape `automaticHandoffCandidate` expects from one webRequest
 * response. The id is supplied by the caller so this stays pure.
 */
export function buildSyntheticDownloadItem(details, id) {
  if (!details || typeof details !== 'object') return null
  if (!Number.isSafeInteger(id) || id < 1) return null
  const url = typeof details.url === 'string' ? details.url : ''
  if (!/^https?:/i.test(url)) return null

  const headers = details.responseHeaders
  const disposition = headerValue(headers, 'content-disposition')
  const fileName =
    sanitizeBasename(parseContentDispositionFilename(disposition) ?? '') ||
    filenameFromUrl(url)
  const contentLength = headerValue(headers, 'content-length').trim()
  const parsedLength = /^\d{1,16}$/.test(contentLength) ? Number(contentLength) : -1
  const totalBytes =
    Number.isSafeInteger(parsedLength) && parsedLength > 0 ? parsedLength : -1
  const referrer =
    typeof details.originUrl === 'string' && details.originUrl.length > 0
      ? details.originUrl
      : typeof details.documentUrl === 'string'
        ? details.documentUrl
        : ''

  return {
    id,
    url,
    finalUrl: url,
    filename: fileName,
    mime: mediaTypeOf(headerValue(headers, 'content-type')),
    totalBytes,
    state: 'in_progress',
    danger: 'safe',
    paused: false,
    referrer
  }
}

/** One listener per worker generation, plus a process-wide id counter. */
let holdInstalled = false
let syntheticDownloadId = FIREFOX_HOLD_FIRST_ID

/** Next synthetic positive download id; starts at FIREFOX_HOLD_FIRST_ID. */
export function nextSyntheticDownloadId() {
  const id = syntheticDownloadId
  syntheticDownloadId =
    syntheticDownloadId >= Number.MAX_SAFE_INTEGER
      ? FIREFOX_HOLD_FIRST_ID
      : syntheticDownloadId + 1
  return id
}

function holdResponse(chromeApi, details) {
  return new Promise((resolve) => {
    let settled = false
    const release = (response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(response)
    }
    // A download must never stay stuck behind this extension. If the hand-off
    // has not settled in time the browser simply keeps its own download.
    const timer = setTimeout(() => release({}), HANDOFF_SUGGEST_TIMEOUT_MS)
    const item = buildSyntheticDownloadItem(details, nextSyntheticDownloadId())
    if (item === null) {
      release({})
      return
    }
    Promise.resolve()
      .then(() => handoffHeldRequest(chromeApi, item))
      // Only a durable receipt cancels; every other result lets the browser
      // download proceed exactly as it would without the extension.
      .then(
        (outcome) => release(outcome === 'cancelled' ? { cancel: true } : {}),
        () => release({})
      )
  })
}

function handleHeadersReceived(chromeApi, details) {
  if (!details || typeof details !== 'object') return undefined
  // No tabId check: Zen reports tabId -1 for real top-level download
  // navigations. The main_frame/sub_frame filter already excludes extension
  // and background fetches.
  if (!isDownloadResponse(details)) return undefined
  return holdResponse(chromeApi, details)
}

/**
 * Install the blocking listener when running in Firefox with the optional
 * blocking permission. Returns whether the listener is installed (or already
 * was), and never rejects. Safe to call on every worker start and again from
 * permissions.onAdded.
 */
export function installFirefoxDownloadHold(chromeApi) {
  if (holdInstalled) return Promise.resolve(true)
  if (!chromeApi || typeof chromeApi !== 'object') return Promise.resolve(false)
  const webRequest = chromeApi.webRequest
  if (
    !webRequest ||
    !webRequest.onHeadersReceived ||
    typeof webRequest.onHeadersReceived.addListener !== 'function'
  ) {
    return Promise.resolve(false)
  }
  // onDeterminingFilename means Chromium, where handoff.js already holds the
  // download before it starts. Never add a second hold there.
  const downloads = chromeApi.downloads
  if (downloads && downloads.onDeterminingFilename) return Promise.resolve(false)
  // Register synchronously, in the same turn as the worker start: Firefox only
  // wakes a suspended MV3 background page for listeners added at top level, so
  // an addListener after an await would stop holding once the page idles.
  // chrome.webRequest exists only while the optional permission is granted, and
  // addListener throws without webRequestBlocking, which keeps the gate.
  try {
    webRequest.onHeadersReceived.addListener(
      (details) => handleHeadersReceived(chromeApi, details),
      { urls: [...HOLD_URL_FILTERS], types: [...HOLD_TYPES] },
      [...HOLD_EXTRA_INFO]
    )
    holdInstalled = true
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(false)
  }
}

/** Test hook: forget the listener and reset the synthetic id counter. */
export function resetFirefoxDownloadHoldForTests() {
  holdInstalled = false
  syntheticDownloadId = FIREFOX_HOLD_FIRST_ID
}
