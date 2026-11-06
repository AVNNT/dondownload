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
export const MAX_URL_LENGTH = 4096
export const MAX_CAPTURED_FILENAME_LENGTH = 180
export const MAX_SNIFFED_TITLE_LENGTH = 500
export const MAX_USER_AGENT_LENGTH = 512
export const MAX_REFERER_LENGTH = 4096
export const MAX_COOKIE_HEADER_LENGTH = 8192
export const HANDOFF_TIMEOUT_MS = 25_000

const PROGRESSIVE_EXTENSIONS = ['mp4', 'webm', 'm4v', 'mov', 'ogv', 'mkv']
const COMPLETE_MEDIA_TYPES = ['video/mp4', 'video/webm']
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

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
  const match = /\.([a-z0-9]{2,5})$/i.exec(value.trim())
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
  if (pathExtension !== null) {
    return {
      ok: true,
      url: normalized.url,
      ...(filename === undefined ? {} : { filename })
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
    expectedBytes: evidence.expectedBytes
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

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        {
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
              })
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          if (runtimeError) {
            finish({ ok: false, error: describeNativeError(runtimeError.message) })
            return
          }
          if (!response || response.ok !== true) {
            finish({ ok: false, error: describeResponseError(response) })
            return
          }
          finish({ ok: true })
        }
      )
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

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        {
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
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          if (runtimeError) {
            finish({ ok: false, error: describeNativeError(runtimeError.message) })
            return
          }
          if (!response || response.ok !== true) {
            finish({ ok: false, error: describeResponseError(response) })
            return
          }
          finish({ ok: true })
        }
      )
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
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      receipt.downloadId
    )
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
  })
  if (!normalized.ok) {
    return Promise.resolve({
      ok: false,
      error: { code: normalized.code, message: normalized.message }
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

    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
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
            : { expectedContentType: normalized.expectedContentType })
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          if (runtimeError) {
            finish({ ok: false, error: describeNativeError(runtimeError.message) })
            return
          }
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
        }
      )
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
 * Probe the native bridge and the running desktop app. `probe` is read-only:
 * it is accepted only when it carries exactly a `type` field, creates nothing
 * and returns no URLs or paths. Welcome and popup status use this instead of
 * sending a synthetic download.
 */
export function probeNativeConnection() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        { type: PROBE_MESSAGE_TYPE },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          if (runtimeError) {
            finish({ ok: false, error: describeNativeError(runtimeError.message) })
            return
          }
          if (
            !response ||
            response.ok !== true ||
            response.operation !== PROBE_MESSAGE_TYPE
          ) {
            finish({
              ok: false,
              error:
                response && response.ok === false
                  ? describeResponseError(response)
                  : {
                      code: 'NATIVE_RESPONSE_INVALID',
                      message: 'The DonDownload helper returned an unexpected response.'
                    }
            })
            return
          }
          finish({ ok: true })
        }
      )
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

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        force
          ? { type: QUEUE_MESSAGE_TYPE, url: normalized.url, force: true }
          : { type: QUEUE_MESSAGE_TYPE, url: normalized.url },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          if (runtimeError) {
            finish({ ok: false, error: describeNativeError(runtimeError.message) })
            return
          }
          if (!response || response.ok !== true) {
            finish({ ok: false, error: describeResponseError(response) })
            return
          }
          finish({ ok: true })
        }
      )
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
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const runtimeError = chrome.runtime.lastError
        if (runtimeError) {
          finish({ ok: false, error: describeNativeError(runtimeError.message) })
          return
        }

        let parsed
        try {
          parsed = parseMediaBridgeResponse(response)
        } catch {
          finish(invalidMediaResponse())
          return
        }
        finish(parsed)
      })
    } catch (error) {
      finish({
        ok: false,
        error: describeNativeError(error instanceof Error ? error.message : '')
      })
    }
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
