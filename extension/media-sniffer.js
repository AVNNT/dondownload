// NDM-style media sniffing for sites the user explicitly enabled.
//
// The background worker observes completed response headers through the
// optional webRequest permission. It classifies a response as media from its
// Content-Type or a conservative file extension, keeps one bounded per-tab
// list, collapses range requests, suppresses HLS/DASH segments, and treats a
// master playlist as the single entry for that stream (master preferred over a
// variant/media playlist).
//
// This module never reads request headers, cookies, bodies, DRM data or the
// page DOM. HLS master text is fetched without credentials (`credentials:
// 'omit'`) only to list variants; if that request fails the manifest is still
// listed with an unknown quality.
//
// Pure functions and the store are exported separately so the classification,
// grouping, manifest parsing and reset rules can be tested without Chrome.

export const MEDIA_SNIFFER_MESSAGE_TYPES = Object.freeze({
  QUERY: 'dondownload:sniffed-query',
  QUEUE: 'dondownload:sniffed-queue',
  CHANGED: 'dondownload:sniffed-changed'
})

export const MAX_SNIFFED_PER_TAB = 50
export const MIN_MEDIA_BYTES = 100 * 1024
export const MAX_HLS_VARIANTS = 20
export const MAX_HLS_TEXT_BYTES = 256 * 1024
export const MAX_MEDIA_URL_LENGTH = 4096

const PROGRESSIVE_EXTENSIONS = Object.freeze([
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'wav'
])

const SEGMENT_EXTENSIONS = Object.freeze(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa'])
const AUDIO_EXTENSIONS = Object.freeze([
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'wav'
])

// A deliberately small ad/tracker list: enough to keep common video-ad hosts
// out of the list without pretending to be a general ad blocker.
const AD_HOSTS = Object.freeze([
  '2mdn.net',
  'adnxs.com',
  'adsrvr.org',
  'criteo.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'outbrain.com',
  'scorecardresearch.com',
  'taboola.com'
])

// Range bookkeeping query parameters used by CDN range streaming. Removing
// them makes several range requests to the same resource collapse to one row.
const RANGE_ONLY_PARAMS = Object.freeze(['range', 'rn', 'rbuf'])

// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const CONTENT_TYPE_TOKEN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function hasExactKeys(record, required, optional = []) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) return false
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false
  }
  return true
}

function normalizeContentType(value) {
  if (typeof value !== 'string') return null
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mediaType.length === 0 || !CONTENT_TYPE_TOKEN.test(mediaType)) return null
  return mediaType
}

/** Canonical HTTP(S) URL with a fragment removed, or null. */
export function normalizeMediaUrl(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (
    raw.length === 0 ||
    raw.length > MAX_MEDIA_URL_LENGTH ||
    CONTROL_CHARACTERS.test(raw)
  ) {
    return null
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname || parsed.username || parsed.password) return null
  parsed.hash = ''
  return parsed.href
}

/**
 * Range requests to the same resource share this key. Only the documented
 * range bookkeeping parameters are removed; every other query value is kept.
 */
export function canonicalMediaUrl(value) {
  const normalized = normalizeMediaUrl(value)
  if (normalized === null) return null
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    return null
  }
  for (const name of RANGE_ONLY_PARAMS) parsed.searchParams.delete(name)
  return parsed.href
}

export function mediaExtension(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const match = /\.([a-z0-9]{2,5})$/i.exec(parsed.pathname)
  return match ? match[1].toLowerCase() : null
}

function hostMatches(host, candidate) {
  return host === candidate || host.endsWith(`.${candidate}`)
}

export function isAdvertisingHost(hostname) {
  if (typeof hostname !== 'string') return false
  const host = hostname.toLowerCase()
  return AD_HOSTS.some((candidate) => hostMatches(host, candidate))
}

/** YouTube SABR/range streams are not standalone files; YouTube uses yt-dlp. */
export function isGoogleVideoPlayback(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (
    hostMatches(parsed.hostname.toLowerCase(), 'googlevideo.com') &&
    /\/videoplayback$/i.test(parsed.pathname)
  )
}

function parseContentLength(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value.trim())) return null
  const length = Number(value.trim())
  return Number.isSafeInteger(length) && length > 0 ? length : null
}

export function parseContentRangeTotal(value) {
  if (typeof value !== 'string') return null
  const match = /^bytes\s+(\d{1,20})-(\d{1,20})\/(\d{1,20}|\*)$/i.exec(
    value.trim()
  )
  if (!match || match[3] === '*') return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= 0 ||
    end >= total
  ) {
    return null
  }
  return total
}

