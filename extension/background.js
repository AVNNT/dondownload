import { sendQueueDownload, sendQueueSniffedMedia } from './bridge.js'
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
  isOverlayTabTracked,
  reconcileOverlayMode,
  syncOverlayForTab
} from './overlay-controller.js'
import {
  MEDIA_MESSAGE_TYPES,
  analyzeEmbeddedPageForSender,
  analyzeMediaForSender,
  queueCapturedSourceForSender,
  queueMediaForSender
} from './media-bridge.js'
import { handleCreatedDownload, installDownloadsListener, hasNeedsLoginBadge, clearNeedsLoginBadge } from './handoff.js'
import { WELCOME_PAGE, shouldOpenWelcome } from './onboarding.js'
import {
  CAPTURE_SETTINGS_KEY,
  readCaptureSettings,
  readNeedsLoginState,
  readOptInCookieHeader
} from './capture-settings.js'
import {
  NETWORK_EVIDENCE_MESSAGE_TYPES,
  evidenceForMessage,
  installNetworkObservation,
  requestNetworkEvidenceForSender
} from './network-evidence.js'
import {
  MEDIA_SNIFFER_MESSAGE_TYPES,
  formatBadgeCount,
  installMediaSniffer,
  normalizeSniffedQueueMessage,
  sniffedEntryForMessage,
  sniffedFilename
} from './media-sniffer.js'

const MENU_ID = 'dondownload-link'
const BADGE_CLEAR_MS = 4_000
const DEFAULT_TITLE = 'Send this page to DonDownload'
const DETECTED_BADGE_COLOR = '#1f6feb'
const SNIFF_AUTH_TTL_MS = 5_000

let badgeGeneration = 0

/**
 * Settings are read once per event batch. Both the evidence observer and the
 * media sniffer must fail closed when a read fails.
 */
async function readSnifferSettings() {
  try {
    return await readCaptureSettings(chrome)
  } catch {
    return null
  }
}

async function hasWebRequestPermission() {
  try {
    return (
      (await chrome.permissions.contains({ permissions: ['webRequest'] })) ===
      true
    )
  } catch {
    return false
  }
}

const sniffAuthCache = new Map()

/**
 * True only when this tab may be sniffed: either the user enabled this exact
 * origin through the existing overlay flow, or the user explicitly turned on
 * "Detect media on all sites" and granted the broad host permission.
 */
async function authorizeSniffTab(tabId, pageUrl) {
  if (!Number.isInteger(tabId) || tabId < 0) return false
  const cached = sniffAuthCache.get(tabId)
  if (
    cached &&
    cached.pageUrl === pageUrl &&
    cached.allowed === true &&
    Date.now() - cached.at < SNIFF_AUTH_TTL_MS
  ) {
    return true
  }

  const settings = await readSnifferSettings()
  if (settings === null || settings.mediaSniffing !== true) return false
  if (!(await hasWebRequestPermission())) return false

  let allowed = false
  if (settings.detectAllSites === true) {
    try {
      allowed =
        (await chrome.permissions.contains({
          origins: ['http://*/*', 'https://*/*']
        })) === true
    } catch {
      allowed = false
    }
  } else {
    const origin = originFromUrl(pageUrl)
    if (origin !== null) {
      const pattern = originToMatchPattern(origin)
      if (pattern !== null) {
        try {
          allowed =
            (await chrome.permissions.contains({ origins: [pattern] })) ===
            true
        } catch {
          allowed = false
        }
        if (allowed) {
          try {
            allowed = await isOverlayTabTracked(chrome, origin, tabId)
          } catch {
            allowed = false
          }
        }
      }
    }
  }

  if (allowed) {
    sniffAuthCache.set(tabId, { pageUrl, allowed: true, at: Date.now() })
  } else {
    sniffAuthCache.delete(tabId)
  }
  return allowed
}

function notifySniffedChanged(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return
  try {
    chrome.tabs.sendMessage(
      tabId,
      { type: MEDIA_SNIFFER_MESSAGE_TYPES.CHANGED },
      clearLastError
    )
  } catch {
    // The tab may be closed or have no overlay content script.
  }
}

async function activeTabForBadge() {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    })
    return Array.isArray(tabs) && tabs[0] ? tabs[0] : null
  } catch {
    return null
  }
}

