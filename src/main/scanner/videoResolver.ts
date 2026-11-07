import {
  MAX_SCAN_NAME_LENGTH,
  MAX_SCAN_VIDEO_ANALYSES,
  MAX_SCAN_VIDEO_ANALYSIS_CONCURRENCY,
  MAX_SCAN_VIDEO_FORMATS,
  type ScanItemStatus,
  type ScanVideoFormat
} from '@shared/scanner'
import type { MediaAnalysis, MediaFormatOption } from '@shared/media'
import { AppError } from '../errors'

/**
 * Resolve video page links and embeds into renderer-safe download options.
 *
 * The resolver calls the existing media engine (normally through the media job
 * manager, so its analysis cache is populated for the later queue step). It
 * carries Concurrency <= 2, a per-session analysis cap and the session abort
 * signal into the yt-dlp child. Only hostnames, bounded titles, a validated
 * public HTTPS thumbnail and opaque option IDs leave this module.
 */

export interface ScanMediaAnalyzeOptions {
  cookie?: string
  signal?: AbortSignal
}

export type ScanMediaAnalyzer = (
  url: string,
  options?: ScanMediaAnalyzeOptions
) => Promise<MediaAnalysis>

export interface VideoResolveInput {
  url: string
  fallbackName: string
}

export interface VideoResolution {
  status: Extract<
    ScanItemStatus,
    | 'ready'
    | 'signin'
    | 'protected'
    | 'unavailable'
    | 'tool-unavailable'
    | 'browser-only'
  >
  title: string | null
  thumbnailUrl: string | null
  durationSeconds: number | null
  width: number | null
  height: number | null
  bestResolution: string | null
  sizeBytes: number | null
  sizeIsEstimate: boolean
  formats: ScanVideoFormat[]
  bestOptionId: string | null
  analysisId: string | null
  expiresAt: number | null
  reason: string | null
}

export interface ResolveVideoCandidatesOptions {
  analyze: ScanMediaAnalyzer
  cookieHost?: string | null
  cookie?: string | null
  signal?: AbortSignal
  cap?: number
  concurrency?: number
  onResult: (index: number, resolution: VideoResolution) => void
}

const DRM_REASON = "This video is DRM-protected and can't be downloaded."
const TOOL_REASON =
  'yt-dlp is not available, so video pages cannot be resolved. Install or update yt-dlp and scan again.'
const SIGNIN_REASON =
  'This video needs a browser sign-in or age verification before it can be resolved.'
export const BROWSER_ONLY_REASON =
  "Can't be read automatically — open it in your browser."
const BLOCKED_BROWSER_TEXT =
  /(?:unsupported url|http error 403|403 forbidden|challenge-platform|cf[-_]?chl|cloudflare|attention required|access denied|bot (?:check|detection)|captcha|turnstile)/i
const SIGNIN_CODES = new Set([
  'MEDIA_ANALYSIS_SIGNIN',
  'MEDIA_NEEDS_LOGIN',
  'HANDOFF_NEEDS_LOGIN',
  'MEDIA_PRIVATE',
  'MEDIA_AGE_RESTRICTED',
  'MEDIA_MEMBERS_ONLY',
  'MEDIA_LOGIN_REQUIRED'
])
const SIGNIN_TEXT =
  /(?:sign[- ]?in|log[- ]?in|login required|age[- ]?(?:restricted|verification)|private video|members[- ]only|requires? (?:authentication|a paid membership))/i
const GENERIC_ANALYSIS_TEXT = /may be unsupported/i

// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const UNSAFE_TEXT = /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i

