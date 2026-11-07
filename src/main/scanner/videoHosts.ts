/**
 * Shared video-host knowledge for the link scanner.
 *
 * yt-dlp resolves the hosts listed here, so the scanner has to answer two
 * different questions for a link:
 *
 *  - is the host a known video host at all (`isKnownVideoHost`)?
 *  - does this particular URL point at one single video
 *    (`isVideoHostVideoUrl`)?
 *
 * Hosts that publish listings, channels, models, categories and search pages
 * next to their videos carry an explicit single-video rule. For those hosts
 * only a matching URL counts as a video; everything else stays a plain page,
 * is never resolved by yt-dlp and is never followed. Hosts without a rule keep
 * the older, permissive behaviour.
 */

/** Registrable domains (and every subdomain) that yt-dlp can resolve. */
const KNOWN_VIDEO_DOMAINS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'twitch.tv',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'streamable.com',
  'rumble.com',
  'odysee.com',
  'bitchute.com',
  'kick.com',
  'x.com',
  'twitter.com',
  'bilibili.com',
  'nicovideo.jp',
  'archive.org',
  'soundcloud.com',
  'v.qq.com',
  'youku.com',
  'media.ccc.de',
  'hanime1.me',
  'pornhub.com',
  'eporner.com',
  'xvideos.com',
  'xnxx.com',
  'xhamster.com',
  'xhamster.desi',
  'xhamster2.com',
  'spankbang.com',
  'redtube.com',
  'youporn.com'
]

/** Opaque video/embed identifier. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{3,64}$/
/** Purely numeric video identifier. */
const NUMERIC_ID = /^\d{3,}$/

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function hasQueryValue(parsed: URL, key: string): boolean {
  const value = parsed.searchParams.get(key)
  return typeof value === 'string' && value.trim().length > 0
}

function pathOf(parsed: URL): string {
  return parsed.pathname.replace(/\/+$/, '')
}

