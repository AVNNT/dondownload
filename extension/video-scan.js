// Orchestration for "Scan this page" on a video page.
//
// The popup cannot read the rendered player itself, and the extraction must keep
// working even if the popup closes, so both the popup and the welcome page ask
// this module (through the background worker) to run it. It injects the
// collector into the user's own video tab, waits for its bounded result, reads
// the one-shot Cookie for that exact origin when the user already allowed it,
// and sends everything through the existing scan bridge.
//
// Nothing here solves a challenge, bypasses an age gate, clicks the page or
// stores a cookie: the user's real browser session is what makes the media
// visible, and the desktop re-validates every URL.

import { sendScanVideo } from './bridge.js'
import { readOptInCookieHeader } from './capture-settings.js'

export const VIDEO_SCAN_MESSAGE_TYPE = 'dondownload:video-scan'
export const VIDEO_COLLECTOR_FILE = 'video-collector.js'
/** The collector's own bounded wait is 6s; this leaves room for injection. */
export const VIDEO_RESULT_TIMEOUT_MS = 20_000
export const VIDEO_POLL_MS = 250

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

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Inject the collector, start a run and poll for its bounded result.
 * Resolves with the collector's `{ pageUrl, title, sources }` or null.
 */
async function collectFromTab(chromeApi, tabId, deps) {
  const sleep = deps.sleep ?? defaultSleep
  const scripting = chromeApi.scripting
  await scripting.executeScript({
    target: injectionTarget(tabId),
    files: [VIDEO_COLLECTOR_FILE],
    injectImmediately: true
  })
  const started = await scripting.executeScript({
    target: injectionTarget(tabId),
    func: () => {
      const api = globalThis.DonDownloadVideoCollector
      if (!api) return false
      return api.startRun(document, window, {})
    }
  })
  if (resultFromInjection(started) !== true) return null

  const deadline = Date.now() + VIDEO_RESULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const polled = await scripting.executeScript({
      target: injectionTarget(tabId),
      func: () => {
        const run = globalThis.__donDownloadVideoRun
        return run && run.result ? run.result : null
      }
    })
    const result = resultFromInjection(polled)
    if (result && typeof result === 'object' && Array.isArray(result.sources)) {
      return result
    }
    await sleep(VIDEO_POLL_MS)
  }
  return null
}

/**
 * Read the media this tab rendered and report it once.
 *
 * `sent: false` means the page exposed no media URL at all, so the caller can
 * fall back to the normal page scan without a second session.
 */
export async function runVideoScan(chromeApi, input, deps = {}) {
  const tabId = input && input.tabId
  const pageUrl = input && input.pageUrl
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
    return failure('INVALID_TAB', 'Open the video page in a tab and scan it again.')
  }
  if (typeof pageUrl !== 'string' || pageUrl.length === 0 || pageUrl.length > 4096) {
    return failure('INVALID_PAGE', 'This tab is not a supported http(s) page.')
  }

  let collected
  try {
    collected = await collectFromTab(chromeApi, tabId, deps)
  } catch {
    return failure(
      'VIDEO_TAB_UNREADABLE',
      'The video page could not be read. Reload it and scan it again.'
    )
  }
  if (collected === null) {
    return failure(
      'VIDEO_TIMEOUT',
      'The video page did not finish loading its player. Start the video, then scan it again.'
    )
  }

  const sources = Array.isArray(collected.sources) ? collected.sources : []
  if (sources.length === 0) {
    return { ok: true, sent: false, sourceCount: 0, pageUrl, title: null }
  }

  const cookie = await readOptInCookieHeader(chromeApi, pageUrl, pageUrl)
  const sent = await sendScanVideo({
    pageUrl,
    ...(typeof collected.title === 'string' ? { title: collected.title } : {}),
    sources,
    ...(cookie === undefined ? {} : { cookie })
  })
  if (!sent.ok) return sent

  return {
    ok: true,
    sent: true,
    sourceCount: sources.length,
    pageUrl,
    title: typeof collected.title === 'string' ? collected.title : null,
    cookieAttached: cookie !== undefined
  }
}

/** True when the desktop should be asked about this tab at all. */
export function isVideoScanResult(result) {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.ok === true &&
    result.sent === true
  )
}
