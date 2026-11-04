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

const MENU_ID = 'dondownload-link'
const BADGE_CLEAR_MS = 4_000
const DEFAULT_TITLE = 'Send this page to DonDownload'

let badgeGeneration = 0

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
}

chrome.runtime.onInstalled.addListener(installLifecycleListeners)
chrome.runtime.onStartup.addListener(installLifecycleListeners)

// The optional host permission may be granted after the action popup has been
// closed by the browser's permission prompt. These top-level listeners let the
// service worker finish the exact-origin registration and injection anyway.
chrome.permissions.onAdded.addListener((permissions) => {
  void handlePermissionsAdded(chrome, permissions).catch(() => undefined)
})

chrome.permissions.onRemoved.addListener((permissions) => {
  void handlePermissionsRemoved(chrome, permissions).catch(() => undefined)
})

// Prune session-only tab records. `tabs.onRemoved` needs no `tabs` permission.
chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetOverlayTab(chrome, tabId).catch(() => undefined)
})

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
