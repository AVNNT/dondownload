import { normalizeSupportedUrl, sendQueueDownload } from './bridge.js'
import { originFromUrl, originToMatchPattern } from './site-policy.js'
import {
  clearPendingEnable,
  describeOverlayStatus,
  overlayRemovalConfirmed,
  rememberPendingEnable
} from './overlay-controller.js'

const sendButton = document.getElementById('send')
const downloadAgainButton = document.getElementById('download-again')
const statusElement = document.getElementById('status')
const urlElement = document.getElementById('page-url')

const overlayStateElement = document.getElementById('overlay-state')
const overlayHintElement = document.getElementById('overlay-hint')
const overlayStatusElement = document.getElementById('overlay-status')
const overlayEnableButton = document.getElementById('overlay-enable')
const overlayDisableButton = document.getElementById('overlay-disable')

let pageUrl = null
let pageOrigin = null
let activeTabId = null
let sending = false
let overlayBusy = false
let overlayGranted = false
let overlayReady = false
let overlayCheckToken = 0

function setStatus(kind, message) {
  statusElement.className = kind ? `status ${kind}` : 'status'
  statusElement.textContent = message
}

function setDownloadAgainAvailable(available) {
  downloadAgainButton.hidden = !available
}

function setSending(next) {
  sending = next
  sendButton.disabled = next || pageUrl === null
  sendButton.textContent = next ? 'Sending…' : 'Download with DonDownload'
  downloadAgainButton.disabled = next
}

function errorHint(error) {
  if (!error) return 'The request was rejected.'
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' ? error.message : 'The request failed.'
  if (
    code === 'APP_NOT_RUNNING' ||
    code === 'APP_UNAVAILABLE' ||
    code === 'NATIVE_HOST_FAILED'
  ) {
    return `${message} Start DonDownload (the tray icon is enough), then try again.`
  }
  if (code === 'DUPLICATE_DOWNLOAD') {
    return `${message} Choose Download again only if you want a second copy.`
  }
  if (code === 'NATIVE_HOST_ERROR') {
    return `${message} Start DonDownload (the tray icon is enough), then try again. If it is already running, re-register the native host.`
  }
  return message
}

function setOverlayMessage(kind, message) {
  overlayStatusElement.className = kind ? `status ${kind}` : 'status'
  overlayStatusElement.textContent = message
}

function siteLabel() {
  if (pageOrigin === null) return 'this site'
  try {
    return new URL(pageOrigin).host
  } catch {
    return 'this site'
  }
}

function overlayAvailable() {
  return pageOrigin !== null && originToMatchPattern(pageOrigin) !== null
}

function renderOverlay() {
  const status = describeOverlayStatus({
    available: overlayAvailable(),
    granted: overlayGranted,
    ready: overlayReady,
    site: siteLabel()
  })

  overlayStateElement.className = `overlay-state ${status.tone}`
  overlayStateElement.textContent = status.label
  overlayHintElement.textContent = status.hint

  const available = overlayAvailable()
  overlayEnableButton.hidden = !available || overlayGranted
  overlayDisableButton.hidden = !available || !overlayGranted
  overlayEnableButton.disabled = overlayBusy || !available || overlayGranted
  overlayDisableButton.disabled = overlayBusy || !available || !overlayGranted
}

function applyOverlayResult(response) {
  if (!response || typeof response !== 'object') {
    overlayGranted = false
    overlayReady = false
    return null
  }

  overlayGranted = response.granted === true
  overlayReady =
    response.granted === true &&
    response.registered === true &&
    response.injected === true

  if (response.ok === false) {
    const message =
      response.error && typeof response.error.message === 'string'
        ? response.error.message
        : 'The overlay request could not be completed.'
    return { success: false, message }
  }

  if (!overlayGranted) return { success: false, message: null }
  if (overlayReady) return { success: true, message: null }

  return {
    success: false,
    message:
      typeof response.message === 'string'
        ? response.message
        : 'Site access is granted, but this tab does not have the overlay yet. Reload the page and check again.'
  }
}