function basenameForUrl(value) {
  try {
    const pathname = new URL(value).pathname
    const segment = pathname.split('/').filter(Boolean).pop() ?? ''
    const decoded = decodeURIComponent(segment)
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    return decoded.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180)
  } catch {
    return ''
  }
}

function extensionForContentType(contentType) {
  if (contentType === 'video/mp4') return 'mp4'
  if (contentType === 'video/webm') return 'webm'
  if (contentType === 'video/quicktime') return 'mov'
  if (contentType === 'video/x-matroska') return 'mkv'
  if (contentType === 'audio/mpeg') return 'mp3'
  if (contentType === 'audio/mp4' || contentType === 'audio/x-m4a') return 'm4a'
  if (contentType === 'audio/aac') return 'aac'
  if (contentType === 'audio/ogg') return 'ogg'
  if (contentType === 'audio/opus') return 'opus'
  if (contentType === 'audio/flac' || contentType === 'audio/x-flac') return 'flac'
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') return 'wav'
  return null
}

export function guessMediaExtension(url, contentType) {
  const extension = mediaExtension(url)
  if (extension !== null && PROGRESSIVE_EXTENSIONS.includes(extension)) {
    return extension
  }
  return extensionForContentType(contentType)
}

function isAudioContentType(contentType) {
  return /^audio\//.test(contentType)
}

function isVideoContentType(contentType) {
  return /^video\//.test(contentType)
}

/**
 * Classify one response observation. Returns:
 *   null                       - not media
 *   { segment: true, ... }     - an HLS/DASH segment (never listed)
 *   { entry: {...} }           - a listable media entry
 */
export function classifyMediaResponse(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null
  const url = normalizeMediaUrl(input.url)
  if (url === null) return null

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (isAdvertisingHost(parsed.hostname)) return null
  if (isGoogleVideoPlayback(url)) return null
  if (
    typeof input.statusCode === 'number' &&
    (input.statusCode < 200 || input.statusCode >= 300) &&
    input.statusCode !== 304
  ) {
    return null
  }

  const key = canonicalMediaUrl(url)
  if (key === null) return null
  const contentType = normalizeContentType(input.contentType)
  const extension = mediaExtension(key)
  const isSegment =
    extension !== null && SEGMENT_EXTENSIONS.includes(extension)
  if (isSegment) {
    return {
      segment: true,
      url,
      key,
      sourceHost: parsed.hostname.toLowerCase(),
      observedAt: now
    }
  }

  let kind = null
  if (
    extension === 'm3u8' ||
    contentType === 'application/vnd.apple.mpegurl' ||
    contentType === 'application/x-mpegurl' ||
    contentType === 'application/mpegurl'
  ) {
    kind = 'hls'
  } else if (extension === 'mpd' || contentType === 'application/dash+xml') {
    kind = 'dash'
  } else if (
    (extension !== null && PROGRESSIVE_EXTENSIONS.includes(extension)) ||
    (contentType !== null &&
      (isAudioContentType(contentType) || isVideoContentType(contentType)))
  ) {
    kind = 'file'
  }
  if (kind === null) return null

  const contentRangeTotal = parseContentRangeTotal(input.contentRange)
  const contentLength = parseContentLength(input.contentLength)
  const sizeBytes =
    kind === 'file' ? contentRangeTotal ?? contentLength : null
  if (kind === 'file' && sizeBytes !== null && sizeBytes < MIN_MEDIA_BYTES) {
    return null
  }

  const filename =
    basenameForUrl(key) ||
    (kind === 'hls' ? 'playlist.m3u8' : kind === 'dash' ? 'manifest.mpd' : 'media')
  const audioOnly =
    extension !== null && AUDIO_EXTENSIONS.includes(extension)
      ? true
      : contentType !== null
        ? isAudioContentType(contentType)
        : false

  return {
    entry: {
      key,
      // Canonical URL: range bookkeeping params are not part of the identity or
      // the visible/downloadable URL.
      url: key,
      kind,
      contentType,
      sizeBytes,
      filename,
      extension: guessMediaExtension(key, contentType),
      audioOnly,
      sourceHost: parsed.hostname.toLowerCase(),
      pageHost: null,
      pageUrl: null,
      title: null,
      variants: [],
      active: kind !== 'file',
      firstSeenAt: now,
      lastSeenAt: now
    }
  }
}

