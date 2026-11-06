import { normalizeCapturedSource, normalizeSupportedUrl, probeNativeConnection, sendQueueDownload, sendScanPage } from './bridge.js'
import { originFromUrl } from './site-policy.js'
import { grantPageUrl } from './grant-parameter.js'
import { rememberOptionsTarget, readCaptureSettings, readNeedsLoginState, clearNeedsLoginState, needsLoginCopy, readOptInCookieHeader } from './capture-settings.js'
import {
  popupConnectionLine,
  siteEnableLabel,
  welcomeUrl
} from './onboarding.js'
import {
  requestExactOriginAccess,
  siteAccessGranted
} from './site-enable.js'
import {
  captureViewModel,
  formatBytes,
  formatOptionDetail,
  optionQueueKey
} from './capture-view.js'
import {
  MEDIA_SNIFFER_MESSAGE_TYPES,
  sniffedFilename
} from './media-sniffer.js'

const sendButton = document.getElementById('send')
const scanButton = document.getElementById('scan-page')
const downloadAgainButton = document.getElementById('download-again')
const statusElement = document.getElementById('status')
const urlElement = document.getElementById('page-url')
const captureList = document.getElementById('capture-list')
const captureEmpty = document.getElementById('capture-empty')
const detectedState = document.getElementById('detected-state')
const findQualitiesButton = document.getElementById('find-qualities')
const openOptionsButton = document.getElementById('open-options')
const nativeStatus = document.getElementById('native-status')
const nativeStatusText = document.getElementById('native-status-text')
const nativeFix = document.getElementById('native-fix')
const siteSection = document.getElementById('site-section')
const siteAccessState = document.getElementById('site-access-state')
const siteHint = document.getElementById('site-hint')
const enableSiteButton = document.getElementById('enable-site')
const siteStatus = document.getElementById('site-status')
const handoffLogin = document.getElementById('handoff-login')
const handoffLoginText = document.getElementById('handoff-login-text')
const handoffLoginButton = document.getElementById('handoff-login-button')

let pageUrl = null
let pageOrigin = null
let activeTabId = null
let sending = false
let scanning = false
let polling = null
let pollAttempts = 0
let sniffedMedia = []
let lastCaptureResponse = null
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
  if (scanButton !== null) {
    scanButton.disabled = next || scanning || pageUrl === null
    scanButton.textContent = scanning ? 'Opening scan…' : 'Scan this page with DonDownload'
  }
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
  if (code === 'MEDIA_DRM_PROTECTED') {
    return "This video is DRM-protected and can't be downloaded."
  }
  return message
}

function setDetectedState(text, tone) {
  detectedState.textContent = text
  detectedState.className = tone ? `section-state ${tone}` : 'section-state'
}

function setSiteStatus(kind, message) {
  siteStatus.className = kind ? `status ${kind}` : 'status'
  siteStatus.textContent = message
}

function showNativeFailure(error) {
  if (nativeStatus === null) return
  nativeStatusText.textContent = popupConnectionLine({ ok: false, error })
  nativeFix.href = welcomeUrl(chrome)
  nativeStatus.hidden = false
}

const NATIVE_FAILURE_CODES = new Set([
  'APP_NOT_RUNNING',
  'APP_UNAVAILABLE',
  'NATIVE_HOST_FAILED',
  'NATIVE_HOST_NOT_REGISTERED',
  'NATIVE_HOST_FORBIDDEN',
  'NATIVE_HOST_ERROR'
])

async function checkNativeConnection() {
  if (nativeStatus === null) return
  const result = await probeNativeConnection()
  if (result.ok) {
    nativeStatus.hidden = true
    return
  }
  nativeStatusText.textContent = popupConnectionLine(result)
  nativeFix.href = welcomeUrl(chrome)
  nativeStatus.hidden = false
}

async function refreshSiteAccess() {
  if (
    siteSection === null ||
    pageOrigin === null ||
    activeTabId === null
  ) {
    if (siteSection !== null) siteSection.hidden = true
    return
  }
  siteSection.hidden = false
  const granted = await siteAccessGranted(chrome, pageOrigin)
  enableSiteButton.textContent = siteEnableLabel(pageOrigin)
  if (granted) {
    siteAccessState.textContent = 'Enabled'
    siteHint.textContent = 'The optional overlay is enabled for this exact site.'
    enableSiteButton.hidden = true
    return
  }
  siteAccessState.textContent = 'Not enabled'
  siteHint.textContent =
    'Enable the optional overlay and media detection for this exact site only.'
  enableSiteButton.hidden = false
  enableSiteButton.disabled = false
}

