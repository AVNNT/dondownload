import {
  CAPTURE_SETTINGS_KEY,
  normalizeCaptureSettings,
  readCaptureSettings,
  readOptionsTarget,
  writeCaptureSettings
} from './capture-settings.js'
import {
  overlayRemovalConfirmed
} from './overlay-controller.js'
import { requestExactOriginAccess } from './site-enable.js'
import { originFromUrl, originToMatchPattern } from './site-policy.js'

const floatingTrigger = document.getElementById('floating-trigger')
const handoffNotifications = document.getElementById('handoff-notifications')
const allSitesState = document.getElementById('all-sites-state')
const handoffMinBytes = document.getElementById('handoff-min-bytes')
const handoffStatus = document.getElementById('handoff-status')
const networkObservation = document.getElementById('network-observation')
const requestNetwork = document.getElementById('request-network')
const removeNetwork = document.getElementById('remove-network')
const networkState = document.getElementById('network-state')
const networkStatus = document.getElementById('network-status')
const mediaSniffing = document.getElementById('media-sniffing')
const sniffingState = document.getElementById('sniffing-state')
const sniffingStatus = document.getElementById('sniffing-status')
const siteCookies = document.getElementById('site-cookies')
const cookieTarget = document.getElementById('cookie-target')
const cookieState = document.getElementById('cookie-state')
const cookieList = document.getElementById('cookie-list')
const cookieStatus = document.getElementById('cookie-status')
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
let networkGranted = false
let cookiesGranted = false
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

function renderHandoffState() {
  // `downloads` is a required manifest permission, so browser downloads are
  // taken over from the moment the extension is installed and the size
  // threshold is always usable. Nothing here has to be granted.
  handoffMinBytes.disabled = false
  const minBytes = String(settings.handoffMinBytes)
  handoffMinBytes.value = ['0', '1000000', '10000000'].includes(minBytes)
    ? minBytes
    : '1000000'
  allSitesState.textContent = 'Active on all sites.'
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

function renderSniffingState() {
  mediaSniffing.checked = settings.mediaSniffing === true
  // Detection on all sites is always on: the broad host access is granted at
  // install, so there is no switch and no prompt for it.
  if (!networkGranted) {
    sniffingState.textContent =
      'webRequest permission is not granted, so no response can be detected yet.'
  } else {
    sniffingState.textContent =
      'Media detection is on for all normal http/https sites.'
  }

  const origin = site === null ? null : site.origin
  cookieTarget.textContent = origin === null ? 'No page selected.' : origin
  siteCookies.disabled = origin === null
  const optedIn =
    origin !== null && settings.cookieOptInOrigins.includes(origin)
  siteCookies.checked = optedIn && cookiesGranted
  if (origin === null) {
    cookieState.textContent = 'Select a site in Site access first.'
  } else if (!optedIn) {
    cookieState.textContent = 'Cookies are not sent for detected media on this site.'
  } else if (!cookiesGranted) {
    cookieState.textContent =
      'This site is opted in, but the cookies permission is not granted, so no cookie is read.'
  } else {
    cookieState.textContent =
      'Cookies will be sent for detected media on this exact origin only.'
  }
  renderCookieList()

  if (settings.cookieOptInOrigins.length === 0) {
    rereadCookieCheckbox()
  }
}

function renderCookieList() {
  while (cookieList.children.length > 0) {
    cookieList.removeChild(cookieList.children[0])
  }
  if (settings.cookieOptInOrigins.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = 'No site sends cookies.'
    cookieList.appendChild(empty)
    return
  }
  for (const origin of settings.cookieOptInOrigins) {
    const row = document.createElement('li')
    const code = document.createElement('code')
    code.textContent = origin
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'origin-remove'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => {
      settings.cookieOptInOrigins = settings.cookieOptInOrigins.filter(
        (value) => value !== origin
      )
      renderSniffingState()
      saveSettings(`Cookies are no longer sent for ${origin}.`)
      setStatus(cookieStatus, 'success', `Cookies are no longer sent for ${origin}.`)
      void maybeRemoveCookiesPermission()
    })
    row.appendChild(code)
    row.appendChild(remove)
    cookieList.appendChild(row)
  }
}

async function maybeRemoveCookiesPermission() {
  if (settings.cookieOptInOrigins.length > 0) return
  try {
    await chrome.permissions.remove({ permissions: ['cookies'] })
    cookiesGranted = false
    renderSniffingState()
  } catch {
    // The toggle already prevents reads; a stale permission is not access.
  }
}

function rereadCookieCheckbox() {
  const origin = site === null ? null : site.origin
  siteCookies.checked =
    origin !== null &&
    cookiesGranted &&
    settings.cookieOptInOrigins.includes(origin)
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
  renderHandoffState()
  renderNetworkState()
  renderSniffingState()
  renderExclusions()
}

