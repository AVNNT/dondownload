import { Parser } from 'htmlparser2'
import { isLikelyVideoPageUrl } from './classify'
import { resolveScanUrl } from './extract/url'

/**
 * Pure, bounded follow policy for phase 2 discovery.
 *
 * A page link is followed only when it is likely to contain video: an iframe
 * embed, a well-known yt-dlp video host, a conservative single-video path, or
 * a same-site video-looking link. Pagination, tag/category, login/account,
 * cart/share and playlist links are never followed.
 *
 * Discourse adds `rel="nofollow ugc"` to every link a user writes. `nofollow`
 * is therefore treated as a ranking hint (a lower score), not a hard block;
 * only links that already look like a video are followed at all.
 */

export const MAX_FOLLOW_CANDIDATES = 2000

const VIDEO_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
  'vimeo.com',
  'player.vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'twitch.tv',
  'clips.twitch.tv',
  'tiktok.com',
  'vm.tiktok.com',
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
  'www.hanime1.me'
])

/** Embeds that are never page content worth following. */
const BLOCKED_IFRAME_HOSTS = new Set([
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'google.com',
  'recaptcha.net',
  'disqus.com',
  'stripe.com',
  'paypal.com'
])

const VIDEO_PATH =
  /(?:^|\/)(?:watch|videos|video\d*|v|embed|player|clips|clip\d*|media|movies|movie\d*|episodes|episode\d*|streams|stream\d*|reels|reel\d*|shorts)(?:\/|$)/i
const VIDEO_TEXT =
  /\b(?:video|watch|clip|trailer|teaser|episode|stream|movie|scene|preview|footage)\b/i
const PAGE_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'php',
  'asp',
  'aspx',
  'jsp',
  'cfm'
])

const PAGINATION_QUERY = new Set([
  'page',
  'p',
  'pg',
  'paged',
  'offset',
  'start',
  'after',
  'before',
  'sort',
  'order'
])
const PAGINATION_TEXT = /^(?:next|previous|prev|older|newer|more|back|forward|[«»‹›←→])$/i
/**
 * Discourse/forum chrome. These are navigation, listings or account pages, not
 * page content. The topic's own posts are read from its JSON post stream, so a
 * `/t/<other-topic>` link is never a reason to fetch another topic.
 */
const FORUM_NAVIGATION_SEGMENTS = new Set([
  't',
  'u',
  'c',
  'tag',
  'tags',
  'latest',
  'new',
  'top',
  'unread',
  'categories',
  'badges',
  'groups',
  'my',
  'admin',
  'moderation',
  'about',
  'faq',
  'guidelines',
  'tos',
  'privacy',
  'safe-mode',
  'users',
  'session',
  'password',
  'activate'
])

const SKIPPED_SEGMENTS = new Set([
  'tag',
  'tags',
  'category',
  'categories',
  'genre',
  'genres',
  'label',
  'labels',
  'login',
  'log-in',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'auth',
  'account',
  'accounts',
  'settings',
  'cart',
  'checkout',
  'share',
  'sharer',
  'intent',
  'send',
  'email',
  'search',
  'playlist',
  'playlists',
  'results',
  'feed'
])

const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'co.kr',
  'com.br',
  'com.mx',
  'co.in',
  'com.tr',
  'com.tw',
  'com.cn'
])

export interface FollowLink {
  url: string
  text: string | null
  rel: string | null
  isEmbed: boolean
}

export interface FollowCandidate extends FollowLink {
  /** Bounded display hint from the anchor/iframe title. */
  nameHint: string | null
}

export type FollowReason =
  | 'embed'
  | 'video-host'
  | 'video-path'
  | 'video-text'

export interface FollowDecision {
  score: number
  reason: FollowReason
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return null
  return Array.from(cleaned).slice(0, 240).join('')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
}

function attributeValue(
  attributes: Record<string, string>,
  name: string
): string | null {
  const value = attributes[name]
  if (typeof value !== 'string') return null
  const decoded = decodeEntities(value).trim()
  return decoded.length > 0 ? decoded : null
}

