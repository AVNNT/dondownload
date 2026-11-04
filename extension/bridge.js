// The browser extension has exactly one outbound operation. It never touches
// the browser's downloads API, webRequest, cookies, tabs history or page DOM.

export const NATIVE_HOST = 'com.dondownload.bridge'
export const QUEUE_MESSAGE_TYPE = 'queue-download'
export const MAX_URL_LENGTH = 4096

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
