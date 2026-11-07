import { Parser } from 'htmlparser2'
import { isMegaHost } from '@shared/urlFragment'
import { isLikelyVideoPageUrl } from '../classify'
import { isVideoHostVideoUrl } from '../videoHosts'
import { resolveAbsoluteUrl, resolveScanUrl } from './url'

/**
 * Pure HTML discovery. `htmlparser2` is an event parser: this module never
 * builds a browser DOM, never executes a script and never calls the network.
 */

export type ExtractedSource =
  | 'meta'
  | 'json-ld'
  | 'media-element'
  | 'image'
  | 'embed'
  | 'anchor'
  | 'script'

export interface ExtractedCandidate {
  url: string
  nameHint: string | null
  downloadAttribute: boolean
  isAttachment: boolean
  fromScript: boolean
  isEmbed: boolean
  source: ExtractedSource
}

export interface ExtractOptions {
  /** Hard cap for links collected from one document (default 5000). */
  maxCandidates?: number
  /** Maximum total inline-script text inspected (default 256 KiB). */
  maxScriptBytes?: number
}

interface RawCandidate {
  url: string
  nameHint: string | null
  downloadAttribute: boolean
  isAttachment: boolean
  fromScript: boolean
  isEmbed: boolean
  source: ExtractedSource
}

