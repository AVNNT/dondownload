import {
  CAPTURE_SETTINGS_KEY,
  normalizeCaptureSettings,
  readCaptureSettings,
  readOptionsTarget,
  writeCaptureSettings
} from './capture-settings.js'
import {
  clearPendingEnable,
  overlayRemovalConfirmed,
  rememberPendingEnable
} from './overlay-controller.js'
import { originFromUrl, originToMatchPattern } from './site-policy.js'

const floatingTrigger = document.getElementById('floating-trigger')
const handoffNotifications = document.getElementById('handoff-notifications')
const automaticHandoff = document.getElementById('automatic-handoff')
const requestDownloads = document.getElementById('request-downloads')
const removeDownloads = document.getElementById('remove-downloads')
const permissionState = document.getElementById('permission-state')
const handoffStatus = document.getElementById('handoff-status')
const networkObservation = document.getElementById('network-observation')
const requestNetwork = document.getElementById('request-network')
const removeNetwork = document.getElementById('remove-network')
const networkState = document.getElementById('network-state')
const networkStatus = document.getElementById('network-status')
const exclusionForm = document.getElementById('exclusion-form')
const exclusionOrigin = document.getElementById('exclusion-origin')
const exclusionList = document.getElementById('exclusion-list')
const exclusionStatus = document.getElementById('exclusion-status')
const siteTarget = document.getElementById('site-target')
const siteState = document.getElementById('site-state')
const siteHint = document.getElementById('site-hint')
const enableSite = document.getElementById('enable-site')
const disableSite = document.getElementById('disable-site')
const siteStatus = document.getElementById('site-status')

let settings = normalizeCaptureSettings(null)
let downloadsGranted = false
let networkGranted = false
let site = null
let siteGranted = false
let siteReady = false
let busy = false

function setStatus(element, kind, message) {
  element.className = kind ? `status ${kind}` : 'status'
  element.textContent = message
}

function setSiteBusy(next) {
  busy = next
  enableSite.disabled = next
  disableSite.disabled = next
}

function saveSettings(message) {
  void writeCaptureSettings(chrome, settings).then((ok) => {
    if (!ok) {
      setStatus(handoffStatus, 'error', 'Settings could not be saved in this browser profile.')
      return
    }
    if (message) setStatus(handoffStatus, 'success', message)
  })
}

function renderPermissionState() {
  automaticHandoff.disabled = !downloadsGranted
  if (!downloadsGranted) {
    automaticHandoff.checked = false
    permissionState.textContent =
      'Downloads permission is not granted. Automatic hand-off is off.'
    requestDownloads.hidden = false
    removeDownloads.hidden = true
    return
  }
  automaticHandoff.checked = settings.automaticFileHandoff === true
  permissionState.textContent =
    'Downloads permission is granted. Automatic hand-off can be turned on.'
  requestDownloads.hidden = true
  removeDownloads.hidden = false
}

function renderNetworkState() {
  networkObservation.disabled = !networkGranted
  if (!networkGranted) {
    networkObservation.checked = false
    networkState.textContent =
      'webRequest permission is not granted. Network response evidence is off.'
    requestNetwork.hidden = false
    removeNetwork.hidden = true
    return
  }
  networkObservation.checked = settings.networkObservation === true
  networkState.textContent =
    'webRequest permission is granted. Response evidence is used only when the toggle is on.'
  requestNetwork.hidden = true
  removeNetwork.hidden = false
}

function renderExclusions() {
  while (exclusionList.children.length > 0) {
    exclusionList.removeChild(exclusionList.children[0])
  }
  if (settings.excludedOrigins.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = 'No excluded sites.'
    exclusionList.appendChild(empty)
    return
  }
  for (const origin of settings.excludedOrigins) {
    const row = document.createElement('li')
    const code = document.createElement('code')
    code.textContent = origin
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'origin-remove'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => {
      settings.excludedOrigins = settings.excludedOrigins.filter(
        (value) => value !== origin
      )
      renderExclusions()
      saveSettings('Excluded sites updated.')
    })
    row.appendChild(code)
    row.appendChild(remove)
    exclusionList.appendChild(row)
  }
}

function renderSettings() {
  floatingTrigger.checked = settings.floatingTriggerEnabled !== false
  handoffNotifications.checked = settings.handoffNotifications !== false
  renderPermissionState()
  renderNetworkState()
  renderExclusions()
}

async function loadSettings() {
  settings = await readCaptureSettings(chrome)
  try {
    downloadsGranted =
      (await chrome.permissions.contains({ permissions: ['downloads'] })) === true
  } catch {
    downloadsGranted = false
  }
  try {
    networkGranted =
      (await chrome.permissions.contains({ permissions: ['webRequest'] })) === true
  } catch {
    networkGranted = false
  }
  if (!downloadsGranted) {
    const changed = settings.automaticFileHandoff === true
    settings.automaticFileHandoff = false
    if (changed) void writeCaptureSettings(chrome, settings)
  }
  if (!networkGranted) {
    const changed = settings.networkObservation === true
    settings.networkObservation = false
    if (changed) void writeCaptureSettings(chrome, settings)
  }
  renderSettings()
}