function segmentsOf(parsed: URL): string[] {
  return parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

/** `https://www.pornhub.com/view_video.php?viewkey=ph5f1234abcd`, `/embed/<id>`. */
function isPornhubVideo(parsed: URL): boolean {
  if (/^\/view_video\.php$/i.test(pathOf(parsed))) {
    return hasQueryValue(parsed, 'viewkey')
  }
  const segments = segmentsOf(parsed)
  return (
    segments.length === 2 &&
    segments[0]!.toLowerCase() === 'embed' &&
    OPAQUE_ID.test(segments[1]!)
  )
}

/** `/video-<id>/<slug>`, `/hd-porn/<id>/<slug>`, `/embed/<id>`. */
function isEpornerVideo(parsed: URL): boolean {
  const segments = segmentsOf(parsed)
  const first = segments[0]
  if (first === undefined) return false
  if (/^video-[A-Za-z0-9]{4,32}$/.test(first)) return true
  const second = segments[1]
  if (second === undefined) return false
  const lower = first.toLowerCase()
  if (lower === 'hd-porn') return /^[A-Za-z0-9]{4,32}$/.test(second)
  return (
    lower === 'embed' &&
    segments.length === 2 &&
    /^[A-Za-z0-9]{4,32}$/.test(second)
  )
}

/** `/video<digits>/<slug>`, `/video.<id>/<slug>`. */
function isXvideosVideo(parsed: URL): boolean {
  const first = segmentsOf(parsed)[0]
  if (first === undefined) return false
  return /^video\d{3,}$/i.test(first) || /^video\.[A-Za-z0-9]{3,}$/i.test(first)
}

/** `/video-<id>/<slug>`. */
function isXnxxVideo(parsed: URL): boolean {
  const first = segmentsOf(parsed)[0]
  if (first === undefined) return false
  return /^video-[A-Za-z0-9]{3,}$/i.test(first)
}

/** `/videos/<slug>-<id>`, `/embed/<id>`. */
function isXhamsterVideo(parsed: URL): boolean {
  const segments = segmentsOf(parsed)
  const first = segments[0]?.toLowerCase()
  const second = segments[1]
  if (first === undefined || second === undefined) return false
  if (first === 'videos') {
    // A listing such as `/videos/amateur` has no trailing video id.
    const match = /-([A-Za-z0-9]{4,20})$/.exec(second)
    return match !== null && /[A-Za-z]/.test(match[1]!)
  }
  return first === 'embed' && segments.length === 2 && OPAQUE_ID.test(second)
}

/** `/<id>/video/<slug>`, `/<id>/embed/`. */
function isSpankbangVideo(parsed: URL): boolean {
  const segments = segmentsOf(parsed)
  const first = segments[0]
  const second = segments[1]?.toLowerCase()
  if (first === undefined || second === undefined) return false
  if (!/^[A-Za-z0-9]{4,20}$/.test(first)) return false
  return second === 'video' || second === 'embed'
}

/** `/<digits>`. */
function isRedtubeVideo(parsed: URL): boolean {
  const segments = segmentsOf(parsed)
  const first = segments[0]
  if (first === undefined || segments.length > 2) return false
  return /^\d{4,}$/.test(first)
}

/** `/watch/<digits>/<slug>`. */
function isYoupornVideo(parsed: URL): boolean {
  const segments = segmentsOf(parsed)
  const first = segments[0]?.toLowerCase()
  const second = segments[1]
  if (first === undefined || second === undefined) return false
  return first === 'watch' && NUMERIC_ID.test(second)
}

/** `/watch?v=<id>`. */
function isHanime1Video(parsed: URL): boolean {
  return /^\/watch$/i.test(pathOf(parsed)) && hasQueryValue(parsed, 'v')
}

/** `/<user>/status/<id>`, `/i/web/status/<id>`. */
function isTwitterStatus(parsed: URL): boolean {
  const segments = segmentsOf(parsed)
  const first = segments[0]?.toLowerCase()
  if (first === undefined) return false
  if (first === 'i') {
    return (
      segments[1]?.toLowerCase() === 'web' &&
      segments[2]?.toLowerCase() === 'status' &&
      NUMERIC_ID.test(segments[3] ?? '')
    )
  }
  return (
    segments[1]?.toLowerCase() === 'status' && NUMERIC_ID.test(segments[2] ?? '')
  )
}

/**
 * Hosts whose site mixes single videos with listings and hubs. A URL on one of
 * these domains is a video only when its rule matches.
 */
const SINGLE_VIDEO_RULES: ReadonlyArray<
  readonly [domain: string, isVideo: (parsed: URL) => boolean]
> = [
  ['pornhub.com', isPornhubVideo],
  ['eporner.com', isEpornerVideo],
  ['xvideos.com', isXvideosVideo],
  ['xnxx.com', isXnxxVideo],
  ['xhamster.com', isXhamsterVideo],
  ['xhamster.desi', isXhamsterVideo],
  ['xhamster2.com', isXhamsterVideo],
  ['spankbang.com', isSpankbangVideo],
  ['redtube.com', isRedtubeVideo],
  ['youporn.com', isYoupornVideo],
  ['hanime1.me', isHanime1Video],
  ['x.com', isTwitterStatus],
  ['twitter.com', isTwitterStatus]
]

function parseHttpUrl(raw: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  return parsed
}

function singleVideoRuleFor(host: string): ((parsed: URL) => boolean) | null {
  for (const [domain, isVideo] of SINGLE_VIDEO_RULES) {
    if (isHostOrSubdomain(host, domain)) return isVideo
  }
  return null
}

/** True for a known video host or any of its subdomains. */
export function isKnownVideoHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host.length === 0) return false
  return KNOWN_VIDEO_DOMAINS.some((domain) => isHostOrSubdomain(host, domain))
}

/** True when this host only counts a rule-matching URL as a video. */
export function hasSingleVideoRules(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host.length === 0) return false
  return singleVideoRuleFor(host) !== null
}

/**
 * True when the URL is a single video page on a host that has an explicit
 * single-video rule. Hosts without a rule always answer false.
 */
export function isSingleVideoPageUrl(raw: string): boolean {
  const parsed = parseHttpUrl(raw)
  if (parsed === null) return false
  const rule = singleVideoRuleFor(normalizeHost(parsed.hostname))
  return rule !== null && rule(parsed)
}

/**
 * True when the URL is a single video on a known video host: either the host
 * has no rule (permissive) or the URL matches its single-video rule.
 */
export function isVideoHostVideoUrl(raw: string): boolean {
  const parsed = parseHttpUrl(raw)
  if (parsed === null) return false
  const host = normalizeHost(parsed.hostname)
  if (!isKnownVideoHost(host)) return false
  const rule = singleVideoRuleFor(host)
  return rule === null || rule(parsed)
}