export function isKnownVideoHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (VIDEO_HOSTS.has(host)) return true
  return (
    host.endsWith('.youtube.com') ||
    host.endsWith('.vimeo.com') ||
    host.endsWith('.dailymotion.com') ||
    host.endsWith('.twitch.tv') ||
    host.endsWith('.tiktok.com')
  )
}

/** Approximate the registrable domain without a full Public Suffix List. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const labels = host.split('.').filter((label) => label.length > 0)
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.')
  return lastTwo
}

function pathExtension(path: string): string | null {
  const match = /\.([a-z0-9]{1,12})$/i.exec(path.replace(/\/+$/, ''))
  return match ? match[1]!.toLowerCase() : null
}

function isPaginationLink(parsed: URL, text: string | null): boolean {
  for (const key of parsed.searchParams.keys()) {
    if (PAGINATION_QUERY.has(key.toLowerCase())) return true
  }
  if (/\/(?:page|p)\/\d+(?:\/|$)/i.test(parsed.pathname)) return true
  if (text !== null && PAGINATION_TEXT.test(text.trim())) return true
  return false
}

function isPixeldrainFilePage(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase()
  return (
    (host === 'pixeldrain.com' || host === 'www.pixeldrain.com') &&
    /^\/u\/[A-Za-z0-9_-]{4,64}\/?$/.test(parsed.pathname)
  )
}

function isSkippedPath(parsed: URL, forumHost: string | null): boolean {
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase())
  if (segments.some((segment) => SKIPPED_SEGMENTS.has(segment))) return true
  // Forum navigation and other topic/user/category pages are never content.
  // This is checked on the first segment so an ordinary `/t/…` path cannot
  // pull in a Discourse suggested/related topic. The rule only applies to the
  // scanned forum's own host: other sites legitimately use `/t/`, `/u/`, `/new/`
  // and `/top/` for content (for example pixeldrain.com/u/<id>).
  const first = segments[0]
  if (
    forumHost !== null &&
    parsed.hostname.toLowerCase() === forumHost &&
    first !== undefined &&
    FORUM_NAVIGATION_SEGMENTS.has(first)
  ) {
    return true
  }
  // Channel/user/profile hubs are listings, not a single video.
  if (segments.some((segment) => segment === 'channel' || segment === 'channels')) {
    return true
  }
  if (segments.length === 1 && segments[0]?.startsWith('@')) return true
  return false
}

/**
 * Score one link for following. Returns null when it must not be fetched.
 * Scores are relative priorities: higher values are fetched first.
 */
