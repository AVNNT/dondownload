import { normalizeCapturedSource, normalizeSupportedUrl, sendQueueDownload } from './bridge.js'
import { originFromUrl } from './site-policy.js'
import { rememberOptionsTarget } from './capture-settings.js'
import { captureViewModel, formatOptionDetail, optionQueueKey } from './capture-view.js'

const sendButton = document.getElementById('send')
const downloadAgainButton = document.getElementById('download-again')
const statusElement = document.getElementById('status')
const urlElement = document.getElementById('page-url')
const captureList = document.getElementById('capture-list')
const captureEmpty = document.getElementById('capture-empty')
const detectedState = document.getElementById('detected-state')
const findQualitiesButton = document.getElementById('find-qualities')
const openOptionsButton = document.getElementById('open-options')

let pageUrl = null
let pageOrigin = null
let activeTabId = null
let sending = false
let polling = null
let pollAttempts = 0
const queuedKeys = new Set()

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
  if (code === 'MEDIA_DUPLICATE_JOB') {
    return 'That option is already downloading in DonDownload.'
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

function clearPolling() {
  if (polling !== null) {
    clearTimeout(polling)
    polling = null
  }
}

function schedulePolling() {
  if (polling !== null) return
  if (pollAttempts >= 40) return
  pollAttempts += 1
  polling = setTimeout(() => {
    polling = null
    queryCapturedSources()
  }, 450)
}

function appendRow(titleText, detailText, actionLabel, action, options = {}) {
  const row = document.createElement('div')
  row.className = 'capture-row'
  if (options.queued === true) row.dataset.queued = 'true'

  const copy = document.createElement('span')
  copy.className = 'capture-copy'
  const title = document.createElement('span')
  title.className = 'capture-title'
  title.textContent = titleText
  title.title = titleText
  const detail = document.createElement('span')
  detail.className = 'capture-detail'
  detail.textContent = detailText
  copy.appendChild(title)
  if (detailText) copy.appendChild(detail)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'capture-action'
  button.textContent = actionLabel
  button.disabled = options.disabled === true
  if (typeof action === 'function') button.addEventListener('click', action)

  row.appendChild(copy)
  row.appendChild(button)
  captureList.appendChild(row)
  return { row, button, detail }
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

function markQueued(button, label = 'Added ✓') {
  if (!button) return
  button.textContent = label
  button.disabled = true
}

function queueSource(source, button) {
  if (sending || activeTabId === null) return
  const key = `source:${source.url}`
  if (queuedKeys.has(key)) return
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
          errorHint(response && response.error ? response.error : null)
        )
        return
      }
      queuedKeys.add(key)
      markQueued(button)
      setStatus('success', 'Added to DonDownload ✓ — downloading in the app')
    }
  )
}

function renderSources(sources) {
  const clean = []
  for (const source of Array.isArray(sources) ? sources : []) {
    const safe = safeSource(source)
    if (safe) clean.push(safe)
  }
  for (const source of clean) {
    const queued = queuedKeys.has(`source:${source.url}`)
    const row = appendRow(
      source.filename,
      [source.qualityLabel, source.current ? 'current playback' : null]
        .filter(Boolean)
        .join(' · ') || 'progressive media',
      queued ? 'Added ✓' : 'Download',
      null,
      { queued, disabled: queued }
    )
    row.button.addEventListener('click', () => queueSource(source, row.button))
  }
  return clean.length
}

function queueOption(analysis, option, button) {
  if (activeTabId === null) return
  const key = optionQueueKey(analysis.analysisId, option.optionId)
  if (!key || queuedKeys.has(key)) return
  button.disabled = true
  button.textContent = 'Adding…'
  chrome.tabs.sendMessage(
    activeTabId,
    {
      type: 'dondownload:media-page-queue',
      analysisId: analysis.analysisId,
      optionId: option.optionId
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        button.disabled = false
        button.textContent = 'Download'
        setStatus('error', 'The page is no longer available. Reopen the popup and try again.')
        return
      }
      if (!response || response.ok !== true) {
        button.disabled = false
        button.textContent = 'Download'
        setStatus(
          'error',
          errorHint(response && response.error ? response.error : null)
        )
        return
      }
      queuedKeys.add(key)
      markQueued(button)
      setStatus('success', 'Added to DonDownload ✓ — downloading in the app')
    }
  )
}

