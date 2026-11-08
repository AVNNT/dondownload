// Optional, bounded playback response evidence.
//
// This module never reads request headers, cookies, credentials, DRM data or
// response bodies. It consumes only the public response URL/status/method and
// the four response headers needed to prove a complete progressive file:
// Content-Type, Content-Range, Content-Length and Content-Encoding.
//
// Evidence lives in memory for the lifetime of one service-worker generation.
// It is deliberately cleared when the worker restarts, on a top-frame
// navigation and when a tab closes. That keeps an old response from being
// mapped to a new document with the same tab/frame ids.

import { authorizeMediaSender } from './media-bridge.js'
import { isOverlayTabTracked } from './overlay-controller.js'
import {
  originFromUrl,
  originToMatchPattern
} from './site-policy.js'

export const NETWORK_EVIDENCE_MESSAGE_TYPES = Object.freeze({
  REQUEST: 'dondownload:network-evidence-request',
  AVAILABLE: 'dondownload:network-evidence'
})

export const MAX_EVIDENCE_PER_DOCUMENT = 24
export const MAX_EVIDENCE_DOCUMENTS = 32
export const EVIDENCE_TTL_MS = 10 * 60 * 1000
export const MAX_EVIDENCE_URL_LENGTH = 4096

export const COMPLETE_MEDIA_TYPES = Object.freeze(['video/mp4', 'video/webm'])

const PROGRESSIVE_EXTENSIONS = Object.freeze([
  'mp4',
  'webm',
  'm4v',
  'mov',
  'ogv',
  'mkv'
])
const SEGMENT_OR_MANIFEST_EXTENSIONS = Object.freeze([
  'm3u8',
  'mpd',
  'm4s',
  'ts'
])
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const CONTENT_TYPE_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function hasExactKeys(record, required, optional = []) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) return false
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false
  }
  return true
}

/** Canonical exact URL for matching; the fragment is never part of a request. */
export function normalizeEvidenceUrl(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (
    raw.length === 0 ||
    raw.length > MAX_EVIDENCE_URL_LENGTH ||
    CONTROL_CHARACTERS.test(raw)
  ) {
    return null
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname || parsed.username || parsed.password) return null
  parsed.hash = ''
  return parsed.href
}

export function normalizeContentType(value) {
  if (typeof value !== 'string') return null
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mediaType.length === 0 || !CONTENT_TYPE_TOKEN.test(mediaType)) return null
  return mediaType
}

function normalizeContentEncoding(value) {
  if (typeof value !== 'string') return null
  const encoding = value.split(',')[0]?.trim().toLowerCase() ?? ''
  if (encoding.length === 0 || !/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(encoding)) {
    return null
  }
  return encoding
}

/** Parse `bytes 0-0/1234`. A `*` total is intentionally not accepted as proof. */
export function parseContentRange(value) {
  if (typeof value !== 'string') return null
  const match = /^bytes\s+(\d{1,20})-(\d{1,20})\/(\d{1,20}|\*)$/i.exec(
    value.trim()
  )
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return null
  }
  if (total !== null) {
    if (!Number.isSafeInteger(total) || total <= 0 || end >= total) return null
  }
  return { start, end, total }
}

export function parseContentLength(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value.trim())) return null
  const length = Number(value.trim())
  return Number.isSafeInteger(length) && length > 0 ? length : null
}

function pathExtension(pathname) {
  const match = /\.([a-z0-9]{2,5})$/i.exec(String(pathname || '').trim())
  return match ? match[1].toLowerCase() : null
}

function isMediaType(contentType) {
  return (
    /^(?:video|audio)\//.test(contentType) ||
    contentType === 'application/vnd.apple.mpegurl' ||
    contentType === 'application/x-mpegurl' ||
    contentType === 'application/mpegurl' ||
    contentType === 'application/dash+xml'
  )
}

/**
 * Convert one onHeadersReceived observation into bounded evidence.
 *
 * The caller supplies only the fields this module is allowed to read. A
 * `blob:`/MSE fetch, a non-GET request, a sub-frame, a manifest/segment URL,
 * a missing total, a non-zero range start or a compressed body is rejected
 * rather than guessed. Extensionless sources additionally require an exact
 * video/mp4 or video/webm complete-file response.
 */