export function scoreFollowLink(input: {
  url: string
  baseUrl: string
  isEmbed?: boolean
  rel?: string | null
  text?: string | null
  /**
   * Host of the forum page being scanned. Forum-navigation paths are rejected
   * only on this host; links to other sites are scored normally. Defaults to
   * the page the link was found on.
   */
  forumHost?: string
}): FollowDecision | null {
  const rel = (input.rel ?? '').toLowerCase()
  const nofollow = rel.split(/\s+/).includes('nofollow')
  const penalty = nofollow ? 10 : 0

  let parsed: URL
  let base: URL
  try {
    parsed = new URL(input.url)
    base = new URL(input.baseUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null

  const baseHost = base.hostname.toLowerCase().replace(/\.$/, '')
  const forumHost =
    typeof input.forumHost === 'string' && input.forumHost.length > 0
      ? input.forumHost.toLowerCase().replace(/\.$/, '')
      : baseHost

  const extension = pathExtension(parsed.pathname)
  if (extension !== null && !PAGE_EXTENSIONS.has(extension)) return null
  if (isPaginationLink(parsed, input.text ?? null)) return null
  if (isSkippedPath(parsed, forumHost)) return null

  const host = parsed.hostname.toLowerCase()
  const sameSite =
    registrableDomain(host) === registrableDomain(base.hostname.toLowerCase())
  const videoHost = isKnownVideoHost(host)
  const likelyVideoPage = isLikelyVideoPageUrl(parsed.href)
  const videoPath = likelyVideoPage || VIDEO_PATH.test(parsed.pathname)
  const directFilePage = isPixeldrainFilePage(parsed)
  const text = cleanText(input.text)
  const videoText = text !== null && VIDEO_TEXT.test(text)

  if (input.isEmbed === true) {
    if (BLOCKED_IFRAME_HOSTS.has(host)) return null
    if (videoHost) return { score: 100 - penalty, reason: 'embed' }
    if (sameSite && videoPath) return { score: 80 - penalty, reason: 'embed' }
    // Follow third-party iframes: a bare embed URL frequently looks like a
    // player but has no recognisable path.
    return { score: 40 - penalty, reason: 'embed' }
  }

  if (videoHost) {
    // A bare channel page is a listing, one level above the actual videos.
    if (parsed.pathname === '/' || parsed.pathname === '') return null
    return { score: 90 - penalty, reason: 'video-host' }
  }
  if (!sameSite) {
    // A cross-site single-video path is a discovery candidate; pagination,
    // login, listings and article links were already rejected above.
    if (videoPath || directFilePage) {
      return { score: 55 - penalty, reason: 'video-path' }
    }
    return null
  }
  if (videoPath) return { score: 70 - penalty, reason: 'video-path' }
  if (videoText) return { score: 50 - penalty, reason: 'video-text' }
  return null
}

/** Extract bounded anchor/iframe follow candidates from one HTML document. */
export function extractFollowCandidates(
  html: string,
  pageUrl: string,
  options: { maxCandidates?: number } = {}
): FollowCandidate[] {
  const maximum = Math.max(
    0,
    Math.min(options.maxCandidates ?? MAX_FOLLOW_CANDIDATES, MAX_FOLLOW_CANDIDATES)
  )
  if (maximum === 0) return []

  const raw: Array<{
    url: string
    text: string | null
    rel: string | null
    isEmbed: boolean
  }> = []
  let anchor: { href: string | null; rel: string | null; text: string } | null =
    null
  let baseHref: string | null = null

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase()
        if (tag === 'base' && baseHref === null) {
          baseHref = attributeValue(attributes, 'href')
          return
        }
        if (tag === 'a') {
          anchor = {
            href: attributeValue(attributes, 'href'),
            rel: attributeValue(attributes, 'rel'),
            text: ''
          }
          return
        }
        if (tag === 'iframe') {
          const src = attributeValue(attributes, 'src')
          if (src !== null && raw.length < maximum) {
            raw.push({
              url: src,
              text: attributeValue(attributes, 'title'),
              rel: null,
              isEmbed: true
            })
          }
        }
      },
      ontext(text) {
        if (anchor !== null && anchor.text.length < 500) anchor.text += text
      },
      onclosetag(name) {
        if (name.toLowerCase() !== 'a' || anchor === null) return
        const current = anchor
        anchor = null
        if (current.href === null || raw.length >= maximum) return
        raw.push({
          url: current.href,
          text: cleanText(current.text),
          rel: current.rel,
          isEmbed: false
        })
      }
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  )

  parser.write(html)
  parser.end()

  let documentBase = pageUrl
  if (baseHref !== null) {
    try {
      const resolved = new URL(baseHref, pageUrl)
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        documentBase = resolved.href
      }
    } catch {
      // Fall back to the document URL for an invalid <base>.
    }
  }

  const seen = new Map<string, FollowCandidate>()
  for (const candidate of raw) {
    const url = resolveScanUrl(candidate.url, documentBase)
    if (url === null) continue
    const existing = seen.get(url)
    if (existing === undefined) {
      seen.set(url, {
        url,
        text: candidate.text,
        rel: candidate.rel,
        isEmbed: candidate.isEmbed,
        nameHint: candidate.text
      })
    } else if (candidate.isEmbed && !existing.isEmbed) {
      existing.isEmbed = true
    }
    if (seen.size >= maximum) break
  }
  return [...seen.values()]
}
