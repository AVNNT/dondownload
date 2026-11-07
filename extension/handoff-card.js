// In-page DonDownload card for an automatic browser hand-off.
//
// The browser's own download is already cancelled by the time this runs, so
// everything here is best effort: the card is injected into the active tab,
// polls the desktop for that one download through the service worker, and
// disappears on its own. Nothing in this module may change the hand-off result
// and nothing here reads page content.
//
// The injected function is serialized by chrome.scripting.executeScript, so it
// must be fully self-contained: no imports, no module-scope references, and
// textContent only (never innerHTML with data).

import { sendDownloadStatus, sendShowDownload } from './bridge.js'

export const HANDOFF_CARD_MESSAGE_TYPES = Object.freeze({
  STATUS: 'dondownload:handoff-status',
  SHOW: 'dondownload:handoff-show'
})
/** A page may only ask about ids this worker handed off in this session. */
export const MAX_HANDED_OFF_DOWNLOAD_IDS = 200
export const MAX_HANDOFF_CARDS = 3
export const HANDOFF_CARD_POLL_MS = 2_000
export const HANDOFF_CARD_MAX_POLL_MS = 30 * 60 * 1_000
export const HANDOFF_CARD_DONE_HIDE_MS = 6_000
export const HANDOFF_CARD_MAX_FAILURES = 3
export const MAX_HANDOFF_CARD_FILENAME_LENGTH = 180

const DOWNLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Download ids handed off by this worker generation. It is deliberately
 * memory-only and bounded: a swallowed or restored worker simply stops
 * answering, and a page can never enumerate or guess another user's ids.
 */
const handedOffDownloadIds = new Set()

export function rememberHandedOffDownload(downloadId) {
  if (
    typeof downloadId !== 'string' ||
    !DOWNLOAD_ID_PATTERN.test(downloadId)
  ) {
    return false
  }
  handedOffDownloadIds.add(downloadId)
  while (handedOffDownloadIds.size > MAX_HANDED_OFF_DOWNLOAD_IDS) {
    const oldest = handedOffDownloadIds.values().next()
    if (oldest.done === true) break
    handedOffDownloadIds.delete(oldest.value)
  }
  return true
}

export function hasHandedOffDownload(downloadId) {
  return (
    typeof downloadId === 'string' && handedOffDownloadIds.has(downloadId)
  )
}

export function forgetHandedOffDownloadsForTests() {
  handedOffDownloadIds.clear()
}

function cardFilename(value) {
  if (typeof value !== 'string') return ''
  const segment =
    value
      .trim()
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop() ?? ''
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  const cleaned = segment.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.length > MAX_HANDOFF_CARD_FILENAME_LENGTH
    ? cleaned.slice(0, MAX_HANDOFF_CARD_FILENAME_LENGTH)
    : cleaned
}

/**
 * The only data that crosses into the page: the desktop download id and a
 * display-only file name. No URL, path, cookie or header is included.
 */
export function handoffCardPayload(receipt, rawFilename) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return null
  }
  const downloadId = receipt.downloadId
  if (
    typeof downloadId !== 'string' ||
    !DOWNLOAD_ID_PATTERN.test(downloadId)
  ) {
    return null
  }
  return { downloadId, filename: cardFilename(rawFilename) }
}

/**
 * The card itself, serialized into the tab by chrome.scripting.executeScript.
 *
 * One fixed bottom-right container per page holds up to three cards, newest on
 * top. Each card polls the service worker every two seconds while the page is
 * visible, pauses while the document is hidden, stops on done/error/close, and
 * gives up after three consecutive failures or thirty minutes. Every value is
 * assigned with textContent.
 */
