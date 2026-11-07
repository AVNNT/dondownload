import { probeNativeConnection, sendScanPage } from './bridge.js'
import { readOptInCookieHeader } from './capture-settings.js'
import { pendingScanGroups, takePendingScans } from './scan-pending.js'
import { connectionView, siteEnableLabel, welcomeUrl } from './onboarding.js'
import { grantPageUrl, readGrantParameter } from './grant-parameter.js'
import {
  enableRecommendedCapture,
  requestExactOriginAccess,
  siteAccessGranted
} from './site-enable.js'

const connection = document.getElementById('connection')
const connectionTitle = document.getElementById('connection-title')
const connectionDetail = document.getElementById('connection-detail')
const connectionSteps = document.getElementById('connection-steps')
const retryButton = document.getElementById('retry')
const enableAllButton = document.getElementById('enable-all-sites')
const chooseLaterButton = document.getElementById('choose-later')
const choicesStatus = document.getElementById('choices-status')
const grantSection = document.getElementById('grant')
const grantDetail = document.getElementById('grant-detail')
const grantButton = document.getElementById('grant-button')
const grantNextButton = document.getElementById('grant-next')
const grantStatus = document.getElementById('grant-status')

let checking = false
let grantOrigin = null
let grantCookies = false

function setChoicesStatus(kind, message) {
  choicesStatus.className = kind ? `status ${kind}` : 'status'
  choicesStatus.textContent = message
}

function renderConnection(result) {
  const view = connectionView(result)
  connection.className = `connection step ${view.connected ? 'ok' : view.tone}`
  connectionTitle.textContent = view.title
  connectionDetail.textContent = view.detail

  while (connectionSteps.children.length > 0) {
    connectionSteps.removeChild(connectionSteps.children[0])
  }
  for (const step of view.steps) {
    const item = document.createElement('li')
    item.textContent = step
    connectionSteps.appendChild(item)
  }
  connectionSteps.hidden = view.steps.length === 0
  retryButton.hidden = view.connected
}

async function checkConnection() {
  if (checking) return
  checking = true
  retryButton.disabled = true
  retryButton.textContent = 'Checking…'
  try {
    const result = await probeNativeConnection()
    renderConnection(result)
  } finally {
    checking = false
    retryButton.disabled = false
    retryButton.textContent = 'Retry'
  }
}

retryButton.addEventListener('click', () => {
  void checkConnection()
})

enableAllButton.addEventListener('click', () => {
  // Keep this a direct user gesture with no await before the request.
  enableAllButton.disabled = true
  setChoicesStatus('', '')
  enableRecommendedCapture(chrome, (result) => {
    enableAllButton.disabled = false
    if (!result.ok) {
      setChoicesStatus('error', result.error || 'Capture stays off.')
      return
    }
    enableAllButton.textContent = 'Recommended setup enabled'
    setChoicesStatus(
      'success',
      'Capture is on: media is detected on all normal http/https sites and new browser downloads, including video and audio files, are taken over by DonDownload with your browser sign-in. You can change the size threshold in Settings.'
    )
  })
})

chooseLaterButton.addEventListener('click', () => {
  window.close()
})

function setGrantStatus(kind, message) {
  grantStatus.className = kind ? `status ${kind}` : 'status'
  grantStatus.textContent = message
}

function renderGranted() {
  grantButton.hidden = true
  grantDetail.textContent = `Site access is enabled for ${grantOrigin} only.`
  setGrantStatus(
    'success',
    grantCookies
      ? 'Cookies will be sent only for downloads from this exact origin and never saved. Click the same link again.'
      : 'Reload the page you want to use, then open the DonDownload toolbar popup.'
  )
}