export function evaluateResponseEvidence(input, now = Date.now()) {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'invalid-input' }
  }
  const url = normalizeEvidenceUrl(input.url)
  if (url === null) return { ok: false, reason: 'invalid-url' }
  if (input.method !== 'GET') return { ok: false, reason: 'not-get' }
  if (!Number.isInteger(input.tabId) || input.tabId < 0) {
    return { ok: false, reason: 'invalid-tab' }
  }
  if (input.frameId !== 0) return { ok: false, reason: 'not-top-frame' }
  // A media element's progressive load is `media`. An MSE/fetch segment is
  // `xmlhttprequest` and is never accepted as one complete file.
  if (input.type !== 'media') return { ok: false, reason: 'not-media-request' }
  if (input.statusCode !== 200 && input.statusCode !== 206) {
    return { ok: false, reason: 'unsuccessful-status' }
  }

  const contentType = normalizeContentType(input.contentType)
  if (contentType === null) return { ok: false, reason: 'missing-content-type' }
  if (isMediaType(contentType) && !COMPLETE_MEDIA_TYPES.includes(contentType)) {
    return { ok: false, reason: 'manifest-or-unsupported-media' }
  }

  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  const extension = pathExtension(pathname)
  if (
    extension !== null &&
    SEGMENT_OR_MANIFEST_EXTENSIONS.includes(extension)
  ) {
    return { ok: false, reason: 'segment-or-manifest' }
  }
  if (
    extension !== null &&
    !PROGRESSIVE_EXTENSIONS.includes(extension)
  ) {
    return { ok: false, reason: 'unknown-extension' }
  }

  const encoding = normalizeContentEncoding(input.contentEncoding)
  const encoded = encoding !== null && encoding !== 'identity'
  const range = parseContentRange(input.contentRange)
  const contentLength = parseContentLength(input.contentLength)

  let totalBytes
  let completeFile
  if (input.statusCode === 206) {
    if (range === null || range.total === null) {
      return { ok: false, reason: 'range-total-unknown' }
    }
    totalBytes = range.total
    completeFile = range.start === 0
  } else {
    if (contentLength === null) {
      return { ok: false, reason: 'content-length-unknown' }
    }
    totalBytes = contentLength
    completeFile = true
  }

  if (encoded) {
    // Content-Length/Content-Range then describe a compressed representation,
    // not the media file's exact size. Never present that as an exact size.
    totalBytes = null
    completeFile = false
  }

  if (extension === null) {
    if (!COMPLETE_MEDIA_TYPES.includes(contentType)) {
      return { ok: false, reason: 'extensionless-not-progressive-media' }
    }
    if (encoded) return { ok: false, reason: 'compressed-body' }
    if (input.statusCode === 206) {
      if (range === null || range.total === null || range.start !== 0) {
        return { ok: false, reason: 'incomplete-range' }
      }
      totalBytes = range.total
    } else {
      if (contentLength === null) {
        return { ok: false, reason: 'content-length-unknown' }
      }
      totalBytes = contentLength
    }
    completeFile = true
  } else if (!/^video\//.test(contentType)) {
    // A progressive container with a non-video response type is not usable
    // evidence (for example a text/html error page served at the same URL).
    return { ok: false, reason: 'not-video-content' }
  }

  if (
    totalBytes === null ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0
  ) {
    return { ok: false, reason: 'size-unknown' }
  }

  return {
    ok: true,
    evidence: {
      url,
      contentType,
      container:
        extension === null
          ? contentType === 'video/webm'
            ? 'webm'
            : 'mp4'
          : extension,
      totalBytes,
      completeFile,
      statusCode: input.statusCode,
      observedAt: now
    }
  }
}

/** Strip internal fields before crossing the content-script boundary. */
export function evidenceForMessage(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const url = normalizeEvidenceUrl(evidence.url)
  const contentType = normalizeContentType(evidence.contentType)
  if (
    url === null ||
    contentType === null ||
    !Number.isSafeInteger(evidence.totalBytes) ||
    evidence.totalBytes <= 0 ||
    evidence.completeFile !== true
  ) {
    return null
  }
  return {
    url,
    contentType,
    container:
      evidence.container === 'webm' || evidence.container === 'mp4'
        ? evidence.container
        : contentType === 'video/webm'
          ? 'webm'
          : 'mp4',
    totalBytes: evidence.totalBytes,
    completeFile: true,
    statusCode: evidence.statusCode,
    observedAt: Number.isSafeInteger(evidence.observedAt)
      ? evidence.observedAt
      : 0
  }
}

function documentKey(tabId, frameId, documentId) {
  const document =
    typeof documentId === 'string' && documentId.length > 0 && documentId.length <= 128
      ? documentId
      : 'nav'
  return `${tabId}:${frameId}:${document}`
}

/**
 * Bounded in-memory evidence keyed by tab/frame/document identity and exact
 * URL. No broad resource list is kept and no mapping by dimensions or "the
 * only player" is possible here.
 */
