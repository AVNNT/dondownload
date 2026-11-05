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
  OVERLAY_CORE_FILE,
  OVERLAY_MESSAGE_TYPES,
  OVERLAY_UI_FILE,
  matchPatternToOrigin,
  originFromUrl,
  originToMatchPattern,
  overlayOriginFromRegistration,
  overlayRegistrationForOrigin
} from './site-policy.js'

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
  if (matches.length !== 1 || matches[0] !== expected.matches[0]) return false
  const js = Array.isArray(stored.js) ? stored.js : []
  return js.length === 2 && js[0] === expected.js[0] && js[1] === expected.js[1]
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

  if (!(await tabMatchesOrigin(chromeApi, tabId, origin))) {
    return {
      ok: true,
      granted: true,
      registered: true,
      injected: false,
      reason: 'ORIGIN_MISMATCH',
      message:
        'The overlay is registered for this site, but this tab is no longer on it. Reload the page to add the button.'
    }
  }

  // Track this tab for teardown after an external revoke. Best effort: a tab
  // that is closed immediately is pruned by tabs.onRemoved.
  await rememberOverlayTab(chromeApi, origin, tabId)

  try {
    await chromeApi.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [OVERLAY_CORE_FILE, OVERLAY_UI_FILE],
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
  const permissionRemoved = await removePermission(chromeApi, pattern)

  await clearPendingEnable(chromeApi)

  // Best effort: removing the registration affects future loads only, so
  // existing documents need this explicit teardown. The message carries the
  // exact origin, and the content script ignores it on any other origin.
  const notification = await notifyOverlayDisabled(chromeApi, tabIds, origin)
  await forgetOverlayOriginTabs(chromeApi, origin)

  if (!registrationRemoved || !permissionRemoved) {
    return disableFailure(registrationRemoved, permissionRemoved, notification)
  }

  return {
    ok: true,
    granted: false,
    registered: false,
    injected: false,
    registrationRemoved: true,
    permissionRemoved: true,
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
    return false
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
      hint: `Overlay is on for ${site}. A floating button follows the active playing video; a detected progressive source can be downloaded directly. Set a browser shortcut at chrome://extensions/shortcuts. Access stays limited to this exact origin.`
    }
  }
  return {
    state: 'attention',
    label: 'Not ready',
    tone: 'error',
    hint: `Site access is granted for ${site}, but this tab does not have the overlay yet. Reload the page, then open this popup again. Nothing else changed.`
  }
}
