import { sendQueueDownload } from './bridge.js'

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

chrome.runtime.onInstalled.addListener(installContextMenu)
chrome.runtime.onStartup.addListener(installContextMenu)

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return
  void handleLink(info.linkUrl)
})