export function videoIdentityForUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
  const safeId = (value: string | null | undefined): string | null =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
      ? value
      : null

  if (host === 'youtu.be') {
    const id = safeId(segments[0])
    if (id !== null) return `youtube:${id}`
  }
  if (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com')
  ) {
    const queryId = safeId(parsed.searchParams.get('v'))
    const pathId = safeId(
      segments[0] === 'embed' ||
        segments[0] === 'shorts' ||
        segments[0] === 'v' ||
        segments[0] === 'live'
        ? segments[1]
        : null
    )
    const id = queryId ?? pathId
    if (id !== null) return `youtube:${id}`
  }
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    const numeric = segments.find((segment) => /^\d{1,12}$/.test(segment))
    if (numeric !== undefined) return `vimeo:${numeric}`
  }
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = safeId(
      host === 'dai.ly' ? segments[0] : segments[1] === 'video' ? segments[2] : undefined
    )
    if (id !== null) return `dailymotion:${id}`
  }
  if (host === 'twitch.tv' || host === 'clips.twitch.tv' || host.endsWith('.twitch.tv')) {
    const clipIndex = segments.indexOf('clip')
    const id = safeId(
      host === 'clips.twitch.tv'
        ? segments[0]
        : clipIndex >= 0
          ? segments[clipIndex + 1]
          : segments[0] === 'videos'
            ? segments[1]
            : null
    )
    if (id !== null) return `twitch:${id}`
  }
  if (host === 'streamable.com') {
    const id = safeId(segments[0])
    if (id !== null) return `streamable:${id}`
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const index = segments.indexOf('video')
    const id = safeId(index >= 0 ? segments[index + 1] : null)
    if (id !== null) return `tiktok:${id}`
  }
  return null
}

function cleanTitle(value: unknown, fallback: string): string {
  const source = typeof value === 'string' ? value : ''
  const cleaned = source
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const bounded = Array.from(cleaned)
    .slice(0, MAX_SCAN_NAME_LENGTH)
    .join('')
    .trim()
  if (bounded.length === 0 || UNSAFE_TEXT.test(bounded)) return fallback
  return bounded
}

export function safeThumbnail(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null
  }
  if (CONTROL_CHARACTERS.test(value)) return null
  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hostname.length === 0
    ) {
      return null
    }
    return parsed.href
  } catch {
    return null
  }
}

function displaySize(option: MediaFormatOption): {
  bytes: number | null
  isEstimate: boolean
} {
  const bytes = option.estimatedBytes ?? option.filesizeBytes ?? null
  return {
    bytes,
    isEstimate:
      option.sizeIsEstimate === true ||
      (option.filesizeBytes === null && option.estimatedBytes !== null)
  }
}

function shortSide(option: MediaFormatOption): number | null {
  if (option.width !== null && option.height !== null) {
    return Math.min(option.width, option.height)
  }
  return option.height ?? option.width
}

/** Frame heights a quality label may name; anything else is not a resolution. */
const KNOWN_HEIGHTS = new Set([
  144, 180, 240, 288, 320, 360, 400, 432, 480, 540, 576, 720, 1080, 1440,
  2160, 4320
])

/**
 * Read a frame height out of free-form text. Only known heights are accepted,
 * so a bitrate or an arbitrary format id number never becomes a quality.
 */
function heightHintFrom(text: string): number | null {
  const lower = text.toLowerCase()
  if (/\b(?:8k|4320p?)\b/.test(lower)) return 4320
  if (/\b(?:4k|2160p?)\b/.test(lower)) return 2160
  if (/\b(?:2k|1440p?)\b/.test(lower)) return 1440
  for (const match of lower.matchAll(/(?:^|[^0-9])(\d{3,4})(?:p(?![a-z])|(?![0-9]))/g)) {
    const value = Number(match[1])
    if (KNOWN_HEIGHTS.has(value)) return value
  }
  return null
}

/**
 * The frame height of a video option. yt-dlp's generic HTML5 extractor (the
 * hanime1 page and similar ones) reports `height: null` while the format id,
 * note or stream URL still says `1080p`, so the label and the original format
 * ids are read as a fallback instead of showing no resolution at all.
 */
function heightOf(option: MediaFormatOption): number | null {
  const side = shortSide(option)
  if (side !== null) return side
  for (const text of [option.label, ...(option.formatIds ?? [])]) {
    if (typeof text !== 'string') continue
    const hint = heightHintFrom(text)
    if (hint !== null) return hint
  }
  return null
}