export function handoffCardInjected(payload) {
  var HOST_ID = 'dondownload-handoff-cards'
  var MAX_CARDS = 3
  var POLL_MS = 2000
  var MAX_POLL_MS = 1800000
  var DONE_HIDE_MS = 6000
  var MAX_FAILURES = 3
  var STATUS_MESSAGE = 'dondownload:handoff-status'
  var SHOW_MESSAGE = 'dondownload:handoff-show'
  var STYLE =
    ':host{all:initial}' +
    '.stack{display:flex;flex-direction:column;gap:8px;align-items:flex-end}' +
    '.card{width:300px;padding:10px 12px;border-radius:12px;background:#111113;' +
    'color:#f4f4f5;font:500 12px/1.4 system-ui,sans-serif;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12)}' +
    '.head{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.brand{font:700 11px/1.4 system-ui,sans-serif;letter-spacing:.04em;' +
    'text-transform:uppercase;color:#93c5fd}' +
    '.title{margin-top:2px;font:600 13px/1.4 system-ui,sans-serif}' +
    '.name{margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'color:#d4d4d8}' +
    '.track{margin-top:8px;height:3px;border-radius:999px;background:rgba(255,255,255,.14);' +
    'overflow:hidden}' +
    '.fill{height:100%;width:0;background:#2563eb;transition:width .25s ease}' +
    '.fill.done{background:#22c55e}' +
    '.fill.error{background:#ef4444}' +
    '.meta{margin-top:6px;color:#a1a1aa;font:500 11px/1.4 system-ui,sans-serif}' +
    '.actions{margin-top:8px;display:flex;gap:6px}' +
    'button{all:unset;cursor:pointer;padding:3px 9px;border-radius:8px;' +
    'border:1px solid rgba(255,255,255,.18);font:600 11px system-ui,sans-serif}' +
    'button.primary{background:#2563eb;border-color:#2563eb;color:#fff}' +
    'button.close{padding:0 6px;border-color:transparent;color:#a1a1aa;' +
    'font:600 14px system-ui,sans-serif}'

  if (!payload || typeof payload !== 'object') return false
  var downloadId =
    typeof payload.downloadId === 'string' ? payload.downloadId : ''
  if (downloadId.length === 0) return false
  var doc = typeof document === 'undefined' ? null : document
  if (!doc || !doc.documentElement) return false
  var filename = typeof payload.filename === 'string' ? payload.filename : ''

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '0 B'
    if (bytes >= 1000000000) return (bytes / 1000000000).toFixed(1) + ' GB'
    if (bytes >= 1000000) return (bytes / 1000000).toFixed(1) + ' MB'
    if (bytes >= 1000) return Math.round(bytes / 1000) + ' KB'
    return Math.round(bytes) + ' B'
  }

  function progressText(completedBytes, totalBytes) {
    if (
      typeof totalBytes !== 'number' ||
      !isFinite(totalBytes) ||
      totalBytes <= 0
    ) {
      return 'Starting\u2026'
    }
    var completed =
      typeof completedBytes === 'number' && isFinite(completedBytes)
        ? completedBytes
        : 0
    var percent = Math.floor((completed / totalBytes) * 100)
    if (percent < 0) percent = 0
    if (percent > 100) percent = 100
    return (
      percent +
      '% \u00b7 ' +
      formatBytes(completed) +
      ' of ' +
      formatBytes(totalBytes)
    )
  }

  var registry = globalThis.__donDownloadHandoffCards
  if (!registry || typeof registry !== 'object') {
    registry = { host: null, stack: null, cards: [] }
    globalThis.__donDownloadHandoffCards = registry
  }
  if (!registry.host || registry.host.isConnected === false) {
    var host = doc.createElement('div')
    host.id = HOST_ID
    host.style.position = 'fixed'
    host.style.right = '16px'
    host.style.bottom = '16px'
    host.style.zIndex = '2147483647'
    var shadow = host.attachShadow({ mode: 'open' })
    var style = doc.createElement('style')
    style.textContent = STYLE
    shadow.appendChild(style)
    var stack = doc.createElement('div')
    stack.className = 'stack'
    shadow.appendChild(stack)
    doc.documentElement.appendChild(host)
    registry.host = host
    registry.stack = stack
  }

  function element(name, className, text) {
    var node = doc.createElement(name)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  var card = element('div', 'card')
  var head = element('div', 'head')
  var brand = element('span', 'brand', 'DonDownload')
  var close = element('button', 'close', '\u00d7')
  close.setAttribute('aria-label', 'Dismiss')
  head.appendChild(brand)
  head.appendChild(close)
  var title = element('div', 'title', 'DonDownload is downloading')
  var name = element('div', 'name', filename)
  if (filename.length > 0) name.title = filename
  var track = element('div', 'track')
  var fill = element('div', 'fill')
  track.appendChild(fill)
  var meta = element('div', 'meta', 'Starting\u2026')
  var actions = element('div', 'actions')
  var show = element('button', 'primary', 'Show')
  actions.appendChild(show)
  card.appendChild(head)
  card.appendChild(title)
  card.appendChild(name)
  card.appendChild(track)
  card.appendChild(meta)
  card.appendChild(actions)

  // Newest on top; the oldest card is dropped once the stack is full.
  registry.stack.insertBefore(card, registry.stack.firstChild)
  registry.cards.push(card)
  while (registry.cards.length > MAX_CARDS) {
    var oldest = registry.cards.shift()
    if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest)
  }

  var timer = null
  var hideTimer = null
  var failures = 0
  var startedAt = Date.now()
  var finished = false

  function stopPolling() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function startPolling() {
    if (finished || timer !== null) return
    if (doc.hidden === true) return
    timer = setInterval(tick, POLL_MS)
  }

  // A hidden tab needs no progress updates: pause the interval and resume with
  // one immediate tick when the page becomes visible again.
  function onVisibilityChange() {
    if (finished) return
    if (doc.hidden === true) {
      stopPolling()
      return
    }
    startPolling()
    tick()
  }

  function setProgress(completedBytes, totalBytes) {
    var percent = 0
    if (typeof totalBytes === 'number' && totalBytes > 0) {
      percent = Math.floor(
        ((typeof completedBytes === 'number' ? completedBytes : 0) / totalBytes) *
          100
      )
      if (percent < 0) percent = 0
      if (percent > 100) percent = 100
    }
    fill.style.width = percent + '%'
    meta.textContent = progressText(completedBytes, totalBytes)
  }

  function remove() {
    stopPolling()
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange)
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (card.parentNode) card.parentNode.removeChild(card)
    var index = registry.cards.indexOf(card)
    if (index >= 0) registry.cards.splice(index, 1)
  }

  function finishWith(status, errorMessage, completedBytes, totalBytes) {
    finished = true
    stopPolling()
    if (status === 'done') {
      title.textContent = 'Downloaded'
      fill.className = 'fill done'
      fill.style.width = '100%'
      meta.textContent =
        typeof totalBytes === 'number' && totalBytes > 0
          ? formatBytes(totalBytes)
          : 'Saved in DonDownload'
      hideTimer = setTimeout(remove, DONE_HIDE_MS)
      return
    }
    title.textContent = 'Download failed'
    fill.className = 'fill error'
    fill.style.width = '100%'
    meta.textContent =
      typeof errorMessage === 'string' && errorMessage.length > 0
        ? errorMessage
        : 'Open DonDownload to see progress'
  }

  function applyStatus(result) {
    if (!result || result.ok !== true) {
      failures += 1
      if (failures >= MAX_FAILURES) {
        stopPolling()
        meta.textContent = 'Open DonDownload to see progress'
      }
      return
    }
    failures = 0
    if (result.status === 'done') {
      finishWith('done', undefined, result.completedBytes, result.totalBytes)
      return
    }
    if (result.status === 'error') {
      finishWith(
        'error',
        result.errorMessage,
        result.completedBytes,
        result.totalBytes
      )
      return
    }
    title.textContent =
      result.status === 'paused'
        ? 'Download paused'
        : 'DonDownload is downloading'
    setProgress(result.completedBytes, result.totalBytes)
  }

  function tick() {
    if (finished) return
    if (Date.now() - startedAt > MAX_POLL_MS) {
      stopPolling()
      meta.textContent = 'Open DonDownload to see progress'
      return
    }
    try {
      chrome.runtime.sendMessage(
        { type: STATUS_MESSAGE, downloadId: downloadId },
        function (response) {
          void chrome.runtime.lastError
          applyStatus(response)
        }
      )
    } catch {
      failures += 1
      if (failures >= MAX_FAILURES) {
        stopPolling()
        meta.textContent = 'Open DonDownload to see progress'
      }
    }
  }

  close.addEventListener('click', remove)
  show.addEventListener('click', function () {
    try {
      chrome.runtime.sendMessage(
        { type: SHOW_MESSAGE, downloadId: downloadId },
        function () {
          void chrome.runtime.lastError
        }
      )
    } catch {
      // The extension context can be gone after a reload; the card still works.
    }
  })

  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibilityChange)
  }
  startPolling()
  tick()
  return true
}