function renderGrantSection() {
  const grant = readGrantParameter(window.location.search)
  if (!grant.present || grantSection === null) return
  grantSection.hidden = false
  if (grantNextButton !== null) grantNextButton.hidden = true
  if (grant.origin === null) {
    grantButton.hidden = true
    grantDetail.textContent =
      'This link did not name a valid http(s) origin. Open the toolbar popup and turn on "Use DonDownload on all sites" instead.'
    setGrantStatus('error', 'Nothing was enabled.')
    return
  }

  grantOrigin = grant.origin
  grantCookies = grant.cookies === true
  grantButton.textContent = grantCookies
    ? `Let DonDownload use my login on ${grant.origin}`
    : siteEnableLabel(grantOrigin)
  grantDetail.textContent = grantCookies
    ? `Grant the optional cookies permission for ${grantOrigin} only. DonDownload will read this site's cookies for the download you clicked, keep them in memory for that job, and never save them. The browser shows its normal permission prompt after you click.`
    : `Grant media detection and the optional overlay for ${grantOrigin} only. The browser shows its normal permission prompt after you click.`
  setGrantStatus('', '')
  void siteAccessGranted(chrome, grantOrigin).then((granted) => {
    if (granted && grantCookies !== true) renderGranted()
  })
}

grantButton.addEventListener('click', () => {
  if (grantOrigin === null) return
  // This click is the user gesture for permissions.request; no await before it.
  grantButton.disabled = true
  setGrantStatus('', '')
  requestExactOriginAccess(
    chrome,
    { origin: grantOrigin, tabId: null, cookies: grantCookies },
    (result) => {
      grantButton.disabled = false
      if (!result.ok) {
        setGrantStatus(
          'error',
          result.error || 'Site access was not granted. Nothing on the page changed.'
        )
        return
      }
      renderGranted()
      if (grantCookies) void startPendingScans(grantOrigin)
    }
  )
})

/**
 * Offer the next site's grant when a batch still has URLs waiting for another
 * origin. The button only navigates to the same welcome page with that exact
 * origin as the grant parameter, so the normal click-to-grant flow stays.
 */
async function continuePendingGrant() {
  if (grantNextButton === null) return
  if (!grantCookies) return
  let groups
  try {
    groups = await pendingScanGroups(chrome)
  } catch {
    groups = []
  }
  const next = groups.find((group) => group.origin !== grantOrigin)
  if (!next) {
    grantNextButton.hidden = true
    return
  }
  const nextUrl = grantPageUrl(welcomeUrl(chrome), next.origin, { cookies: true })
  if (nextUrl === null) {
    grantNextButton.hidden = true
    return
  }
  grantNextButton.textContent = `Allow ${next.origin}`
  grantNextButton.hidden = false
  grantNextButton.onclick = () => {
    window.location.assign(nextUrl)
  }
  setGrantStatus(
    '',
    `${next.urls.length} scan${
      next.urls.length === 1 ? '' : 's'
    } still need your sign-in on ${next.origin}. Allow it in this tab to continue.`
  )
}

/**
 * Finish a "Scan this page" or "Scan several links" that needed the one-time
 * cookies grant. Only fresh pending URLs for exactly this origin run; each
 * cookie is read now, sent once and never stored.
 */
async function startPendingScans(origin) {
  const pageUrls = await takePendingScans(chrome, origin)
  if (pageUrls.length === 0) return
  setGrantStatus(
    '',
    `Starting ${pageUrls.length} scan${pageUrls.length === 1 ? '' : 's'} in DonDownload…`
  )
  for (const pageUrl of pageUrls) {
    const cookie = await readOptInCookieHeader(chrome, pageUrl, pageUrl)
    const result = await sendScanPage(pageUrl, cookie)
    if (!result.ok) {
      setGrantStatus(
        'error',
        (result.error && result.error.message) ||
          'The scan could not be started. Make sure DonDownload is running and scan again.'
      )
      void continuePendingGrant()
      return
    }
  }
  setGrantStatus(
    'success',
    `${pageUrls.length} scan${pageUrls.length === 1 ? '' : 's'} opened in DonDownload with your sign-in. You can close this tab; next time scans on this site start right away.`
  )
  void continuePendingGrant()
}

renderGrantSection()
void checkConnection()