/**
 * Parse an HLS playlist. A master playlist has `#EXT-X-STREAM-INF` entries and
 * wins over a variant/media playlist; `isMediaPlaylist` lets the store suppress
 * a variant that is already part of a known master.
 */
export function parseHlsMaster(text, baseUrl) {
  const result = {
    isMaster: false,
    isMediaPlaylist: false,
    variants: []
  }
  if (typeof text !== 'string' || text.length === 0) return result
  const bounded = text.slice(0, MAX_HLS_TEXT_BYTES)
  const lines = bounded.split(/\r?\n/)
  let pending = null

  const parseAttributes = (line) => {
    const attributes = {}
    const body = line.slice(line.indexOf(':') + 1)
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi
    let match
    while ((match = pattern.exec(body)) !== null) {
      attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '')
    }
    return attributes
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line)
      continue
    }
    if (line.length === 0 || line.startsWith('#')) continue
    if (pending === null) continue

    let variantUrl = null
    try {
      const resolved = new URL(line, baseUrl)
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        variantUrl = resolved.href
      }
    } catch {
      variantUrl = null
    }
    if (variantUrl !== null) {
      const bandwidth = Number(pending.BANDWIDTH)
      const resolution = /^(\d{1,5})x(\d{1,5})$/i.exec(pending.RESOLUTION || '')
      const width = resolution ? Number(resolution[1]) : null
      const height = resolution ? Number(resolution[2]) : null
      const label =
        width !== null && height !== null && width > 0 && height > 0
          ? `${height}p`
          : Number.isFinite(bandwidth) && bandwidth > 0
            ? `${Math.round(bandwidth / 1000)} kbps`
            : null
      result.variants.push({
        url: variantUrl,
        width: width !== null && width > 0 ? width : null,
        height: height !== null && height > 0 ? height : null,
        bandwidth:
          Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null,
        label,
        name:
          typeof pending.NAME === 'string' && pending.NAME.length > 0
            ? pending.NAME.slice(0, 80)
            : null
      })
      result.isMaster = true
    }
    pending = null
    if (result.variants.length >= MAX_HLS_VARIANTS) break
  }

  if (result.isMaster) {
    result.variants.sort((left, right) => {
      const leftHeight = left.height ?? 0
      const rightHeight = right.height ?? 0
      if (rightHeight !== leftHeight) return rightHeight - leftHeight
      return (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
    })
    return result
  }
  result.isMediaPlaylist = /#EXTINF:/.test(bounded)
  return result
}

function cloneEntry(entry) {
  return {
    ...entry,
    variants: entry.variants.map((variant) => ({ ...variant }))
  }
}

/**
 * Bounded per-tab store. Entries live in memory only for the service-worker
 * generation and are cleared on a top-level navigation (with a timestamp
 * variant that keeps responses already seen for the new URL).
 */