export function createNetworkEvidenceStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maximumPerDocument =
    Number.isSafeInteger(options.maximumPerDocument) &&
    options.maximumPerDocument > 0
      ? options.maximumPerDocument
      : MAX_EVIDENCE_PER_DOCUMENT
  const maximumDocuments =
    Number.isSafeInteger(options.maximumDocuments) &&
    options.maximumDocuments > 0
      ? options.maximumDocuments
      : MAX_EVIDENCE_DOCUMENTS
  const ttl = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : EVIDENCE_TTL_MS
  const documents = new Map()

  function prune() {
    const current = now()
    for (const [key, document] of documents) {
      for (const [url, evidence] of document.entries) {
        if (current - evidence.observedAt > ttl) document.entries.delete(url)
      }
      if (document.entries.size === 0) documents.delete(key)
    }
    while (documents.size > maximumDocuments) {
      const oldest = documents.keys().next()
      if (oldest.done) break
      documents.delete(oldest.value)
    }
  }

  function record(input, identity) {
    if (!identity || !Number.isInteger(identity.tabId) || identity.tabId < 0) {
      return null
    }
    const result = evaluateResponseEvidence(input, now())
    if (result.ok !== true) return null
    const key = documentKey(identity.tabId, identity.frameId, identity.documentId)
    let document = documents.get(key)
    if (!document) {
      document = {
        tabId: identity.tabId,
        frameId: identity.frameId,
        documentId:
          typeof identity.documentId === 'string' ? identity.documentId : null,
        entries: new Map()
      }
      documents.set(key, document)
    }
    // Delete first so re-observation moves the exact URL to the newest slot.
    document.entries.delete(result.evidence.url)
    document.entries.set(result.evidence.url, result.evidence)
    while (document.entries.size > maximumPerDocument) {
      const oldest = document.entries.keys().next()
      if (oldest.done) break
      document.entries.delete(oldest.value)
    }
    prune()
    return result.evidence
  }

  function get(identity, rawUrl) {
    if (!identity || !Number.isInteger(identity.tabId) || identity.tabId < 0) {
      return null
    }
    const url = normalizeEvidenceUrl(rawUrl)
    if (url === null) return null
    prune()
    const key = documentKey(identity.tabId, identity.frameId, identity.documentId)
    const document = documents.get(key)
    if (!document) return null
    return document.entries.get(url) ?? null
  }

  function clearTab(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return
    for (const [key, document] of documents) {
      if (document.tabId === tabId) documents.delete(key)
    }
  }

  function clearAll() {
    documents.clear()
  }

  function count() {
    prune()
    return documents.size
  }

  return { record, get, clearTab, clearAll, count }
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null
  for (const header of headers) {
    if (
      header &&
      typeof header.name === 'string' &&
      header.name.toLowerCase() === name &&
      typeof header.value === 'string'
    ) {
      return header.value
    }
  }
  return null
}

async function originIsGranted(chromeApi, origin) {
  const pattern = originToMatchPattern(origin)
  if (pattern === null) return false
  try {
    return (await chromeApi.permissions.contains({ origins: [pattern] })) === true
  } catch {
    return false
  }
}

async function hasWebRequestPermission(chromeApi) {
  try {
    return (
      (await chromeApi.permissions.contains({ permissions: ['webRequest'] })) ===
      true
    )
  } catch {
    return false
  }
}

/**
 * Background-only request path. The content script supplies only the exact
 * currentSrc URL; the trusted sender supplies tab/frame/document identity.
 * There is no tab id parameter and no polling.
 */
export async function requestNetworkEvidenceForSender(
  chromeApi,
  message,
  sender,
  deps
) {
  if (
    !message ||
    message.type !== NETWORK_EVIDENCE_MESSAGE_TYPES.REQUEST ||
    !hasExactKeys(message, ['type', 'url'])
  ) {
    return failure('INVALID_MESSAGE', 'The evidence request is not valid.')
  }
  const url = normalizeEvidenceUrl(message.url)
  if (url === null) {
    return failure('INVALID_MESSAGE', 'The evidence URL is not valid.')
  }

  const authorization = await authorizeMediaSender(chromeApi, sender)
  if (authorization.ok !== true) return authorization

  if (!deps || deps.enabled !== true) {
    return { ok: true, evidence: null }
  }
  if (!(await hasWebRequestPermission(chromeApi))) {
    return { ok: true, evidence: null }
  }

  const evidence = deps.store.get(
    {
      tabId: authorization.tabId,
      frameId: sender.frameId,
      documentId: sender.documentId
    },
    url
  )
  return { ok: true, evidence: evidence ? evidenceForMessage(evidence) : null }
}

/**
 * Install the two top-frame webRequest listeners. The caller owns the enabled
 * flag and must only set it after the optional webRequest permission and the
 * explicit user preference are both true.
 */
