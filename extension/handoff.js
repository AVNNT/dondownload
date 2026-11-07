// Automatic browser download hand-off.
//
// The browser's own download is cancelled only after the native host returns a
// strict durable receipt. Every other outcome leaves it running: an extra copy
// is safer than losing the user's file. This module never reads page content,
// never logs a URL and never uses a page-supplied tab id.
//
// The decision runs in chrome.downloads.onDeterminingFilename, before the
// browser starts the transfer, so a "Save as" window never opens for a
// download DonDownload takes over. Every path releases the held download with
// suggest(): immediately when it is not a candidate, after the cancel when it
// is, and from a safety timer if the hand-off hangs.

import { sendDurableHandoff } from './bridge.js'
import {
  rememberHandedOffDownload,
  showHandoffCard
} from './handoff-card.js'
import {
  claimHandoffDownload,
  clearNeedsLoginState,
  finishHandoffDownload,
  readCaptureSettings,
  readHandoffCookieHeader,
  recordNeedsLoginState
} from './capture-settings.js'
import {
  automaticHandoffCandidate,
  originFromPageUrl
} from './handoff-policy.js'

export const HANDOFF_BADGE_CLEAR_MS = 4_000

/**
 * How long a held download waits for the hand-off decision before the browser
 * is released. A download must never stay stuck behind this extension.
 */
export const HANDOFF_SUGGEST_TIMEOUT_MS = 5_000
let badgeGeneration = 0
let needsLoginBadge = false

function hostOf(value) {
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}

function setNeedsLoginBadge(chromeApi, host) {
  needsLoginBadge = true
  // Invalidate any pending "DD" clear from an earlier successful hand-off.
  badgeGeneration += 1
  const action = chromeApi && chromeApi.action
  if (!action) return
  try {
    ignoreResult(action.setBadgeBackgroundColor({ color: '#a16207' }))
    ignoreResult(action.setBadgeText({ text: '!' }))
    ignoreResult(
      action.setTitle({
        title: `DonDownload: This download needs your login on ${host || 'this site'}`
      })
    )
  } catch {
    // Badge feedback is best effort; the popup still explains the state.
  }
}

/** True while the persistent "needs login" badge owns the toolbar. */
export function hasNeedsLoginBadge() {
  return needsLoginBadge
}

/** A successful later hand-off clears the stale login warning. */
export function clearNeedsLoginBadge() {
  needsLoginBadge = false
}

function ignoreResult(result) {
  if (result && typeof result.catch === 'function') result.catch(() => undefined)
}

function notifyHandoff(chromeApi, settings, text, title) {
  if (!settings || settings.handoffNotifications !== true) return
  const action = chromeApi && chromeApi.action
  if (!action) return
  const generation = ++badgeGeneration
  try {
    ignoreResult(action.setBadgeBackgroundColor({ color: '#1f7a3a' }))
    ignoreResult(action.setBadgeText({ text }))
    ignoreResult(action.setTitle({ title: `DonDownload: ${title}` }))
  } catch {
    return
  }
  setTimeout(() => {
    if (generation !== badgeGeneration) return
    ignoreResult(action.setBadgeText({ text: '' }))
    ignoreResult(action.setTitle({ title: 'Send this page to DonDownload' }))
  }, HANDOFF_BADGE_CLEAR_MS)
}

function searchDownload(chromeApi, downloadId) {
  return new Promise((resolve) => {
    const downloads = chromeApi && chromeApi.downloads
    if (!downloads || typeof downloads.search !== 'function') {
      resolve({ ok: false })
      return
    }
    try {
      downloads.search({ id: downloadId }, (items) => {
        const runtimeError = chromeApi.runtime && chromeApi.runtime.lastError
        if (runtimeError || !Array.isArray(items) || items.length !== 1) {
          resolve({ ok: false })
          return
        }
        resolve({ ok: true, item: items[0] })
      })
    } catch {
      resolve({ ok: false })
    }
  })
}

function cancelDownload(chromeApi, downloadId) {
  return new Promise((resolve) => {
    const downloads = chromeApi && chromeApi.downloads
    if (!downloads || typeof downloads.cancel !== 'function') {
      resolve({ ok: false })
      return
    }
    try {
      downloads.cancel(downloadId, () => {
        const runtimeError = chromeApi.runtime && chromeApi.runtime.lastError
        resolve({ ok: !runtimeError })
      })
    } catch {
      resolve({ ok: false })
    }
  })
}

