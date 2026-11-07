// Lifecycle policy for the optional per-site overlay. Unlike site-policy.js
// this module performs Chrome API calls, but every function receives the
// `chrome` object explicitly so the whole flow can be tested with a fake API.
//
// The important constraint is that "enabled" means two separate things:
//   1. a persistent content-script registration exists for the exact origin;
//   2. the overlay UI was actually injected and verified in the current tab.
// The popup must never describe the overlay as on/success when only the host
// permission exists. A permission prompt can close the action popup before its
// callback runs, so the grant is also applied through permissions.onAdded.

import {
  OVERLAY_ALL_SITES_ID,
  OVERLAY_ALL_SITES_MATCHES,
  OVERLAY_MESSAGE_TYPES,
  OVERLAY_SCRIPT_FILES,
  allSitesOverlayWanted,
  matchPatternToOrigin,
  originFromUrl,
  originToMatchPattern,
  overlayAllSitesRegistration,
  overlayOriginFromRegistration,
  overlayRegistrationForOrigin
} from './site-policy.js'
import { readCaptureSettings, writeCaptureSettings } from './capture-settings.js'

export const OVERLAY_PENDING_STORAGE_KEY = 'dondownloadOverlayPendingEnable'
export const OVERLAY_PENDING_TTL_MS = 5 * 60 * 1000
export const OVERLAY_HOST_ID = 'dondownload-overlay-host'
export const OVERLAY_TABS_STORAGE_KEY = 'dondownloadOverlayTabs'
export const OVERLAY_MAX_TRACKED_TABS = 200

const inFlightEnables = new Map()

function failure(code, message, extra) {
  return { ok: false, error: { code, message }, ...extra }
}

function isExactOrigin(value) {
  return (
    typeof value === 'string' &&
    originFromUrl(value) === value &&
    originToMatchPattern(value) !== null
  )
}

function sessionStorage(chromeApi) {
  const storage = chromeApi && chromeApi.storage
  return storage && storage.session ? storage.session : null
}

async function readTrackedTabs(chromeApi) {
  const session = sessionStorage(chromeApi)
  if (session === null) return {}
  try {
    const stored = await session.get(OVERLAY_TABS_STORAGE_KEY)
    const value = stored && stored[OVERLAY_TABS_STORAGE_KEY]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

    const tracked = {}
    for (const [origin, tabIds] of Object.entries(value)) {
      if (!isExactOrigin(origin) || !Array.isArray(tabIds)) continue
      const clean = [
        ...new Set(
          tabIds.filter((tabId) => Number.isInteger(tabId) && tabId >= 0)
        )
      ].slice(0, OVERLAY_MAX_TRACKED_TABS)
      if (clean.length > 0) tracked[origin] = clean
    }
    return tracked
  } catch {
    return {}
  }
}

async function writeTrackedTabs(chromeApi, tracked) {
  const session = sessionStorage(chromeApi)
  if (session === null) return false
  try {
    if (Object.keys(tracked).length === 0) {
      await session.remove(OVERLAY_TABS_STORAGE_KEY)
    } else {
      await session.set({ [OVERLAY_TABS_STORAGE_KEY]: tracked })
    }
    return true
  } catch {
    return false
  }
}

/**
 * True only when this exact tab was recorded as running the overlay for the
 * exact origin. The service worker uses this before any native media call so an
 * arbitrary same-origin message cannot borrow another tab's grant.
 */
export async function isOverlayTabTracked(chromeApi, origin, tabId) {
  if (!isExactOrigin(origin)) return false
  if (!Number.isInteger(tabId) || tabId < 0) return false
  const tracked = await readTrackedTabs(chromeApi)
  return Array.isArray(tracked[origin]) && tracked[origin].includes(tabId)
}

/**
 * Remember a tab that currently runs the overlay for an exact origin. Chrome
 * does not let the extension query same-origin tabs after the host grant is
 * revoked (the URL filter needs `tabs` or a matching host grant), so this
 * session-only map is what makes external-revoke teardown possible without
 * broadening permissions. Tab ids expire with the browser session; the
 * content script additionally checks the message origin before tearing down.
 */
