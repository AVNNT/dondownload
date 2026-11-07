// Outbound native messaging. The manual capture operation stays exactly as it
// was; media operations add strict analyze/queue/status/cancel envelopes over
// the same native host. This module never touches the browser's downloads API,
// network interception, cookies, tabs history or page DOM.

import {
  isMediaOutputFormat,
  isOpaqueMediaId,
  parseMediaBridgeResponse
} from './media-contract.js'
import { normalizeHandoffFile } from './handoff-policy.js'

export const NATIVE_HOST = 'com.dondownload.bridge'
export const QUEUE_MESSAGE_TYPE = 'queue-download'
export const PROBE_MESSAGE_TYPE = 'probe'
export const CAPTURED_SOURCE_MESSAGE_TYPE = 'queue-captured-source'
export const SNIFFED_MEDIA_MESSAGE_TYPE = 'queue-sniffed-media'
export const DURABLE_HANDOFF_MESSAGE_TYPE = 'handoff-download'
export const DOWNLOAD_STATUS_MESSAGE_TYPE = 'download-status'
export const SHOW_DOWNLOAD_MESSAGE_TYPE = 'show-download'
export const SCAN_PAGE_MESSAGE_TYPE = 'scan-page'
export const SCAN_IMAGES_MESSAGE_TYPE = 'scan-images'
export const SCAN_GOFILE_MESSAGE_TYPE = 'scan-gofile'
export const SCAN_VIDEO_MESSAGE_TYPE = 'scan-video'
export const MAX_SCAN_VIDEO_SOURCES = 24
export const MAX_VIDEO_LABEL_LENGTH = 80
export const MAX_VIDEO_TITLE_LENGTH = 300
const VIDEO_SOURCE_KINDS = ['file', 'hls', 'dash']
export const MAX_SCAN_GOFILE_FILES = 500
export const MAX_GOFILE_NAME_LENGTH = 240
const GOFILE_SHARE_ID = /^[A-Za-z0-9_-]{4,64}$/
const GOFILE_SHARE_STATUSES = [
  'ok',
  'empty',
  'not-found',
  'password',
  'premium',
  'timeout'
]
export const MAX_SCAN_IMAGES = 1000
export const MAX_IMAGE_ALT_LENGTH = 200
export const MAX_PAGE_TITLE_LENGTH = 200
export const MAX_URL_LENGTH = 4096
export const MAX_CAPTURED_FILENAME_LENGTH = 180
export const MAX_SNIFFED_TITLE_LENGTH = 500
export const MAX_USER_AGENT_LENGTH = 512
export const MAX_REFERER_LENGTH = 4096
export const MAX_COOKIE_HEADER_LENGTH = 8192
export const HANDOFF_TIMEOUT_MS = 25_000
const DOWNLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HANDOFF_STATUS_VALUES = ['queued', 'running', 'paused', 'done', 'error']
const MAX_HANDOFF_STATUS_FILENAME_LENGTH = 180
const MAX_HANDOFF_STATUS_MESSAGE_LENGTH = 200

const PROGRESSIVE_EXTENSIONS = ['mp4', 'webm', 'm4v', 'mov', 'ogv', 'mkv']
const COMPLETE_MEDIA_TYPES = ['video/mp4', 'video/webm']
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

// ---------------------------------------------------------------------------
// Native transport
//
// One persistent native messaging port per service-worker lifetime keeps a
// single host process alive instead of spawning one process per message. Every
// request carries an `id` that the host echoes back, so replies are matched to
// their caller. Anything the port cannot do falls back to the original one-shot
// sendNativeMessage path: no connectNative, a failed connect, or a disconnect
// before the host answered.
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
// A port that dies without ever answering usually means the host is not
// registered. Skip the port for a moment instead of paying a failed connect on
// every request.
const NATIVE_PORT_RETRY_MS = 30_000

let nativePort = null
let nativePortDelivered = false
let nativePortUnavailableUntil = 0
let nextNativeRequestId = 1
const pendingNativeRequests = new Map()

function nativeTimeoutError() {
  return {
    code: 'NATIVE_TIMEOUT',
    message: "DonDownload's native helper did not answer in time. Try again."
  }
}

function normalizeRequestTimeout(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 600_000)
    : DEFAULT_REQUEST_TIMEOUT_MS
}

function handleNativePortMessage(rawMessage) {
  if (rawMessage === null || typeof rawMessage !== 'object') return
  nativePortDelivered = true
  const id = typeof rawMessage.id === 'string' ? rawMessage.id : null
  if (id === null) return
  const pending = pendingNativeRequests.get(id)
  if (!pending) return
  // The id is transport bookkeeping only; callers see the host's own fields.
  const response = { ...rawMessage }
  delete response.id
  pending.finish({ ok: true, response })
}

function handleNativePortDisconnect(port) {
  if (port !== nativePort) return
  nativePort = null
  const delivered = nativePortDelivered
  nativePortDelivered = false
  // Reading lastError clears Chromium's "unchecked runtime.lastError" warning.
  const runtimeError = chrome.runtime.lastError
  const message =
    runtimeError && typeof runtimeError.message === 'string'
      ? runtimeError.message
      : ''
  if (!delivered) {
    nativePortUnavailableUntil = Date.now() + NATIVE_PORT_RETRY_MS
  }
  for (const pending of Array.from(pendingNativeRequests.values())) {
    if (message.length > 0) {
      // The host refused or vanished before answering: report it exactly as the
      // one-shot path would.
      pending.finish({ ok: false, error: describeNativeError(message) })
      continue
    }
    // No diagnostic: re-send this request as a single message.
    pending.finish({ retry: true })
  }
}