/**
 * Drop a cancelled download from the browser's download list. Best effort: the
 * hand-off already succeeded, so a browser that refuses the erase only leaves a
 * cancelled entry behind.
 */
function eraseDownload(chromeApi, downloadId) {
  return new Promise((resolve) => {
    const downloads = chromeApi && chromeApi.downloads
    if (!downloads || typeof downloads.erase !== 'function') {
      resolve({ ok: false })
      return
    }
    try {
      downloads.erase({ id: downloadId }, () => {
        const runtimeError = chromeApi.runtime && chromeApi.runtime.lastError
        resolve({ ok: !runtimeError })
      })
    } catch {
      resolve({ ok: false })
    }
  })
}

/**
 * Report a download the browser no longer owns. Purely additive feedback: the
 * badge, the remembered id for the service worker and the in-page card can all
 * fail without changing the hand-off outcome.
 */
async function completeTakeover(chromeApi, settings, item, receipt) {
  notifyHandoff(chromeApi, settings, 'DD', 'Sent to DonDownload')
  try {
    rememberHandedOffDownload(receipt.downloadId)
  } catch {
    // Session memory is best effort; the badge still reports the hand-off.
  }
  await showHandoffCard(chromeApi, settings, item, receipt)
}

/**
 * Handle one chrome.downloads item. Returns a short outcome string for focused
 * tests; callers never need to log it with a URL.
 *
 * This is the download-manager path: the browser already decided the transfer
 * is a download, so no extension allowlist applies. The user's "only files
 * larger than" threshold is enforced from the browser's exact total, except for
 * an always-hand-off type (a `.funscript`), which is a few KB by nature.
 */