export async function rememberOverlayTab(chromeApi, origin, tabId) {
  if (!isExactOrigin(origin)) return false
  if (!Number.isInteger(tabId) || tabId < 0) return false

  const tracked = await readTrackedTabs(chromeApi)
  const current = tracked[origin] ?? []
  if (current.includes(tabId)) return true
  tracked[origin] = [...current, tabId].slice(-OVERLAY_MAX_TRACKED_TABS)
  return writeTrackedTabs(chromeApi, tracked)
}

/** Forget one closed tab. Called from chrome.tabs.onRemoved, no permission needed. */
export async function forgetOverlayTab(chromeApi, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return false
  const tracked = await readTrackedTabs(chromeApi)
  let changed = false
  for (const [origin, tabIds] of Object.entries(tracked)) {
    const next = tabIds.filter((id) => id !== tabId)
    if (next.length === tabIds.length) continue
    changed = true
    if (next.length === 0) delete tracked[origin]
    else tracked[origin] = next
  }
  if (!changed) return true
  return writeTrackedTabs(chromeApi, tracked)
}

async function forgetOverlayOriginTabs(chromeApi, origin) {
  const tracked = await readTrackedTabs(chromeApi)
  if (!Object.prototype.hasOwnProperty.call(tracked, origin)) return true
  delete tracked[origin]
  return writeTrackedTabs(chromeApi, tracked)
}

async function notifyOverlayDisabled(chromeApi, tabIds, origin) {
  let notified = 0
  let failed = 0
  for (const tabId of tabIds) {
    try {
      await chromeApi.tabs.sendMessage(tabId, {
        type: OVERLAY_MESSAGE_TYPES.DISABLED,
        origin
      })
      notified += 1
    } catch {
      // The tab may be closed, restricted or already have no content script.
      failed += 1
    }
  }
  return { notified, failed }
}

function sameRegistration(stored, expected) {
  if (!stored || typeof stored !== 'object') return false
  if (stored.id !== expected.id) return false
  const matches = Array.isArray(stored.matches) ? stored.matches : []
  if (
    matches.length !== expected.matches.length ||
    matches.some((pattern, index) => pattern !== expected.matches[index])
  ) {
    return false
  }
  const js = Array.isArray(stored.js) ? stored.js : []
  return (
    js.length === expected.js.length &&
    js.every((file, index) => file === expected.js[index])
  )
}

async function tabMatchesOrigin(chromeApi, tabId, origin) {
  if (!Number.isInteger(tabId) || tabId < 0) return false
  try {
    const tab = await chromeApi.tabs.get(tabId)
    return originFromUrl(tab && tab.url) === origin
  } catch {
    return false
  }
}

/**
 * Runs inside the page's extension isolated world after the overlay files are
 * injected. It verifies the host exists and the runtime is healthy, so success
 * is reported from the page, not from a resolved API call alone.
 */
export function overlayPresenceProbe() {
  try {
    const host = document.getElementById('dondownload-overlay-host')
    const runtime = globalThis.__dondownloadOverlayRuntime
    return Boolean(
      host &&
        host.isConnected &&
        host.getAttribute('data-dondownload-overlay') === '' &&
        host.shadowRoot &&
        host.shadowRoot.querySelector('.trigger') &&
        runtime &&
        runtime.active === true &&
        runtime.disabled === false
    )
  } catch {
    return false
  }
}