function ensureNativePort() {
  if (nativePort !== null) return nativePort
  if (Date.now() < nativePortUnavailableUntil) return null
  const runtime = typeof chrome === 'undefined' ? null : chrome.runtime
  if (!runtime || typeof runtime.connectNative !== 'function') return null

  let port
  try {
    port = runtime.connectNative(NATIVE_HOST)
  } catch {
    nativePortUnavailableUntil = Date.now() + NATIVE_PORT_RETRY_MS
    return null
  }
  if (
    !port ||
    typeof port.postMessage !== 'function' ||
    !port.onMessage ||
    typeof port.onMessage.addListener !== 'function' ||
    !port.onDisconnect ||
    typeof port.onDisconnect.addListener !== 'function'
  ) {
    nativePortUnavailableUntil = Date.now() + NATIVE_PORT_RETRY_MS
    return null
  }

  nativePort = port
  nativePortDelivered = false
  port.onMessage.addListener((message) => {
    if (port !== nativePort) return
    handleNativePortMessage(message)
  })
  port.onDisconnect.addListener(() => handleNativePortDisconnect(port))
  return port
}

function postOverPort(port, message, timeoutMs) {
  return new Promise((resolve) => {
    const id = String(nextNativeRequestId)
    nextNativeRequestId += 1
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      pendingNativeRequests.delete(id)
      resolve(result)
    }
    timer = setTimeout(
      () => finish({ ok: false, error: nativeTimeoutError() }),
      timeoutMs
    )
    pendingNativeRequests.set(id, { finish })
    try {
      port.postMessage({ ...message, id })
    } catch {
      finish({ retry: true })
    }
  })
}

/** One host process per message. The fallback and the single-message path. */
function sendSingleNativeMessage(message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(
      () => finish({ ok: false, error: nativeTimeoutError() }),
      timeoutMs
    )
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const runtimeError = chrome.runtime.lastError
        if (runtimeError) {
          finish({ ok: false, error: describeNativeError(runtimeError.message) })
          return
        }
        finish({ ok: true, response })
      })
    } catch (error) {
      finish({
        ok: false,
        error: {
          code: 'NATIVE_HOST_FAILED',
          message:
            error instanceof Error
              ? error.message
              : "Could not contact DonDownload's native helper."
        }
      })
    }
  })
}

/**
 * Send one native envelope. Resolves with `{ ok: true, response }` or
 * `{ ok: false, error }` and never rejects.
 */
function sendNativeRequest(message, options) {
  const timeoutMs = normalizeRequestTimeout(options && options.timeoutMs)
  const port = ensureNativePort()
  if (port === null) return sendSingleNativeMessage(message, timeoutMs)
  return postOverPort(port, message, timeoutMs).then((result) =>
    result.retry === true ? sendSingleNativeMessage(message, timeoutMs) : result
  )
}

/**
 * Test seam: forget the persistent port and every pending request so a test
 * can start from a clean transport.
 */
export function resetNativeBridgeForTests() {
  for (const pending of Array.from(pendingNativeRequests.values())) {
    pending.finish({ ok: false, error: nativeTimeoutError() })
  }
  pendingNativeRequests.clear()
  nativePort = null
  nativePortDelivered = false
  nativePortUnavailableUntil = 0
  nextNativeRequestId = 1
}

/**
 * Validate a page/link URL before it leaves the browser. The native host and
 * the desktop app validate again; this copy exists for clear popup feedback.
 */
export function normalizeSupportedUrl(value) {
  if (typeof value !== 'string') {
    return { ok: false, code: 'UNSUPPORTED_URL', message: 'No page URL is available.' }
  }

  const raw = value.trim()
  if (raw.length === 0) {
    return { ok: false, code: 'UNSUPPORTED_URL', message: 'No page URL is available.' }
  }
  if (raw.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      code: 'URL_TOO_LONG',
      message: `The URL is too long (maximum ${MAX_URL_LENGTH} characters).`
    }
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_URL',
      message: 'The URL contains unsupported control characters.'
    }
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, code: 'MALFORMED_URL', message: 'That does not look like a valid URL.' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'UNSUPPORTED_URL',
      message: 'Only http:// and https:// links can be sent to DonDownload.'
    }
  }
  if (!url.hostname) {
    return { ok: false, code: 'MALFORMED_URL', message: 'The URL must include a host name.' }
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: 'UNSUPPORTED_URL',
      message: 'URLs containing embedded credentials are not supported.'
    }
  }

  url.hash = ''
  if (url.href.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      code: 'URL_TOO_LONG',
      message: `The URL is too long (maximum ${MAX_URL_LENGTH} characters).`
    }
  }

  return { ok: true, url: url.href }
}

function progressiveExtension(value) {
  if (typeof value !== 'string') return null
  // KVS player URLs end with a slash after the file name (`/1.mp4/`).
  const trimmed = value.trim().replace(/\/+$/, '')
  const match = /\.([a-z0-9]{2,5})$/i.exec(trimmed)
  if (!match) return null
  const extension = match[1].toLowerCase()
  return PROGRESSIVE_EXTENSIONS.indexOf(extension) === -1 ? null : extension
}

function normalizeCapturedFilename(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (
    raw.length === 0 ||
    raw.length > MAX_CAPTURED_FILENAME_LENGTH * 2 ||
    CONTROL_CHARACTERS.test(raw) ||
    /[\\/]/.test(raw)
  ) {
    return undefined
  }
  const cleaned = raw
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return undefined
  }
  const name =
    cleaned.length > MAX_CAPTURED_FILENAME_LENGTH
      ? cleaned.slice(0, MAX_CAPTURED_FILENAME_LENGTH)
      : cleaned
  return progressiveExtension(name) === null ? undefined : name
}

/**
 * Validate one observed progressive playback source before it leaves the
 * browser. A blob: or manifest URL is explicitly unsupported: the extension
 * cannot prove a single downloadable representation from an MSE segment or an
 * HLS/DASH manifest without a resolver.
 */