function renderAnalysis(analysis) {
  if (!analysis || !Array.isArray(analysis.options)) return
  for (const option of analysis.options) {
    if (!option || typeof option.optionId !== 'string') continue
    const key = optionQueueKey(analysis.analysisId, option.optionId)
    const queued = key !== '' && queuedKeys.has(key)
    const detail = formatOptionDetail(option)
    const row = appendRow(
      typeof option.label === 'string' ? option.label : 'Verified option',
      detail || option.container || 'verified',
      queued ? 'Added ✓' : 'Download',
      null,
      { queued, disabled: queued }
    )
    row.button.addEventListener('click', () =>
      queueOption(analysis, option, row.button)
    )
  }
}

function renderAnalyzing() {
  appendRow(
    'Finding qualities…',
    'yt-dlp is analyzing this page. Quality options appear here when ready.',
    'Working',
    null,
    { disabled: true }
  )
}

function renderFailed(model) {
  appendRow(
    'Qualities are not ready',
    model.detail || 'The analyzer did not return verified options. Try again.',
    'Try again',
    () => requestAnalysis(),
    { disabled: false }
  )
}

function renderEmptyMessage(model) {
  captureEmpty.hidden = false
  if (model.mode === 'streaming') {
    captureEmpty.textContent =
      'This player streams video with Media Source, HLS or DASH. Qualities come from the verified DonDownload analysis, not from a guessed file.'
    return
  }
  if (model.mode === 'empty') {
    captureEmpty.textContent =
      'No video was detected on this page yet. You can still analyze the page with yt-dlp.'
    return
  }
  captureEmpty.textContent =
    'Play a video on an enabled site. Only a progressive source this exact player actually played is listed; nothing is sniffed or guessed.'
}

function renderCapture(response) {
  clearPolling()
  const model = captureViewModel(response)
  clearCaptureList()

  const sourceCount = renderSources(response && response.sources)
  if (model.mode === 'streaming') {
    if (model.analysis) {
      renderAnalysis(model.analysis)
    } else if (model.analyzing) {
      renderAnalyzing()
      schedulePolling()
    } else if (model.failed) {
      renderFailed(model)
    }
  }

  setDetectedState(
    model.detectedLabel,
    model.mode === 'empty' ? 'muted' : ''
  )
  captureEmpty.hidden = sourceCount > 0 || model.mode === 'streaming'
  if (!captureEmpty.hidden) renderEmptyMessage(model)

  findQualitiesButton.hidden = !(
    model.showFindAction ||
    (model.mode === 'streaming' && !model.analysis && !model.analyzing)
  )
  findQualitiesButton.textContent =
    model.mode === 'streaming' && model.failed
      ? 'Try qualities again'
      : 'Find qualities for this page'
  if (model.mode === 'streaming' && model.failed) {
    setStatus('error', model.detail || 'The page analysis failed. Try again.')
  }
}

function queryCapturedSources() {
  if (activeTabId === null) {
    renderCapture(null)
    return
  }
  chrome.tabs.sendMessage(
    activeTabId,
    { type: 'dondownload:capture-query' },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        renderCapture(null)
        return
      }
      if (!response || response.ok !== true) {
        renderCapture(null)
        return
      }
      renderCapture(response)
    }
  )
}

function requestAnalysis() {
  if (activeTabId === null) return
  findQualitiesButton.disabled = true
  findQualitiesButton.textContent = 'Finding qualities…'
  pollAttempts = 0
  setStatus('', 'Finding qualities…')
  chrome.tabs.sendMessage(
    activeTabId,
    { type: 'dondownload:media-page-analyze' },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      findQualitiesButton.disabled = false
      if (runtimeError) {
        setStatus(
          'error',
          'Enable the overlay for this site, reload the page, then try again.'
        )
        return
      }
      if (!response || response.ok !== true) {
        setStatus(
          'error',
          errorHint(response && response.error ? response.error : null)
        )
        return
      }
      if (response.status === 'ready' && response.analysis) {
        renderCapture({
          ok: true,
          sources: [],
          streaming: { detected: true },
          analysis: response.analysis,
          status: 'ready'
        })
        return
      }
      schedulePolling()
    }
  )
}

findQualitiesButton.addEventListener('click', () => requestAnalysis())

function loadActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const runtimeError = chrome.runtime.lastError
    if (runtimeError) {
      urlElement.textContent = 'The active tab could not be read.'
      setStatus('error', runtimeError.message ?? 'The active tab could not be read.')
      renderCapture(null)
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
      renderCapture(null)
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

window.addEventListener('unload', clearPolling)

loadActiveTab()