async function enableUncached(chromeApi, origin, tabId) {
  if (!isExactOrigin(origin)) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }

  const pattern = originToMatchPattern(origin)
  const registration = overlayRegistrationForOrigin(origin)
  if (pattern === null || registration === null) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }

  // An explicit enable also lifts a previous per-site exclusion.
  await setOriginExcluded(chromeApi, origin, false)

  // In all-sites mode the one broad registration already covers every origin,
  // so a second per-origin registration would inject the overlay twice.
  if (await allSitesOverlayActive(chromeApi)) {
    return injectOverlayIntoMatchingTab(
      chromeApi,
      origin,
      tabId,
      'ALL_SITES',
      'The overlay is on for all sites. Reload the page if the button is missing.'
    )
  }

  let granted = false
  try {
    granted = (await chromeApi.permissions.contains({ origins: [pattern] })) === true
  } catch {
    return failure(
      'PERMISSION_UNREADABLE',
      'Site access could not be read. Reopen the popup and try again.',
      { granted: false }
    )
  }
  if (!granted) {
    return failure(
      'PERMISSION_REQUIRED',
      'Site access was not granted. Enable the overlay again and accept the browser prompt.',
      { granted: false }
    )
  }

  // The persistent registration is the part that makes reloads work. Verify
  // the stored shape instead of assuming the write took effect.
  try {
    const existing = await chromeApi.scripting.getRegisteredContentScripts({
      ids: [registration.id]
    })
    if (existing.length === 0) {
      await chromeApi.scripting.registerContentScripts([registration])
    } else {
      await chromeApi.scripting.updateContentScripts([registration])
    }
    const stored = await chromeApi.scripting.getRegisteredContentScripts({
      ids: [registration.id]
    })
    if (!sameRegistration(stored[0], registration)) {
      return failure(
        'REGISTRATION_FAILED',
        'The per-site overlay registration could not be saved, so reloads would not keep it. Try again.',
        { granted: true, registered: false }
      )
    }
  } catch {
    return failure(
      'REGISTRATION_FAILED',
      'The per-site overlay registration could not be saved, so reloads would not keep it. Try again.',
      { granted: true, registered: false }
    )
  }

  return injectOverlayIntoMatchingTab(
    chromeApi,
    origin,
    tabId,
    'ORIGIN_MISMATCH',
    'The overlay is registered for this site, but this tab is no longer on it. Reload the page to add the button.'
  )
}

/**
 * Inject and verify the overlay in one tab that is already on `origin`.
 * `mismatchReason` is reported when the tab moved to another page.
 */
async function injectOverlayIntoMatchingTab(
  chromeApi,
  origin,
  tabId,
  mismatchReason,
  mismatchMessage
) {
  if (!(await tabMatchesOrigin(chromeApi, tabId, origin))) {
    return {
      ok: true,
      granted: true,
      registered: true,
      injected: false,
      reason: mismatchReason,
      message: mismatchMessage
    }
  }

  // Track this tab for teardown after an external revoke. Best effort: a tab
  // that is closed immediately is pruned by tabs.onRemoved.
  await rememberOverlayTab(chromeApi, origin, tabId)

  try {
    await chromeApi.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [...OVERLAY_SCRIPT_FILES],
      injectImmediately: true
    })
    // executeScript can resolve while a page navigation discards the frame, so
    // prove the UI is present in the page before claiming success.
    const verification = await chromeApi.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: overlayPresenceProbe,
      world: 'ISOLATED'
    })
    const present =
      Array.isArray(verification) &&
      verification.some((result) => result && result.result === true)
    if (!present) {
      return {
        ok: true,
        granted: true,
        registered: true,
        injected: false,
        reason: 'INJECTION_NOT_VERIFIED',
        message:
          'Site access is granted and saved, but this tab did not report the overlay. Reload the page and check again.'
      }
    }
  } catch {
    return {
      ok: true,
      granted: true,
      registered: true,
      injected: false,
      reason: 'INJECTION_FAILED',
      message:
        'Site access is granted and saved, but the overlay could not be added to this tab. Reload the page; restricted browser pages are not supported.'
    }
  }

  return { ok: true, granted: true, registered: true, injected: true }
}

/**
 * True when the broad host grant is present. All-sites mode needs it for both
 * the registration and the injection into already-open tabs.
 */
export async function allSitesHostsGranted(chromeApi) {
  try {
    return (
      (await chromeApi.permissions.contains({
        origins: [...OVERLAY_ALL_SITES_MATCHES]
      })) === true
    )
  } catch {
    return false
  }
}

/** True when the stored settings ask for the all-sites overlay. */
export async function allSitesOverlayWantedFromSettings(chromeApi) {
  let settings
  try {
    settings = await readCaptureSettings(chromeApi)
  } catch {
    return false
  }
  if (!allSitesOverlayWanted(settings, true)) return false
  return allSitesHostsGranted(chromeApi)
}

/** True when the all-sites registration is stored. */
async function allSitesRegistrationStored(chromeApi) {
  try {
    const stored = await chromeApi.scripting.getRegisteredContentScripts({
      ids: [OVERLAY_ALL_SITES_ID]
    })
    return Array.isArray(stored) && stored.length > 0
  } catch {
    return false
  }
}

async function allSitesOverlayActive(chromeApi) {
  return (
    (await allSitesOverlayWantedFromSettings(chromeApi)) &&
    (await allSitesRegistrationStored(chromeApi))
  )
}