export function normalizeCapturedSource(rawUrl, rawFilename, rawEvidence) {
  const normalized = normalizeSupportedUrl(rawUrl)
  if (!normalized.ok) {
    return { ok: false, code: normalized.code, message: normalized.message }
  }

  let path = ''
  try {
    path = new URL(normalized.url).pathname
  } catch {
    return {
      ok: false,
      code: 'MALFORMED_URL',
      message: 'That does not look like a valid URL.'
    }
  }
  if (/\.(m3u8|mpd)$/i.test(path)) {
    return {
      ok: false,
      code: 'CAPTURED_SOURCE_UNSUPPORTED',
      message:
        'This player uses an HLS or DASH manifest. DonDownload cannot map it to one verified file without an explicit resolver.'
    }
  }

  let filename
  if (rawFilename !== undefined) {
    filename = normalizeCapturedFilename(rawFilename)
    if (filename === undefined) {
      return {
        ok: false,
        code: 'INVALID_FILENAME',
        message: 'The captured media filename is not valid.'
      }
    }
  }

  const pathExtension = progressiveExtension(path)
  let referer
  if (rawEvidence && typeof rawEvidence === 'object' && rawEvidence.referer !== undefined) {
    const normalizedReferer = normalizeSupportedUrl(rawEvidence.referer)
    if (!normalizedReferer.ok) {
      return {
        ok: false,
        code: normalizedReferer.code,
        message: normalizedReferer.message
      }
    }
    referer = normalizedReferer.url
  }
  let userAgent
  if (rawEvidence && typeof rawEvidence === 'object' && rawEvidence.userAgent !== undefined) {
    userAgent = normalizeHeaderText(rawEvidence.userAgent, MAX_USER_AGENT_LENGTH)
    if (userAgent === null) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: 'The browser user agent is not valid.'
      }
    }
  }

  if (pathExtension !== null) {
    return {
      ok: true,
      url: normalized.url,
      ...(filename === undefined ? {} : { filename }),
      ...(referer === undefined ? {} : { referer }),
      ...(userAgent === undefined ? {} : { userAgent })
    }
  }

  // An extensionless URL is accepted only with exact response evidence from
  // the optional network observer. A filename such as `clip.mp4` is a display
  // label, not proof that the response is one complete progressive file.
  const evidence =
    rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
      ? rawEvidence
      : null
  const contentType =
    evidence && typeof evidence.contentType === 'string'
      ? evidence.contentType.trim().toLowerCase()
      : ''
  if (COMPLETE_MEDIA_TYPES.indexOf(contentType) === -1) {
    return {
      ok: false,
      code: 'CAPTURED_SOURCE_UNVERIFIED',
      message:
        'This extensionless playback source has no verified complete-file network response, so it was not queued.'
    }
  }
  if (
    !evidence ||
    !Number.isSafeInteger(evidence.expectedBytes) ||
    evidence.expectedBytes <= 0
  ) {
    return {
      ok: false,
      code: 'CAPTURED_SOURCE_UNVERIFIED',
      message:
        'This extensionless playback source has no verified total size, so it was not queued.'
    }
  }

  return {
    ok: true,
    url: normalized.url,
    ...(filename === undefined ? {} : { filename }),
    contentType,
    expectedBytes: evidence.expectedBytes,
    ...(referer === undefined ? {} : { referer }),
    ...(userAgent === undefined ? {} : { userAgent })
  }
}

/**
 * Queue one verified progressive source through the same native host and
 * authenticated loopback bridge as the manual capture path. Resolves only
 * after the desktop manager has persisted the download.
 */
export function sendQueueCapturedSource(rawUrl, rawFilename, rawEvidence) {
  const normalized = normalizeCapturedSource(rawUrl, rawFilename, rawEvidence)
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
    })
  }

  return sendNativeRequest({
    type: CAPTURED_SOURCE_MESSAGE_TYPE,
    url: normalized.url,
    ...(normalized.filename === undefined
      ? {}
      : { filename: normalized.filename }),
    ...(normalized.contentType === undefined
      ? {}
      : {
          contentType: normalized.contentType,
          expectedBytes: normalized.expectedBytes
        }),
    ...(normalized.referer === undefined ? {} : { referer: normalized.referer }),
    ...(normalized.userAgent === undefined
      ? {}
      : { userAgent: normalized.userAgent })
  }).then((result) => {
    if (result.ok === false) return result
    if (!result.response || result.response.ok !== true) {
      return { ok: false, error: describeResponseError(result.response) }
    }
    return { ok: true }
  })
}

function hasControlCharacters(value) {
  return CONTROL_CHARACTERS.test(value)
}

function normalizeHeaderText(value, maximum) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > maximum ||
    hasControlCharacters(trimmed)
  ) {
    return null
  }
  return trimmed
}

/**
 * Validate one sniffed media request before it leaves the browser. The desktop
 * bridge validates the same fields again; this copy exists for clear feedback
 * and keeps any unsupported kind or header shape from reaching the native host.
 */
