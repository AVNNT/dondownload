// Orchestration for "Scan this Gofile share".
//
// The popup cannot read the rendered Gofile rows itself, and the extraction
// must keep working even if the popup closes, so both the popup and the welcome
// page ask this module (through the background worker) to run it. It injects
// the collector into the user's own Gofile tab, waits for its bounded result,
// reads the one-shot Gofile Cookie when the user already allowed it, and sends
// everything through the existing scan bridge.
//
// The real frontend keeps each file's download URL out of the DOM, so the
// collector clicks the row's download button and this module records the browser
// download that starts: a short-lived capture window (see gofile-capture.js)
// takes priority over the automatic hand-off, records the URL and file name,
// and cancels and erases the browser's copy immediately. Rows whose URL was not
// captured are still reported, as unavailable rows.
//
// Nothing here calls api.gofile.io, reads a token from page storage, creates a
// guest account or stores a cookie.

import { sendScanGofile } from './bridge.js'
import { readOptInCookieHeader } from './capture-settings.js'
import {
  armGofileCapture,
  disarmGofileCapture,
  isGofileHostUrl,
  readGofileCapture
} from './gofile-capture.js'

export const GOFILE_SCAN_MESSAGE_TYPE = 'dondownload:gofile-scan'
export const GOFILE_COLLECTOR_FILE = 'gofile-collector.js'
/** The collector's own bounded wait is 15s; this leaves room for injection. */
export const GOFILE_RESULT_TIMEOUT_MS = 25_000
export const GOFILE_POLL_MS = 250
/** A capture window only has to outlive the collector's own click pass. */
export const GOFILE_CAPTURE_WINDOW_MS = 30_000
/** The last click's download can still be arriving when the run resolves. */
export const GOFILE_CAPTURE_SETTLE_MS = 400

const SHARE_ID = /^[A-Za-z0-9_-]{4,64}$/
const DOWNLOAD_PATH = /^\/download\//

/** True for `https://gofile.io/d/<id>` (and the `www` host). */
export function isGofileShareUrl(raw) {
  return shareIdOf(raw) !== null
}

/** The share id of a `https://gofile.io/d/<id>` URL, or null. */
export function shareIdOf(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  const host = parsed.hostname.toLowerCase()
  if (host !== 'gofile.io' && host !== 'www.gofile.io') return null
  const match = /^\/d\/([^/]+)\/?$/.exec(parsed.pathname)
  if (match === null) return null
  return SHARE_ID.test(match[1]) ? match[1] : null
}

/**
 * The tab that currently shows this exact share. Used after a one-time cookie
 * grant so the continuation scans the tab the user already opened instead of
 * asking them to open it again.
 */
export async function findGofileTab(chromeApi, pageUrl) {
  const shareId = shareIdOf(pageUrl)
  if (shareId === null) return null
  let tabs
  try {
    tabs = await chromeApi.tabs.query({
      url: ['https://gofile.io/d/*', 'https://www.gofile.io/d/*']
    })
  } catch {
    return null
  }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || typeof tab.id !== 'number') continue
    if (shareIdOf(tab.url) === shareId) return tab.id
  }
  return null
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function injectionTarget(tabId) {
  return { tabId, allFrames: false }
}

function resultFromInjection(outcome) {
  if (!Array.isArray(outcome)) return null
  for (const entry of outcome) {
    if (entry && entry.result !== undefined && entry.result !== null) {
      return entry.result
    }
  }
  return null
}

/**
 * Inject the collector, start a run and poll for its bounded result.
 * Resolves with the collector's `{ shareId, status, files }` or null.
 *
 * `captureDownloads` makes the collector click every row's download button, so
 * the armed capture window in the background can learn each row's URL.
 */
async function collectFromTab(chromeApi, tabId, deps) {
  const sleep = deps.sleep ?? defaultSleep
  const scripting = chromeApi.scripting
  await scripting.executeScript({
    target: injectionTarget(tabId),
    files: [GOFILE_COLLECTOR_FILE],
    injectImmediately: true
  })
  const started = await scripting.executeScript({
    target: injectionTarget(tabId),
    func: () => {
      const api = globalThis.DonDownloadGofileCollector
      if (!api) return false
      return api.startRun(document, window, { captureDownloads: true })
    }
  })
  if (resultFromInjection(started) !== true) return null

  const deadline = Date.now() + GOFILE_RESULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const polled = await scripting.executeScript({
      target: injectionTarget(tabId),
      func: () => {
        const run = globalThis.__donDownloadGofileRun
        return run && run.result ? run.result : null
      }
    })
    const result = resultFromInjection(polled)
    if (result && typeof result === 'object' && typeof result.status === 'string') {
      return result
    }
    await sleep(GOFILE_POLL_MS)
  }
  return null
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/** A Gofile download URL, HTTPS only. */
function isGofileDownloadUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return false
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (!isGofileHostUrl(parsed.href)) return false
  return DOWNLOAD_PATH.test(parsed.pathname)
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The file name a Gofile download URL ends in, or null. */
function fileNameOfDownloadUrl(raw) {
  try {
    const parsed = new URL(raw)
    const segments = parsed.pathname.split('/').filter((part) => part.length > 0)
    if (segments.length === 0) return null
    return decodeSegment(segments[segments.length - 1] ?? '')
  } catch {
    return null
  }
}