/** Remove the all-sites registration and verify it is really gone. */
async function removeAllSitesRegistration(chromeApi) {
  try {
    await chromeApi.scripting.unregisterContentScripts({
      ids: [OVERLAY_ALL_SITES_ID]
    })
  } catch {
    // It may already be absent; the check below decides the truth.
  }
  return !(await allSitesRegistrationStored(chromeApi))
}

function isExcludedOrigin(settings, origin) {
  return Boolean(
    settings &&
      Array.isArray(settings.excludedOrigins) &&
      origin !== null &&
      settings.excludedOrigins.includes(origin)
  )
}

/**
 * Inject the overlay into every already-open http(s) tab that does not have it
 * yet. A tab that already runs the overlay (from a per-origin registration or
 * an earlier injection) is skipped, so nothing is ever injected twice.
 */
export async function injectAllSitesIntoOpenTabs(chromeApi) {
  let settings
  try {
    settings = await readCaptureSettings(chromeApi)
  } catch {
    settings = { excludedOrigins: [] }
  }
  let tabs
  try {
    tabs = await chromeApi.tabs.query({ url: [...OVERLAY_ALL_SITES_MATCHES] })
  } catch {
    return { ok: false, injected: [], skipped: [], failed: [] }
  }
  const injected = []
  const skipped = []
  const failed = []
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const tabId = tab && tab.id
    if (!Number.isInteger(tabId) || tabId < 0) continue
    const origin = originFromUrl(tab.url)
    if (origin === null) {
      skipped.push(tabId)
      continue
    }
    if (isExcludedOrigin(settings, origin)) {
      skipped.push(tabId)
      continue
    }
    try {
      const presence = await chromeApi.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: overlayPresenceProbe,
        world: 'ISOLATED'
      })
      const present =
        Array.isArray(presence) &&
        presence.some((result) => result && result.result === true)
      if (present) {
        skipped.push(tabId)
        continue
      }
      await chromeApi.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: [...OVERLAY_SCRIPT_FILES],
        injectImmediately: true
      })
      await rememberOverlayTab(chromeApi, origin, tabId)
      injected.push(tabId)
    } catch {
      // Restricted pages (browser UI, extension pages) and discarded tabs.
      failed.push(tabId)
    }
  }
  return { ok: true, injected, skipped, failed }
}

/**
 * Make the persistent registrations match the current settings and grant.
 *
 * - all-sites mode on: register the one broad registration and drop every
 *   per-origin registration (the broad one already covers them);
 * - all-sites mode off: remove the broad registration and restore the
 *   per-origin registrations for origins that still have their grant.
 *
 * `injectOpenTabs` additionally injects the overlay into tabs that are already
 * open, so turning the switch on shows it without a reload.
 */
export async function reconcileOverlayMode(chromeApi, options = {}) {
  let settings
  try {
    settings = await readCaptureSettings(chromeApi)
  } catch {
    return { ok: false, mode: 'unknown', registered: false, injected: [] }
  }
  const broadGranted = await allSitesHostsGranted(chromeApi)
  const wanted = allSitesOverlayWanted(settings, broadGranted)

  if (!wanted) {
    const removed = await removeAllSitesRegistration(chromeApi)
    let restored = 0
    if (settings.floatingTriggerEnabled !== false) {
      try {
        const enabled = await readEnabledOrigins(chromeApi)
        const present = new Set(enabled)
        for (const origin of enabled) {
          if (present.has(origin)) continue
          const registration = overlayRegistrationForOrigin(origin)
          if (registration === null) continue
          try {
            await chromeApi.scripting.registerContentScripts([registration])
            restored += 1
          } catch {
            // The next reconcile or the popup retries.
          }
        }
      } catch {
        // Best effort; the popup can still enable a site explicitly.
      }
    }
    return {
      ok: removed,
      mode: 'per-origin',
      registered: false,
      restored,
      injected: []
    }
  }

  const registration = overlayAllSitesRegistration()
  try {
    const stored = await chromeApi.scripting.getRegisteredContentScripts({
      ids: [registration.id]
    })
    if (!Array.isArray(stored) || stored.length === 0) {
      await chromeApi.scripting.registerContentScripts([registration])
    } else if (!sameRegistration(stored[0], registration)) {
      await chromeApi.scripting.updateContentScripts([registration])
    }
  } catch {
    return { ok: false, mode: 'all-sites', registered: false, injected: [] }
  }
  const registered = await allSitesRegistrationStored(chromeApi)

  // One broad registration is enough; per-origin ones would inject twice.
  try {
    const registrations = await chromeApi.scripting.getRegisteredContentScripts()
    const perOrigin = (Array.isArray(registrations) ? registrations : [])
      .filter((entry) => overlayOriginFromRegistration(entry) !== null)
      .map((entry) => entry.id)
    if (perOrigin.length > 0) {
      await chromeApi.scripting.unregisterContentScripts({ ids: perOrigin })
    }
  } catch {
    // The content script guards against a double host anyway.
  }

  const injected =
    options.injectOpenTabs === true
      ? (await injectAllSitesIntoOpenTabs(chromeApi)).injected
      : []
  return { ok: registered, mode: 'all-sites', registered, injected }
}