export function createMediaSnifferStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maximumPerTab =
    Number.isSafeInteger(options.maximumPerTab) && options.maximumPerTab > 0
      ? options.maximumPerTab
      : MAX_SNIFFED_PER_TAB
  const tabs = new Map()

  function tabState(tabId) {
    let state = tabs.get(tabId)
    if (!state) {
      state = { entries: new Map(), pageTitle: null, pageUrl: null }
      tabs.set(tabId, state)
    }
    return state
  }

  function trim(state) {
    while (state.entries.size > maximumPerTab) {
      let victim = null
      for (const [key, entry] of state.entries) {
        if (victim === null) {
          victim = { key, entry }
          continue
        }
        const victimScore = victim.entry.active ? 1 : 0
        const score = entry.active ? 1 : 0
        if (
          score < victimScore ||
          (score === victimScore &&
            entry.lastSeenAt < victim.entry.lastSeenAt)
        ) {
          victim = { key, entry }
        }
      }
      if (victim === null) break
      state.entries.delete(victim.key)
    }
  }

  function findMasterForVariant(state, variantKey) {
    for (const entry of state.entries.values()) {
      if (entry.kind !== 'hls' || entry.variants.length === 0) continue
      if (
        entry.variants.some(
          (variant) => canonicalMediaUrl(variant.url) === variantKey
        )
      ) {
        return entry
      }
    }
    return null
  }

  function record(tabId, pageUrl, pageTitle, entry, manifestInfo, at = now()) {
    if (!Number.isInteger(tabId) || tabId < 0 || !entry) return null
    const state = tabState(tabId)
    state.pageUrl = pageUrl
    if (typeof pageTitle === 'string' && pageTitle.trim().length > 0) {
      state.pageTitle = pageTitle.trim().slice(0, 500)
    }
    if (entry.pageUrl === null) entry.pageUrl = pageUrl
    if (entry.pageHost === null) {
      try {
        entry.pageHost = new URL(pageUrl).hostname.toLowerCase()
      } catch {
        entry.pageHost = null
      }
    }
    if (entry.title === null) entry.title = state.pageTitle

    const key = entry.key
    entry.lastSeenAt = at

    if (entry.kind === 'hls' && manifestInfo) {
      if (manifestInfo.isMaster === true) {
        entry.variants = (manifestInfo.variants || []).map((variant) => ({
          ...variant
        }))
        entry.active = true
        for (const variant of entry.variants) {
          const variantKey = canonicalMediaUrl(variant.url)
          if (variantKey !== null && variantKey !== key) {
            state.entries.delete(variantKey)
          }
        }
      } else if (manifestInfo.isMediaPlaylist === true) {
        const master = findMasterForVariant(state, key)
        if (master) {
          // The master already represents this variant; never add a second row.
          master.active = true
          master.lastSeenAt = at
          return cloneEntry(master)
        }
      }
    }

    const existing = state.entries.get(key)
    if (existing) {
      if (entry.kind !== 'file' || entry.sizeBytes !== null) {
        existing.sizeBytes = entry.sizeBytes
      }
      existing.contentType = entry.contentType ?? existing.contentType
      existing.active = existing.active || entry.active
      existing.lastSeenAt = at
      if (entry.title !== null) existing.title = entry.title
      if (entry.variants.length > 0) existing.variants = entry.variants
      existing.audioOnly = existing.audioOnly || entry.audioOnly
      trim(state)
      return cloneEntry(existing)
    }

    state.entries.set(key, cloneEntry(entry))
    trim(state)
    return cloneEntry(entry)
  }

  /** Segments are never listed; they only prove an HLS stream is active. */
  function markSegment(tabId, sourceHost, at = now()) {
    const state = tabs.get(tabId)
    if (!state) return false
    let changed = false
    for (const entry of state.entries.values()) {
      if (entry.kind !== 'hls') continue
      if (
        sourceHost &&
        entry.sourceHost &&
        entry.sourceHost !== sourceHost
      ) {
        continue
      }
      entry.active = true
      entry.lastSeenAt = at
      changed = true
    }
    return changed
  }

  function setPageTitle(tabId, pageTitle) {
    const state = tabs.get(tabId)
    if (!state || typeof pageTitle !== 'string' || pageTitle.trim().length === 0) {
      return
    }
    state.pageTitle = pageTitle.trim().slice(0, 500)
    for (const entry of state.entries.values()) {
      if (entry.title === null) entry.title = state.pageTitle
    }
  }

  function list(tabId) {
    const state = tabs.get(tabId)
    if (!state) return []
    return [...state.entries.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map(cloneEntry)
  }

  function get(tabId, rawUrl) {
    const state = tabs.get(tabId)
    if (!state) return null
    const key = canonicalMediaUrl(rawUrl)
    if (key === null) return null
    const entry = state.entries.get(key)
    return entry ? cloneEntry(entry) : null
  }

  function count(tabId) {
    const state = tabs.get(tabId)
    return state ? state.entries.size : 0
  }

  function clearTab(tabId) {
    if (!Number.isInteger(tabId)) {
      tabs.clear()
      return
    }
    tabs.delete(tabId)
  }

  /**
   * SPA/history navigation: drop everything older than the URL change while
   * keeping an entry that a racing response already recorded for the new URL.
   */
  function clearBefore(tabId, timestamp) {
    const state = tabs.get(tabId)
    if (!state) return
    for (const [key, entry] of state.entries) {
      if (entry.lastSeenAt < timestamp) state.entries.delete(key)
    }
  }

  function clearAll() {
    tabs.clear()
  }

  return {
    record,
    markSegment,
    setPageTitle,
    list,
    get,
    count,
    clearTab,
    clearBefore,
    clearAll
  }
}

/**
 * Background listener installation. Authorization is supplied by the caller
 * because it owns settings/permission reads. `authorizeTab(tabId, pageUrl)`
 * must return true only for an enabled site (or the explicit all-sites mode).
 */
