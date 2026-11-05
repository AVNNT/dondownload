import { sendQueueDownload } from './bridge.js'
import {
  OVERLAY_MESSAGE_TYPES,
  OVERLAY_SCRIPT_PREFIX,
  originFromUrl,
  originToMatchPattern,
  overlayOriginFromRegistration
} from './site-policy.js'
import {
  disableOverlayForOrigin,
  enableOverlayForTab,
  forgetOverlayTab,
  handleOverlayReady,
  handlePermissionsAdded,
  handlePermissionsRemoved,
  syncOverlayForTab
} from './overlay-controller.js'
import {
  MEDIA_MESSAGE_TYPES,
  analyzeEmbeddedPageForSender,
  analyzeMediaForSender,
  queueCapturedSourceForSender,
  queueMediaForSender
} from './media-bridge.js'
import { handleCreatedDownload, installDownloadsListener } from './handoff.js'
import { CAPTURE_SETTINGS_KEY, readCaptureSettings } from './capture-settings.js'
import {
  NETWORK_EVIDENCE_MESSAGE_TYPES,
  evidenceForMessage,
  installNetworkObservation,
  requestNetworkEvidenceForSender
} from './network-evidence.js'

const MENU_ID = 'dondownload-link'
const BADGE_CLEAR_MS = 4_000
const DEFAULT_TITLE = 'Send this page to DonDownload'

let badgeGeneration = 0

/**
 * Optional response evidence. The store is intentionally memory-only: a new
 * service-worker generation starts empty, so a response from before a worker
 * restore can never be mapped to a current document.
 */
const networkObservation = installNetworkObservation(chrome, {
  onEvidence(tabId, evidence) {
    const safe = evidenceForMessage(evidence)
    if (safe === null) return
    try {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: NETWORK_EVIDENCE_MESSAGE_TYPES.AVAILABLE,
          url: safe.url,
          evidence: safe
        },
        clearLastError
      )
    } catch {
      // The tab may be closed or have no overlay content script.
    }
  }
})
networkObservation.install()

async function refreshNetworkObservation() {
  let granted = false
  try {
    granted =
      (await chrome.permissions.contains({ permissions: ['webRequest'] })) === true
  } catch {
    granted = false
  }
  let settings
  try {
    settings = await readCaptureSettings(chrome)
  } catch {
    settings = { networkObservation: false }
  }
  networkObservation.setPermissionGranted(granted)
  networkObservation.setEnabled(settings.networkObservation === true)
  if (granted !== true || settings.networkObservation !== true) {
    networkObservation.store.clearAll()
  }
}

void refreshNetworkObservation().catch(() => undefined)

function clearLastError() {
  // Reading lastError prevents "Unchecked runtime.lastError" noise.
  void chrome.runtime.lastError
}

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    clearLastError()
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: 'Download with DonDownload',
        contexts: ['link']
      },
      clearLastError
    )
  })
}

function ignoreResult(result) {
  if (result && typeof result.catch === 'function') {
    result.catch(() => undefined)
  }
}

function showBadge(text, color, title) {
  const generation = ++badgeGeneration
  try {
    ignoreResult(chrome.action.setBadgeBackgroundColor({ color }))
    ignoreResult(chrome.action.setBadgeText({ text }))
    ignoreResult(chrome.action.setTitle({ title: `DonDownload: ${title}` }))
  } catch {
    // Badge feedback is best effort; the popup and context menu still work.
    return
  }

  setTimeout(() => {
    if (generation !== badgeGeneration) return
    ignoreResult(chrome.action.setBadgeText({ text: '' }))
    ignoreResult(chrome.action.setTitle({ title: DEFAULT_TITLE }))
  }, BADGE_CLEAR_MS)
}

async function handleLink(linkUrl) {
  const result = await sendQueueDownload(linkUrl)
  if (result.ok) {
    // The app only says ok after DownloadManager.add has resolved.
    showBadge('OK', '#1f7a3a', 'Download added')
    return
  }

  if (result.error.code === 'DUPLICATE_DOWNLOAD') {
    // Never silently resubmit with force from the context menu. The popup is
    // the explicit, user-initiated place to choose Download again.
    showBadge(
      '!',
      '#a16207',
      'Already in DonDownload — use Download again in the app'
    )
    return
  }

  showBadge('!', '#a61b1b', result.error.message)
}

function overlayFailure(code, message) {
  return { ok: false, error: { code, message } }
}

async function handleContentDisable(message, sender) {
  if (!sender || !sender.tab || sender.frameId !== 0) {
    return overlayFailure('INVALID_SENDER', 'The request did not come from an opted-in page.')
  }
  if (
    originFromUrl(sender.tab.url) !== message.origin ||
    originToMatchPattern(message.origin) === null
  ) {
    return overlayFailure('ORIGIN_MISMATCH', 'The overlay site did not match.')
  }
  return disableOverlayForOrigin(chrome, message.origin, sender.tab.id)
}

async function reconcileOverlayRegistrations() {
  try {
    const registrations = await chrome.scripting.getRegisteredContentScripts()
    for (const registration of registrations) {
      if (
        !registration ||
        typeof registration.id !== 'string' ||
        !registration.id.startsWith(OVERLAY_SCRIPT_PREFIX)
      ) {
        continue
      }

      const origin = overlayOriginFromRegistration(registration)
      const pattern = origin === null ? null : originToMatchPattern(origin)
      let granted = false
      if (pattern !== null) {
        try {
          granted = await chrome.permissions.contains({ origins: [pattern] })
        } catch {
          granted = false
        }
      }
      if (!granted) {
        await chrome.scripting.unregisterContentScripts({ ids: [registration.id] })
      }
    }
  } catch {
    // Reconciliation is best effort and never blocks the manual capture path.
  }
}