/**
 * Origins the user enabled one by one. They are the session-tracked tabs plus
 * any origin with a stored per-origin registration; both are already limited
 * to origins the user chose.
 */
async function readEnabledOrigins(chromeApi) {
  const origins = new Set()
  try {
    const registrations = await chromeApi.scripting.getRegisteredContentScripts()
    for (const registration of Array.isArray(registrations) ? registrations : []) {
      const origin = overlayOriginFromRegistration(registration)
      if (origin !== null) origins.add(origin)
    }
  } catch {
    // Fall through with whatever the session map has.
  }
  const tracked = await readTrackedTabs(chromeApi)
  for (const origin of Object.keys(tracked)) origins.add(origin)
  return [...origins]
}

/** Register the exact origin and inject/verify the overlay in the current tab. */
export function enableOverlayForTab(chromeApi, origin, tabId) {
  const key = `${origin}\u0000${tabId}`
  const existing = inFlightEnables.get(key)
  if (existing) return existing

  const promise = enableUncached(chromeApi, origin, tabId).finally(() => {
    inFlightEnables.delete(key)
  })
  inFlightEnables.set(key, promise)
  return promise
}

/**
 * Re-apply an existing grant when the popup opens (or after the popup was
 * closed by the permission prompt). Never registers or injects without a grant.
 */
export async function syncOverlayForTab(chromeApi, origin, tabId) {
  if (!isExactOrigin(origin)) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }
  const pattern = originToMatchPattern(origin)
  if (pattern === null) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }

  let granted = false
  try {
    granted = (await chromeApi.permissions.contains({ origins: [pattern] })) === true
  } catch {
    return failure(
      'PERMISSION_UNREADABLE',
      'Site access could not be read. Reopen the popup and try again.',
      { granted: false }
    )
  }
  if (!granted) {
    return { ok: true, granted: false, registered: false, injected: false, reason: 'NOT_GRANTED' }
  }

  // A site the user turned off stays off until an explicit enable, even though
  // the broad host grant covers it.
  try {
    const settings = await readCaptureSettings(chromeApi)
    if (
      Array.isArray(settings.excludedOrigins) &&
      settings.excludedOrigins.includes(origin)
    ) {
      return {
        ok: true,
        granted: false,
        registered: false,
        injected: false,
        reason: 'EXCLUDED'
      }
    }
  } catch {
    // Without settings the overlay stays on, exactly like the content script.
  }

  return enableOverlayForTab(chromeApi, origin, tabId)
}

async function registrationIsAbsent(chromeApi, registration) {
  try {
    const stored = await chromeApi.scripting.getRegisteredContentScripts({
      ids: [registration.id]
    })
    return Array.isArray(stored) && stored.length === 0
  } catch {
    return false
  }
}

/**
 * Remove the exact-origin registration and verify it is really gone. A
 * concurrent permissions.onRemoved handler may have removed it first, which is
 * success rather than failure.
 */
async function removeRegistration(chromeApi, origin) {
  const registration = overlayRegistrationForOrigin(origin)
  if (registration === null) return false
  try {
    await chromeApi.scripting.unregisterContentScripts({ ids: [registration.id] })
  } catch {
    // It may already be gone; verification below decides the truth.
  }
  return registrationIsAbsent(chromeApi, registration)
}

/** Remove the exact pattern and verify the grant is really gone. */
async function removePermission(chromeApi, pattern) {
  try {
    await chromeApi.permissions.remove({ origins: [pattern] })
  } catch {
    // Verification below decides the truth instead of trusting the return value.
  }
  try {
    return (await chromeApi.permissions.contains({ origins: [pattern] })) !== true
  } catch {
    return false
  }
}

