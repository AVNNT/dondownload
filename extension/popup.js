import { normalizeSupportedUrl, sendQueueDownload } from './bridge.js'

const sendButton = document.getElementById('send')
const downloadAgainButton = document.getElementById('download-again')
const statusElement = document.getElementById('status')
const urlElement = document.getElementById('page-url')

let pageUrl = null
let sending = false

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
  return message
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
      urlElement.textContent = rawUrl || 'No address is available for this tab.'
      setStatus(
        'error',
        `${normalized.message} Open a normal http:// or https:// page to use DonDownload.`
      )
      setSending(false)
      return
    }

    pageUrl = normalized.url
    urlElement.textContent = pageUrl
    setStatus('', '')
    setDownloadAgainAvailable(false)
    setSending(false)
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

loadActiveTab()