export function normalizeSniffedMedia(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: 'The detected media request is not valid.'
    }
  }
  const allowed = [
    'url',
    'pageUrl',
    'referer',
    'userAgent',
    'kind',
    'title',
    'filename',
    'variant',
    'cookie',
    'expectedBytes'
  ]
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: 'The detected media request contains unsupported fields.'
      }
    }
  }

  const url = normalizeSupportedUrl(input.url)
  if (!url.ok) return { ok: false, code: url.code, message: url.message }
  const pageUrl = normalizeSupportedUrl(input.pageUrl)
  if (!pageUrl.ok) return { ok: false, code: pageUrl.code, message: pageUrl.message }

  if (input.kind !== 'file' && input.kind !== 'hls' && input.kind !== 'dash') {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: 'The detected media kind is not supported.'
    }
  }

  const userAgent = normalizeHeaderText(input.userAgent, MAX_USER_AGENT_LENGTH)
  if (userAgent === null) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: 'The browser user agent is not valid.'
    }
  }

  const title = normalizeHeaderText(input.title, MAX_SNIFFED_TITLE_LENGTH)
  if (title === null) {
    return {
      ok: false,
      code: 'INVALID_MESSAGE',
      message: 'The media title is not valid.'
    }
  }

  let refererUrl = pageUrl.url
  if (input.referer !== undefined) {
    const referer = normalizeSupportedUrl(input.referer)
    if (!referer.ok) {
      return { ok: false, code: referer.code, message: referer.message }
    }
    let refererOrigin = null
    let pageOrigin = null
    try {
      refererOrigin = new URL(referer.url).origin
      pageOrigin = new URL(pageUrl.url).origin
    } catch {
      refererOrigin = null
    }
    if (refererOrigin === null || refererOrigin !== pageOrigin) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: 'The media referer must belong to the page origin.'
      }
    }
    refererUrl = referer.url
  }

  let filename
  if (input.filename !== undefined) {
    filename = normalizeCapturedFilename(input.filename)
    if (filename === undefined) {
      return {
        ok: false,
        code: 'INVALID_FILENAME',
        message: 'The detected media filename is not valid.'
      }
    }
  }

  let variant = null
  if (input.variant !== undefined) {
    const raw = input.variant
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: 'The selected HLS variant is not valid.'
      }
    }
    for (const key of Object.keys(raw)) {
      if (!['url', 'label', 'width', 'height', 'bandwidth'].includes(key)) {
        return {
          ok: false,
          code: 'INVALID_MESSAGE',
          message: 'The selected HLS variant contains unsupported fields.'
        }
      }
    }
    const variantUrl = normalizeSupportedUrl(raw.url)
    if (!variantUrl.ok) {
      return { ok: false, code: variantUrl.code, message: variantUrl.message }
    }
    variant = { url: variantUrl.url }
    if (raw.label !== undefined) {
      const label = normalizeHeaderText(raw.label, 80)
      if (label === null) {
        return {
          ok: false,
          code: 'INVALID_MESSAGE',
          message: 'The selected HLS variant label is not valid.'
        }
      }
      variant.label = label
    }
    for (const key of ['width', 'height', 'bandwidth']) {
      if (raw[key] === undefined) continue
      const value = raw[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
        return {
          ok: false,
          code: 'INVALID_MESSAGE',
          message: 'The selected HLS variant metadata is not valid.'
        }
      }
      variant[key] = value
    }
  }

  let cookie
  if (input.cookie !== undefined) {
    cookie = normalizeHeaderText(input.cookie, MAX_COOKIE_HEADER_LENGTH)
    if (cookie === null || /[\r\n]/.test(cookie)) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: 'The browser cookie header is not valid.'
      }
    }
  }

  let expectedBytes
  if (input.expectedBytes !== undefined) {
    if (
      !Number.isSafeInteger(input.expectedBytes) ||
      input.expectedBytes <= 0
    ) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: 'The detected media size is not valid.'
      }
    }
    expectedBytes = input.expectedBytes
  }

  return {
    ok: true,
    input: {
      url: url.url,
      pageUrl: pageUrl.url,
      referer: refererUrl,
      userAgent,
      kind: input.kind,
      title,
      ...(filename === undefined ? {} : { filename }),
      ...(variant === null ? {} : { variant }),
      ...(cookie === undefined ? {} : { cookie }),
      ...(expectedBytes === undefined ? {} : { expectedBytes })
    }
  }
}

/**
 * Queue one detected media item through the native host. Cookies, when the
 * user opted in for that exact origin, travel only in this message and are
 * never written to extension storage.
 */
export function sendQueueSniffedMedia(input) {
  const normalized = normalizeSniffedMedia(input)
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
    })
  }
  const value = normalized.input

  return sendNativeRequest({
    type: SNIFFED_MEDIA_MESSAGE_TYPE,
    url: value.url,
    pageUrl: value.pageUrl,
    referer: value.referer,
    userAgent: value.userAgent,
    kind: value.kind,
    title: value.title,
    ...(value.filename === undefined ? {} : { filename: value.filename }),
    ...(value.variant === undefined ? {} : { variant: value.variant }),
    ...(value.cookie === undefined ? {} : { cookie: value.cookie }),
    ...(value.expectedBytes === undefined
      ? {}
      : { expectedBytes: value.expectedBytes })
  }).then((result) => {
    if (result.ok === false) return result
    if (!result.response || result.response.ok !== true) {
      return { ok: false, error: describeResponseError(result.response) }
    }
    return { ok: true }
  })
}

function invalidDurableResponse() {
  return {
    ok: false,
    error: {
      code: 'HANDOFF_RECEIPT_INVALID',
      message: 'The durable hand-off receipt was not valid. The browser download was left running.'
    }
  }
}

function validReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null
  const keys = Object.keys(receipt)
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(receipt, 'downloadId') ||
    !Object.prototype.hasOwnProperty.call(receipt, 'persistedAt')
  ) {
    return null
  }
  if (
    typeof receipt.downloadId !== 'string' ||
    !DOWNLOAD_ID_PATTERN.test(receipt.downloadId)
  ) {
    return null
  }
  if (
    typeof receipt.persistedAt !== 'number' ||
    !Number.isSafeInteger(receipt.persistedAt) ||
    receipt.persistedAt < 1
  ) {
    return null
  }
  return { downloadId: receipt.downloadId, persistedAt: receipt.persistedAt }
}

/**
 * Strict automatic hand-off. Resolves ok only when the native host returned an
 * accepted, durable receipt after a verified SQLite write. Every other outcome
 * (bridge unavailable, timeout, malformed response, duplicate or persistence
 * failure) is ok:false so the caller keeps the browser download running.
 */