export function installMediaSniffer(chromeApi, options = {}) {
  const store =
    options.store && typeof options.store.record === 'function'
      ? options.store
      : createMediaSnifferStore()
  const authorizeTab =
    typeof options.authorizeTab === 'function' ? options.authorizeTab : null
  const onChange =
    typeof options.onChange === 'function' ? options.onChange : null
  const fetchImpl =
    typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  let enabled = false
  let permissionGranted = false
  let installed = false
  const manifestCache = new Map()

  async function fetchManifestInfo(url) {
    const key = canonicalMediaUrl(url) ?? url
    if (manifestCache.has(key)) return manifestCache.get(key)
    const task = (async () => {
      if (typeof fetchImpl !== 'function') {
        return { isMaster: false, isMediaPlaylist: false, variants: [] }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      try {
        const response = await fetchImpl(url, {
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal
        })
        if (!response || response.ok !== true) {
          return { isMaster: false, isMediaPlaylist: false, variants: [] }
        }
        const text = (await response.text()).slice(0, MAX_HLS_TEXT_BYTES)
        const parsed = parseHlsMaster(text, response.url || url)
        return parsed
      } catch {
        return { isMaster: false, isMediaPlaylist: false, variants: [] }
      } finally {
        clearTimeout(timer)
      }
    })()
    manifestCache.set(key, task)
    if (manifestCache.size > 100) {
      const oldest = manifestCache.keys().next()
      if (!oldest.done) manifestCache.delete(oldest.value)
    }
    return task
  }

  async function handleHeaders(details) {
    if (!enabled || !permissionGranted || !authorizeTab) return
    if (!details || details.method !== 'GET') return
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return
    if (details.type === 'main_frame') return

    let tab
    try {
      tab = await chromeApi.tabs.get(details.tabId)
    } catch {
      return
    }
    const pageUrl = tab && typeof tab.url === 'string' ? tab.url : ''
    if (!/^https?:/i.test(pageUrl)) return
    let allowed = false
    try {
      allowed = (await authorizeTab(details.tabId, pageUrl)) === true
    } catch {
      allowed = false
    }
    if (!allowed) return

    const classified = classifyMediaResponse(
      {
        url: details.url,
        statusCode: details.statusCode,
        contentType: headerValue(details.responseHeaders, 'content-type'),
        contentRange: headerValue(details.responseHeaders, 'content-range'),
        contentLength: headerValue(details.responseHeaders, 'content-length')
      },
      now()
    )
    if (classified === null) return

    if (classified.segment === true) {
      if (store.markSegment(details.tabId, classified.sourceHost, now())) {
        notify(details.tabId)
      }
      return
    }

    let manifestInfo = null
    if (classified.entry.kind === 'hls') {
      manifestInfo = await fetchManifestInfo(classified.entry.url)
    }
    const before = store.count(details.tabId)
    store.record(
      details.tabId,
      pageUrl,
      tab && typeof tab.title === 'string' ? tab.title : null,
      classified.entry,
      manifestInfo,
      now()
    )
    if (store.count(details.tabId) !== before || manifestInfo !== null) {
      notify(details.tabId)
    }
  }

  function notify(tabId) {
    if (!onChange) return
    try {
      onChange(tabId)
    } catch {
      // Badge/UI feedback is best effort.
    }
  }

  function handleBeforeRequest(details) {
    if (!enabled || !permissionGranted) return
    if (!details || details.type !== 'main_frame') return
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return
    store.clearTab(details.tabId)
    manifestCache.clear()
    notify(details.tabId)
  }

  function install() {
    if (installed) return true
    const webRequest = chromeApi && chromeApi.webRequest
    if (
      !webRequest ||
      !webRequest.onHeadersReceived ||
      !webRequest.onBeforeRequest
    ) {
      return false
    }
    try {
      // `responseHeaders` only. Request headers and cookies are never exposed.
      webRequest.onHeadersReceived.addListener(
        (details) => {
          void handleHeaders(details).catch(() => undefined)
        },
        filter,
        ['responseHeaders']
      )
      webRequest.onBeforeRequest.addListener((details) => {
        handleBeforeRequest(details)
      }, filter)
      installed = true
      return true
    } catch {
      return false
    }
  }

  function handleTabUrlChanged(tabId, changedAt = now()) {
    if (!Number.isInteger(tabId) || tabId < 0) return
    store.clearBefore(tabId, changedAt)
    manifestCache.clear()
    notify(tabId)
  }

  return {
    store,
    install,
    handleTabUrlChanged,
    setEnabled(value) {
      enabled = value === true
    },
    setPermissionGranted(value) {
      permissionGranted = value === true
    },
    isEnabled() {
      return enabled && permissionGranted
    }
  }
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null
  for (const header of headers) {
    if (
      header &&
      typeof header.name === 'string' &&
      header.name.toLowerCase() === name &&
      typeof header.value === 'string'
    ) {
      return header.value
    }
  }
  return null
}

/** Public message shape (no internal fetch/cache data). */
export function sniffedEntryForMessage(entry) {
  if (!entry || typeof entry !== 'object') return null
  const url = normalizeMediaUrl(entry.url)
  if (url === null) return null
  const kind =
    entry.kind === 'hls' || entry.kind === 'dash' || entry.kind === 'file'
      ? entry.kind
      : null
  if (kind === null) return null
  const variants = Array.isArray(entry.variants)
    ? entry.variants
        .filter(
          (variant) =>
            variant &&
            normalizeMediaUrl(variant.url) !== null &&
            typeof variant.url === 'string'
        )
        .slice(0, MAX_HLS_VARIANTS)
        .map((variant, index) => ({
          id: `${entry.key ?? url}:${index}`,
          url: variant.url,
          label:
            typeof variant.label === 'string' ? variant.label.slice(0, 80) : null,
          width:
            Number.isSafeInteger(variant.width) && variant.width > 0
              ? variant.width
              : null,
          height:
            Number.isSafeInteger(variant.height) && variant.height > 0
              ? variant.height
              : null,
          bandwidth:
            Number.isSafeInteger(variant.bandwidth) && variant.bandwidth > 0
              ? variant.bandwidth
              : null
        }))
    : []
  return {
    key: typeof entry.key === 'string' ? entry.key : url,
    url,
    kind,
    contentType:
      typeof entry.contentType === 'string' ? entry.contentType : null,
    sizeBytes:
      Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0
        ? entry.sizeBytes
        : null,
    filename:
      typeof entry.filename === 'string' && entry.filename.length > 0
        ? entry.filename
        : 'media',
    title:
      typeof entry.title === 'string' && entry.title.length > 0
        ? entry.title
        : null,
    sourceHost:
      typeof entry.sourceHost === 'string' ? entry.sourceHost : null,
    audioOnly: entry.audioOnly === true,
    active: entry.active === true,
    variants
  }
}

function sanitizeFilenameBase(value, fallback) {
  const raw = typeof value === 'string' ? value : ''
  const cleaned = raw
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return fallback
  }
  return cleaned.slice(0, 120)
}