async function updateBadgeForTab(tabId) {
  const active = await activeTabForBadge()
  if (!active || active.id !== tabId) return
  await applyBadgeCount(mediaSniffer.store.count(tabId))
}

async function applyBadgeCount(count) {
  if (count === 0) {
    let needsLogin = hasNeedsLoginBadge()
    if (!needsLogin) {
      try {
        needsLogin = (await readNeedsLoginState(chrome)) !== null
      } catch {
        needsLogin = false
      }
    }
    if (needsLogin) {
      try {
        ignoreResult(chrome.action.setBadgeBackgroundColor({ color: '#a16207' }))
        ignoreResult(chrome.action.setBadgeText({ text: '!' }))
        ignoreResult(
          chrome.action.setTitle({
            title: 'DonDownload: This download needs your browser login'
          })
        )
      } catch {
        // Badge feedback is best effort.
      }
      return
    }
  }
  const text = formatBadgeCount(count)
  try {
    ignoreResult(chrome.action.setBadgeBackgroundColor({ color: DETECTED_BADGE_COLOR }))
    ignoreResult(chrome.action.setBadgeText({ text }))
    ignoreResult(
      chrome.action.setTitle({
        title:
          count > 0
            ? `DonDownload: ${count} media item${count === 1 ? '' : 's'} detected on this tab`
            : DEFAULT_TITLE
      })
    )
  } catch {
    // Badge feedback is best effort.
  }
}

function refreshActiveBadge() {
  void (async () => {
    const active = await activeTabForBadge()
    if (!active || !Number.isInteger(active.id)) {
      await applyBadgeCount(0)
      return
    }
    await updateBadgeForTab(active.id)
  })().catch(() => undefined)
}

const mediaSniffer = installMediaSniffer(chrome, {
  authorizeTab: authorizeSniffTab,
  onChange(tabId) {
    void updateBadgeForTab(tabId).catch(() => undefined)
    notifySniffedChanged(tabId)
  }
})
mediaSniffer.install()

async function refreshMediaSniffing() {
  const granted = await hasWebRequestPermission()
  const settings = await readSnifferSettings()
  mediaSniffer.setPermissionGranted(granted)
  mediaSniffer.setEnabled(settings !== null && settings.mediaSniffing === true)
  sniffAuthCache.clear()
  if (!granted || settings === null || settings.mediaSniffing !== true) {
    mediaSniffer.store.clearAll()
    await applyBadgeCount(0)
  } else {
    refreshActiveBadge()
  }
}

void refreshMediaSniffing().catch(() => undefined)

function invalidSniffedSender() {
  return overlayFailure(
    'INVALID_SENDER',
    'The detected media request did not come from this extension or an enabled page.'
  )
}

/**
 * The popup/options pages run in a tab, so `sender.tab` is set for them too.
 * They may address another tab explicitly; a content script may only address
 * its own tab.
 */
function senderIsExtensionPage(sender) {
  if (!sender || typeof sender.url !== 'string') return false
  try {
    return sender.url.startsWith(chrome.runtime.getURL(''))
  } catch {
    return false
  }
}

function querySniffedForSender(message, sender) {
  const senderTabId =
    sender && sender.tab && Number.isInteger(sender.tab.id)
      ? sender.tab.id
      : null
  const requested = message.tabId
  const tabId = Number.isInteger(requested) ? requested : senderTabId
  if (!Number.isInteger(tabId) || tabId < 0) {
    return overlayFailure('INVALID_MESSAGE', 'The detected media tab is not valid.')
  }
  // A content script may query only its own tab. Extension pages (the popup)
  // may query the active tab they were opened for.
  if (
    senderTabId !== null &&
    senderTabId !== tabId &&
    !senderIsExtensionPage(sender)
  ) {
    return invalidSniffedSender()
  }
  if (sender && typeof sender.id === 'string' && sender.id !== chrome.runtime.id) {
    return invalidSniffedSender()
  }
  const media = mediaSniffer.store
    .list(tabId)
    .map(sniffedEntryForMessage)
    .filter((entry) => entry !== null)
  return { ok: true, media }
}