export function installNetworkObservation(chromeApi, options = {}) {
  const store =
    options.store && typeof options.store.record === 'function'
      ? options.store
      : createNetworkEvidenceStore()
  const onEvidence =
    typeof options.onEvidence === 'function' ? options.onEvidence : null
  const urls = ['http://*/*', 'https://*/*']
  // Only a top-frame media response can become evidence, so the browser
  // filters out every other request before this extension is woken.
  const mediaFilter = { urls, types: ['media'] }
  const navigationFilter = { urls, types: ['main_frame'] }
  let enabled = false
  let permissionGranted = false
  let installed = false
  let listening = false

  /** The cheap structural checks, run before any tab lookup or authorization. */
  function isCandidateEvent(details) {
    if (!details || details.method !== 'GET') return false
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return false
    if (details.frameId !== 0) return false
    if (details.type !== 'media') return false
    return normalizeEvidenceUrl(details.url) !== null
  }

  async function authorizeEvent(details) {
    const url = normalizeEvidenceUrl(details.url)
    if (url === null) return null
    const mediaOrigin = originFromUrl(url)
    if (mediaOrigin === null) return null

    let pageUrl
    try {
      const tab = await chromeApi.tabs.get(details.tabId)
      pageUrl = tab && typeof tab.url === 'string' ? tab.url : ''
    } catch {
      return null
    }
    const pageOrigin = originFromUrl(pageUrl)
    if (pageOrigin === null) return null
    if (!(await isOverlayTabTracked(chromeApi, pageOrigin, details.tabId))) {
      return null
    }
    if (!(await originIsGranted(chromeApi, pageOrigin))) return null
    // A media CDN origin must itself be an exact granted origin. The optional
    // host grant is never broadened to all sites here.
    if (
      mediaOrigin !== pageOrigin &&
      !(await originIsGranted(chromeApi, mediaOrigin))
    ) {
      return null
    }
    return { pageOrigin, mediaOrigin }
  }

  async function handleHeaders(details) {
    if (!enabled || !permissionGranted) return
    if (!isCandidateEvent(details)) return
    const authorized = await authorizeEvent(details)
    if (authorized === null) return
    const evidence = store.record(
      {
        url: details.url,
        statusCode: details.statusCode,
        method: details.method,
        tabId: details.tabId,
        frameId: details.frameId,
        type: details.type,
        contentType: headerValue(details.responseHeaders, 'content-type'),
        contentRange: headerValue(details.responseHeaders, 'content-range'),
        contentLength: headerValue(details.responseHeaders, 'content-length'),
        contentEncoding: headerValue(details.responseHeaders, 'content-encoding')
      },
      {
        tabId: details.tabId,
        frameId: details.frameId,
        documentId: details.documentId
      }
    )
    if (evidence !== null && onEvidence) {
      onEvidence(details.tabId, evidence)
    }
  }

  function handleBeforeRequest(details) {
    if (!enabled || !permissionGranted) return
    if (!details || details.frameId !== 0) return
    if (details.type !== 'main_frame') return
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return
    // A top-frame navigation creates a new document. Never let old response
    // evidence match a reused tab/frame id.
    store.clearTab(details.tabId)
  }

  function headersListener(details) {
    void handleHeaders(details).catch(() => undefined)
  }

  function beforeRequestListener(details) {
    handleBeforeRequest(details)
  }

  /**
   * Keep the webRequest listeners registered only while observation is both
   * enabled and permitted. Idle listeners would otherwise wake the service
   * worker for requests that can never produce evidence.
   */
  function syncListeners() {
    if (!installed) return
    const webRequest = chromeApi && chromeApi.webRequest
    if (
      !webRequest ||
      !webRequest.onHeadersReceived ||
      !webRequest.onBeforeRequest
    ) {
      return
    }
    const wanted = enabled && permissionGranted
    if (wanted === listening) return
    try {
      if (wanted) {
        // `responseHeaders` only. `extraHeaders` is never requested, so cookie,
        // credential and DRM-related headers are not exposed to this extension.
        webRequest.onHeadersReceived.addListener(headersListener, mediaFilter, [
          'responseHeaders'
        ])
        webRequest.onBeforeRequest.addListener(
          beforeRequestListener,
          navigationFilter
        )
      } else {
        webRequest.onHeadersReceived.removeListener(headersListener)
        webRequest.onBeforeRequest.removeListener(beforeRequestListener)
      }
      listening = wanted
    } catch {
      // A listener that could not be registered leaves observation idle.
    }
  }

  function install() {
    if (installed) return true
    const webRequest = chromeApi && chromeApi.webRequest
    if (
      !webRequest ||
      !webRequest.onHeadersReceived ||
      !webRequest.onBeforeRequest
    ) {
      return false
    }
    installed = true
    syncListeners()
    return true
  }

  return {
    store,
    install,
    setEnabled(value) {
      enabled = value === true
      syncListeners()
    },
    setPermissionGranted(value) {
      permissionGranted = value === true
      syncListeners()
    },
    isEnabled() {
      return enabled && permissionGranted
    },
    clearTab(tabId) {
      store.clearTab(tabId)
    }
  }
}