/**
 * True when the broad http/https access is a required manifest permission. The
 * all-sites switch is always on, so such a grant cannot be revoked; a per-site
 * "off" then means excluding the origin instead.
 */
async function broadHostsRequired(chromeApi) {
  try {
    const manifest = chromeApi.runtime.getManifest()
    const hosts = Array.isArray(manifest && manifest.host_permissions)
      ? manifest.host_permissions
      : []
    return OVERLAY_ALL_SITES_MATCHES.every((pattern) => hosts.includes(pattern))
  } catch {
    return false
  }
}

/** Add or remove one origin in the excluded list and report whether it stuck. */
async function setOriginExcluded(chromeApi, origin, excluded) {
  try {
    const settings = await readCaptureSettings(chromeApi)
    const current = Array.isArray(settings.excludedOrigins)
      ? settings.excludedOrigins
      : []
    const next = current.filter((value) => value !== origin)
    if (excluded) next.push(origin)
    if (next.length === current.length && !excluded) return true
    settings.excludedOrigins = next
    return await writeCaptureSettings(chromeApi, settings)
  } catch {
    return false
  }
}

/**
 * True only when disable actually verified both removals. The popup uses this
 * instead of treating a resolved message as success.
 */
export function overlayRemovalConfirmed(result) {
  return Boolean(
    result &&
      result.ok === true &&
      result.registrationRemoved === true &&
      result.permissionRemoved === true
  )
}

function disableFailure(registrationRemoved, permissionRemoved, notification) {
  const parts = []
  parts.push(
    permissionRemoved
      ? 'site access was removed'
      : 'site access is still granted or could not be verified'
  )
  parts.push(
    registrationRemoved
      ? 'the saved overlay registration was removed'
      : 'the saved overlay registration is still present or could not be verified'
  )
  return failure(
    'OVERLAY_DISABLE_INCOMPLETE',
    `The overlay did not fully turn off: ${parts.join('; ')}. Reload the page, then rerun Turn off; if it still fails, remove site access for this origin in the browser's extension settings.`,
    {
      granted: !permissionRemoved,
      registered: !registrationRemoved,
      registrationRemoved,
      permissionRemoved,
      notifiedTabs: notification.notified,
      failedNotifications: notification.failed
    }
  )
}

/** Remove the grant, the persistent registration and the in-page overlay. */
export async function disableOverlayForOrigin(chromeApi, origin, tabId) {
  if (!isExactOrigin(origin)) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }
  const pattern = originToMatchPattern(origin)
  if (pattern === null) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }

  const tabIds = new Set()
  if (Number.isInteger(tabId) && tabId >= 0) tabIds.add(tabId)

  // Collect same-origin tabs while the exact host grant is still present, so
  // already-open pages remove the overlay immediately. This does not require
  // the "tabs" permission; the granted origin pattern is used.
  try {
    const tabs = await chromeApi.tabs.query({ url: pattern })
    for (const tab of tabs) {
      if (Number.isInteger(tab.id) && tab.id >= 0) tabIds.add(tab.id)
    }
  } catch {
    // The active tab and any tracked tabs are still notified below.
  }

  // Tabs remembered from enable/sync/ready messages cover cases where the
  // query above cannot see a tab.
  const tracked = await readTrackedTabs(chromeApi)
  for (const knownTabId of tracked[origin] ?? []) tabIds.add(knownTabId)

  const registrationRemoved = await removeRegistration(chromeApi, origin)
  // Site access is granted at install for every http/https site, so the exact
  // pattern cannot be revoked. Turning the overlay off for one site then means
  // excluding its origin from the always-on registration.
  const permissionRemoved = await removePermission(chromeApi, pattern)
  const excluded =
    permissionRemoved || !(await broadHostsRequired(chromeApi))
      ? false
      : await setOriginExcluded(chromeApi, origin, true)
  const siteOff = permissionRemoved || excluded

  await clearPendingEnable(chromeApi)

  // Best effort: removing the registration affects future loads only, so
  // existing documents need this explicit teardown. The message carries the
  // exact origin, and the content script ignores it on any other origin.
  const notification = await notifyOverlayDisabled(chromeApi, tabIds, origin)
  await forgetOverlayOriginTabs(chromeApi, origin)

  if (!registrationRemoved || !siteOff) {
    return disableFailure(registrationRemoved, siteOff, notification)
  }

  return {
    ok: true,
    granted: false,
    registered: false,
    injected: false,
    registrationRemoved: true,
    permissionRemoved: siteOff,
    excluded,
    notifiedTabs: notification.notified,
    failedNotifications: notification.failed
  }
}