function setSiteState() {
  if (site === null) {
    siteTarget.textContent = 'No page selected.'
    siteState.textContent = ''
    siteHint.textContent =
      'Open the toolbar popup on the page you want, then choose Settings & site access. The exact origin is stored only for this browser session.'
    enableSite.hidden = true
    disableSite.hidden = true
    return
  }
  siteTarget.textContent = site.origin
  if (!siteGranted) {
    siteState.textContent = 'Site access off'
    siteHint.textContent =
      'The overlay is optional. Enabling asks for this exact origin only.'
  } else if (siteReady) {
    siteState.textContent = 'Overlay on'
    siteHint.textContent =
      'The overlay is registered and active in that tab. The floating button follows the active playing video.'
  } else {
    siteState.textContent = 'Access granted, overlay not verified'
    siteHint.textContent =
      'Reload that page, then revisit this settings tab and check the state.'
  }
  enableSite.hidden = siteGranted
  disableSite.hidden = !siteGranted
}

async function loadSite() {
  site = await readOptionsTarget(chrome)
  siteGranted = false
  siteReady = false
  if (site !== null) {
    const pattern = originToMatchPattern(site.origin)
    if (pattern === null) {
      site = null
    } else {
      try {
        siteGranted =
          (await chrome.permissions.contains({ origins: [pattern] })) === true
      } catch {
        siteGranted = false
      }
    }
  }
  setSiteState()
  if (site !== null && siteGranted) requestSiteSync()
}

function applySiteResult(response) {
  if (!response || typeof response !== 'object') {
    siteGranted = false
    siteReady = false
    return null
  }
  siteGranted = response.granted === true
  siteReady =
    response.granted === true &&
    response.registered === true &&
    response.injected === true
  if (response.ok === false) {
    return {
      message:
        response.error && typeof response.error.message === 'string'
          ? response.error.message
          : 'The site request could not be completed.'
    }
  }
  if (!siteGranted) return { message: null }
  if (siteReady) return { message: null }
  return {
    message:
      typeof response.message === 'string'
        ? response.message
        : 'Site access is saved, but the overlay was not verified in that tab. Reload the page.'
  }
}

function requestSiteSync() {
  if (site === null) return
  setSiteBusy(true)
  chrome.runtime.sendMessage(
    {
      type: 'dondownload:overlay-sync',
      origin: site.origin,
      tabId: site.tabId
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      setSiteBusy(false)
      if (runtimeError) {
        setStatus(siteStatus, 'error', 'The overlay state could not be checked.')
        setSiteState()
        return
      }
      const result = applySiteResult(response)
      setSiteState()
      if (result && result.message) setStatus(siteStatus, 'error', result.message)
    }
  )
}

function sendSiteEnable() {
  if (site === null) return
  setSiteBusy(true)
  setStatus(siteStatus, '', '')
  chrome.runtime.sendMessage(
    {
      type: 'dondownload:overlay-enable',
      origin: site.origin,
      tabId: site.tabId
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      setSiteBusy(false)
      if (runtimeError) {
        siteReady = false
        setSiteState()
        setStatus(siteStatus, 'error', 'The overlay request could not be completed.')
        return
      }
      const result = applySiteResult(response)
      setSiteState()
      if (result && result.message) {
        setStatus(siteStatus, 'error', result.message)
        return
      }
      setStatus(siteStatus, 'success', 'Overlay is ready on the selected tab.')
    }
  )
}

floatingTrigger.addEventListener('change', () => {
  settings.floatingTriggerEnabled = floatingTrigger.checked
  saveSettings('Floating button preference saved.')
})

handoffNotifications.addEventListener('change', () => {
  settings.handoffNotifications = handoffNotifications.checked
  saveSettings('Hand-off feedback preference saved.')
})

automaticHandoff.addEventListener('change', () => {
  if (!downloadsGranted) {
    automaticHandoff.checked = false
    return
  }
  settings.automaticFileHandoff = automaticHandoff.checked
  saveSettings(
    automaticHandoff.checked
      ? 'Automatic hand-off is on for supported non-media files.'
      : 'Automatic hand-off is off.'
  )
})

networkObservation.addEventListener('change', () => {
  if (!networkGranted) {
    networkObservation.checked = false
    return
  }
  settings.networkObservation = networkObservation.checked
  saveSettings(
    networkObservation.checked
      ? 'Network response evidence is on for opted-in pages.'
      : 'Network response evidence is off.'
  )
})

requestNetwork.addEventListener('click', () => {
  // Direct user-gesture request. No await may run before permissions.request.
  try {
    chrome.permissions.request({ permissions: ['webRequest'] }, (granted) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        setStatus(networkStatus, 'error', 'The webRequest permission could not be requested.')
        return
      }
      networkGranted = granted === true
      if (!networkGranted) {
        settings.networkObservation = false
        renderNetworkState()
        setStatus(networkStatus, 'error', 'Permission was not granted. Network evidence stays off.')
        return
      }
      settings.networkObservation = true
      renderNetworkState()
      saveSettings('webRequest permission granted. Network response evidence is on.')
      setStatus(networkStatus, 'success', 'Network response evidence is on.')
    })
  } catch {
    setStatus(networkStatus, 'error', 'The webRequest permission could not be requested.')
  }
})