export function sendDurableHandoff(rawUrl, rawFilename, options = {}) {
  const normalized = normalizeHandoffFile(rawUrl, rawFilename, {
    expectedBytes: options && options.expectedBytes,
    expectedContentType: options && options.expectedContentType
  }, {
    // This is the automatic browser-download path: the browser already
    // decided the transfer is a download, so no extension allowlist applies.
    allowAnyFile: true,
    ...(Number.isSafeInteger(options && options.minBytes)
      ? { requireMinimumBytes: options.minBytes }
      : {}),
    // An always-hand-off type (a `.funscript`) is below the threshold by
    // nature and must not be re-rejected here.
    ...(options && options.ignoreMinimumBytes === true
      ? { ignoreMinimumBytes: true }
      : {})
  })
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
    })
  }
  // The extension already scoped these values to the browser's login. They are
  // validated again here and travel only in this native message; nothing is
  // written to extension storage.
  const cookie = normalizeHeaderText(
    options && options.cookie,
    MAX_COOKIE_HEADER_LENGTH
  )
  const userAgent = normalizeHeaderText(
    options && options.userAgent,
    MAX_USER_AGENT_LENGTH
  )
  let referer
  if (options && options.referer !== undefined) {
    const normalizedReferer = normalizeSupportedUrl(options.referer)
    if (!normalizedReferer.ok) {
      return Promise.resolve({
        ok: false,
        error: {
          code: normalizedReferer.code,
          message: normalizedReferer.message
        }
      })
    }
    referer = normalizedReferer.url
  }
  if (cookie !== null && /[\r\n]/.test(cookie)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_MESSAGE',
        message: 'The browser cookie header is not valid.'
      }
    })
  }
  const configured =
    options && typeof options.timeoutMs === 'number' ? options.timeoutMs : 0
  const timeoutMs =
    Number.isFinite(configured) && configured > 0
      ? Math.min(configured, 120_000)
      : HANDOFF_TIMEOUT_MS

  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: {
          code: 'HANDOFF_TIMEOUT',
          message: 'DonDownload did not confirm the hand-off in time. The browser download was left running.'
        }
      })
    }, timeoutMs)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // The hand-off deadline above stays authoritative, so the transport
    // deadline is always a little later than it.
    sendNativeRequest(
      {
        type: DURABLE_HANDOFF_MESSAGE_TYPE,
        url: normalized.url,
        ...(normalized.filename === undefined
          ? {}
          : { filename: normalized.filename }),
        ...(normalized.expectedBytes === undefined
          ? {}
          : { expectedBytes: normalized.expectedBytes }),
        ...(normalized.expectedContentType === undefined
          ? {}
          : { expectedContentType: normalized.expectedContentType }),
        ...(referer === undefined ? {} : { referer }),
        ...(userAgent === undefined || userAgent === null ? {} : { userAgent }),
        ...(cookie === undefined || cookie === null ? {} : { cookie })
      },
      { timeoutMs: timeoutMs + 5_000 }
    ).then((result) => {
      if (result.ok === false) {
        finish(result)
        return
      }
      const response = result.response
      if (
        !response ||
        response.ok !== true ||
        response.accepted !== true ||
        response.durable !== true ||
        response.operation !== DURABLE_HANDOFF_MESSAGE_TYPE
      ) {
        if (response && response.ok === false) {
          finish({ ok: false, error: describeResponseError(response) })
          return
        }
        finish(invalidDurableResponse())
        return
      }
      const receipt = validReceipt(response.receipt)
      if (receipt === null) {
        finish(invalidDurableResponse())
        return
      }
      finish({ ok: true, durable: true, receipt })
    })
  })
}

/**
 * Send one small native envelope and resolve with either the raw response or a
 * transport error. Both new hand-off card operations are read-only, so they
 * share this one transport.
 */
function sendNativeEnvelope(message) {
  return sendNativeRequest(message)
}

function invalidDownloadStatusResponse() {
  return {
    ok: false,
    error: {
      code: 'DOWNLOAD_STATUS_INVALID',
      message: 'DonDownload returned an unexpected download status.'
    }
  }
}

function safeStatusFilename(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_HANDOFF_STATUS_FILENAME_LENGTH ||
    hasControlCharacters(trimmed) ||
    /[\\/]/.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

function safeStatusMessage(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (
    text.length === 0 ||
    text.length > MAX_HANDOFF_STATUS_MESSAGE_LENGTH ||
    hasControlCharacters(text) ||
    /(?:https?|file):\/\//i.test(text) ||
    /[A-Za-z]:\\/.test(text)
  ) {
    return undefined
  }
  return text
}

/**
 * Strict progress for the one download the extension took over. Only a
 * validated id is sent, and only the five browser-facing fields are accepted
 * back, so no URL, path or header can reach the page.
 */
export function sendDownloadStatus(rawDownloadId) {
  if (
    typeof rawDownloadId !== 'string' ||
    !DOWNLOAD_ID_PATTERN.test(rawDownloadId)
  ) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_DOWNLOAD_ID',
        message: 'The download identifier is not valid.'
      }
    })
  }

  return sendNativeEnvelope({
    type: DOWNLOAD_STATUS_MESSAGE_TYPE,
    downloadId: rawDownloadId
  }).then((result) => {
    if (result.ok !== true) return result
    const response = result.response
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return invalidDownloadStatusResponse()
    }
    if (response.ok === false) {
      return { ok: false, error: describeResponseError(response) }
    }
    if (response.ok !== true) return invalidDownloadStatusResponse()

    const keys = Object.keys(response)
    for (const key of keys) {
      if (
        key !== 'ok' &&
        key !== 'status' &&
        key !== 'completedBytes' &&
        key !== 'totalBytes' &&
        key !== 'filename' &&
        key !== 'errorMessage'
      ) {
        return invalidDownloadStatusResponse()
      }
    }
    if (
      HANDOFF_STATUS_VALUES.indexOf(response.status) === -1 ||
      !Number.isSafeInteger(response.completedBytes) ||
      response.completedBytes < 0 ||
      !Number.isSafeInteger(response.totalBytes) ||
      response.totalBytes < 0
    ) {
      return invalidDownloadStatusResponse()
    }
    const filename = safeStatusFilename(response.filename)
    if (filename === null) return invalidDownloadStatusResponse()
    const errorMessage = safeStatusMessage(response.errorMessage)

    return {
      ok: true,
      status: response.status,
      completedBytes: response.completedBytes,
      totalBytes: response.totalBytes,
      filename,
      ...(errorMessage === undefined ? {} : { errorMessage })
    }
  })
}