async function queueSniffedForSender(message, sender) {
  const normalized = normalizeSniffedQueueMessage(message)
  if (normalized.ok !== true) return normalized
  const senderTabId =
    sender && sender.tab && Number.isInteger(sender.tab.id)
      ? sender.tab.id
      : null
  const tabId =
    normalized.tabId === undefined ? senderTabId : normalized.tabId
  if (!Number.isInteger(tabId) || tabId < 0) {
    return overlayFailure('INVALID_MESSAGE', 'The detected media tab is not valid.')
  }
  if (
    senderTabId !== null &&
    senderTabId !== tabId &&
    !senderIsExtensionPage(sender)
  ) {
    return invalidSniffedSender()
  }
  if (sender && typeof sender.id === 'string' && sender.id !== chrome.runtime.id) {
    return invalidSniffedSender()
  }

  const entry = mediaSniffer.store.get(tabId, normalized.url)
  if (entry === null) {
    return overlayFailure(
      'MEDIA_NOT_FOUND',
      'This detected media is no longer available. Reload the page and try again.'
    )
  }

  let variant = null
  if (normalized.variantUrl !== null) {
    variant =
      entry.variants.find(
        (candidate) => candidate.url === normalized.variantUrl
      ) ?? null
    if (variant === null) {
      return overlayFailure(
        'MEDIA_VARIANT_NOT_FOUND',
        'That quality is no longer available. Reload the page and try again.'
      )
    }
  }

  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return overlayFailure('TAB_NOT_FOUND', 'The page is no longer available.')
  }
  const pageUrl = tab && typeof tab.url === 'string' ? tab.url : ''
  if (!/^https?:/i.test(pageUrl)) {
    return overlayFailure('INVALID_ORIGIN', 'The page is not a normal HTTP(S) page.')
  }
  if (!(await authorizeSniffTab(tabId, pageUrl))) {
    return overlayFailure(
      'PERMISSION_REQUIRED',
      'Media detection is not enabled for this site. Enable the overlay or all-sites detection in Settings.'
    )
  }

  const mediaUrl = variant === null ? entry.url : variant.url
  const filename = sniffedFilename(entry, mediaUrl)
  const cookie = await readOptInCookieHeader(chrome, pageUrl, mediaUrl)
  const expectedBytes =
    variant === null && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0
      ? entry.sizeBytes
      : undefined

  const result = await sendQueueSniffedMedia({
    url: mediaUrl,
    pageUrl,
    referer: pageUrl,
    userAgent: navigator.userAgent,
    kind: entry.kind,
    title: entry.title || entry.filename || filename,
    filename,
    ...(variant === null
      ? {}
      : {
          variant: {
            url: variant.url,
            ...(typeof variant.label === 'string'
              ? { label: variant.label }
              : {}),
            ...(Number.isSafeInteger(variant.width) && variant.width > 0
              ? { width: variant.width }
              : {}),
            ...(Number.isSafeInteger(variant.height) && variant.height > 0
              ? { height: variant.height }
              : {}),
            ...(Number.isSafeInteger(variant.bandwidth) &&
            variant.bandwidth > 0
              ? { bandwidth: variant.bandwidth }
              : {})
          }
        }),
    ...(cookie === undefined ? {} : { cookie }),
    ...(expectedBytes === undefined ? {} : { expectedBytes })
  })
  if (result.ok !== true) return result
  return { ok: true }
}

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
    // Restore the detected-media count rather than always clearing the badge.
    refreshActiveBadge()
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
    // The all-sites registration is decided by the settings and the broad host
    // grant, so a leftover from a previous session is removed when it is no
    // longer wanted, and created when it is.
    await reconcileOverlayMode(chrome, { injectOpenTabs: true })
  } catch {
    // Reconciliation is best effort and never blocks the manual capture path.
  }
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

function installLifecycleListeners(details) {
  installContextMenu()
  void reconcileOverlayRegistrations()
  installDownloadsSupport()
  networkObservation.install()
  void refreshNetworkObservation().catch(() => undefined)
  mediaSniffer.install()
  void refreshMediaSniffing().catch(() => undefined)

  // A fresh install gets one welcome tab. Updates and browser restarts never
  // open it, so normal use is not interrupted.
  if (shouldOpenWelcome(details)) {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE), active: true })
    } catch {
      // A browser that refuses the tab still has the popup and options page.
    }
  }
}

/**
 * The downloads permission is optional and granted only on a user gesture from
 * the popup or the options page. Until then `chrome.downloads` is absent, so
 * this is a guarded no-op rather than a broken top-level listener. It is called
 * again after a grant and on a message from the granting page, so takeover
 * starts without reloading the extension.
 */
