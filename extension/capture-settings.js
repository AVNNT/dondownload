// Persistent user preferences and short-lived automatic hand-off bookkeeping.
// Settings are cosmetic/user choices; processed download IDs use storage.session
// so a suspended MV3 worker still sees them after it wakes.

import { originFromPageUrl } from './handoff-policy.js'

export const CAPTURE_SETTINGS_KEY = 'dondownloadCaptureSettings'
export const HANDOFF_STATE_KEY = 'dondownloadHandoffState'
export const OPTIONS_TARGET_KEY = 'dondownloadOptionsTarget'
export const MAX_HANDOFF_IDS = 300
export const MAX_EXCLUDED_ORIGINS = 100

export const DEFAULT_CAPTURE_SETTINGS = Object.freeze({
  floatingTriggerEnabled: true,
  automaticFileHandoff: false,
  handoffNotifications: true,
  excludedOrigins: []
})

function storageArea(chromeApi, area) {
  const storage = chromeApi && chromeApi.storage
  return storage && storage[area] ? storage[area] : null
}

export function normalizeCaptureSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const excludedOrigins = []
  if (Array.isArray(source.excludedOrigins)) {
    for (const candidate of source.excludedOrigins) {
      const origin = originFromPageUrl(candidate)
      if (origin === null || excludedOrigins.includes(origin)) continue
      excludedOrigins.push(origin)
      if (excludedOrigins.length >= MAX_EXCLUDED_ORIGINS) break
    }
  }
  return {
    floatingTriggerEnabled:
      source.floatingTriggerEnabled !== false,
    automaticFileHandoff: source.automaticFileHandoff === true,
    handoffNotifications: source.handoffNotifications !== false,
    excludedOrigins
  }
}

export async function readCaptureSettings(chromeApi) {
  const local = storageArea(chromeApi, 'local')
  if (local === null) return { ...DEFAULT_CAPTURE_SETTINGS, excludedOrigins: [] }
  try {
    const stored = await local.get(CAPTURE_SETTINGS_KEY)
    return normalizeCaptureSettings(stored && stored[CAPTURE_SETTINGS_KEY])
  } catch {
    return { ...DEFAULT_CAPTURE_SETTINGS, excludedOrigins: [] }
  }
}

export async function writeCaptureSettings(chromeApi, value) {
  const local = storageArea(chromeApi, 'local')
  if (local === null) return false
  try {
    await local.set({ [CAPTURE_SETTINGS_KEY]: normalizeCaptureSettings(value) })
    return true
  } catch {
    return false
  }
}

export async function readHandoffState(chromeApi) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) throw new Error('Session storage is unavailable.')
  const stored = await session.get(HANDOFF_STATE_KEY)
  return normalizeHandoffState(stored && stored[HANDOFF_STATE_KEY])
}

export function normalizeHandoffState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}

  function ids(input) {
    const result = []
    if (!Array.isArray(input)) return result
    for (const candidate of input) {
      if (
        Number.isSafeInteger(candidate) &&
        candidate > 0 &&
        !result.includes(candidate)
      ) {
        result.push(candidate)
      }
      if (result.length >= MAX_HANDOFF_IDS) break
    }
    return result
  }

  return {
    processed: ids(source.processed),
    pending: ids(source.pending)
  }
}

async function writeHandoffState(chromeApi, state) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return false
  try {
    await session.set({ [HANDOFF_STATE_KEY]: normalizeHandoffState(state) })
    return true
  } catch {
    return false
  }
}

/**
 * Reserve one browser download before any native call. If this cannot be
 * persisted, the caller must leave the browser download alone: without the
 * session record a respawned worker could hand off the same ID twice.
 */
const stateWrites = new WeakMap()

function updateHandoffState(chromeApi, update, fallback) {
  const previous = stateWrites.get(chromeApi) || Promise.resolve()
  const next = previous.catch(() => undefined).then(update).catch(() => fallback)
  stateWrites.set(chromeApi, next)
  return next
}

export function claimHandoffDownload(chromeApi, downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 1) {
    return Promise.resolve({ ok: false, reason: 'invalid-id' })
  }
  return updateHandoffState(chromeApi, async () => {
    const state = await readHandoffState(chromeApi)
    if (state.processed.includes(downloadId) || state.pending.includes(downloadId)) {
      return { ok: false, reason: 'duplicate' }
    }
    if (state.pending.length >= MAX_HANDOFF_IDS) {
      return { ok: false, reason: 'capacity' }
    }
    state.pending.push(downloadId)
    if (!(await writeHandoffState(chromeApi, state))) {
      return { ok: false, reason: 'storage-unavailable' }
    }
    return { ok: true }
  }, { ok: false, reason: 'storage-unavailable' })
}

/**
 * Mark an ID processed, optionally with an outcome. A failed write leaves the
 * pending reservation in place, which deliberately prevents retrying an
 * uncertain hand-off after the worker suspends.
 */
export function finishHandoffDownload(chromeApi, downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 1) return Promise.resolve(false)
  return updateHandoffState(chromeApi, async () => {
    const state = await readHandoffState(chromeApi)
    state.pending = state.pending.filter((id) => id !== downloadId)
    state.processed = [...state.processed.filter((id) => id !== downloadId), downloadId].slice(
      -MAX_HANDOFF_IDS
    )
    return writeHandoffState(chromeApi, state)
  }, false)
}

export async function rememberOptionsTarget(chromeApi, target) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return false
  const tabId =
    target && Number.isInteger(target.tabId) && target.tabId >= 0
      ? target.tabId
      : null
  const origin = originFromPageUrl(target && target.origin)
  if (tabId === null || origin === null) return false
  try {
    await session.set({ [OPTIONS_TARGET_KEY]: { tabId, origin } })
    return true
  } catch {
    return false
  }
}

export async function readOptionsTarget(chromeApi) {
  const session = storageArea(chromeApi, 'session')
  if (session === null) return null
  try {
    const stored = await session.get(OPTIONS_TARGET_KEY)
    const target = stored && stored[OPTIONS_TARGET_KEY]
    if (!target || !Number.isInteger(target.tabId) || target.tabId < 0) return null
    const origin = originFromPageUrl(target.origin)
    if (origin === null) return null
    return { tabId: target.tabId, origin }
  } catch {
    return null
  }
}
