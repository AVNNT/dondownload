import { normalizeCapturedSource, normalizeSupportedUrl, sendQueueDownload } from './bridge.js'
import { originFromUrl } from './site-policy.js'
import { rememberOptionsTarget } from './capture-settings.js'

const sendButton = document.getElementById('send')
const downloadAgainButton = document.getElementById('download-again')
const statusElement = document.getElementById('status')
const urlElement = document.getElementById('page-url')
const captureList = document.getElementById('capture-list')
const captureEmpty = document.getElementById('capture-empty')
const detectedState = document.getElementById('detected-state')
const openOptionsButton = document.getElementById('open-options')

let pageUrl = null
let pageOrigin = null
let activeTabId = null
let sending = false

function setStatus(kind, message) {
  statusElement.className = kind ? `status ${kind}` : 'status'
  statusElement.textContent = message
}

function setSending(next) {
  sending = next
  sendButton.disabled = next || pageUrl === null
  sendButton.textContent = next ? 'Sending…' : 'Download this page'
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

function setDetectedState(text, tone) {
  detectedState.textContent = text
  detectedState.className = tone ? `section-state ${tone}` : 'section-state'
}

function clearCaptureList() {
  while (captureList.children.length > 0) {
    captureList.removeChild(captureList.children[0])
  }
}

function safeSource(source) {
  if (!source || typeof source !== 'object') return null
  const normalized = normalizeCapturedSource(source.url, source.filename)
  if (!normalized.ok) return null
  return {
    url: normalized.url,
    filename: normalized.filename || 'video',
    qualityLabel:
      typeof source.qualityLabel === 'string' &&
      /^\d{2,5}p$/.test(source.qualityLabel)
        ? source.qualityLabel
        : null,
    current: source.current === true
  }
}

function queueSource(source) {
  if (sending || activeTabId === null) return
  setStatus('', '')
  setSending(true)
  chrome.tabs.sendMessage(
    activeTabId,
    { type: 'dondownload:capture-download', url: source.url },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      setSending(false)
      if (runtimeError) {
        setStatus('error', 'The page is no longer available. Reopen the popup and try again.')
        return
      }
      if (!response || response.ok !== true) {
        setStatus(
          'error',
          errorHint(
            response && response.error ? response.error : null
          )
        )
        return
      }
      setStatus('success', 'Added to DonDownload.')
    }
  )
}

function renderSources(sources) {
  clearCaptureList()
  const clean = []
  for (const source of Array.isArray(sources) ? sources : []) {
    const safe = safeSource(source)
    if (safe) clean.push(safe)
  }
  captureEmpty.hidden = clean.length > 0
  if (clean.length === 0) {
    setDetectedState('Nothing detected', 'muted')
    return
  }
  setDetectedState(`${clean.length} source${clean.length === 1 ? '' : 's'}`, '')
  for (const source of clean) {
    const row = document.createElement('div')
    row.className = 'capture-row'

    const copy = document.createElement('span')
    copy.className = 'capture-copy'
    const title = document.createElement('span')
    title.className = 'capture-title'
    title.textContent = source.filename
    title.title = source.filename
    const detail = document.createElement('span')
    detail.className = 'capture-detail'
    detail.textContent = [source.qualityLabel, source.current ? 'current playback' : null]
      .filter(Boolean)
      .join(' · ') || 'progressive media'
    copy.appendChild(title)
    copy.appendChild(detail)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'capture-action'
    button.textContent = 'Download'
    button.addEventListener('click', () => queueSource(source))

    row.appendChild(copy)
    row.appendChild(button)
    captureList.appendChild(row)
  }
}

function queryCapturedSources() {
  if (activeTabId === null) {
    renderSources([])
    return
  }
  chrome.tabs.sendMessage(
    activeTabId,
    { type: 'dondownload:capture-query' },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        renderSources([])
        return
      }
      if (!response || response.ok !== true || !Array.isArray(response.sources)) {
        renderSources([])
        return
      }
      renderSources(response.sources)
    }
  )
}

function loadActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const runtimeError = chrome.runtime.lastError
    if (runtimeError) {
      urlElement.textContent = 'The active tab could not be read.'
      setStatus('error', runtimeError.message ?? 'The active tab could not be read.')
      renderSources([])
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
      renderSources([])
      return
    }

    pageUrl = normalized.url
    pageOrigin = originFromUrl(normalized.url)
    activeTabId = tab && Number.isInteger(tab.id) ? tab.id : null
    urlElement.textContent = pageUrl
    setStatus('', '')
    setSending(false)
    setDetectedState('Checking…', '')
    queryCapturedSources()
  })
}

function reportSendFailure(error) {
  const duplicate = error && typeof error === 'object' && error.code === 'DUPLICATE_DOWNLOAD'
  setStatus('error', errorHint(error))
  downloadAgainButton.hidden = !duplicate
  setSending(false)
}

async function sendPage(force) {
  if (sending || pageUrl === null) return
  setSending(true)
  downloadAgainButton.hidden = true
  setStatus('', '')

  const result = await sendQueueDownload(pageUrl, force ? { force: true } : {})
  if (result.ok) {
    setStatus('success', 'Added to DonDownload. It continues after this popup closes.')
    sendButton.textContent = 'Added'
    setTimeout(() => setSending(false), 1_200)
  } else {
    reportSendFailure(result.error)
  }
}

sendButton.addEventListener('click', () => {
  void sendPage(false)
})

downloadAgainButton.addEventListener('click', () => {
  void sendPage(true)
})

openOptionsButton.addEventListener('click', async () => {
  if (pageOrigin !== null && activeTabId !== null) {
    await rememberOptionsTarget(chrome, { tabId: activeTabId, origin: pageOrigin })
  }
  chrome.runtime.openOptionsPage()
})

loadActiveTab()
