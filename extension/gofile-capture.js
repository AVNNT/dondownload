// Short-lived capture of the downloads a Gofile row click starts.
//
// The real gofile.io frontend never puts a download URL in the DOM: manager.js
// builds a transient anchor, clicks it and removes it. The only way to learn a
// row's URL is therefore to let the browser start that download and read the
// item back. This module owns that window:
//
//  - it is armed only for the duration of one "scan this Gofile share" flow,
//    with a hard timeout and a hard download cap;
//  - it only ever looks at gofile.io / *.gofile.io URLs, and at the armed tab's
//    own referrer when the browser reports one;
//  - a captured download is recorded (URL + file name) and then cancelled and
//    erased immediately, so Chrome never keeps the file;
//  - while armed it takes priority over the automatic browser hand-off, so the
//    same download is never both captured and handed to DonDownload.
//
// Nothing here reads page content, a cookie or a token, and nothing is stored.

/** A capture window that outlives its flow is a bug, not a feature. */
export const GOFILE_CAPTURE_TIMEOUT_MS = 30_000
/** One share is capped at the collector's own file limit. */
export const GOFILE_CAPTURE_MAX_DOWNLOADS = 500
/** Give the browser a moment to settle a cancel before erasing the entry. */
export const GOFILE_CAPTURE_ERASE_DELAY_MS = 250

let armed = null
let captureGeneration = 0

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function originOf(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/** True for `gofile.io` and any `*.gofile.io` host. */
export function isGofileHostUrl(value) {
  const host = hostOf(value)
  if (host.length === 0) return false
  if (host === 'gofile.io' || host === 'www.gofile.io') return true
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.gofile\.io$/.test(host)
}

/** True while a Gofile row capture window is open. */
export function isGofileCaptureArmed() {
  return armed !== null
}

/**
 * Open one capture window for a Gofile tab scan. Arming twice only refreshes the
 * deadline, so a retried scan cannot leave two windows open.
 */
export function armGofileCapture(input = {}) {
  const tabId =
    typeof input.tabId === 'number' && Number.isInteger(input.tabId) ? input.tabId : null
  const pageUrl = typeof input.pageUrl === 'string' ? input.pageUrl : ''
  const timeoutMs =
    typeof input.timeoutMs === 'number' && input.timeoutMs > 0
      ? input.timeoutMs
      : GOFILE_CAPTURE_TIMEOUT_MS
  disarmGofileCapture()
  captureGeneration += 1
  const generation = captureGeneration
  armed = {
    tabId,
    pageUrl,
    origin: originOf(pageUrl),
    generation,
    downloads: new Map(),
    order: [],
    timer: null
  }
  if (typeof setTimeout === 'function') {
    armed.timer = setTimeout(() => {
      if (armed !== null && armed.generation === generation) disarmGofileCapture()
    }, timeoutMs)
    // A pending capture must never keep a worker alive on its own.
    if (armed.timer && typeof armed.timer.unref === 'function') armed.timer.unref()
  }
  return { armed: true, tabId, timeoutMs }
}

/** Close the capture window and forget everything it recorded. */
export function disarmGofileCapture() {
  if (armed === null) return { armed: false }
  if (armed.timer !== null && typeof clearTimeout === 'function') {
    clearTimeout(armed.timer)
  }
  const recorded = armed.order.length
  armed = null
  captureGeneration += 1
  return { armed: false, recorded }
}

/** Test hook: drop the window without touching timers. */
export function resetGofileCaptureForTests() {
  if (armed !== null && armed.timer !== null && typeof clearTimeout === 'function') {
    clearTimeout(armed.timer)
  }
  armed = null
  captureGeneration += 1
}

/**
 * True when a browser download belongs to the armed Gofile window: a Gofile
 * host, the armed tab when the browser reports one, and the armed page's own
 * origin as referrer when a referrer is reported.
 */
export function isArmedGofileDownload(item) {
  if (armed === null) return false
  if (!item || typeof item !== 'object') return false
  if (typeof item.byExtensionId === 'string' && item.byExtensionId.length > 0) {
    return false
  }
  const url =
    typeof item.finalUrl === 'string' && item.finalUrl.length > 0
      ? item.finalUrl
      : typeof item.url === 'string'
        ? item.url
        : ''
  if (!isGofileHostUrl(url)) return false
  if (
    armed.tabId !== null &&
    typeof item.tabId === 'number' &&
    Number.isInteger(item.tabId) &&
    item.tabId !== armed.tabId
  ) {
    return false
  }
  const referrerOrigin = originOf(item.referrer)
  if (referrerOrigin !== null && armed.origin !== null && referrerOrigin !== armed.origin) {
    return false
  }
  return true
}

function fileNameOf(item) {
  const raw = typeof item.filename === 'string' ? item.filename : ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base.length > 0 ? base : null
}

/**
 * Record one captured download. Returns the record, or null when the item is not
 * part of the armed window or the window is already full.
 */
export function recordGofileCapture(item) {
  if (!isArmedGofileDownload(item)) return null
  if (typeof item.id !== 'number' || !Number.isInteger(item.id)) return null
  if (armed.downloads.has(item.id)) return armed.downloads.get(item.id)
  if (armed.order.length >= GOFILE_CAPTURE_MAX_DOWNLOADS) return null
  const url =
    typeof item.finalUrl === 'string' && item.finalUrl.length > 0
      ? item.finalUrl
      : typeof item.url === 'string'
        ? item.url
        : ''
  const record = { downloadId: item.id, url, filename: fileNameOf(item) }
  armed.downloads.set(item.id, record)
  armed.order.push(record)
  return record
}

/** Everything captured so far in the open window, in arrival order. */
export function readGofileCapture() {
  if (armed === null) return { armed: false, downloads: [] }
  return {
    armed: true,
    downloads: armed.order.map((record) => ({
      url: record.url,
      filename: record.filename
    }))
  }
}

function cancelDownload(chromeApi, downloadId) {
  const downloads = chromeApi && chromeApi.downloads
  if (!downloads || typeof downloads.cancel !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      downloads.cancel(downloadId, () => {
        void (chromeApi.runtime && chromeApi.runtime.lastError)
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

function eraseDownload(chromeApi, downloadId) {
  const downloads = chromeApi && chromeApi.downloads
  if (!downloads || typeof downloads.erase !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      downloads.erase({ id: downloadId }, () => {
        void (chromeApi.runtime && chromeApi.runtime.lastError)
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * Take one browser download out of the browser: record it, cancel it and erase
 * the entry. Returns true when the item belonged to the armed window, which is
 * also the signal that the automatic hand-off must not run for it.
 *
 * The cancel starts immediately (nothing is written to disk) and the erase runs
 * after a short delay so Chrome has settled the cancel; both are best effort.
 * A download the browser reports twice is recorded and cancelled once, and one
 * that arrives after the window is full is still cancelled and erased.
 */
export function captureGofileDownload(chromeApi, item) {
  if (!isArmedGofileDownload(item)) return false
  if (typeof item.id !== 'number' || !Number.isInteger(item.id)) return false
  if (armed.downloads.has(item.id)) return true
  recordGofileCapture(item)
  void cancelDownload(chromeApi, item.id)
  const erase = () => {
    void eraseDownload(chromeApi, item.id)
  }
  if (typeof setTimeout === 'function') {
    setTimeout(erase, GOFILE_CAPTURE_ERASE_DELAY_MS)
  } else {
    erase()
  }
  return true
}