const FILE_EXTENSION =
  /\.(mp4|webm|m4v|mkv|mov|avi|wmv|flv|ogv|mpeg|mpg|3gp|ts|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff|jpg|jpeg|png|gif|webp|avif|bmp|tif|tiff|heic|heif|funscript|pdf|doc|docx|odt|rtf|txt|md|csv|xls|xlsx|ods|ppt|pptx|odp|epub|json|xml|log|srt|vtt|zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|img|dmg|m3u8|mpd)(?:[?#]|$)/i

const TRACKING_IMAGE = /(?:^|[/_.-])(1x1|pixel|spacer|blank|beacon|tracking|analytics|transparent)(?:[/_.-]|$)/i

const META_KEYS = new Set([
  'og:video',
  'og:video:url',
  'og:video:secure_url',
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:player:stream',
  'twitter:image',
  'twitter:image:src'
])

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

function looksLikeCandidateUrl(url: string, nameHint: string | null): boolean {
  if (FILE_EXTENSION.test(url)) return true
  if (nameHint !== null && FILE_EXTENSION.test(nameHint)) return true
  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (isVideoHostVideoUrl(url)) return true
  if (isLikelyVideoPageUrl(url)) return true
  if (isMegaHost(hostname)) return true
  return (
    hostname === 'pixeldrain.com' ||
    hostname === 'www.pixeldrain.com' ||
    hostname === 'gofile.io' ||
    hostname === 'www.gofile.io'
  )
}

function isTinyImage(url: string, width: number | null): boolean {
  if (width !== null && width > 0 && width < 96) return true
  if (/\.svg(?:[?#]|$)/i.test(url)) return true
  if (url.startsWith('data:')) return true
  if (TRACKING_IMAGE.test(url)) return true

  let parsed: URL
  try {
    // Resolve a relative image path against a harmless placeholder so query
    // size hints (for example `?w=32`) are still inspected.
    parsed = new URL(url, 'https://placeholder.invalid/')
  } catch {
    return false
  }
  if (
    parsed.protocol === 'data:' ||
    parsed.protocol === 'blob:' ||
    parsed.protocol === 'javascript:'
  ) {
    return true
  }
  const rawWidth = parsed.searchParams.get('w') ?? parsed.searchParams.get('width')
  const rawHeight = parsed.searchParams.get('h') ?? parsed.searchParams.get('height')
  const parsedWidth = rawWidth === null ? null : Number(rawWidth)
  const parsedHeight = rawHeight === null ? null : Number(rawHeight)
  if (
    parsedWidth !== null &&
    Number.isFinite(parsedWidth) &&
    parsedWidth > 0 &&
    parsedWidth < 96
  ) {
    return true
  }
  if (
    parsedHeight !== null &&
    Number.isFinite(parsedHeight) &&
    parsedHeight > 0 &&
    parsedHeight < 48
  ) {
    return true
  }
  return false
}

function largestSrcsetCandidate(
  value: string
): { url: string; width: number | null } | null {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  let best: { url: string; width: number | null; score: number } | null = null
  for (const entry of entries) {
    const match = /^(\S+)(?:\s+(.+))?$/.exec(entry)
    if (!match) continue
    const url = match[1]!
    if (url.startsWith('data:')) continue
    let width: number | null = null
    let density = 0
    for (const part of (match[2] ?? '').split(/\s+/)) {
      if (/^\d+w$/i.test(part)) width = Number(part.slice(0, -1))
      else if (/^\d+(?:\.\d+)?x$/i.test(part)) density = Number(part.slice(0, -1))
    }
    const score = width ?? density * 1000
    if (best === null || score > best.score) {
      best = { url, width, score }
    }
  }
  return best === null ? null : { url: best.url, width: best.width }
}

function collectJsonLdValues(
  value: unknown,
  depth: number,
  output: Array<{ url: string; name: string | null; embed: boolean }>
): void {
  if (depth > 8 || output.length > 500) return
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLdValues(entry, depth + 1, output)
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
  const interesting =
    types.some((entry) =>
      /^(VideoObject|AudioObject|DataDownload|MediaObject|ImageObject)$/i.test(
        entry
      )
    ) || record.contentUrl !== undefined
  if (interesting) {
    const name = typeof record.name === 'string' ? record.name : null
    for (const key of ['contentUrl', 'embedUrl', 'url']) {
      const raw = record[key]
      if (typeof raw === 'string') {
        output.push({ url: raw, name, embed: key === 'embedUrl' })
      }
    }
  }
  for (const entry of Object.values(record)) {
    if (typeof entry === 'object' && entry !== null) {
      collectJsonLdValues(entry, depth + 1, output)
    }
  }
}

/**
 * True when the LAST extension of the URL's path is a media extension. A URL
 * such as `.../1080P_4000K_65036195.mp4/master.m3u8` carries a media extension
 * in an earlier segment too, so only the last segment decides.
 */
function hasMediaExtension(value: string): boolean {
  let pathname: string
  try {
    pathname = new URL(value, 'https://placeholder.invalid/').pathname.toLowerCase()
  } catch {
    return false
  }
  const segments = pathname.split('/')
  const last = segments[segments.length - 1] ?? ''
  const dot = last.lastIndexOf('.')
  if (dot === -1 || dot === last.length - 1) return false
  const extension = last.slice(dot + 1)
  return extension === 'm3u8' || extension === 'mpd' || extension === 'mp4' || extension === 'webm'
}

function scriptUrls(text: string): string[] {
  const matches: string[] = []
  // Bundlers commonly escape slashes as `\/` inside inline JSON/scripts.
  const normalized = text.replace(/\\\//g, '/')
  // The URL is captured whole, up to the first delimiter, and filtered by its
  // last path extension afterwards: stopping the pattern at the first media
  // extension truncated `.../x.mp4/master.m3u8` to the mp4 segment.
  const pattern = /(?:https?:\/\/|\/)[^\s"'<>\\]+/gi
  for (const match of normalized.matchAll(pattern)) {
    const value = match[0].replace(/[),.;\]}]+$/, '')
    if (value.length === 0 || value.length > 4096) continue
    if (!hasMediaExtension(value)) continue
    matches.push(value)
    if (matches.length >= 200) break
  }
  return matches
}

/** Extract candidate links from one HTML document. Pure and deterministic. */
export function extractCandidates(
  html: string,
  pageUrl: string,
  options: ExtractOptions = {}
): ExtractedCandidate[] {
  const maxCandidates = options.maxCandidates ?? 5000
  const maxScriptBytes = options.maxScriptBytes ?? 256 * 1024

  const raw: RawCandidate[] = []
  let baseHref: string | null = null
  /**
   * Effective document base. `<base href>` normally sits in `<head>`, but it may
   * appear anywhere, so it is read again for every link instead of once at the
   * end: a relative href has to be resolved before any host rule can match it.
   */
  const documentBaseUrl = (): string => {
    if (baseHref === null) return pageUrl
    try {
      const resolvedBase = new URL(baseHref, pageUrl)
      if (
        resolvedBase.protocol === 'http:' ||
        resolvedBase.protocol === 'https:'
      ) {
        return resolvedBase.href
      }
    } catch {
      // Fall back to the page URL for an invalid <base>.
    }
    return pageUrl
  }
  let inScript = false
  let scriptIsJsonLd = false
  let scriptText = ''
  let scriptBytes = 0
  let capturedScriptBytes = 0
  let anchor: {
    href: string | null
    name: string
    downloadAttribute: boolean
    isAttachment: boolean
  } | null = null
  const jsonLdBlocks: string[] = []

  const push = (candidate: RawCandidate): void => {
    if (raw.length >= maxCandidates) return
    raw.push(candidate)
  }

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase()
        if (tag === 'base' && baseHref === null) {
          baseHref = attributeValue(attributes, 'href')
          return
        }
        if (tag === 'meta') {
          const key = (
            attributeValue(attributes, 'property') ??
            attributeValue(attributes, 'name') ??
            ''
          ).toLowerCase()
          const content = attributeValue(attributes, 'content')
          if (content !== null && META_KEYS.has(key)) {
            push({
              url: content,
              nameHint: null,
              downloadAttribute: false,
              isAttachment: false,
              fromScript: false,
              isEmbed: key.includes('player'),
              source: 'meta'
            })
          }
          return
        }
        if (tag === 'script') {
          inScript = true
          const type = (attributeValue(attributes, 'type') ?? '').toLowerCase()
          scriptIsJsonLd = type === 'application/ld+json'
          scriptText = ''
          return
        }
        if (tag === 'a') {
          anchor = {
            href: attributeValue(attributes, 'href'),
            name: '',
            downloadAttribute:
              Object.prototype.hasOwnProperty.call(attributes, 'download'),
            isAttachment:
              /(?:^|\s)attachment(?:\s|$)/i.test(
                attributeValue(attributes, 'class') ?? ''
              )
          }
          return
        }
        if (tag === 'img') {
          const srcset = attributeValue(attributes, 'srcset')
          let usedSrcset = false
          if (srcset !== null) {
            const best = largestSrcsetCandidate(srcset)
            if (best !== null && !isTinyImage(best.url, best.width)) {
              usedSrcset = true
              push({
                url: best.url,
                nameHint: attributeValue(attributes, 'alt'),
                downloadAttribute: false,
                isAttachment: false,
                fromScript: false,
                isEmbed: false,
                source: 'image'
              })
            }
          }
          const src = attributeValue(attributes, 'src')
          if (!usedSrcset && src !== null && !isTinyImage(src, null)) {
            push({
              url: src,
              nameHint: attributeValue(attributes, 'alt'),
              downloadAttribute: false,
              isAttachment: false,
              fromScript: false,
              isEmbed: false,
              source: 'image'
            })
          }
          return
        }
        if (tag === 'video' || tag === 'audio' || tag === 'source') {
          const src = attributeValue(attributes, 'src')
          if (src !== null) {
            push({
              url: src,
              nameHint: attributeValue(attributes, 'title'),
              downloadAttribute: false,
              isAttachment: false,
              fromScript: false,
              isEmbed: false,
              source: 'media-element'
            })
          }
          if (tag === 'video') {
            const poster = attributeValue(attributes, 'poster')
            if (poster !== null && !isTinyImage(poster, null)) {
              push({
                url: poster,
                nameHint: null,
                downloadAttribute: false,
                isAttachment: false,
                fromScript: false,
                isEmbed: false,
                source: 'image'
              })
            }
          }
          return
        }
        if (tag === 'iframe') {
          const src = attributeValue(attributes, 'src')
          if (src !== null) {
            push({
              url: src,
              nameHint: attributeValue(attributes, 'title'),
              downloadAttribute: false,
              isAttachment: false,
              fromScript: false,
              isEmbed: true,
              source: 'embed'
            })
          }
        }
      },
      ontext(text) {
        if (inScript) {
          if (scriptIsJsonLd) {
            scriptText += text
            capturedScriptBytes += text.length
            if (capturedScriptBytes > 256 * 1024) {
              scriptText = scriptText.slice(0, 256 * 1024)
            }
          } else if (scriptBytes < maxScriptBytes) {
            scriptText += text
            scriptBytes += text.length
          }
          return
        }
        if (anchor !== null && anchor.name.length < 500) {
          anchor.name += text
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase()
        if (tag === 'script' && inScript) {
          if (scriptIsJsonLd) {
            if (jsonLdBlocks.length < 20) jsonLdBlocks.push(scriptText)
          } else {
            for (const url of scriptUrls(scriptText)) {
              push({
                url,
                nameHint: null,
                downloadAttribute: false,
                isAttachment: false,
                fromScript: true,
                isEmbed: false,
                source: 'script'
              })
            }
          }
          inScript = false
          scriptIsJsonLd = false
          scriptText = ''
          return
        }
        if (tag === 'a' && anchor !== null) {
          const current = anchor
          anchor = null
          if (current.href === null) return
          const name = current.name.replace(/\s+/g, ' ').trim().slice(0, 500)
          // Host rules need an absolute URL: `/video-abc/slug/` and
          // `/view_video.php?viewkey=…` are what real video sites emit.
          const absoluteHref =
            resolveAbsoluteUrl(current.href, documentBaseUrl()) ?? current.href
          if (
            current.downloadAttribute ||
            current.isAttachment ||
            looksLikeCandidateUrl(absoluteHref, name.length > 0 ? name : null)
          ) {
            push({
              url: current.href,
              nameHint: name.length > 0 ? name : null,
              downloadAttribute: current.downloadAttribute,
              isAttachment: current.isAttachment,
              fromScript: false,
              isEmbed: false,
              source: 'anchor'
            })
          }
        }
      }
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  )

  parser.write(html)
  parser.end()

  for (const block of jsonLdBlocks.slice(0, 20)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    const values: Array<{ url: string; name: string | null; embed: boolean }> = []
    collectJsonLdValues(parsed, 0, values)
    for (const value of values) {
      push({
        url: value.url,
        nameHint: value.name,
        downloadAttribute: false,
        isAttachment: false,
        fromScript: false,
        isEmbed: value.embed,
        source: 'json-ld'
      })
    }
  }

  const documentBase = documentBaseUrl()

  const deduped = new Map<string, ExtractedCandidate>()
  for (const candidate of raw) {
    const url = resolveScanUrl(candidate.url, documentBase)
    if (url === null) continue
    const existing = deduped.get(url)
    if (
      existing === undefined ||
      (existing.nameHint === null && candidate.nameHint !== null) ||
      (candidate.isAttachment && !existing.isAttachment)
    ) {
      deduped.set(url, {
        url,
        nameHint: candidate.nameHint,
        downloadAttribute: candidate.downloadAttribute,
        isAttachment: candidate.isAttachment,
        fromScript: candidate.fromScript,
        isEmbed: candidate.isEmbed,
        source: candidate.source
      })
    }
  }
  return [...deduped.values()]
}
