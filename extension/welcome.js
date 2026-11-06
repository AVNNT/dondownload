import { probeNativeConnection } from './bridge.js'
import { connectionView } from './onboarding.js'
import { enableAllSitesDetection } from './site-enable.js'

const connection = document.getElementById('connection')
const connectionTitle = document.getElementById('connection-title')
const connectionDetail = document.getElementById('connection-detail')
const connectionSteps = document.getElementById('connection-steps')
const retryButton = document.getElementById('retry')
const enableAllButton = document.getElementById('enable-all-sites')
const chooseLaterButton = document.getElementById('choose-later')
const choicesStatus = document.getElementById('choices-status')

let checking = false

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
  enableAllSitesDetection(chrome, (result) => {
    enableAllButton.disabled = false
    if (!result.ok) {
      setChoicesStatus('error', result.error || 'All-site detection stays off.')
      return
    }
    enableAllButton.textContent = 'Enabled on all sites'
    setChoicesStatus(
      'success',
      'Detection is on for all normal http/https sites. You can turn it off in Settings.'
    )
  })
})

chooseLaterButton.addEventListener('click', () => {
  window.close()
})

void checkConnection()