removeNetwork.addEventListener('click', () => {
  try {
    chrome.permissions.remove({ permissions: ['webRequest'] }, (removed) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError || removed !== true) {
        setStatus(networkStatus, 'error', 'The webRequest permission could not be removed.')
        return
      }
      networkGranted = false
      settings.networkObservation = false
      renderNetworkState()
      saveSettings('webRequest permission removed. Network response evidence is off.')
      setStatus(networkStatus, 'success', 'Network response evidence is off.')
    })
  } catch {
    setStatus(networkStatus, 'error', 'The webRequest permission could not be removed.')
  }
})

requestDownloads.addEventListener('click', () => {
  // This must remain a direct user-gesture request with no preceding await.
  try {
    chrome.permissions.request({ permissions: ['downloads'] }, (granted) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        setStatus(handoffStatus, 'error', 'The downloads permission could not be requested.')
        return
      }
      downloadsGranted = granted === true
      if (!downloadsGranted) {
        settings.automaticFileHandoff = false
        renderPermissionState()
        setStatus(handoffStatus, 'error', 'Permission was not granted. Automatic hand-off stays off.')
        return
      }
      settings.automaticFileHandoff = true
      renderPermissionState()
      saveSettings('Downloads permission granted. Automatic hand-off is on.')
    })
  } catch {
    setStatus(handoffStatus, 'error', 'The downloads permission could not be requested.')
  }
})

removeDownloads.addEventListener('click', () => {
  try {
    chrome.permissions.remove({ permissions: ['downloads'] }, (removed) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError || removed !== true) {
        setStatus(handoffStatus, 'error', 'The downloads permission could not be removed.')
        return
      }
      downloadsGranted = false
      settings.automaticFileHandoff = false
      renderPermissionState()
      saveSettings('Downloads permission removed. Automatic hand-off is off.')
    })
  } catch {
    setStatus(handoffStatus, 'error', 'The downloads permission could not be removed.')
  }
})

exclusionForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const raw = exclusionOrigin.value.trim()
  let origin = null
  try {
    const parsed = new URL(raw)
    if (parsed.origin === raw) origin = originFromUrl(raw)
  } catch {
    origin = null
  }
  if (origin === null) {
    setStatus(exclusionStatus, 'error', 'Enter an exact origin such as https://example.com.')
    return
  }
  if (!settings.excludedOrigins.includes(origin)) {
    settings.excludedOrigins.push(origin)
  }
  exclusionOrigin.value = ''
  renderExclusions()
  saveSettings(`Excluded ${origin}.`)
  setStatus(exclusionStatus, 'success', `Excluded ${origin}.`)
})

enableSite.addEventListener('click', () => {
  if (busy || site === null) return
  const pattern = originToMatchPattern(site.origin)
  if (pattern === null) {
    setStatus(siteStatus, 'error', 'This origin is not supported.')
    return
  }
  if (siteGranted) {
    sendSiteEnable()
    return
  }

  void rememberPendingEnable(chrome, site.origin, site.tabId)
  setSiteBusy(true)
  setStatus(siteStatus, '', '')
  try {
    chrome.permissions.request({ origins: [pattern] }, (granted) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError || granted !== true) {
        void clearPendingEnable(chrome)
        setSiteBusy(false)
        setStatus(siteStatus, 'error', 'Site access was not granted. Nothing on the page changed.')
        setSiteState()
        return
      }
      sendSiteEnable()
    })
  } catch {
    void clearPendingEnable(chrome)
    setSiteBusy(false)
    setStatus(siteStatus, 'error', 'Site access could not be requested.')
    setSiteState()
  }
})

disableSite.addEventListener('click', () => {
  if (busy || site === null) return
  setSiteBusy(true)
  setStatus(siteStatus, '', '')
  chrome.runtime.sendMessage(
    {
      type: 'dondownload:overlay-disable',
      origin: site.origin,
      tabId: site.tabId
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError
      setSiteBusy(false)
      if (runtimeError || !overlayRemovalConfirmed(response)) {
        setStatus(
          siteStatus,
          'error',
          response &&
            response.error &&
            typeof response.error.message === 'string'
            ? response.error.message
            : 'The overlay did not fully turn off. Reload the page and try again.'
        )
        setSiteState()
        return
      }
      siteGranted = false
      siteReady = false
      setSiteState()
      setStatus(siteStatus, 'success', 'Overlay and exact-origin access removed.')
    }
  )
})

// Keep the page in sync if the service worker changes the preference elsewhere.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[CAPTURE_SETTINGS_KEY]) return
    settings = normalizeCaptureSettings(changes[CAPTURE_SETTINGS_KEY].newValue)
    renderSettings()
  })
}

void loadSettings()
void loadSite()