function requestOverlayState() {
  const token = ++overlayCheckToken
  if (!overlayAvailable()) {
    overlayGranted = false
    overlayReady = false
    renderOverlay()
    return
  }

  const pattern = originToMatchPattern(pageOrigin)
  overlayBusy = true
  renderOverlay()

  chrome.permissions.contains({ origins: [pattern] }, (granted) => {
    const runtimeError = chrome.runtime.lastError
    if (token !== overlayCheckToken) return
    if (runtimeError) {
      overlayBusy = false
      overlayGranted = false
      overlayReady = false
      renderOverlay()
      setOverlayMessage('error', runtimeError.message ?? 'Site access could not be read.')
      return
    }

    if (granted !== true) {
      overlayBusy = false
      overlayGranted = false
      overlayReady = false
      renderOverlay()
      return
    }

    overlayGranted = true
    chrome.runtime.sendMessage(
      {
        type: 'dondownload:overlay-sync',
        origin: pageOrigin,
        tabId: activeTabId
      },
      (response) => {
        if (token !== overlayCheckToken) return
        const sendError = chrome.runtime.lastError
        overlayBusy = false
        if (sendError) {
          overlayReady = false
          renderOverlay()
          setOverlayMessage(
            'error',
            sendError.message ?? 'The overlay state could not be checked.'
          )
          return
        }
        const result = applyOverlayResult(response)
        renderOverlay()
        if (result && result.message) setOverlayMessage('error', result.message)
      }
    )
  })
}

/**
 * Re-read only the grant after a failed disable. Do not run the sync path here:
 * it would re-register and re-inject the overlay the user just tried to remove.
 */
function refreshOverlayGrant() {
  const token = ++overlayCheckToken
  if (!overlayAvailable()) {
    overlayGranted = false
    overlayReady = false
    renderOverlay()
    return
  }

  const pattern = originToMatchPattern(pageOrigin)
  overlayBusy = true
  renderOverlay()

  chrome.permissions.contains({ origins: [pattern] }, (granted) => {
    const runtimeError = chrome.runtime.lastError
    if (token !== overlayCheckToken) return
    overlayBusy = false
    if (runtimeError) {
      overlayGranted = false
      overlayReady = false
      renderOverlay()
      setOverlayMessage('error', runtimeError.message ?? 'Site access could not be read.')
      return
    }
    overlayGranted = granted === true
    overlayReady = false
    renderOverlay()
  })
}

function loadActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const runtimeError = chrome.runtime.lastError
    if (runtimeError) {
      urlElement.textContent = 'The active tab could not be read.'
      setStatus('error', runtimeError.message ?? 'The active tab could not be read.')
      return
    }

    const tab = tabs && tabs[0]
    const rawUrl = tab && typeof tab.url === 'string' ? tab.url : ''
    const normalized = normalizeSupportedUrl(rawUrl)

    if (!normalized.ok) {
      pageUrl = null
      pageOrigin = null
      activeTabId = null
      urlElement.textContent = rawUrl || 'No address is available for this tab.'
      setStatus(
        'error',
        `${normalized.message} Open a normal http:// or https:// page to use DonDownload.`
      )
      setSending(false)
      overlayGranted = false
      overlayReady = false
      renderOverlay()
      return
    }

    pageUrl = normalized.url
    pageOrigin = originFromUrl(normalized.url)
    activeTabId = tab && Number.isInteger(tab.id) ? tab.id : null
    urlElement.textContent = pageUrl
    setStatus('', '')
    setDownloadAgainAvailable(false)
    setSending(false)
    setOverlayMessage('', '')
    renderOverlay()
    requestOverlayState()
  })
}

function reportSendFailure(error) {
  const duplicate =
    error && typeof error === 'object' && error.code === 'DUPLICATE_DOWNLOAD'
  setStatus('error', errorHint(error))
  setDownloadAgainAvailable(duplicate)
  setSending(false)
}

sendButton.addEventListener('click', async () => {
  if (sending || pageUrl === null) return
  setSending(true)
  setDownloadAgainAvailable(false)
  setStatus('', '')

  const result = await sendQueueDownload(pageUrl)
  if (result.ok) {
    statusElement.className = 'status success'
    statusElement.textContent =
      'Added to DonDownload. The download continues even if this popup closes.'
    sendButton.textContent = 'Added'
    setTimeout(() => setSending(false), 1_200)
  } else {
    reportSendFailure(result.error)
  }
})