/** The active tab of the last-focused normal window, or null. */
async function activeTab(chromeApi) {
  try {
    const tabs = chromeApi && chromeApi.tabs
    if (!tabs || typeof tabs.query !== 'function') return null
    const found = await tabs.query({ active: true, lastFocusedWindow: true })
    if (!Array.isArray(found)) return null
    const tab = found[0]
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return null
    return tab
  } catch {
    return null
  }
}

/**
 * Inject the card into one tab. Any failure (chrome:// page, no host grant, a
 * PDF viewer) resolves false so the hand-off keeps its badge-only behaviour.
 */
export async function injectHandoffCard(chromeApi, tabId, payload) {
  try {
    const scripting = chromeApi && chromeApi.scripting
    if (!scripting || typeof scripting.executeScript !== 'function') return false
    if (!Number.isInteger(tabId) || tabId < 0) return false
    if (!payload || typeof payload.downloadId !== 'string') return false
    await scripting.executeScript({
      target: { tabId, allFrames: false },
      func: handoffCardInjected,
      args: [payload],
      world: 'ISOLATED'
    })
    return true
  } catch {
    return false
  }
}

/**
 * Show the card for a confirmed hand-off. Never throws and never reports
 * anything to the caller's result: the download is already taken over.
 */
export async function showHandoffCard(chromeApi, settings, item, receipt) {
  try {
    if (!settings || settings.handoffNotifications !== true) return false
    const payload = handoffCardPayload(receipt, item && item.filename)
    if (payload === null) return false
    const tab = await activeTab(chromeApi)
    if (tab === null) return false
    return await injectHandoffCard(chromeApi, tab.id, payload)
  } catch {
    return false
  }
}

