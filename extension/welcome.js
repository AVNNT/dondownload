import { probeNativeConnection } from './bridge.js'
import { connectionView, siteEnableLabel } from './onboarding.js'
import { readGrantParameter } from './grant-parameter.js'
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
const grantStatus = document.getElementById('grant-status')

let checking = false
let grantOrigin = null

function setChoicesStatus(kind, message) {
  choicesStatus.className = kind ? `status ${kind}` : 'status'
  choicesStatus.textContent = message
}

function renderConnection(result) {
  const view = connectionView(result)
  connection.className = `connection ${view.connected ? 'ok' : view.tone}`
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
      'Capture is on: media is detected on all normal http/https sites and browser downloads are handed to DonDownload. You can change both in Settings.'
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
    'Reload the page you want to use, then open the DonDownload toolbar popup.'
  )
}

function renderGrantSection() {
  const grant = readGrantParameter(window.location.search)
  if (!grant.present || grantSection === null) return
  grantSection.hidden = false
  if (grant.origin === null) {
    grantButton.hidden = true
    grantDetail.textContent =
      'This link did not name a valid http(s) origin. Open the toolbar popup and choose Enable on this site instead.'
    setGrantStatus('error', 'Nothing was enabled.')
    return
  }

  grantOrigin = grant.origin
  grantButton.textContent = siteEnableLabel(grantOrigin)
  grantDetail.textContent = `Grant media detection and the optional overlay for ${grantOrigin} only. The browser shows its normal permission prompt after you click.`
  setGrantStatus('', '')
  void siteAccessGranted(chrome, grantOrigin).then((granted) => {
    if (granted) renderGranted()
  })
}

grantButton.addEventListener('click', () => {
  if (grantOrigin === null) return
  // This click is the user gesture for permissions.request; no await before it.
  grantButton.disabled = true
  setGrantStatus('', '')
  requestExactOriginAccess(
    chrome,
    { origin: grantOrigin, tabId: null },
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
    }
  )
})

renderGrantSection()
void checkConnection()
