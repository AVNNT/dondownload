/**
 * Renderer-only drag & drop routing. A dropped URL is treated as a media page
 * only when it looks like one; everything else goes to the direct-link form.
 * The Add dialog is the only consumer, so nothing is queued implicitly.
 */

const MEDIA_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'streamable.com',
  'kick.com',
  'archive.org',
  'soundcloud.com',
  'bandcamp.com'
]

const MEDIA_PATH = /\/(?:watch|video|videos|reel|reels|clip|clips|shorts|embed|playlist|album|track)\//i

export type DroppedTarget = 'direct' | 'media'

export interface DroppedRoute {
  target: DroppedTarget
  url: string
}

const HTTP_URL = /^https?:\/\/\S+$/i
const EMBEDDED_URL = /https?:\/\/[^\s"'<>]+/i
const NON_WEB_SCHEME = /^(?:data|blob|file|javascript|about):/i

/**
 * Payloads like `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg">`
 * carry a URL-looking xlink/xmlns, which is never something the user dropped.
 * Markup and non-web schemes are ignored wholesale.
 */
function isIgnoredDragText(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  if (trimmed.startsWith('#')) return true
  if (NON_WEB_SCHEME.test(trimmed)) return true
  if (trimmed.startsWith('<') || /xmlns\s*=/i.test(trimmed)) return true
  return false
}

function normalizeHttpUrl(candidate: string): string | null {
  const raw = candidate.replace(/[),.;]+$/, '')
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

/**
 * A uri-list line is a URI, so it must *be* an HTTP(S) URL. URLs embedded in
 * surrounding prose or file-manager annotations are rejected.
 */
function urlFromUriListLine(line: string): string | null {
  const candidate = line.trim()
  if (isIgnoredDragText(candidate)) return null
  if (!HTTP_URL.test(candidate)) return null
  return normalizeHttpUrl(candidate)
}

/**
 * Plain text is often selected prose ("check this <url> out"), so a URL may be
 * extracted from it — but never from markup or script-ish payloads.
 */
function urlFromText(text: string): string | null {
  if (isIgnoredDragText(text)) return null
  const match = text.match(EMBEDDED_URL)
  if (!match) return null
  return normalizeHttpUrl(match[0])
}

/** Pull the first HTTP(S) URL out of uri-list/plain-text drop payloads. */
export function extractDroppedUrl(payload: {
  uriList?: string | null
  text?: string | null
}): string | null {
  if (payload.uriList) {
    for (const line of payload.uriList.split(/\r?\n/)) {
      const url = urlFromUriListLine(line)
      if (url) return url
    }
  }
  if (payload.text) {
    const url = urlFromText(payload.text.trim())
    if (url) return url
  }
  return null
}

/** Whether the drag currently in flight started inside the app window. */
export interface DragOriginState {
  internal: boolean
}

export const IDLE_DRAG_ORIGIN: DragOriginState = { internal: false }

export type DragOriginEvent = 'dragstart' | 'dragend' | 'drop'

/**
 * `dragstart` only reaches our window listeners for elements belonging to this
 * document, so any such drag is internal and its payload (logo, selected text,
 * table rows) must not feed the window drop zone. External drags from a browser
 * or another app never emit `dragstart` here.
 */
export function reduceDragOrigin(
  state: DragOriginState,
  event: DragOriginEvent
): DragOriginState {
  if (event === 'dragstart') return { internal: true }
  if (!state.internal) return state
  return IDLE_DRAG_ORIGIN
}

export function isLikelyMediaUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (MEDIA_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) {
    return true
  }
  if (/[?&]list=/i.test(parsed.search)) return true
  if (MEDIA_PATH.test(parsed.pathname)) return true
  return false
}

export function routeDroppedUrl(url: string): DroppedRoute | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return {
      target: isLikelyMediaUrl(url) ? 'media' : 'direct',
      url: parsed.href
    }
  } catch {
    return null
  }
}