function installLifecycleListeners() {
  installContextMenu()
  void reconcileOverlayRegistrations()
  installDownloadsSupport()
  networkObservation.install()
  void refreshNetworkObservation().catch(() => undefined)
}

/**
 * The downloads permission is optional and granted only from the options page
 * on a user gesture. Until then `chrome.downloads` is absent, so this is a
 * guarded no-op rather than a broken top-level listener.
 */
function installDownloadsSupport() {
  installDownloadsListener(chrome, (item) => handleCreatedDownload(chrome, item))
}

async function toggleOverlayOnActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = Array.isArray(tabs) ? tabs[0] : null
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return
    await chrome.tabs.sendMessage(tab.id, { type: 'dondownload:overlay-toggle' })
  } catch {
    // The active tab may be a browser page, an opted-out site or have no
    // content script. A command is not an error and never opens a window.
  }
}

// Evaluate this at worker start as well as after a grant. Service-worker
// suspension/recreation re-runs the module, and permissions.onAdded covers a
// grant that happened while the worker was alive but the API was not yet
// exposed.
installDownloadsSupport()

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-overlay') return
    void toggleOverlayOnActiveTab()
  })
}
chrome.runtime.onInstalled.addListener(installLifecycleListeners)
chrome.runtime.onStartup.addListener(installLifecycleListeners)

// The optional host permission may be granted after the action popup has been
// closed by the browser's permission prompt. These top-level listeners let the
// service worker finish the exact-origin registration and injection anyway.
chrome.permissions.onAdded.addListener((permissions) => {
  installDownloadsSupport()
  networkObservation.install()
  void refreshNetworkObservation().catch(() => undefined)
  void handlePermissionsAdded(chrome, permissions).catch(() => undefined)
})

chrome.permissions.onRemoved.addListener((permissions) => {
  void refreshNetworkObservation().catch(() => undefined)
  void handlePermissionsRemoved(chrome, permissions).catch(() => undefined)
})

// Prune session-only tab records. `tabs.onRemoved` needs no `tabs` permission.
chrome.tabs.onRemoved.addListener((tabId) => {
  networkObservation.clearTab(tabId)
  void forgetOverlayTab(chrome, tabId).catch(() => undefined)
})

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[CAPTURE_SETTINGS_KEY]) return
    void refreshNetworkObservation().catch(() => undefined)
  })
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return
  void handleLink(info.linkUrl)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  if (message.type === OVERLAY_MESSAGE_TYPES.ENABLE) {
    void enableOverlayForTab(chrome, message.origin, message.tabId)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('OVERLAY_FAILED', 'The overlay request could not be completed.')
        )
      )
    return true
  }

  if (message.type === OVERLAY_MESSAGE_TYPES.SYNC) {
    void syncOverlayForTab(chrome, message.origin, message.tabId)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('OVERLAY_FAILED', 'The overlay state could not be checked.')
        )
      )
    return true
  }

  if (message.type === OVERLAY_MESSAGE_TYPES.READY) {
    // No response is needed. Tracking is best effort, so a closed channel is
    // never reported back to the page.
    void handleOverlayReady(chrome, message, sender).catch(() => undefined)
    return false
  }

  if (message.type === MEDIA_MESSAGE_TYPES.ANALYZE) {
    void analyzeMediaForSender(chrome, message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('MEDIA_REQUEST_FAILED', 'The media request could not be completed.')
        )
      )
    return true
  }

  if (message.type === MEDIA_MESSAGE_TYPES.ANALYZE_EMBED) {
    void analyzeEmbeddedPageForSender(chrome, message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('MEDIA_REQUEST_FAILED', 'The embedded media request could not be completed.')
        )
      )
    return true
  }

  if (message.type === MEDIA_MESSAGE_TYPES.QUEUE) {
    void queueMediaForSender(chrome, message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('MEDIA_REQUEST_FAILED', 'The media request could not be completed.')
        )
      )
    return true
  }

  if (message.type === MEDIA_MESSAGE_TYPES.CAPTURE_QUEUE) {
    void queueCapturedSourceForSender(chrome, message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure(
            'CAPTURE_REQUEST_FAILED',
            'The captured source request could not be completed.'
          )
        )
      )
    return true
  }

  if (message.type === NETWORK_EVIDENCE_MESSAGE_TYPES.REQUEST) {
    void requestNetworkEvidenceForSender(chrome, message, sender, {
      store: networkObservation.store,
      enabled: networkObservation.isEnabled()
    })
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure(
            'EVIDENCE_REQUEST_FAILED',
            'The playback response evidence request could not be completed.'
          )
        )
      )
    return true
  }

  if (message.type === OVERLAY_MESSAGE_TYPES.DISABLE) {
    void disableOverlayForOrigin(chrome, message.origin, message.tabId)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('OVERLAY_FAILED', 'The overlay request could not be completed.')
        )
      )
    return true
  }

  if (message.type === OVERLAY_MESSAGE_TYPES.DISABLE_SITE) {
    void handleContentDisable(message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure('OVERLAY_FAILED', 'The overlay request could not be completed.')
        )
      )
    return true
  }

  return false
})
