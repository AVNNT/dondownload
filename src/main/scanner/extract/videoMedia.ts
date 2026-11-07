import { Parser } from 'htmlparser2'
import {
  MAX_SCAN_VIDEO_MEDIA_SOURCES,
  type ScanVideoMediaKind,
  type ScanVideoMediaSource
} from '@shared/scanVideo'
import { resolveScanUrl } from './url'

/**
 * Direct media discovery for a single video page.
 *
 * yt-dlp does not know every video site (`hanime1.me` has no extractor) and
 * some sites answer yt-dlp with an age gate, geo block or Cloudflare challenge.
 * The page itself still points at its media: `<video>`/`<source>` elements,
 * `og:video`, JSON-LD `contentUrl`, and the player configuration in inline
 * scripts (`sources: [{src, label}]`, `"videoUrl"`, Pornhub-style
 * `mediaDefinitions`). This module reads exactly those, purely and
 * deterministically: no DOM, no script execution, no network.
 *
 * Everything it returns is untrusted. The caller normalizes each URL and
 * checks it against the public-target policy before it reaches a downloader.
 */

export interface ExtractedVideoMedia {
  /** Cleaned page title (`og:title`, then `<title>`), or null. */
  title: string | null
  thumbnailUrl: string | null
  durationSeconds: number | null
  /**
   * Set when the document is a bot challenge or an age/login gate and it
   * exposed no media at all. The caller keeps the card browser-only.
   */
  blocked: 'challenge' | 'gate' | null
  sources: ScanVideoMediaSource[]
}

interface RawSource {
  url: string
  kind: ScanVideoMediaKind
  label: string | null
  width: number | null
  height: number | null
  sizeBytes: number | null
}

/** Total inline-script text inspected per document. */
const MAX_SCRIPT_BYTES = 512 * 1024
const MAX_JSON_LD_BLOCKS = 20
/** Characters inspected around one URL inside a script. */
const CONTEXT_WINDOW = 420
/** A `size` attribute below this is a quality label (`1080`), not bytes. */
const SIZE_ATTRIBUTE_AS_BYTES = 100_000

const CHALLENGE_TEXT =
  /(?:challenge-platform|cf[-_]chl|cf_chl_opt|cf-browser-verification|attention required!?\s*\|\s*cloudflare|just a moment\.\.\.|enable javascript and cookies to continue|checking your browser|ddos protection by|cf-error-details)/i
const GATE_TEXT =
  /(?:age verification|verify your age|are you (?:over )?18|this (?:content|video) is (?:for adults|age[- ]restricted)|age[- ]restricted|log ?in to (?:continue|watch)|sign ?in to (?:continue|watch)|members[- ]only|requires? (?:a )?(?:paid )?membership)/i