/**
 * Focus the desktop and reveal that download row. The response carries no
 * data, so only an explicit confirmation is accepted.
 */
export function sendShowDownload(rawDownloadId) {
  if (
    typeof rawDownloadId !== 'string' ||
    !DOWNLOAD_ID_PATTERN.test(rawDownloadId)
  ) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_DOWNLOAD_ID',
        message: 'The download identifier is not valid.'
      }
    })
  }

  return sendNativeEnvelope({
    type: SHOW_DOWNLOAD_MESSAGE_TYPE,
    downloadId: rawDownloadId
  }).then((result) => {
    if (result.ok !== true) return result
    const response = result.response
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return {
        ok: false,
        error: {
          code: 'NATIVE_RESPONSE_INVALID',
          message: 'The DonDownload helper returned an unexpected response.'
        }
      }
    }
    if (response.ok === false) {
      return { ok: false, error: describeResponseError(response) }
    }
    if (response.ok !== true || response.shown !== true) {
      return {
        ok: false,
        error: {
          code: 'NATIVE_RESPONSE_INVALID',
          message: 'The DonDownload helper returned an unexpected response.'
        }
      }
    }
    return { ok: true }
  })
}

/**
 * Probe the native bridge and the running desktop app. `probe` is read-only:
 * it is accepted only when it carries exactly a `type` field, creates nothing
 * and returns no URLs or paths. Welcome and popup status use this instead of
 * sending a synthetic download.
 */
export function probeNativeConnection() {
  return sendNativeRequest({ type: PROBE_MESSAGE_TYPE }).then((result) => {
    if (result.ok === false) return result
    const response = result.response
    if (
      !response ||
      response.ok !== true ||
      response.operation !== PROBE_MESSAGE_TYPE
    ) {
      return {
        ok: false,
        error:
          response && response.ok === false
            ? describeResponseError(response)
            : {
                code: 'NATIVE_RESPONSE_INVALID',
                message: 'The DonDownload helper returned an unexpected response.'
              }
      }
    }
    return { ok: true }
  })
}

function describeNativeError(message) {
  const text = typeof message === 'string' ? message : 'Unknown native messaging error.'

  if (/not found|not installed|not registered/i.test(text)) {
    return {
      code: 'NATIVE_HOST_NOT_REGISTERED',
      message:
        "DonDownload's browser bridge is not registered for this browser. Run the supplied registration script with this extension's exact ID, then try again."
    }
  }
  if (/forbidden|access|denied|not allowed/i.test(text)) {
    return {
      code: 'NATIVE_HOST_FORBIDDEN',
      message:
        "This extension is not authorized to use DonDownload's bridge. Re-register the native host with this extension's exact 32-character ID."
    }
  }
  if (/exited|terminated|disconnected|communicat/i.test(text)) {
    return {
      code: 'NATIVE_HOST_FAILED',
      message:
        "DonDownload's native helper stopped before answering. Start DonDownload, then try again. If it is already running, re-register the native host."
    }
  }
  return { code: 'NATIVE_HOST_ERROR', message: text }
}

function describeResponseError(response) {
  if (response && typeof response === 'object' && response.error) {
    const code = typeof response.error.code === 'string' ? response.error.code : 'APP_REJECTED'
    const message =
      typeof response.error.message === 'string' && response.error.message.length > 0
        ? response.error.message
        : 'DonDownload rejected the request.'
    return { code, message }
  }
  return {
    code: 'NATIVE_RESPONSE_INVALID',
    message: 'The DonDownload helper returned an unexpected response.'
  }
}

/**
 * Resolves only after the native host reports that the desktop app accepted the
 * URL. Any transport, host, registration, duplicate or app error resolves as
 * ok: false. `options.force === true` is the only way to request an explicit
 * second copy, and only a user-initiated Download again control may set it.
 */
export function sendQueueDownload(rawUrl, options = {}) {
  const normalized = normalizeSupportedUrl(rawUrl)
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
    })
  }

  const force =
    options !== null &&
    typeof options === 'object' &&
    options.force === true

  return sendNativeRequest(
    force
      ? { type: QUEUE_MESSAGE_TYPE, url: normalized.url, force: true }
      : { type: QUEUE_MESSAGE_TYPE, url: normalized.url }
  ).then((result) => {
    if (result.ok === false) return result
    if (!result.response || result.response.ok !== true) {
      return { ok: false, error: describeResponseError(result.response) }
    }
    return { ok: true }
  })
}

/**
 * "Scan this page with DonDownload". Only a validated HTTP(S) URL and, when
 * the user already opted in for that exact origin, the exact-host Cookie are
 * sent. The desktop starts a discovery-only scan; this message never queues a
 * download. The Cookie is never written to extension storage.
 */
export function sendScanPage(rawUrl, rawCookie) {
  const normalized = normalizeSupportedUrl(rawUrl)
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
    })
  }

  let cookie
  if (rawCookie !== undefined && rawCookie !== null) {
    cookie = normalizeHeaderText(rawCookie, MAX_COOKIE_HEADER_LENGTH)
    if (cookie === null || /[\r\n]/.test(cookie)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'INVALID_MESSAGE',
          message: 'The browser cookie header is not valid.'
        }
      })
    }
  }

  return sendNativeRequest({
    type: SCAN_PAGE_MESSAGE_TYPE,
    url: normalized.url,
    ...(cookie === undefined ? {} : { cookie })
  }).then((result) => {
    if (result.ok === false) return result
    const response = result.response
    if (!response || response.ok !== true || response.accepted !== true) {
      return {
        ok: false,
        error:
          response && response.ok === false
            ? describeResponseError(response)
            : {
                code: 'NATIVE_RESPONSE_INVALID',
                message: 'The DonDownload helper returned an unexpected response.'
              }
      }
    }
    return { ok: true }
  })
}