export async function rememberPendingEnable(chromeApi, origin, tabId) {
  if (!isExactOrigin(origin)) return false
  const session = sessionStorage(chromeApi)
  if (session === null) return false
  try {
    await session.set({
      [OVERLAY_PENDING_STORAGE_KEY]: {
        origin,
        tabId: Number.isInteger(tabId) && tabId >= 0 ? tabId : null,
        createdAt: Date.now()
      }
    })
    return true
  } catch {
    return false
  }
}

export async function clearPendingEnable(chromeApi) {
  const session = sessionStorage(chromeApi)
  if (session === null) return false
  try {
    await session.remove(OVERLAY_PENDING_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export async function readPendingEnable(chromeApi, now = Date.now()) {
  const session = sessionStorage(chromeApi)
  if (session === null) return null
  try {
    const stored = await session.get(OVERLAY_PENDING_STORAGE_KEY)
    const pending = stored && stored[OVERLAY_PENDING_STORAGE_KEY]
    if (!pending || !isExactOrigin(pending.origin)) return null
    if (
      typeof pending.createdAt !== 'number' ||
      now - pending.createdAt > OVERLAY_PENDING_TTL_MS
    ) {
      await clearPendingEnable(chromeApi)
      return null
    }
    return {
      origin: pending.origin,
      tabId: Number.isInteger(pending.tabId) ? pending.tabId : null,
      createdAt: pending.createdAt
    }
  } catch {
    return null
  }
}

/**
 * A permission prompt closes the action popup in at least Helium/Chromium 156,
 * so the popup cannot run the follow-up enable message. The popup records the
 * exact origin/tab before requesting; this listener finishes the job when the
 * grant arrives. Returns the enable result, or null when there was no matching
 * pending request.
 */
export async function handlePermissionsAdded(chromeApi, permissions) {
  const pending = await readPendingEnable(chromeApi)
  if (pending === null) return null

  const added = Array.isArray(permissions && permissions.origins)
    ? permissions.origins
    : []
  const pattern = originToMatchPattern(pending.origin)
  if (pattern === null || !added.includes(pattern)) return null

  await clearPendingEnable(chromeApi)
  return enableOverlayForTab(chromeApi, pending.origin, pending.tabId)
}

/**
 * A content script announces itself after injection or a reload. The sender's
 * tab is tracked for external-revoke teardown. If the grant is already gone
 * (revoked just before the message arrived), tear this document down now
 * instead of waiting for an event that already happened.
 */
export async function handleOverlayReady(chromeApi, message, sender) {
  const origin =
    message && typeof message.origin === 'string' ? message.origin : null
  if (!isExactOrigin(origin)) return false
  if (!sender || !sender.tab || sender.frameId !== 0) return false

  const tabId = sender.tab.id
  if (!Number.isInteger(tabId) || tabId < 0) return false

  // sender.tab.url is normally available from the exact-origin grant. If it is
  // hidden, the message still comes from our isolated-world content script,
  // which only sends its own location.origin.
  const senderUrl = sender.tab.url
  if (typeof senderUrl === 'string' && originFromUrl(senderUrl) !== origin) {
    return false
  }

  const pattern = originToMatchPattern(origin)
  if (pattern === null) return false

  let granted = false
  try {
    granted = (await chromeApi.permissions.contains({ origins: [pattern] })) === true
  } catch {
    granted = false
  }

  // In all-sites mode the broad grant covers this origin, and an excluded site
  // must never run the overlay.
  if (!granted && (await allSitesOverlayActive(chromeApi))) {
    let excluded = false
    try {
      const settings = await readCaptureSettings(chromeApi)
      excluded = isExcludedOrigin(settings, origin)
    } catch {
      excluded = false
    }
    if (!excluded) return rememberOverlayTab(chromeApi, origin, tabId)
  }

  if (!granted) {
    await notifyOverlayDisabled(chromeApi, [tabId], origin)
    await forgetOverlayTab(chromeApi, tabId)
    return false
  }

  return rememberOverlayTab(chromeApi, origin, tabId)
}

/**
 * Revoking access outside the popup must remove the registration and tear down
 * the already-running overlay. Chrome does not make same-origin tabs queryable
 * after the grant is gone (a `tabs.query({url})` filter needs `tabs` or a
 * matching host grant), and this extension deliberately has neither. The
 * session-only tab map recorded by enable/sync/ready messages is therefore the
 * exact-origin-safe way to reach existing documents. The message carries the
 * origin, so a reused tab id can never tear down another site's overlay.
 */
export async function handlePermissionsRemoved(chromeApi, permissions) {
  const removed = Array.isArray(permissions && permissions.origins)
    ? permissions.origins
    : []
  if (removed.length === 0) return []

  // Revoking the broad host grant turns all-sites mode off: remove the one
  // broad registration and stop there (no per-origin grant was revoked).
  if (removed.some((pattern) => OVERLAY_ALL_SITES_MATCHES.includes(pattern))) {
    await removeAllSitesRegistration(chromeApi)
    // Per-origin grants are untouched, so their registrations and overlays
    // stay; only the broad registration goes away.
    return []
  }

  const origins = new Set()
  for (const pattern of removed) {
    const origin = matchPatternToOrigin(pattern)
    if (origin !== null) origins.add(origin)
  }
  if (origins.size === 0) return []

  try {
    const registrations = await chromeApi.scripting.getRegisteredContentScripts()
    for (const registration of registrations) {
      const origin = overlayOriginFromRegistration(registration)
      if (origin !== null && origins.has(origin)) {
        try {
          await chromeApi.scripting.unregisterContentScripts({ ids: [registration.id] })
        } catch {
          // It may already be gone.
        }
      }
    }
  } catch {
    // Best effort; startup reconciliation covers leftovers.
  }

  const tracked = await readTrackedTabs(chromeApi)
  for (const origin of origins) {
    await notifyOverlayDisabled(chromeApi, tracked[origin] ?? [], origin)
    await forgetOverlayOriginTabs(chromeApi, origin)
  }

  const pending = await readPendingEnable(chromeApi)
  if (pending !== null && origins.has(pending.origin)) {
    await clearPendingEnable(chromeApi)
  }

  return [...origins]
}

/**
 * Pure popup copy. "On" is only produced when both the persistent registration
 * and the verified injection are true; a bare host grant is never success.
 */
export function describeOverlayStatus(input) {
  const available = Boolean(input && input.available)
  const granted = Boolean(input && input.granted)
  const ready = Boolean(input && input.ready)
  const site =
    input && typeof input.site === 'string' && input.site.length > 0
      ? input.site
      : 'this site'
  // The browser shortcut is user-configurable. Callers that know the current
  // value pass it in; without one the copy points at the browser settings page
  // instead of naming a shortcut the user may not have.
  const shortcut =
    input &&
    typeof input.shortcut === 'string' &&
    input.shortcut.trim().length > 0
      ? input.shortcut.trim()
      : null

  if (!available) {
    return {
      state: 'unavailable',
      label: 'Unavailable',
      tone: 'error',
      hint: 'The video overlay works only on normal http:// or https:// pages. This page was not changed.'
    }
  }
  if (!granted) {
    return {
      state: 'off',
      label: 'Off',
      tone: 'off',
      hint: 'Optional. Adds a small DonDownload button when you hover a video on this site. Enabling asks for access to this exact origin only. Choose Analyze to see verified options and reported file sizes; a download is queued only when you pick one.'
    }
  }
  if (ready) {
    return {
      state: 'on',
      label: 'On',
      tone: 'on',
      hint: `Overlay is on for ${site}. A floating button follows the active playing video; a detected progressive source can be downloaded directly. ${
        shortcut === null
          ? 'Set a browser shortcut at chrome://extensions/shortcuts.'
          : `Press ${shortcut} to show or hide the overlay.`
      } Choose Analyze to see verified options and reported file sizes; a download is queued only when you pick one, and access stays limited to this exact origin.`
    }
  }
  return {
    state: 'attention',
    label: 'Not ready',
    tone: 'error',
    hint: `Site access is granted for ${site}, but this tab does not have the overlay yet. Reload the page, then open this popup again. Nothing else changed.`
  }
}