downloadAgainButton.addEventListener('click', async () => {
  if (sending || pageUrl === null) return
  setSending(true)
  setDownloadAgainAvailable(false)
  setStatus('', '')

  // The only caller that sets force: an explicit user choice to create a
  // second copy even though the app reported an unfinished duplicate.
  const result = await sendQueueDownload(pageUrl, { force: true })
  if (result.ok) {
    statusElement.className = 'status success'
    statusElement.textContent =
      'Added another copy to DonDownload. The download continues even if this popup closes.'
    sendButton.textContent = 'Added'
    setTimeout(() => setSending(false), 1_200)
  } else {
    reportSendFailure(result.error)
  }
})

function sendOverlayEnable() {
  overlayBusy = true
  renderOverlay()
  setOverlayMessage('', '')

  chrome.runtime.sendMessage(
    {
      type: 'dondownload:overlay-enable',
      origin: pageOrigin,
      tabId: activeTabId
    },
    (response) => {
      const sendError = chrome.runtime.lastError
      overlayBusy = false
      if (sendError) {
        overlayReady = false
        renderOverlay()
        setOverlayMessage(
          'error',
          sendError.message ?? 'The overlay request could not be completed.'
        )
        return
      }

      const result = applyOverlayResult(response)
      renderOverlay()
      if (result && result.success) {
        setOverlayMessage(
          'success',
          `Overlay is ready on this tab and saved for ${siteLabel()}. Hover a video or press Alt+Shift+D.`
        )
        return
      }
      setOverlayMessage(
        'error',
        (result && result.message) ||
          'Site access is granted, but this tab does not have the overlay yet. Reload the page and check again.'
      )
    }
  )
}

overlayEnableButton.addEventListener('click', () => {
  if (overlayBusy || pageOrigin === null || activeTabId === null) return
  const pattern = originToMatchPattern(pageOrigin)
  if (pattern === null) {
    setOverlayMessage('error', 'The video overlay is not supported on this page.')
    return
  }

  if (overlayGranted) {
    sendOverlayEnable()
    return
  }

  overlayBusy = true
  renderOverlay()
  setOverlayMessage('', '')

  // Record the exact origin/tab before the prompt. Chromium closes the action
  // popup when it shows the permission prompt, so the background worker must be
  // able to finish registration and injection from permissions.onAdded.
  void rememberPendingEnable(chrome, pageOrigin, activeTabId)

  // The permission request must be started directly from this click handler
  // and must not be preceded by an awaited call. It asks for one exact origin,
  // never for every site.
  try {
    chrome.permissions.request({ origins: [pattern] }, (granted) => {
      const requestError = chrome.runtime.lastError
      if (requestError) {
        void clearPendingEnable(chrome)
        overlayBusy = false
        renderOverlay()
        setOverlayMessage(
          'error',
          requestError.message ?? 'Site access could not be requested.'
        )
        requestOverlayState()
        return
      }
      if (granted !== true) {
        void clearPendingEnable(chrome)
        overlayBusy = false
        renderOverlay()
        setOverlayMessage(
          'error',
          'Site access was not granted, so the overlay was not added. Nothing on the page was changed.'
        )
        requestOverlayState()
        return
      }

      // If the popup survived the prompt, reply with the verified result. If it
      // did not, permissions.onAdded already performed the same work.
      sendOverlayEnable()
    })
  } catch {
    void clearPendingEnable(chrome)
    overlayBusy = false
    renderOverlay()
    setOverlayMessage(
      'error',
      'Site access could not be requested. Try again from the popup button.'
    )
    requestOverlayState()
  }
})

overlayDisableButton.addEventListener('click', () => {
  if (overlayBusy || pageOrigin === null) return
  overlayBusy = true
  renderOverlay()
  setOverlayMessage('', '')

  chrome.runtime.sendMessage(
    {
      type: 'dondownload:overlay-disable',
      origin: pageOrigin,
      tabId: activeTabId
    },
    (response) => {
      const sendError = chrome.runtime.lastError
      overlayBusy = false
      // Do not claim success from the message alone: both the exact-origin
      // grant and the persistent registration must be verified as gone.
      if (sendError || !overlayRemovalConfirmed(response)) {
        renderOverlay()
        const message =
          response && response.error && typeof response.error.message === 'string'
            ? response.error.message
            : 'The overlay could not be fully turned off. Reload the page and try again.'
        setOverlayMessage('error', message)
        refreshOverlayGrant()
        return
      }

      overlayGranted = false
      overlayReady = false
      renderOverlay()
      setOverlayMessage(
        'success',
        `Overlay turned off and site access removed for ${siteLabel()}.`
      )
    }
  )
})

loadActiveTab()