/**
 * "Scan this Gofile share". The rows were read from the user's own signed-in
 * tab, so this only forwards the share id, the extraction status and the
 * validated download links. Every link must be HTTPS on gofile.io or one of its
 * `store<N>` hosts; the optional `accountToken` Cookie is the same one-shot
 * value the other scans use and is never stored.
 */
export function sendScanGofile(input) {
  const raw = input === null || typeof input !== 'object' ? {} : input
  const shareId = typeof raw.shareId === 'string' ? raw.shareId.trim() : ''
  if (!GOFILE_SHARE_ID.test(shareId)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_SHARE',
        message: 'That Gofile share link is not valid.'
      }
    })
  }
  const status = GOFILE_SHARE_STATUSES.includes(raw.status) ? raw.status : 'empty'

  const files = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.files) ? raw.files : []) {
    if (files.length >= MAX_SCAN_GOFILE_FILES) break
    if (entry === null || typeof entry !== 'object') continue
    const url = normalizeSupportedUrl(entry.url)
    if (!url.ok) continue
    let parsed
    try {
      parsed = new URL(url.url)
    } catch {
      continue
    }
    const host = parsed.hostname.toLowerCase()
    const onGofile =
      host === 'gofile.io' ||
      host === 'www.gofile.io' ||
      /^[a-z0-9-]+(\.[a-z0-9-]+)*\.gofile\.io$/.test(host)
    if (!onGofile || parsed.protocol !== 'https:') continue
    if (!/^\/download\//.test(parsed.pathname)) continue
    if (seen.has(url.url)) continue
    seen.add(url.url)
    const name = normalizeHeaderText(entry.name, MAX_GOFILE_NAME_LENGTH)
    if (name === null) continue
    const size =
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size) &&
      entry.size > 0
        ? Math.round(entry.size)
        : null
    files.push({ name, size, url: url.url })
  }

  let cookie
  if (raw.cookie !== undefined && raw.cookie !== null) {
    cookie = normalizeHeaderText(raw.cookie, MAX_COOKIE_HEADER_LENGTH)
    if (cookie === null || /[\r\n]/.test(cookie)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'INVALID_MESSAGE',
          message: 'The browser cookie header is not valid.'
        }
      })
    }
  }

  return sendNativeRequest({
    type: SCAN_GOFILE_MESSAGE_TYPE,
    shareId,
    status,
    files,
    ...(cookie === undefined ? {} : { cookie })
  }).then((result) => {
    if (result.ok === false) return result
    const response = result.response
    if (!response || response.ok !== true || response.accepted !== true) {
      return {
        ok: false,
        error:
          response && response.ok === false
            ? describeResponseError(response)
            : {
                code: 'NATIVE_RESPONSE_INVALID',
                message: 'The DonDownload helper returned an unexpected response.'
              }
      }
    }
    return { ok: true }
  })
}

/**
 * "Download images on this page". The list was collected on the live DOM, so
 * this only forwards validated http(s) URLs plus the optional Pinterest 736x
 * fallback. The desktop re-validates everything, re-checks the public-target
 * policy and opens the picker; nothing is downloaded from here.
 */
export function sendScanImages(input) {
  const page = normalizeSupportedUrl(input === null || typeof input !== 'object' ? '' : input.pageUrl)
  if (!page.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: page.code, message: page.message }
    })
  }

  const rawImages = Array.isArray(input.images) ? input.images : []
  const images = []
  const seen = new Set()
  for (const rawImage of rawImages) {
    if (images.length >= MAX_SCAN_IMAGES) break
    if (rawImage === null || typeof rawImage !== 'object') continue
    const url = normalizeSupportedUrl(rawImage.url)
    if (!url.ok || seen.has(url.url)) continue
    seen.add(url.url)
    const entry = { url: url.url }
    if (rawImage.fallbackUrl !== undefined) {
      const fallback = normalizeSupportedUrl(rawImage.fallbackUrl)
      if (fallback.ok && fallback.url !== url.url) entry.fallbackUrl = fallback.url
    }
    if (typeof rawImage.width === 'number' && Number.isFinite(rawImage.width) && rawImage.width > 0) {
      entry.width = Math.round(rawImage.width)
    }
    if (typeof rawImage.height === 'number' && Number.isFinite(rawImage.height) && rawImage.height > 0) {
      entry.height = Math.round(rawImage.height)
    }
    if (typeof rawImage.alt === 'string' && rawImage.alt.length > 0) {
      entry.alt = rawImage.alt.slice(0, MAX_IMAGE_ALT_LENGTH)
    }
    images.push(entry)
  }
  if (images.length === 0) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'NO_IMAGES',
        message: 'No downloadable images were found on this page.'
      }
    })
  }

  const title =
    typeof input.pageTitle === 'string'
      ? input.pageTitle.slice(0, MAX_PAGE_TITLE_LENGTH)
      : ''

  return sendNativeRequest({
    type: SCAN_IMAGES_MESSAGE_TYPE,
    pageUrl: page.url,
    pageTitle: title,
    images
  }).then((result) => {
    if (result.ok === false) return result
    const response = result.response
    if (!response || response.ok !== true || response.accepted !== true) {
      return {
        ok: false,
        error:
          response && response.ok === false
            ? describeResponseError(response)
            : {
                code: 'NATIVE_RESPONSE_INVALID',
                message: 'The DonDownload helper returned an unexpected response.'
              }
      }
    }
    return { ok: true }
  })
}

/**
 * Report the media URLs the user's own video tab rendered. A page yt-dlp cannot
 * read (no extractor, a Cloudflare challenge, an age gate) still plays in that
 * tab, so the collector reads the video/source elements and the player config
 * it exposed and this sends only validated http(s) URLs. The optional Cookie is
 * the same one-shot exact-origin value the other scans use.
 */