async function loadSettings() {
  settings = await readCaptureSettings(chrome)
  try {
    networkGranted =
      (await chrome.permissions.contains({ permissions: ['webRequest'] })) === true
  } catch {
    networkGranted = false
  }
  try {
    cookiesGranted =
      (await chrome.permissions.contains({ permissions: ['cookies'] })) === true
  } catch {
    cookiesGranted = false
  }
  if (!cookiesGranted && settings.cookieOptInOrigins.length > 0) {
    settings.cookieOptInOrigins = []
    void writeCaptureSettings(chrome, settings)
  }
  if (!networkGranted) {
    const changed = settings.networkObservation === true
    settings.networkObservation = false
    if (changed) void writeCaptureSettings(chrome, settings)
  }
  renderSettings()
}

function applyCookieOptIn(origin) {
  if (!settings.cookieOptInOrigins.includes(origin)) {
    settings.cookieOptInOrigins.push(origin)
  }
  saveSettings(`Cookies will be sent for detected media on ${origin}.`)
  renderSniffingState()
  setStatus(cookieStatus, 'success', `Cookies will be sent for detected media on ${origin}.`)
}

function requestCookiesForSite(origin) {
  try {
    chrome.permissions.request({ permissions: ['cookies'] }, (granted) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError || granted !== true) {
        cookiesGranted = false
        renderSniffingState()
        setStatus(
          cookieStatus,
          'error',
          'The cookies permission was not granted. No cookie is read.'
        )
        return
      }
      cookiesGranted = true
      applyCookieOptIn(origin)
    })
  } catch {
    cookiesGranted = false
    renderSniffingState()
    setStatus(cookieStatus, 'error', 'The cookies permission could not be requested.')
  }
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
      'The overlay is registered and active in that tab. The floating button appears as soon as a visible video is attached or starts, and background analysis is limited to this exact enabled origin.'
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
  renderSniffingState()
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

handoffMinBytes.addEventListener('change', () => {
  settings.handoffMinBytes = Number(handoffMinBytes.value)
  settings.handoffMinBytes = normalizeCaptureSettings(settings).handoffMinBytes
  renderHandoffState()
  saveSettings(
    settings.handoffMinBytes === 0
      ? 'Every browser download size is handed off.'
      : `Only browser downloads larger than ${
          settings.handoffMinBytes >= 10_000_000 ? '10 MB' : '1 MB'
        } are handed off.`
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

mediaSniffing.addEventListener('change', () => {
  settings.mediaSniffing = mediaSniffing.checked
  if (!mediaSniffing.checked) {
    saveSettings('Media detection is off.')
    renderSniffingState()
    return
  }
  if (networkGranted) {
    saveSettings('Media detection is on for sites you enable.')
    renderSniffingState()
    return
  }
  // Direct user-gesture request. No await may run before permissions.request.
  try {
    chrome.permissions.request({ permissions: ['webRequest'] }, (granted) => {
      const runtimeError = chrome.runtime.lastError
      networkGranted = granted === true
      if (runtimeError || !networkGranted) {
        settings.mediaSniffing = false
        mediaSniffing.checked = false
        renderSniffingState()
        setStatus(
          sniffingStatus,
          'error',
          'The webRequest permission was not granted. Media detection stays off.'
        )
        return
      }
      saveSettings('webRequest permission granted. Media detection is on.')
      renderSniffingState()
      setStatus(sniffingStatus, 'success', 'Media detection is on.')
    })
  } catch {
    settings.mediaSniffing = false
    mediaSniffing.checked = false
    renderSniffingState()
    setStatus(sniffingStatus, 'error', 'The webRequest permission could not be requested.')
  }
})

siteCookies.addEventListener('change', () => {
  if (site === null) {
    siteCookies.checked = false
    return
  }
  const origin = site.origin
  if (siteCookies.checked) {
    if (!cookiesGranted) {
      requestCookiesForSite(origin)
      return
    }
    applyCookieOptIn(origin)
    return
  }
  settings.cookieOptInOrigins = settings.cookieOptInOrigins.filter(
    (value) => value !== origin
  )
  saveSettings(`Cookies are no longer sent for ${origin}.`)
  renderSniffingState()
  setStatus(cookieStatus, 'success', `Cookies are no longer sent for ${origin}.`)
  void maybeRemoveCookiesPermission()
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
  if (siteGranted) {
    sendSiteEnable()
    return
  }

  setSiteBusy(true)
  setStatus(siteStatus, '', '')
  requestExactOriginAccess(chrome, site, (result) => {
    setSiteBusy(false)
    if (!result.ok) {
      setStatus(siteStatus, 'error', result.error || 'Site access was not granted.')
      setSiteState()
      return
    }
    const applied = applySiteResult(result.response)
    setSiteState()
    if (applied && applied.message) {
      setStatus(siteStatus, 'error', applied.message)
      return
    }
    setStatus(siteStatus, 'success', 'Overlay is ready on the selected tab.')
  })
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
