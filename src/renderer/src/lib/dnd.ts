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

/** Pull the first HTTP(S) URL out of uri-list/plain-text drop payloads. */
export function extractDroppedUrl(payload: {
  uriList?: string | null
  text?: string | null
}): string | null {
  const candidates: string[] = []
  if (payload.uriList) {
    candidates.push(
      ...payload.uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
    )
  }
  if (payload.text) candidates.push(payload.text.trim())

  for (const candidate of candidates) {
    const match = candidate.match(/https?:\/\/[^\s"'<>]+/i)
    if (!match) continue
    const raw = match[0].replace(/[),.;]+$/, '')
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      if (!parsed.hostname) continue
      return parsed.href
    } catch {
      // Try the next candidate.
    }
  }
  return null
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