function normalizeName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

/**
 * Match the downloads the capture window recorded to the rows the collector
 * read. A row is matched by its file name, first against the browser-decided
 * file name and then against the name the download URL ends in; each captured
 * download is used once. A row with no match keeps `url: null` and stays an
 * unavailable card.
 */
export function matchCapturedDownloads(rows, downloads) {
  const files = []
  const unavailable = []
  const remaining = []
  for (const download of Array.isArray(downloads) ? downloads : []) {
    if (!download || typeof download !== 'object') continue
    const url = typeof download.url === 'string' ? download.url : ''
    if (!isGofileDownloadUrl(url)) continue
    remaining.push({
      url,
      filename: normalizeName(download.filename),
      urlName: normalizeName(fileNameOfDownloadUrl(url))
    })
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (name.length === 0) continue
    const size =
      typeof row.size === 'number' && Number.isFinite(row.size) && row.size > 0
        ? Math.round(row.size)
        : null
    const direct = typeof row.url === 'string' ? row.url : ''
    if (isGofileDownloadUrl(direct)) {
      files.push({ name, size, url: direct })
      continue
    }
    const wanted = normalizeName(name)
    let matched = -1
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]
      if (candidate.filename === wanted || candidate.urlName === wanted) {
        matched = index
        break
      }
    }
    if (matched === -1) {
      unavailable.push({ name, size })
      continue
    }
    const [captured] = remaining.splice(matched, 1)
    files.push({ name, size, url: captured.url })
  }

  return { files, unavailable }
}

/**
 * Run one Gofile share scan for an already-open tab. The Cookie is read for
 * `gofile.io` only when the user already allowed it for that origin, is sent
 * once and is never stored.
 */
export async function runGofileScan(chromeApi, input, deps = {}) {
  const tabId = input && input.tabId
  const pageUrl = input && input.pageUrl
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
    return failure('INVALID_TAB', 'Open the Gofile share in a tab and scan it again.')
  }
  if (!isGofileShareUrl(pageUrl)) {
    return failure('NOT_GOFILE', 'This page is not a Gofile share link.')
  }

  const sleep = deps.sleep ?? defaultSleep
  // The window is armed before the collector can click anything and closed as
  // soon as the run settles, so no unrelated download can be captured.
  armGofileCapture({
    tabId,
    pageUrl,
    timeoutMs: GOFILE_CAPTURE_WINDOW_MS
  })
  let collected
  try {
    collected = await collectFromTab(chromeApi, tabId, deps)
    if (collected !== null) await sleep(GOFILE_CAPTURE_SETTLE_MS)
  } catch {
    disarmGofileCapture()
    return failure(
      'GOFILE_TAB_UNREADABLE',
      'The Gofile tab could not be read. Reload the share and scan it again.'
    )
  }
  const captured = readGofileCapture().downloads
  disarmGofileCapture()
  if (collected === null) {
    return failure(
      'GOFILE_TIMEOUT',
      'The Gofile page did not finish rendering its file list. Reload the share and scan it again.'
    )
  }

  const shareId = typeof collected.shareId === 'string' ? collected.shareId : null
  if (shareId === null || !SHARE_ID.test(shareId)) {
    return failure('GOFILE_SHARE_UNKNOWN', 'That Gofile share could not be read.')
  }
  const rows = Array.isArray(collected.files) ? collected.files : []
  const status = typeof collected.status === 'string' ? collected.status : 'empty'
  const { files, unavailable } = matchCapturedDownloads(rows, captured)

  const cookie = await readOptInCookieHeader(chromeApi, pageUrl, pageUrl)
  const sent = await sendScanGofile({
    shareId,
    status,
    files,
    ...(unavailable.length === 0 ? {} : { unavailable }),
    ...(cookie === undefined ? {} : { cookie })
  })
  if (!sent.ok) return sent

  return {
    ok: true,
    shareId,
    status,
    fileCount: files.length,
    unavailableCount: unavailable.length,
    cookieAttached: cookie !== undefined
  }
}