async function refreshNeedsLogin() {
  if (handoffLogin === null || pageOrigin === null) {
    if (handoffLogin !== null) handoffLogin.hidden = true
    return
  }
  const state = await readNeedsLoginState(chrome)
  if (!state || state.origin !== pageOrigin) {
    handoffLogin.hidden = true
    return
  }
  try {
    const settings = await readCaptureSettings(chrome)
    if (settings.cookieOptInOrigins.includes(pageOrigin)) {
      handoffLogin.hidden = true
      return
    }
  } catch {
    // Show the actionable state rather than hiding a real login warning.
  }
  const copy = needsLoginCopy(state.host)
  handoffLoginText.textContent = copy.message
  handoffLoginButton.textContent = copy.button
  handoffLoginButton.disabled = false
  handoffLogin.hidden = false
}

function clearNeedsLogin() {
  if (handoffLogin !== null) handoffLogin.hidden = true
  void clearNeedsLoginState(chrome)
  try {
    chrome.runtime.sendMessage({ type: 'dondownload:handoff-login-clear' })
  } catch {
    // Best effort.
  }
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

function sniffedQualityLabel(entry, variant) {
  if (variant) {
    if (typeof variant.label === 'string' && variant.label.length > 0) {
      return variant.label
    }
    if (typeof variant.height === 'number' && variant.height > 0) {
      return `${variant.height}p`
    }
    if (typeof variant.bandwidth === 'number' && variant.bandwidth > 0) {
      return `${Math.round(variant.bandwidth / 1000)} kbps`
    }
  }
  if (entry.kind === 'hls') return 'HLS quality unknown'
  if (entry.kind === 'dash') return 'DASH quality unknown'
  return null
}

function sniffedKindLabel(entry) {
  if (entry.kind === 'hls') return 'HLS'
  if (entry.kind === 'dash') return 'DASH'
  const filename = typeof entry.filename === 'string' ? entry.filename : ''
  const match = /\.([a-z0-9]{2,5})$/i.exec(filename)
  return match ? match[1].toUpperCase() : 'FILE'
}

function sniffedQueueKey(entry, variant) {
  return `sniffed:${entry.key || entry.url}:${variant ? variant.url : 'auto'}`
}

function queueSniffed(entry, variant, button) {
  if (sending || activeTabId === null) return
  const key = sniffedQueueKey(entry, variant)
  if (queuedKeys.has(key)) return
  setStatus('', '')
  setSending(true)
  button.textContent = 'Adding…'
  chrome.runtime.sendMessage(
    {
      type: MEDIA_SNIFFER_MESSAGE_TYPES.QUEUE,
      tabId: activeTabId,
      url: entry.url,
      ...(variant ? { variantUrl: variant.url } : {})
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      setSending(false)
      if (runtimeError) {
        button.textContent = 'Download'
        setStatus('error', 'The background worker did not respond. Reopen the popup.')
        return
      }
      if (!response || response.ok !== true) {
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

function renderSniffed() {
  let count = 0
  for (const entry of sniffedMedia) {
    if (!entry || typeof entry !== 'object') continue
    const variants =
      Array.isArray(entry.variants) && entry.variants.length > 0
        ? entry.variants
        : [null]
    const displayTitle =
      typeof entry.title === 'string' && entry.title.length > 0
        ? entry.title
        : sniffedFilename(entry)
    const details = []
    details.push(sniffedKindLabel(entry))
    if (entry.sizeBytes !== null && typeof entry.sizeBytes === 'number') {
      const size = formatBytes(entry.sizeBytes)
      if (size) details.push(size)
    }
    if (typeof entry.sourceHost === 'string' && entry.sourceHost.length > 0) {
      details.push(entry.sourceHost)
    }
    if (entry.active === true && entry.kind === 'hls') details.push('active')
    for (const variant of variants) {
      const label = sniffedQualityLabel(entry, variant)
      if (label) details.push(label)
      const rowDetails = details.join(' · ')
      const queued = queuedKeys.has(sniffedQueueKey(entry, variant))
      const row = appendRow(
        displayTitle,
        rowDetails,
        queued ? 'Added ✓' : 'Download',
        null,
        { queued, disabled: queued }
      )
      row.button.addEventListener('click', () =>
        queueSniffed(entry, variant, row.button)
      )
      count += 1
    }
  }
  return count
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
      'This player streams video with Media Source, HLS or DASH. Qualities come from the verified DonDownload analysis, or from an HLS master playlist when it can be read without cookies.'
    return
  }
  if (model.mode === 'empty') {
    captureEmpty.textContent =
      'No media was detected on this tab yet. Play or open a video/audio item, or analyze the page with yt-dlp.'
    return
  }
  captureEmpty.textContent =
    'Enable this site (or all-site detection) in Settings, then play or open media. Detected responses are listed here; cookies are read only after an exact-site opt-in.'
}

function renderCapture(response) {
  clearPolling()
  lastCaptureResponse = response
  const model = captureViewModel(response)
  clearCaptureList()

  const sniffedCount = renderSniffed()
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
  captureEmpty.hidden =
    sniffedCount > 0 || sourceCount > 0 || model.mode === 'streaming'
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

function querySniffedMedia() {
  if (activeTabId === null) {
    sniffedMedia = []
    return
  }
  chrome.runtime.sendMessage(
    { type: MEDIA_SNIFFER_MESSAGE_TYPES.QUERY, tabId: activeTabId },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) return
      sniffedMedia =
        response && response.ok === true && Array.isArray(response.media)
          ? response.media
          : []
      renderCapture(lastCaptureResponse)
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
      if (siteSection !== null) siteSection.hidden = true
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
    querySniffedMedia()
    void refreshSiteAccess()
    void refreshNeedsLogin()
    queryCapturedSources()
  })
}

function reportSendFailure(error) {
  const duplicate = error && typeof error === 'object' && error.code === 'DUPLICATE_DOWNLOAD'
  if (
    error &&
    typeof error === 'object' &&
    NATIVE_FAILURE_CODES.has(error.code)
  ) {
    showNativeFailure(error)
  }
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

async function scanPage() {
  if (scanning || pageUrl === null) return
  scanning = true
  setSending(false)
  setStatus('', 'Scanning this page in DonDownload…')
  try {
    // Cookies are read only when the exact page origin is already on the
    // per-origin opt-in list and the optional cookies permission is granted.
    const cookie = await readOptInCookieHeader(chrome, pageUrl, pageUrl)
    const result = await sendScanPage(pageUrl, cookie)
    if (result.ok) {
      setStatus(
        'success',
        cookie === undefined
          ? 'Scan opened in DonDownload. No browser cookies were sent; if the page needs a sign-in, allow cookies for this site and scan again.'
          : 'Scan opened in DonDownload. Review the grouped results and choose files there.'
      )
      return
    }
    reportSendFailure(result.error)
  } finally {
    scanning = false
    setSending(false)
  }
}

sendButton.addEventListener('click', () => {
  void sendPage(false)
})

scanButton?.addEventListener('click', () => {
  void scanPage()
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

handoffLoginButton.addEventListener('click', () => {
  if (pageOrigin === null) return
  handoffLoginButton.disabled = true
  // The permission prompt closes this popup, so finish the cookies grant in a
  // normal welcome tab through the existing exact-origin grant flow.
  const grantUrl = grantPageUrl(welcomeUrl(chrome), pageOrigin, { cookies: true })
  clearNeedsLogin()
  if (grantUrl !== null) {
    try {
      chrome.tabs.create({ url: grantUrl })
      return
    } catch {
      // Fall back to the options page below.
    }
  }
  handoffLoginButton.disabled = false
  chrome.runtime.openOptionsPage()
})

enableSiteButton.addEventListener('click', () => {  if (pageOrigin === null || activeTabId === null) return
  enableSiteButton.disabled = true
  setSiteStatus('', '')
  // A permission prompt closes the toolbar popup before its callback runs, so
  // finish the exact-origin request in a normal tab instead. The welcome page
  // validates the parameter again and requests only that origin after a click.
  const grantUrl = grantPageUrl(welcomeUrl(chrome), pageOrigin)
  if (grantUrl !== null) {
    try {
      chrome.tabs.create({ url: grantUrl })
      setSiteStatus(
        '',
        `The browser permission prompt opens in a tab. Allow access for ${pageOrigin}, then reload the page you want to use.`
      )
      enableSiteButton.disabled = false
      return
    } catch {
      // Fall back to the in-popup request below.
    }
  }

  requestExactOriginAccess(
    chrome,
    { origin: pageOrigin, tabId: activeTabId },
    (result) => {
      if (!result.ok) {
        enableSiteButton.disabled = false
        setSiteStatus('error', result.error || 'Site access was not granted.')
        return
      }
      setSiteStatus('success', 'Enabled for this exact site.')
      setTimeout(() => {
        void refreshSiteAccess()
        querySniffedMedia()
        queryCapturedSources()
      }, 600)
    }
  )
})

nativeFix.addEventListener('click', (event) => {
  event.preventDefault()
  chrome.tabs.create({ url: welcomeUrl(chrome) })
})

window.addEventListener('unload', clearPolling)

void checkNativeConnection()
loadActiveTab()