/**
 * Filename for a detected entry: sanitized title plus the real extension. No
 * URL id or opaque key is ever part of the visible name.
 */
export function sniffedFilename(entry, variantUrl = null) {
  const sourceUrl =
    typeof variantUrl === 'string' && variantUrl.length > 0
      ? variantUrl
      : entry && entry.url
  const contentType = entry && entry.contentType
  const extension = guessMediaExtension(sourceUrl, contentType) ||
    (entry && (entry.kind === 'hls' || entry.kind === 'dash') ? 'mp4' : 'mp4')
  const fallback =
    entry && typeof entry.filename === 'string' && entry.filename.length > 0
      ? entry.filename.replace(/\.[a-z0-9]{2,5}$/i, '')
      : 'media'
  const base = sanitizeFilenameBase(
    entry && typeof entry.title === 'string' ? entry.title : fallback,
    sanitizeFilenameBase(fallback, 'media')
  )
  return `${base}.${extension}`
}

/** Toolbar badge text for a detected-media count. */
export function formatBadgeCount(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}

export function normalizeSniffedQueueMessage(value) {
  if (
    !value ||
    value.type !== MEDIA_SNIFFER_MESSAGE_TYPES.QUEUE ||
    !hasExactKeys(value, ['type', 'url'], ['tabId', 'variantUrl'])
  ) {
    return failure('INVALID_MESSAGE', 'The detected media request is not valid.')
  }
  const url = normalizeMediaUrl(value.url)
  if (url === null) {
    return failure('INVALID_MESSAGE', 'The detected media URL is not valid.')
  }
  if (
    value.tabId !== undefined &&
    (!Number.isInteger(value.tabId) || value.tabId < 0)
  ) {
    return failure('INVALID_MESSAGE', 'The detected media tab is not valid.')
  }
  let variantUrl = null
  if (value.variantUrl !== undefined) {
    variantUrl = normalizeMediaUrl(value.variantUrl)
    if (variantUrl === null) {
      return failure('INVALID_MESSAGE', 'The selected variant URL is not valid.')
    }
  }
  return {
    ok: true,
    tabId: value.tabId,
    url,
    variantUrl
  }
}