export async function handleCreatedDownload(chromeApi, item, options = {}) {
  // A held item comes from onDeterminingFilename: the browser has not started
  // the transfer and is waiting for suggest(), so there is no live download to
  // re-read and nothing to keep running.
  const held = options !== null && typeof options === 'object' && options.held === true
  let settings
  try {
    settings = await readCaptureSettings(chromeApi)
  } catch {
    return 'settings-unavailable'
  }
  if (settings.automaticFileHandoff !== true) return 'disabled'

  const downloads = chromeApi && chromeApi.downloads
  if (!downloads) return 'downloads-unavailable'

  const candidateOptions = { minBytes: settings.handoffMinBytes }
  const candidate = automaticHandoffCandidate(
    item,
    settings.excludedOrigins,
    candidateOptions
  )
  if (!candidate.ok) return `ignored:${candidate.reason}`

  const downloadOrigin = candidate.origin
  const pageOrigin = originFromPageUrl(item.referrer)
  const cookieUrl =
    typeof item.finalUrl === 'string' && item.finalUrl.length > 0
      ? item.finalUrl
      : candidate.url
  // The user switched this on and granted the optional cookies permission with
  // it, so the browser's cookies for exactly this download URL are read without
  // a per-site opt-in. `getAll({ url })` returns cookies for that URL only;
  // nothing is stored and nothing is logged.
  const cookie = await readHandoffCookieHeader(chromeApi, cookieUrl)

  const claim = await claimHandoffDownload(chromeApi, item.id)
  if (!claim.ok) {
    if (claim.reason === 'duplicate') return 'duplicate-uncertain'
    return `not-claimed:${claim.reason}`
  }

  let handoff
  try {
    handoff = await sendDurableHandoff(candidate.url, candidate.filename, {
      expectedBytes: candidate.expectedBytes,
      expectedContentType: candidate.expectedContentType,
      minBytes: settings.handoffMinBytes,
      // The candidate already decided this file ignores the size threshold; the
      // bridge must not re-reject it as too small.
      ignoreMinimumBytes: candidate.alwaysHandoff === true,
      ...(originFromPageUrl(item.referrer) !== null
        ? { referer: item.referrer }
        : {}),
      ...(typeof navigator !== 'undefined' &&
      typeof navigator.userAgent === 'string'
        ? { userAgent: navigator.userAgent }
        : {}),
      ...(cookie === undefined ? {} : { cookie })
    })
  } catch {
    handoff = {
      ok: false,
      error: { code: 'HANDOFF_FAILED', message: 'The hand-off failed.' }
    }
  }

  // Any failure, malformed receipt, duplicate or timeout leaves the browser
  // download running. Finish the session record so a suspended worker never
  // retries an uncertain transfer.
  if (!handoff || handoff.ok !== true || handoff.durable !== true) {
    await finishHandoffDownload(chromeApi, item.id)
    if (
      cookie === undefined &&
      handoff &&
      handoff.error &&
      handoff.error.code === 'HANDOFF_NEEDS_LOGIN'
    ) {
      // The preflight reached a login wall without a cookie. Remember it for
      // the popup so the user can opt this exact origin in with one click.
      const origin = pageOrigin ?? downloadOrigin
      const host = hostOf(cookieUrl)
      if (origin !== null && host.length > 0) {
        await recordNeedsLoginState(chromeApi, { origin, host })
        setNeedsLoginBadge(chromeApi, host)
        return 'needs-login'
      }
    }
    notifyHandoff(chromeApi, settings, '!', 'Hand-off not confirmed; browser download kept')
    return 'left-running'
  }
  await clearNeedsLoginState(chromeApi)
  clearNeedsLoginBadge()

  if (held) {
    // Cancel the held download before it starts, then erase the cancelled entry
    // so the browser shows no download at all. The caller releases the browser
    // with suggest() once this resolves.
    const heldCancel = await cancelDownload(chromeApi, item.id)
    if (heldCancel.ok) await eraseDownload(chromeApi, item.id)
    await finishHandoffDownload(chromeApi, item.id)
    if (!heldCancel.ok) {
      notifyHandoff(chromeApi, settings, '!', 'Hand-off saved; browser download kept')
      return 'left-running-cancel-failed'
    }
    await completeTakeover(chromeApi, settings, item, handoff.receipt)
    return 'cancelled'
  }

  const reread = await searchDownload(chromeApi, item.id)
  if (!reread.ok) {
    await finishHandoffDownload(chromeApi, item.id)
    notifyHandoff(chromeApi, settings, '!', 'Hand-off saved; browser download kept')
    return 'left-running-unreadable'
  }
  if (reread.item.state !== 'in_progress') {
    // The browser may have completed between creation and receipt. A possible
    // duplicate is safer than losing the file, so never cancel here.
    await finishHandoffDownload(chromeApi, item.id)
    notifyHandoff(chromeApi, settings, '!', 'Hand-off saved; browser download completed already')
    return 'left-running-completed'
  }
  const currentSettings = await readCaptureSettings(chromeApi)
  const currentCandidate = automaticHandoffCandidate(
    reread.item,
    currentSettings.excludedOrigins,
    { minBytes: currentSettings.handoffMinBytes }
  )
  if (!currentSettings.automaticFileHandoff || !currentCandidate.ok || currentCandidate.url !== candidate.url) {
    await finishHandoffDownload(chromeApi, item.id)
    return 'left-running-changed'
  }

  const cancelled = await cancelDownload(chromeApi, item.id)
  await finishHandoffDownload(chromeApi, item.id)
  if (!cancelled.ok) {
    notifyHandoff(chromeApi, settings, '!', 'Hand-off saved; browser download kept')
    return 'left-running-cancel-failed'
  }
  await completeTakeover(chromeApi, settings, item, handoff.receipt)
  return 'cancelled'
}

/** One listener registration per worker generation. */
let downloadsListenerInstalled = false

/**
 * Download ids this worker already took over. Both download events can report
 * one download, so a taken-over id is never decided a second time.
 */
const handledDownloadIds = new Set()
const MAX_HANDLED_DOWNLOAD_IDS = 200

function downloadIdOf(item) {
  return item && Number.isSafeInteger(item.id) && item.id > 0 ? item.id : null
}

function wasHandled(item) {
  const id = downloadIdOf(item)
  return id !== null && handledDownloadIds.has(id)
}

function rememberHandled(item) {
  const id = downloadIdOf(item)
  if (id === null) return
  handledDownloadIds.add(id)
  while (handledDownloadIds.size > MAX_HANDLED_DOWNLOAD_IDS) {
    const oldest = handledDownloadIds.values().next().value
    handledDownloadIds.delete(oldest)
  }
}