function resolutionLabel(option: MediaFormatOption | undefined): string | null {
  if (!option || option.kind !== 'video') return null
  const side = heightOf(option)
  if (side === null) return null
  return `${side}p`
}

function toScanFormat(option: MediaFormatOption): ScanVideoFormat {
  const size = displaySize(option)
  return {
    optionId: option.optionId,
    kind: option.kind,
    label: option.label,
    container: option.container,
    width: option.width,
    height: option.height,
    sizeBytes: size.bytes,
    sizeIsEstimate: size.isEstimate,
    outputFormats:
      Array.isArray(option.outputFormats) && option.outputFormats.length > 0
        ? [...option.outputFormats]
        : ['auto']
  }
}

function buildResolution(
  analysis: MediaAnalysis,
  input: VideoResolveInput
): VideoResolution {
  const formats = analysis.options
    .slice(0, MAX_SCAN_VIDEO_FORMATS)
    .map(toScanFormat)
  const available = new Set(formats.map((format) => format.optionId))
  const preferredId =
    analysis.bestVideoOptionId !== null && available.has(analysis.bestVideoOptionId)
      ? analysis.bestVideoOptionId
      : formats[0]?.optionId ?? null
  const selected = analysis.options.find(
    (option) => option.optionId === preferredId
  )
  const size = selected
    ? displaySize(selected)
    : { bytes: null, isEstimate: false }
  const duration =
    typeof analysis.durationSeconds === 'number' &&
    Number.isFinite(analysis.durationSeconds) &&
    analysis.durationSeconds >= 0
      ? Math.floor(analysis.durationSeconds)
      : null

  return {
    status: 'ready',
    title: cleanTitle(analysis.title, input.fallbackName),
    thumbnailUrl: safeThumbnail(analysis.thumbnailUrl),
    durationSeconds: duration,
    width: selected?.width ?? null,
    height: selected === undefined ? null : heightOf(selected),
    bestResolution: resolutionLabel(selected),
    sizeBytes: size.bytes,
    sizeIsEstimate: size.isEstimate,
    formats,
    bestOptionId: preferredId,
    analysisId: analysis.analysisId,
    expiresAt: analysis.expiresAt,
    reason: null
  }
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return 'SCAN_VIDEO_FAILED'
}

export function classifyVideoError(
  error: unknown,
  aborted: boolean
): Pick<VideoResolution, 'status' | 'reason'> {
  if (aborted || errorCode(error) === 'MEDIA_ANALYSIS_CANCELLED') {
    throw new AppError('SCAN_CANCELLED', 'The scan was cancelled.')
  }
  const code = errorCode(error)
  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''
  if (code === 'MEDIA_DRM_PROTECTED') {
    return { status: 'protected', reason: DRM_REASON }
  }
  if (code === 'MEDIA_TOOL_UNAVAILABLE' || code === 'MEDIA_ENGINE_MISSING') {
    return { status: 'tool-unavailable', reason: TOOL_REASON }
  }
  if (SIGNIN_CODES.has(code)) {
    return { status: 'signin', reason: SIGNIN_REASON }
  }
  if (
    code === 'MEDIA_ANALYSIS_FAILED' &&
    SIGNIN_TEXT.test(message) &&
    !GENERIC_ANALYSIS_TEXT.test(message)
  ) {
    return { status: 'signin', reason: SIGNIN_REASON }
  }
  // A likely video page that yt-dlp cannot read (unsupported extractor,
  // Cloudflare/bot challenge or 403) is still useful to the user. Expose it as
  // a browser-only card instead of failing silently. There is no retry: the
  // resolver calls the analyzer exactly once per item.
  if (code === 'MEDIA_UNSUPPORTED_MEDIA') {
    return { status: 'browser-only', reason: BROWSER_ONLY_REASON }
  }
  if (BLOCKED_BROWSER_TEXT.test(message)) {
    return { status: 'browser-only', reason: BROWSER_ONLY_REASON }
  }
  if (code === 'MEDIA_UNSUPPORTED_PLAYLIST') {
    return {
      status: 'unavailable',
      reason: 'Playlists and collections are not supported. Open a single video page.'
    }
  }
  if (code === 'MEDIA_UNSUPPORTED_LIVE') {
    return {
      status: 'unavailable',
      reason: 'This is a live stream. Download it after it ends (as a VOD).'
    }
  }
  if (code === 'MEDIA_ANALYSIS_TIMEOUT') {
    return {
      status: 'unavailable',
      reason: 'The site took too long to resolve this video.'
    }
  }
  if (code === 'MEDIA_ANALYSIS_EXTRACTOR_FAILED') {
    return {
      status: 'unavailable',
      reason: 'yt-dlp could not understand this video page. The site may have changed.'
    }
  }
  return {
    status: 'unavailable',
    reason: 'This video could not be resolved. It may be private or unsupported.'
  }
}