function installDownloadsSupport() {
  return installDownloadsListener(chrome, (item) => handleCreatedDownload(chrome, item))
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
  mediaSniffer.install()
  void refreshNetworkObservation().catch(() => undefined)
  void refreshMediaSniffing().catch(() => undefined)
  void handlePermissionsAdded(chrome, permissions).catch(() => undefined)
  // A broad grant arriving after the popup closed still turns the all-sites
  // overlay on for open tabs.
  void reconcileOverlayMode(chrome, { injectOpenTabs: true }).catch(() => undefined)
})

chrome.permissions.onRemoved.addListener((permissions) => {
  void refreshNetworkObservation().catch(() => undefined)
  void refreshMediaSniffing().catch(() => undefined)
  void handlePermissionsRemoved(chrome, permissions).catch(() => undefined)
  void reconcileOverlayMode(chrome).catch(() => undefined)
})

// Prune session-only tab records. `tabs.onRemoved` needs no `tabs` permission.
chrome.tabs.onRemoved.addListener((tabId) => {
  networkObservation.clearTab(tabId)
  mediaSniffer.store.clearTab(tabId)
  sniffAuthCache.delete(tabId)
  refreshActiveBadge()
  void forgetOverlayTab(chrome, tabId).catch(() => undefined)
})

// SPA/history updates and normal navigations both report a URL change. Keep
// entries already observed for the new URL, drop everything from before it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo || typeof changeInfo.url !== 'string') return
  sniffAuthCache.delete(tabId)
  mediaSniffer.handleTabUrlChanged(tabId, Date.now())
  refreshActiveBadge()
})

chrome.tabs.onActivated.addListener((info) => {
  if (!info || !Number.isInteger(info.tabId)) return
  void updateBadgeForTab(info.tabId).catch(() => undefined)
})

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[CAPTURE_SETTINGS_KEY]) return
    const previous = changes[CAPTURE_SETTINGS_KEY].oldValue
    const next = changes[CAPTURE_SETTINGS_KEY].newValue
    if (
      previous &&
      next &&
      JSON.stringify(previous.cookieOptInOrigins || []) !==
        JSON.stringify(next.cookieOptInOrigins || [])
    ) {
      clearNeedsLoginBadge()
    }
    void refreshNetworkObservation().catch(() => undefined)
    void refreshMediaSniffing().catch(() => undefined)
    if (
      !previous ||
      !next ||
      previous.floatingTriggerEnabled !== next.floatingTriggerEnabled ||
      previous.detectAllSites !== next.detectAllSites ||
      JSON.stringify(previous.excludedOrigins || []) !==
        JSON.stringify(next.excludedOrigins || [])
    ) {
      void reconcileOverlayMode(chrome, { injectOpenTabs: true }).catch(
        () => undefined
      )
    }
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

  if (message.type === 'dondownload:overlay-all-sites') {
    // The popup/options page just turned all-sites mode on or off. Register or
    // remove the one broad registration and inject into open tabs now.
    void reconcileOverlayMode(chrome, { injectOpenTabs: true })
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure(
            'OVERLAY_FAILED',
            'The all-sites overlay could not be updated.'
          )
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

  if (message.type === 'dondownload:handoff-login-clear') {
    clearNeedsLoginBadge()
    refreshActiveBadge()
    return false
  }

  if (message.type === 'dondownload:downloads-support') {
    // The popup/options page asked for the optional permissions in one click.
    // Install the downloads listener now instead of waiting for the next worker
    // start, so takeover works immediately after the grant.
    let listener = false
    try {
      listener = installDownloadsSupport()
    } catch {
      listener = false
    }
    sendResponse({ ok: true, listener })
    return false
  }

  if (message.type === MEDIA_SNIFFER_MESSAGE_TYPES.QUERY) {    try {
      sendResponse(querySniffedForSender(message, sender))
    } catch {
      sendResponse(
        overlayFailure('MEDIA_REQUEST_FAILED', 'The detected media list could not be read.')
      )
    }
    return false
  }

  if (message.type === MEDIA_SNIFFER_MESSAGE_TYPES.QUEUE) {
    void queueSniffedForSender(message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          overlayFailure(
            'MEDIA_REQUEST_FAILED',
            'The detected media could not be queued.'
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
