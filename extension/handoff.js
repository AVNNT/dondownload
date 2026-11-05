// Automatic browser download hand-off.
//
// The browser's own download is cancelled only after the native host returns a
// strict durable receipt. Every other outcome leaves it running: an extra copy
// is safer than losing the user's file. This module never reads page content,
// never logs a URL and never uses a page-supplied tab id.

import { sendDurableHandoff } from './bridge.js'
import {
  claimHandoffDownload,
  finishHandoffDownload,
  readCaptureSettings
} from './capture-settings.js'
import { automaticHandoffCandidate } from './handoff-policy.js'

export const HANDOFF_BADGE_CLEAR_MS = 4_000
let badgeGeneration = 0

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
 * Handle one chrome.downloads.onCreated item. Returns a short outcome string for
 * focused tests; callers never need to log it with a URL.
 */
export async function handleCreatedDownload(chromeApi, item) {
  let settings
  try {
    settings = await readCaptureSettings(chromeApi)
  } catch {
    return 'settings-unavailable'
  }
  if (settings.automaticFileHandoff !== true) return 'disabled'

  const downloads = chromeApi && chromeApi.downloads
  if (!downloads) return 'downloads-unavailable'

  let granted = false
  try {
    const permissions = chromeApi && chromeApi.permissions
    granted =
      permissions && typeof permissions.contains === 'function'
        ? (await permissions.contains({ permissions: ['downloads'] })) === true
        : false
  } catch {
    granted = false
  }
  if (!granted) return 'permission-required'

  const candidate = automaticHandoffCandidate(item, settings.excludedOrigins)
  if (!candidate.ok) return `ignored:${candidate.reason}`

  const claim = await claimHandoffDownload(chromeApi, item.id)
  if (!claim.ok) {
    if (claim.reason === 'duplicate') return 'duplicate-uncertain'
    return `not-claimed:${claim.reason}`
  }

  let handoff
  try {
    handoff = await sendDurableHandoff(candidate.url, candidate.filename, {
      expectedBytes: candidate.expectedBytes,
      expectedContentType: candidate.expectedContentType
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
    notifyHandoff(chromeApi, settings, '!', 'Hand-off not confirmed; browser download kept')
    return 'left-running'
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
  const currentCandidate = automaticHandoffCandidate(reread.item, currentSettings.excludedOrigins)
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
  notifyHandoff(chromeApi, settings, 'DD', 'Handed off to DonDownload')
  return 'cancelled'
}

/** Register the downloads listener only when the optional grant is present. */
let downloadsListenerInstalled = false

export function installDownloadsListener(chromeApi, onCreated) {
  const downloads = chromeApi && chromeApi.downloads
  if (!downloads || !downloads.onCreated) return false
  if (downloadsListenerInstalled) return true
  try {
    downloads.onCreated.addListener((item) => {
      Promise.resolve(onCreated(item)).catch(() => undefined)
    })
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
        void searchDownload(chromeApi, delta.id).then((result) => {
          if (result.ok) return onCreated(result.item)
          return undefined
        }).catch(() => undefined)
      })
    }
    downloadsListenerInstalled = true
    return true
  } catch {
    return false
  }
}