export interface ResolveVideoResult {
  index: number
  resolution: VideoResolution
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * Resolve inputs with bounded parallelism. Items beyond the cap are left
 * untouched so the session can report a clean "limited" state.
 */
export async function resolveVideoCandidates(
  inputs: readonly VideoResolveInput[],
  options: ResolveVideoCandidatesOptions
): Promise<void> {
  const cap = Math.max(
    0,
    Math.min(options.cap ?? MAX_SCAN_VIDEO_ANALYSES, MAX_SCAN_VIDEO_ANALYSES)
  )
  const limit = Math.max(
    1,
    Math.min(
      options.concurrency ?? MAX_SCAN_VIDEO_ANALYSIS_CONCURRENCY,
      MAX_SCAN_VIDEO_ANALYSIS_CONCURRENCY
    )
  )
  const targets = inputs.slice(0, cap)
  let cursor = 0
  let stopped = false

  const cookieFor = (url: string): string | undefined => {
    if (
      typeof options.cookie !== 'string' ||
      options.cookie.length === 0 ||
      typeof options.cookieHost !== 'string' ||
      options.cookieHost.length === 0
    ) {
      return undefined
    }
    try {
      return new URL(url).host === options.cookieHost ? options.cookie : undefined
    } catch {
      return undefined
    }
  }

  const runners = Array.from(
    { length: Math.min(limit, targets.length) },
    async () => {
      for (;;) {
        if (stopped || isAborted(options.signal)) return
        const index = cursor
        cursor += 1
        if (index >= targets.length) return
        const target = targets[index]!
        const cookie = cookieFor(target.url)
        let resolution: VideoResolution
        try {
          const analysis = await options.analyze(target.url, {
            ...(cookie === undefined ? {} : { cookie }),
            ...(options.signal === undefined ? {} : { signal: options.signal })
          })
          if (isAborted(options.signal)) {
            throw new AppError('SCAN_CANCELLED', 'The scan was cancelled.')
          }
          resolution = buildResolution(analysis, target)
        } catch (error) {
          if (isAborted(options.signal)) {
            throw new AppError('SCAN_CANCELLED', 'The scan was cancelled.')
          }
          resolution = {
            title: null,
            thumbnailUrl: null,
            durationSeconds: null,
            width: null,
            height: null,
            bestResolution: null,
            sizeBytes: null,
            sizeIsEstimate: false,
            formats: [],
            bestOptionId: null,
            analysisId: null,
            expiresAt: null,
            ...classifyVideoError(error, isAborted(options.signal))
          }
        }
        if (isAborted(options.signal)) return
        options.onResult(index, resolution)
        if (resolution.status === 'tool-unavailable') {
          stopped = true
          return
        }
      }
    }
  )

  await Promise.all(runners)
}

export const videoResolverInternals = {
  buildResolution,
  cleanTitle,
  safeThumbnail,
  displaySize
}