const MEDIA_URL =
  /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov)(?:\?[^\s"'<>\\]*)?/gi
const ROOT_RELATIVE_MEDIA_URL =
  /(?:^|["'(=\s])(\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov)(?:\?[^\s"'<>\\]*)?)/gi

const QUALITY_KEYS = /["']?(?:label|quality|res|resolution|height|size)["']?\s*:\s*["']?([^"',}\]\n]{1,40})/gi

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
}

function attribute(
  attributes: Record<string, string>,
  name: string
): string | null {
  const value = attributes[name]
  if (typeof value !== 'string') return null
  const decoded = decodeEntities(value).trim()
  return decoded.length > 0 ? decoded : null
}

function cleanText(value: string | null): string | null {
  if (value === null) return null
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/** Height in pixels from a player label such as `1080p`, `1920x1080`, `4K`. */
export function heightFromLabel(raw: string | null): number | null {
  if (raw === null) return null
  const value = raw.trim().toLowerCase()
  if (value.length === 0 || value.length > 40) return null
  if (/^\d{2,4}$/.test(value)) {
    const height = Number(value)
    return height >= 144 && height <= 4320 ? height : null
  }
  const explicit = /(\d{3,4})\s*p(?![a-z0-9])/.exec(value)
  if (explicit !== null) {
    const height = Number(explicit[1])
    if (height >= 144 && height <= 4320) return height
  }
  const pair = /(\d{2,4})\s*[x×]\s*(\d{3,4})/.exec(value)
  if (pair !== null) {
    const height = Number(pair[2])
    if (height >= 144 && height <= 4320) return height
  }
  if (/\b(?:4k|uhd)\b/.test(value)) return 2160
  if (/\b(?:full hd|fhd)\b/.test(value)) return 1080
  if (/\b(?:qhd|2k)\b/.test(value)) return 1440
  if (/\bhd\b/.test(value)) return 720
  if (/\bsd\b/.test(value)) return 480
  return null
}

/** Height in pixels hinted by the media URL itself (`/1080/`, `_720p.mp4`). */
export function heightFromUrl(raw: string): number | null {
  const value = raw.toLowerCase()
  const label = /(?:^|[^0-9])(\d{3,4})p(?:[^a-z0-9]|$)/.exec(value)
  if (label !== null) {
    const height = Number(label[1])
    if (height >= 144 && height <= 4320) return height
  }
  const pair = /(?:^|[^0-9])(\d{3,4})x(\d{3,4})(?:[^0-9]|$)/.exec(value)
  if (pair !== null) {
    const height = Number(pair[2])
    if (height >= 144 && height <= 4320) return height
  }
  const known = /(?:^|[^0-9])(2160|1440|1080|720|540|480|360|240)(?:[^0-9]|$)/.exec(
    value
  )
  if (known !== null) return Number(known[1])
  return null
}

function kindFromUrl(raw: string): ScanVideoMediaKind | null {
  let pathname: string
  try {
    pathname = new URL(raw, 'https://placeholder.invalid/').pathname.toLowerCase()
  } catch {
    return null
  }
  if (/\.m3u8$/.test(pathname)) return 'hls'
  if (/\.mpd$/.test(pathname)) return 'dash'
  if (/\.(?:mp4|m4v|webm|mkv|mov)$/.test(pathname)) return 'file'
  return null
}

function kindFromContentType(value: string | null): ScanVideoMediaKind | null {
  if (value === null) return null
  const type = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === 'application/vnd.apple.mpegurl' || type === 'application/x-mpegurl') {
    return 'hls'
  }
  if (type === 'application/dash+xml') return 'dash'
  if (/^video\/(?:mp4|webm|quicktime|x-matroska)$/.test(type)) return 'file'
  return null
}

function kindFromFormatHint(value: string | null): ScanVideoMediaKind | null {
  if (value === null) return null
  const hint = value.trim().toLowerCase()
  if (hint === 'hls' || hint === 'm3u8' || hint === 'application/x-mpegurl') {
    return 'hls'
  }
  if (hint === 'dash' || hint === 'mpd') return 'dash'
  if (hint === 'mp4' || hint === 'webm' || hint === 'file' || hint === 'progressive') {
    return 'file'
  }
  return null
}

function durationFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/^\d{1,7}(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return seconds > 0 ? Math.floor(seconds) : null
  }
  // ISO 8601 durations such as PT1H2M3S.
  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(
    trimmed
  )
  if (iso === null) return null
  const days = Number(iso[1] ?? 0)
  const hours = Number(iso[2] ?? 0)
  const minutes = Number(iso[3] ?? 0)
  const seconds = Number(iso[4] ?? 0)
  const total = days * 86_400 + hours * 3600 + minutes * 60 + seconds
  return total > 0 ? Math.floor(total) : null
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

/**
 * Read the direct media a single video page exposes. Pure: the same HTML and
 * page URL always produce the same result.
 */
export function extractVideoMedia(
  html: string,
  pageUrl: string
): ExtractedVideoMedia {
  const raw: RawSource[] = []
  const jsonLdBlocks: string[] = []
  let titleText: string | null = null
  let ogTitle: string | null = null
  let thumbnail: string | null = null
  let duration: number | null = null
  let inTitle = false
  let titleBuffer = ''
  let inScript = false
  let scriptIsJsonLd = false
  let scriptBuffer = ''
  let inlineScript = ''
  let inlineScriptBytes = 0

  const push = (
    value: string | null,
    kindHint: ScanVideoMediaKind | null,
    label: string | null,
    width: number | null,
    height: number | null,
    sizeBytes: number | null
  ): void => {
    if (value === null) return
    const url = resolveScanUrl(value, pageUrl)
    if (url === null) return
    const kind = kindFromUrl(url) ?? kindHint
    if (kind === null) return
    raw.push({
      url,
      kind,
      label: cleanText(label),
      width,
      height: height ?? heightFromLabel(label) ?? heightFromUrl(url),
      sizeBytes
    })
  }

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase()
        if (tag === 'title') {
          inTitle = true
          titleBuffer = ''
          return
        }
        if (tag === 'meta') {
          const key = (
            attribute(attributes, 'property') ??
            attribute(attributes, 'name') ??
            ''
          ).toLowerCase()
          const content = attribute(attributes, 'content')
          if (content === null) return
          if (key === 'og:title' || key === 'twitter:title') {
            ogTitle ??= content
            return
          }
          if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') {
            if (thumbnail === null && isHttpUrl(content)) thumbnail = content
            return
          }
          if (key === 'og:video:duration' || key === 'video:duration') {
            duration ??= durationFromValue(content)
            return
          }
          if (
            key === 'og:video' ||
            key === 'og:video:url' ||
            key === 'og:video:secure_url' ||
            key === 'twitter:player:stream'
          ) {
            push(content, null, null, null, null, null)
          }
          return
        }
        if (tag === 'script') {
          inScript = true
          const type = (attribute(attributes, 'type') ?? '').toLowerCase()
          scriptIsJsonLd = type === 'application/ld+json'
          scriptBuffer = ''
          return
        }
        if (tag === 'video' || tag === 'source') {
          const typeHint = kindFromContentType(attribute(attributes, 'type'))
          const label =
            attribute(attributes, 'label') ??
            attribute(attributes, 'res') ??
            attribute(attributes, 'resolution') ??
            attribute(attributes, 'quality') ??
            attribute(attributes, 'data-quality') ??
            attribute(attributes, 'data-res') ??
            attribute(attributes, 'data-resolution')
          const rawSize = attribute(attributes, 'size') ?? attribute(attributes, 'data-size')
          const numericSize = rawSize !== null && /^\d{1,15}$/.test(rawSize) ? Number(rawSize) : null
          const sizeBytes =
            numericSize !== null && numericSize >= SIZE_ATTRIBUTE_AS_BYTES
              ? numericSize
              : null
          const sizeLabel =
            numericSize !== null && numericSize < SIZE_ATTRIBUTE_AS_BYTES
              ? String(numericSize)
              : null
          const width =
            attribute(attributes, 'width') !== null &&
            /^\d{2,5}$/.test(attribute(attributes, 'width') as string)
              ? Number(attribute(attributes, 'width'))
              : null
          const height =
            attribute(attributes, 'height') !== null &&
            /^\d{2,5}$/.test(attribute(attributes, 'height') as string)
              ? Number(attribute(attributes, 'height'))
              : null
          if (tag === 'video') {
            const poster = attribute(attributes, 'poster')
            if (poster !== null && thumbnail === null && isHttpUrl(poster)) {
              thumbnail = poster
            }
          }
          const src =
            attribute(attributes, 'src') ?? attribute(attributes, 'data-src')
          push(src, typeHint, label ?? sizeLabel, width, height, sizeBytes)
        }
      },
      ontext(text) {
        if (inTitle) {
          if (titleBuffer.length < 1000) titleBuffer += text
          return
        }
        if (!inScript) return
        if (scriptIsJsonLd) {
          if (scriptBuffer.length < 256 * 1024) scriptBuffer += text
          return
        }
        if (inlineScriptBytes < MAX_SCRIPT_BYTES) {
          inlineScript += text
          inlineScriptBytes += text.length
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase()
        if (tag === 'title' && inTitle) {
          inTitle = false
          titleText ??= cleanText(titleBuffer)
          return
        }
        if (tag === 'script' && inScript) {
          if (scriptIsJsonLd) {
            if (jsonLdBlocks.length < MAX_JSON_LD_BLOCKS) {
              jsonLdBlocks.push(scriptBuffer)
            }
          } else if (inlineScriptBytes < MAX_SCRIPT_BYTES) {
            // Separate blocks so one URL context never spans two scripts.
            inlineScript += '\n;\n'
          }
          inScript = false
          scriptIsJsonLd = false
          scriptBuffer = ''
        }
      }
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  )

  parser.write(html)
  parser.end()

  for (const block of jsonLdBlocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    collectJsonLd(parsed, 0, (entry) => {
      if (entry.title !== null && ogTitle === null) ogTitle = entry.title
      if (entry.thumbnail !== null && thumbnail === null) {
        thumbnail = entry.thumbnail
      }
      if (entry.duration !== null && duration === null) duration = entry.duration
      if (entry.url !== null) {
        push(entry.url, null, entry.label, entry.width, entry.height, null)
      }
    })
  }

  scanInlineScripts(inlineScript, (url, context, urlOffset) => {
    const hint = kindFromFormatHint(readFormatHint(context, urlOffset))
    push(url, hint, readQualityFromContext(context, urlOffset), null, null, null)
  })

  const sources = finalizeSources(raw)
  const blocked: ExtractedVideoMedia['blocked'] =
    sources.length > 0
      ? null
      : CHALLENGE_TEXT.test(html)
        ? 'challenge'
        : GATE_TEXT.test(html)
          ? 'gate'
          : null

  return {
    title: cleanText(ogTitle) ?? titleText,
    thumbnailUrl: thumbnail,
    durationSeconds: duration,
    blocked,
    sources
  }
}

interface JsonLdEntry {
  url: string | null
  title: string | null
  thumbnail: string | null
  duration: number | null
  label: string | null
  width: number | null
  height: number | null
}

function collectJsonLd(
  value: unknown,
  depth: number,
  visit: (entry: JsonLdEntry) => void
): void {
  if (depth > 6) return
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLd(entry, depth + 1, visit)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const type = record['@type']
  const types = Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === 'string')
    : typeof type === 'string'
      ? [type]
      : []
  const isVideo = types.some((entry) =>
    /^(?:VideoObject|Movie|Clip|TVEpisode)$/i.test(entry)
  )
  if (isVideo || typeof record.contentUrl === 'string') {
    const contentUrl =
      typeof record.contentUrl === 'string' ? record.contentUrl : null
    const thumbnailUrl =
      typeof record.thumbnailUrl === 'string'
        ? record.thumbnailUrl
        : typeof record.thumbnail === 'string'
          ? record.thumbnail
          : null
    const height =
      typeof record.height === 'number' && Number.isFinite(record.height)
        ? Math.round(record.height)
        : null
    const width =
      typeof record.width === 'number' && Number.isFinite(record.width)
        ? Math.round(record.width)
        : null
    visit({
      url: contentUrl,
      title: typeof record.name === 'string' ? record.name : null,
      thumbnail:
        thumbnailUrl !== null && isHttpUrl(thumbnailUrl) ? thumbnailUrl : null,
      duration: durationFromValue(record.duration),
      label: typeof record.videoQuality === 'string' ? record.videoQuality : null,
      width: width !== null && width > 0 && width <= 100_000 ? width : null,
      height: height !== null && height > 0 && height <= 100_000 ? height : null
    })
  }
  for (const entry of Object.values(record)) {
    if (typeof entry === 'object' && entry !== null) {
      collectJsonLd(entry, depth + 1, visit)
    }
  }
}

/** Every media URL in one inline script, with the text around it as context. */
function scanInlineScripts(
  text: string,
  visit: (url: string, context: string, urlOffset: number) => void
): void {
  if (text.length === 0) return
  // Bundlers and player configs escape slashes as `\/` inside JSON.
  const normalized = text.replace(/\\\//g, '/')
  const seen = new Set<string>()
  const emit = (match: string, index: number): void => {
    const value = match.replace(/[),.;]+$/, '')
    if (value.length === 0 || value.length > 4096) return
    const key = `${index}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    const start = Math.max(0, index - CONTEXT_WINDOW)
    const end = Math.min(normalized.length, index + value.length + CONTEXT_WINDOW)
    visit(value, normalized.slice(start, end), index - start)
  }
  for (const match of normalized.matchAll(MEDIA_URL)) {
    emit(match[0], match.index ?? 0)
  }
  for (const match of normalized.matchAll(ROOT_RELATIVE_MEDIA_URL)) {
    emit(match[1] ?? '', match.index ?? 0)
  }
}

/**
 * The hint that describes this URL inside one player entry.
 *
 * A single `mediaDefinitions`/`sources` array holds several renditions, so the
 * first `"quality"` in the context window belongs to the entry above. Player
 * configs name the URL before its label (`{src, label}`, `{videoUrl, quality}`),
 * so a hint after the URL wins and the nearest one before it is the fallback.
 */
function closestMatch(
  context: string,
  pattern: RegExp,
  urlOffset: number
): RegExpMatchArray | null {
  let after: RegExpMatchArray | null = null
  let afterDistance = Number.POSITIVE_INFINITY
  let before: RegExpMatchArray | null = null
  let beforeDistance = Number.POSITIVE_INFINITY
  for (const match of context.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index >= urlOffset) {
      const distance = index - urlOffset
      if (distance < afterDistance) {
        after = match
        afterDistance = distance
      }
      continue
    }
    const distance = urlOffset - index
    if (distance < beforeDistance) {
      before = match
      beforeDistance = distance
    }
  }
  return after ?? before
}

function readQualityFromContext(context: string, urlOffset: number): string | null {
  const hint = closestMatch(context, QUALITY_KEYS, urlOffset)
  if (hint !== null) {
    const height = heightFromLabel(hint[1] ?? null)
    if (height !== null) return `${height}p`
  }
  const inline = closestMatch(context, /(\d{3,4})\s*p(?:[^a-z0-9]|$)/gi, urlOffset)
  if (inline !== null) {
    const height = heightFromLabel(inline[1] ?? null)
    if (height !== null) return `${height}p`
  }
  return null
}

function readFormatHint(context: string, urlOffset: number): string | null {
  const match = closestMatch(
    context,
    /["']?format["']?\s*:\s*["']?([a-z0-9/+.-]{1,24})/gi,
    urlOffset
  )
  return match === null ? null : (match[1] ?? null)
}

/**
 * Deduplicate by URL, merge a later quality hint into an earlier entry, and
 * order best first. `MAX_SCAN_VIDEO_MEDIA_SOURCES` is a hard cap.
 */
function finalizeSources(raw: readonly RawSource[]): ScanVideoMediaSource[] {
  const byUrl = new Map<string, RawSource>()
  for (const entry of raw) {
    const existing = byUrl.get(entry.url)
    if (existing === undefined) {
      byUrl.set(entry.url, entry)
      continue
    }
    byUrl.set(entry.url, {
      url: existing.url,
      kind: existing.kind,
      label: existing.label ?? entry.label,
      width: existing.width ?? entry.width,
      height: existing.height ?? entry.height,
      sizeBytes: existing.sizeBytes ?? entry.sizeBytes
    })
  }

  const kindRank: Record<ScanVideoMediaKind, number> = {
    file: 0,
    hls: 1,
    dash: 2
  }
  return [...byUrl.values()]
    .sort((left, right) => {
      const leftHeight = left.height ?? 0
      const rightHeight = right.height ?? 0
      if (leftHeight !== rightHeight) return rightHeight - leftHeight
      return kindRank[left.kind] - kindRank[right.kind]
    })
    .slice(0, MAX_SCAN_VIDEO_MEDIA_SOURCES)
    .map((entry) => ({
      url: entry.url,
      kind: entry.kind,
      ...(entry.label === null ? {} : { label: entry.label }),
      ...(entry.width === null ? {} : { width: entry.width }),
      ...(entry.height === null ? {} : { height: entry.height }),
      ...(entry.sizeBytes === null ? {} : { sizeBytes: entry.sizeBytes })
    }))
}