function cardFailure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Service-worker side of the card. Only this extension's own content scripts
 * may ask, and only about ids this worker handed off itself in this session, so
 * a page can never probe an arbitrary download id.
 */
export async function handleHandoffCardMessage(chromeApi, message, sender) {
  if (!message || typeof message !== 'object') return null
  const type = message.type
  if (
    type !== HANDOFF_CARD_MESSAGE_TYPES.STATUS &&
    type !== HANDOFF_CARD_MESSAGE_TYPES.SHOW
  ) {
    return null
  }

  const runtime = chromeApi && chromeApi.runtime
  const ownId = runtime && typeof runtime.id === 'string' ? runtime.id : ''
  if (
    !sender ||
    typeof sender.id !== 'string' ||
    ownId.length === 0 ||
    sender.id !== ownId
  ) {
    return cardFailure(
      'INVALID_SENDER',
      'The download card request did not come from this extension.'
    )
  }

  const downloadId = message.downloadId
  if (
    typeof downloadId !== 'string' ||
    !DOWNLOAD_ID_PATTERN.test(downloadId)
  ) {
    return cardFailure(
      'INVALID_MESSAGE',
      'The download identifier is not valid.'
    )
  }
  if (!hasHandedOffDownload(downloadId)) {
    return cardFailure(
      'NOT_FOUND',
      'DonDownload did not take over that download.'
    )
  }

  return type === HANDOFF_CARD_MESSAGE_TYPES.STATUS
    ? sendDownloadStatus(downloadId)
    : sendShowDownload(downloadId)
}