export function sendScanVideo(input) {
  const raw = input === null || typeof input !== 'object' ? {} : input
  const page = normalizeSupportedUrl(raw.pageUrl)
  if (!page.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: page.code, message: page.message }
    })
  }

  const sources = []
  const seen = new Set()
  for (const entry of Array.isArray(raw.sources) ? raw.sources : []) {
    if (sources.length >= MAX_SCAN_VIDEO_SOURCES) break
    if (entry === null || typeof entry !== 'object') continue
    const url = normalizeSupportedUrl(entry.url)
    if (!url.ok || seen.has(url.url)) continue
    if (!VIDEO_SOURCE_KINDS.includes(entry.kind)) continue
    seen.add(url.url)
    const source = { url: url.url, kind: entry.kind }
    const label = normalizeHeaderText(entry.label, MAX_VIDEO_LABEL_LENGTH)
    if (label !== null) source.label = label
    for (const key of ['width', 'height', 'sizeBytes']) {
      const value = entry[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        source[key] = Math.round(value)
      }
    }
    sources.push(source)
  }

  let cookie
  if (raw.cookie !== undefined && raw.cookie !== null) {
    cookie = normalizeHeaderText(raw.cookie, MAX_COOKIE_HEADER_LENGTH)
    if (cookie === null || /[\r\n]/.test(cookie)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'INVALID_MESSAGE',
          message: 'The browser cookie header is not valid.'
        }
      })
    }
  }

  const title = normalizeHeaderText(raw.title, MAX_VIDEO_TITLE_LENGTH)

  return sendNativeRequest({
    type: SCAN_VIDEO_MESSAGE_TYPE,
    pageUrl: page.url,
    ...(title === null ? {} : { title }),
    sources,
    ...(cookie === undefined ? {} : { cookie })
  }).then((result) => {
    if (result.ok === false) return result
    const response = result.response
    if (!response || response.ok !== true || response.accepted !== true) {
      return {
        ok: false,
        error:
          response && response.ok === false
            ? describeResponseError(response)
            : {
                code: 'NATIVE_RESPONSE_INVALID',
                message: 'The DonDownload helper returned an unexpected response.'
              }
      }
    }
    return { ok: true, sourceCount: sources.length }
  })
}

function invalidMediaResponse() {
  return {
    ok: false,
    error: {
      code: 'NATIVE_RESPONSE_INVALID',
      message: 'The DonDownload helper returned an unexpected media response.'
    }
  }
}

/**
 * Send one exact media envelope and validate the entire response against the
 * frozen DTO contract. Any transport, host or shape error resolves as ok:false
 * with a safe message.
 */
function sendMediaMessage(message) {
  return sendNativeRequest(message).then((result) => {
    if (result.ok === false) return result

    let parsed
    try {
      parsed = parseMediaBridgeResponse(result.response)
    } catch {
      return invalidMediaResponse()
    }
    return parsed
  })
}

function normalizeJobCookie(value) {
  if (value === undefined) return undefined
  const cookie = normalizeHeaderText(value, MAX_COOKIE_HEADER_LENGTH)
  if (cookie === null || /[\r\n]/.test(cookie)) return null
  return cookie
}

/** Analyze the page URL obtained by the background worker, never the DOM. */
export function sendAnalyzeMedia(rawUrl, rawCookie) {
  const normalized = normalizeSupportedUrl(rawUrl)
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
    })
  }
  const cookie = normalizeJobCookie(rawCookie)
  if (cookie === null) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_MESSAGE',
        message: 'The browser cookie header is not valid.'
      }
    })
  }

  return sendMediaMessage({
    type: 'analyze-media',
    url: normalized.url,
    ...(cookie === undefined ? {} : { cookie })
  }).then(
    (result) => {
      if (result.ok === false) return result
      if (result.operation !== 'analyze-media') return invalidMediaResponse()
      return { ok: true, analysis: result.analysis }
    }
  )
}

/** Queue one opaque analysis/option pair. Raw format selectors never leave. */
export function sendQueueMedia(input) {
  const analysisId = input && input.analysisId
  const optionId = input && input.optionId
  const outputFormat = input && input.outputFormat
  const cookie = normalizeJobCookie(input && input.cookie)
  if (cookie === null) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_MESSAGE',
        message: 'The browser cookie header is not valid.'
      }
    })
  }
  if (!isOpaqueMediaId(analysisId) || !isOpaqueMediaId(optionId)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_MEDIA_OPTION',
        message: 'The selected media option is not valid. Analyze the page again.'
      }
    })
  }
  if (outputFormat !== undefined && !isMediaOutputFormat(outputFormat)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'INVALID_MEDIA_OPTION',
        message: 'The selected output format is not valid.'
      }
    })
  }

  return sendMediaMessage({
    type: 'queue-media',
    analysisId,
    optionId,
    ...(outputFormat === undefined ? {} : { outputFormat }),
    ...(cookie === undefined ? {} : { cookie })
  }).then((result) => {
    if (result.ok === false) return result
    if (result.operation !== 'queue-media') return invalidMediaResponse()
    return { ok: true, job: result.job }
  })
}

export function sendMediaStatus(jobId) {
  if (!isOpaqueMediaId(jobId)) {
    return Promise.resolve({
      ok: false,
      error: { code: 'INVALID_MEDIA_JOB', message: 'The media job identifier is not valid.' }
    })
  }
  return sendMediaMessage({ type: 'media-status', jobId }).then((result) => {
    if (result.ok === false) return result
    if (result.operation !== 'media-status') return invalidMediaResponse()
    return { ok: true, job: result.job }
  })
}

export function sendCancelMedia(jobId) {
  if (!isOpaqueMediaId(jobId)) {
    return Promise.resolve({
      ok: false,
      error: { code: 'INVALID_MEDIA_JOB', message: 'The media job identifier is not valid.' }
    })
  }
  return sendMediaMessage({ type: 'cancel-media', jobId }).then((result) => {
    if (result.ok === false) return result
    if (result.operation !== 'cancel-media') return invalidMediaResponse()
    return { ok: true, job: result.job }
  })
}