function callSuggest(suggest) {
  if (typeof suggest !== 'function') return
  try {
    suggest()
  } catch {
    // A download that already resolved rejects the call; nothing to release.
  }
}

/**
 * Run one held download from chrome.downloads.onDeterminingFilename. The browser
 * is waiting for suggest() before it starts the transfer or opens a Save As
 * window, so the decision runs here and the download is released exactly once:
 * as soon as the decision settles, or from the safety timer if it hangs.
 */
function runHeldDownload(chromeApi, item, suggest, onCreated) {
  if (wasHandled(item)) {
    callSuggest(suggest)
    return false
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    callSuggest(suggest)
  }
  const timer = setTimeout(release, HANDOFF_SUGGEST_TIMEOUT_MS)
  const settle = (outcome) => {
    clearTimeout(timer)
    // A taken-over download was cancelled and erased above; releasing the held
    // decision afterwards only resolves the browser's pending callback. A
    // captured one was cancelled by the Gofile row capture.
    if (outcome === 'cancelled' || outcome === 'captured') rememberHandled(item)
    release()
  }
  Promise.resolve()
    .then(() => onCreated(item, { held: true }))
    .then(settle, () => {
      clearTimeout(timer)
      release()
    })
  return true
}

/**
 * Register the chrome.downloads listeners. `downloads` is a required manifest
 * permission, so the worker calls this unconditionally on every start; calling
 * it again only ever adds one listener per worker generation.
 *
 * onDeterminingFilename is used when the browser has it, because it runs before
 * the browser starts the download. onCreated is registered *as well*, never
 * instead: the held event does not fire for every download (a page- or
 * extension-initiated one can skip it, and a browser driving downloads through
 * its own automation surface skips it too), and the Gofile row capture depends
 * on onCreated. Both paths share the same handled-id set, so one download is
 * never decided twice.
 */
export function installDownloadsListener(chromeApi, onCreated) {
  const downloads = chromeApi && chromeApi.downloads
  if (!downloads || typeof onCreated !== 'function') return false
  const holdsFilenames =
    downloads.onDeterminingFilename &&
    typeof downloads.onDeterminingFilename.addListener === 'function'
  const hasCreated = downloads.onCreated && typeof downloads.onCreated.addListener === 'function'
  if (!holdsFilenames && !hasCreated) return false
  if (downloadsListenerInstalled) return true
  try {
    if (holdsFilenames) {
      downloads.onDeterminingFilename.addListener((item, suggest) =>
        runHeldDownload(chromeApi, item, suggest, onCreated)
      )
    }
    if (hasCreated) {
      downloads.onCreated.addListener((item) => {
        if (wasHandled(item)) return
        Promise.resolve(onCreated(item))
          .then((outcome) => {
            if (outcome === 'cancelled' || outcome === 'captured') rememberHandled(item)
          })
          .catch(() => undefined)
      })
    }
    if (downloads.onChanged && typeof downloads.onChanged.addListener === 'function') {
      downloads.onChanged.addListener((delta) => {
        if (
          !delta ||
          !Number.isSafeInteger(delta.id) ||
          !delta.totalBytes ||
          typeof delta.totalBytes.current !== 'number' ||
          !Number.isSafeInteger(delta.totalBytes.current) ||
          delta.totalBytes.current <= 0
        ) {
          return
        }
        // A download the browser already reported a size for can still become a
        // candidate; one that was decided is never decided again.
        if (handledDownloadIds.has(delta.id)) return
        void searchDownload(chromeApi, delta.id).then((result) => {
          if (!result.ok || wasHandled(result.item)) return undefined
          return Promise.resolve(onCreated(result.item))
            .then((outcome) => {
              if (outcome === 'cancelled') rememberHandled(result.item)
            })
            .catch(() => undefined)
        }).catch(() => undefined)
      })
    }
    downloadsListenerInstalled = true
    return true
  } catch {
    return false
  }
}

/** Test hook: forget that listeners were installed for a previous fake API. */
export function resetDownloadsListenerForTests() {
  downloadsListenerInstalled = false
  handledDownloadIds.clear()
}

/**
 * Mark one browser download as already decided. The Gofile row capture uses it
 * so a late `onChanged` (a cancelled item still reports a total) never sends the
 * same download through the hand-off a second time.
 */
export function rememberDecidedDownload(item) {
  rememberHandled(item)
}
