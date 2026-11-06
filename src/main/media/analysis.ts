/**
 * Analysis and format parsing for the media engine: bounded display text,
 * detected-manifest requests, playlist entry parsing, DRM detection and the
 * analyze() flow. Everything here is pure apart from analyze(), which receives
 * its process, cookie, clock and cache ports from engine.ts.
 */
import { MAX_COLLECTION_ENTRY_TITLE_LENGTH } from '@shared/batches'
import type { CollectionEntry, CollectionEntryErrorCode } from '@shared/batches'
import { normalizeMediaSourceUrl, parseMediaAnalysis } from '@shared/media'
import type { MediaAnalysis, MediaToolState } from '@shared/media'
import { ValidationError } from '@shared/validation'
import { AppError } from '../errors'
import { buildAnalyzeArgs } from './args'
import { MediaInfoError, buildMediaAnalysis } from './formats'
import type { InternalMediaOption } from './formats'
import {
  ProcessAbortedError,
  ProcessOutputError,
  ProcessStartError,
  ProcessTimeoutError
} from './process'
import type { CapturedProcessResult } from './process'
import type { Toolchain } from './toolchain'
import { looksLikeExtractorFailure } from './updater'

export const MAX_ANALYSIS_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_RAW_COLLECTION_TITLE_LENGTH = 4096
const FALLBACK_ENTRY_TITLE = 'Untitled entry'
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/** Reject URL- and path-shaped display text before it reaches a public DTO. */
const UNSAFE_DISPLAY_TEXT =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i
const MAX_DIRECT_HEADER_LENGTH = 8192

export const YTDLP_HINT =
  'Install yt-dlp (for example: winget install yt-dlp.yt-dlp or pip install -U yt-dlp), place yt-dlp.exe in vendor/yt-dlp/, or set DONDOWNLOAD_YTDLP_PATH. yt-dlp is not bundled or downloaded by DonDownload.'

export const FFMPEG_HINT =
  'Install FFmpeg (for example: winget install Gyan.FFmpeg), place ffmpeg.exe in vendor/ffmpeg/ or vendor/ffmpeg/bin/, or set DONDOWNLOAD_FFMPEG_PATH. FFmpeg is not bundled or downloaded by DonDownload.'

export interface MediaDirectDownload {
  kind: 'hls' | 'dash'
  referer: string
  userAgent: string
  cookie?: string
  title: string
}

export interface StoredAnalysis {
  id: string
  /** Normalized page URL exactly as the user supplied it. */
  url: string
  /** yt-dlp target; differs only for a normalized Vimeo player URL. */
  targetUrl: string
  /** Whether this analysis was produced with an opted-in cookie header. */
  usedCookies: boolean
  title: string
  expiresAt: number
  options: Map<string, InternalMediaOption>
}

interface PlaylistEntryDraft {
  dto: CollectionEntry
  url: string | null
  durationSeconds: number | null
}

export function firstLineVersion(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) return null
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > 0 ? clean.slice(0, 100) : null
}

export function ffmpegVersion(output: string): string | null {
  const first = firstLineVersion(output)
  if (first === null) return null
  const match = /ffmpeg version\s+(\S+)/i.exec(first)
  return (match?.[1] ?? first).slice(0, 100)
}

export function toolUnavailableError(state: MediaToolState): AppError {
  return new AppError(
    'MEDIA_TOOL_UNAVAILABLE',
    state.message ?? 'yt-dlp is not available.',
    state.hint ?? YTDLP_HINT
  )
}

export function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/**
 * Produce bounded display text that cannot smuggle a URL or filesystem path
 * through a renderer-safe title field.
 */
export function parseDirectDownload(value: unknown): MediaDirectDownload | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid detected media download request.')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['kind', 'referer', 'userAgent', 'cookie', 'title'].includes(key)) {
      throw new ValidationError(
        'The detected media download request contains unsupported fields.'
      )
    }
  }
  if (record.kind !== 'hls' && record.kind !== 'dash') {
    throw new ValidationError('The detected stream kind is unsupported.')
  }
  const referer = normalizeMediaSourceUrl(record.referer)
  if (referer.length > 4096) {
    throw new ValidationError('The detected media referer is too long.')
  }
  const readHeader = (
    key: 'userAgent' | 'cookie',
    maximum: number
  ): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined
    const candidate = record[key]
    if (
      typeof candidate !== 'string' ||
      candidate.trim().length === 0 ||
      candidate.length > maximum ||
      CONTROL_CHARACTERS.test(candidate) ||
      /[\r\n]/.test(candidate)
    ) {
      throw new ValidationError(`The detected media ${key} is invalid.`)
    }
    return candidate
  }
  const userAgent = readHeader('userAgent', 512)
  if (userAgent === undefined) {
    throw new ValidationError('The detected media user agent is missing.')
  }
  const cookie = readHeader('cookie', MAX_DIRECT_HEADER_LENGTH)
  const title =
    typeof record.title === 'string' &&
    record.title.trim().length > 0 &&
    record.title.length <= 500 &&
    !CONTROL_CHARACTERS.test(record.title)
      ? record.title
      : 'Detected media'
  return {
    kind: record.kind,
    referer,
    userAgent,
    ...(cookie === undefined ? {} : { cookie }),
    title
  }
}

/** Optional one-job Cookie header on an analysis download request. */
export function readOptionalCookie(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'cookie')) return undefined
  const value = record.cookie
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_DIRECT_HEADER_LENGTH ||
    /[\r\n]/.test(value) ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError('The browser cookie header is invalid.')
  }
  return value
}

export function cleanDisplayText(
  value: unknown,
  maximum: number,
  fallback: string
): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return fallback
  if (UNSAFE_DISPLAY_TEXT.test(cleaned)) return fallback
  const bounded = cleaned.slice(0, maximum).trim()
  return bounded.length === 0 ? fallback : bounded
}

/**
 * Vimeo's public watch page regularly refuses yt-dlp's web client
 * (`The web client only works when logged-in`), while the player endpoint for
 * the same numeric video works without credentials. Only the target handed to
 * yt-dlp changes: the analysis keeps the user's original page URL for display
 * and association checks.
 */
export function normalizeVimeoPlayerUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'vimeo.com' && host !== 'www.vimeo.com') return null

  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
  const numericId = /^\d{1,12}$/
  let id: string | null = null
  let hash: string | null = null

  if (segments.length === 1 && numericId.test(segments[0] ?? '')) {
    id = segments[0] ?? null
  } else if (
    segments.length === 2 &&
    numericId.test(segments[0] ?? '') &&
    /^[A-Za-z0-9]{1,64}$/.test(segments[1] ?? '')
  ) {
    // Unlisted video: vimeo.com/<id>/<hash>
    id = segments[0] ?? null
    hash = segments[1] ?? null
  } else if (
    segments.length === 3 &&
    segments[0] === 'channels' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(segments[1] ?? '') &&
    numericId.test(segments[2] ?? '')
  ) {
    // Channel page: vimeo.com/channels/<channel>/<id>
    id = segments[2] ?? null
  }
  if (id === null) return null

  if (hash === null) {
    const queryHash = parsed.searchParams.get('h')
    if (queryHash !== null && /^[A-Za-z0-9]{1,64}$/.test(queryHash)) {
      hash = queryHash
    }
  }

  const player = new URL(`https://player.vimeo.com/video/${id}`)
  if (hash !== null) player.searchParams.set('h', hash)
  return player.href
}

/** yt-dlp's DRM refusal must not be shown as a generic download failure. */
const DRM_ERROR_TEXT = /DRM(?:[-\s]*protected)|\bDRM protection\b/i

export function looksLikeDrmError(output: string): boolean {
  return DRM_ERROR_TEXT.test(output)
}

/**
 * yt-dlp's sign-in/age-gate refusal must be distinguishable from an
 * unsupported or broken page so the scanner can show a sign-in state instead
 * of a generic failure.
 */
const SIGNIN_ERROR_TEXT =
  /(?:sign in to confirm|please (?:sign|log) in|login required|log ?in required|requires? (?:a )?(?:sign[- ]?in|login|authentication)|age[- ]?(?:restricted|verification)|confirm your age|private video|members[- ]only|available to (?:members|subscribers) only|HTTP Error 401)/i

export function looksLikeSigninError(output: string): boolean {
  return SIGNIN_ERROR_TEXT.test(output)
}

/** yt-dlp's own `--max-filesize` refusal is the app's size-cap outcome. */
const MAX_FILESIZE_ERROR_TEXT = /max[-\s]?filesize|larger than the (?:maximum|allowed)/i

export function looksLikeMaxFilesizeError(output: string): boolean {
  return MAX_FILESIZE_ERROR_TEXT.test(output)
}

/** Durations stay private; only finite, non-negative values are retained. */
function safeCollectionDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
}

interface EntryProblem {
  code: CollectionEntryErrorCode
  reason: string
}

function entryProblem(field: Record<string, unknown>): EntryProblem | null {
  if (field.has_drm === true || field.drm === true) {
    return { code: 'unsupported', reason: 'DRM-protected media is not supported.' }
  }

  const liveStatus =
    typeof field.live_status === 'string'
      ? field.live_status.toLowerCase()
      : ''
  if (
    field.is_live === true ||
    liveStatus === 'is_live' ||
    liveStatus === 'is_upcoming' ||
    liveStatus === 'post_live'
  ) {
    return { code: 'unsupported', reason: 'Live streams are not supported.' }
  }

  const availability =
    typeof field.availability === 'string'
      ? field.availability.toLowerCase()
      : ''
  if (availability === 'private' || availability === 'needs_auth') {
    return { code: 'private', reason: 'This entry requires a sign-in.' }
  }
  if (availability === 'subscriber_only' || availability === 'premium') {
    return {
      code: 'members-only',
      reason: 'This entry requires a paid membership.'
    }
  }
  if (
    availability === 'region_restricted' ||
    field.region_restricted === true
  ) {
    return {
      code: 'region-restricted',
      reason: 'This entry is not available in your region.'
    }
  }
  if (field.age_restricted === true) {
    return {
      code: 'age-restricted',
      reason: 'This entry requires age verification.'
    }
  }

  // Flat listings often represent unavailable YouTube entries as a title
  // placeholder instead of a provider error. Map only known placeholders; raw
  // error text is never forwarded.
  const title = typeof field.title === 'string' ? field.title : ''
  if (/\[private video\]/i.test(title)) {
    return { code: 'private', reason: 'This entry is private.' }
  }
  if (/\[(?:deleted|removed) video\]/i.test(title)) {
    return { code: 'removed', reason: 'This entry was removed.' }
  }
  if (/\[unavailable video\]/i.test(title)) {
    return { code: 'unavailable', reason: 'This entry is unavailable.' }
  }
  if (/\[(?:members[- ]only|premium)\]/i.test(title)) {
    return {
      code: 'members-only',
      reason: 'This entry requires a paid membership.'
    }
  }
  if (/\[age[- ]restricted\]/i.test(title)) {
    return {
      code: 'age-restricted',
      reason: 'This entry requires age verification.'
    }
  }

  return null
}

function entryPageUrl(field: Record<string, unknown>): string | null {
  for (const candidate of [field.url, field.webpage_url, field.original_url]) {
    if (typeof candidate !== 'string') continue
    try {
      return normalizeMediaSourceUrl(candidate)
    } catch {
      // Try the next candidate; a malformed flat URL is not a hard failure for
      // the whole playlist.
    }
  }
  return null
}

export function buildPlaylistEntryDraft(
  raw: unknown,
  position: number,
  id: string
): PlaylistEntryDraft {
  const field = asPlainRecord(raw)
  if (field === null) {
    return {
      dto: {
        id,
        position,
        title: FALLBACK_ENTRY_TITLE,
        availability: 'unavailable',
        errorCode: 'unknown',
        errorReason: 'This entry could not be read.'
      },
      url: null,
      durationSeconds: null
    }
  }

  const rawTitle = typeof field.title === 'string' ? field.title : ''
  const title = cleanDisplayText(
    rawTitle,
    MAX_COLLECTION_ENTRY_TITLE_LENGTH,
    FALLBACK_ENTRY_TITLE
  )
  const problem = entryProblem(field)
  if (problem !== null) {
    return {
      dto: {
        id,
        position,
        title,
        availability: 'unavailable',
        errorCode: problem.code,
        errorReason: problem.reason
      },
      url: null,
      durationSeconds: safeCollectionDuration(field.duration)
    }
  }

  if (rawTitle.length > MAX_RAW_COLLECTION_TITLE_LENGTH) {
    return {
      dto: {
        id,
        position,
        title,
        availability: 'unavailable',
        errorCode: 'too-large',
        errorReason: 'This entry has too much metadata.'
      },
      url: null,
      durationSeconds: null
    }
  }

  const url = entryPageUrl(field)
  if (url === null) {
    return {
      dto: {
        id,
        position,
        title,
        availability: 'unavailable',
        errorCode: 'unavailable',
        errorReason: 'This entry has no playable page.'
      },
      url: null,
      durationSeconds: safeCollectionDuration(field.duration)
    }
  }

  return {
    dto: {
      id,
      position,
      title,
      availability: 'available',
      errorCode: null,
      errorReason: null
    },
    url,
    durationSeconds: safeCollectionDuration(field.duration)
  }
}

export async function filterPublicFormatTargets(
  rawInfo: unknown,
  assertPublicTarget: (url: string) => Promise<void>
): Promise<unknown> {
    if (
      typeof rawInfo !== 'object' ||
      rawInfo === null ||
      Array.isArray(rawInfo)
    ) {
      return rawInfo
    }
    const info = rawInfo as Record<string, unknown>
    if (!Array.isArray(info.formats)) return rawInfo

    // Formats often share one CDN host. Resolve each distinct hostname once
    // during this analysis rather than issuing one DNS query per format.
    const targetChecks = new Map<string, Promise<boolean>>()
    const formats = await Promise.all(
      info.formats.map(async (value): Promise<unknown | null> => {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          return null
        }
        const format = value as Record<string, unknown>
        if (typeof format.url !== 'string') return null

        let url: string
        try {
          url = normalizeMediaSourceUrl(format.url)
        } catch {
          return null
        }

        const host = new URL(url).hostname.toLowerCase()
        let check = targetChecks.get(host)
        if (!check) {
          check = assertPublicTarget(url).then(
            () => true,
            () => false
          )
          targetChecks.set(host, check)
        }
        if (!(await check)) return null
        return { ...format, url }
      })
    )

    return {
      ...info,
      formats: formats.filter((format): format is Record<string, unknown> =>
        format !== null && typeof format === 'object'
      )
    }
  }

export async function filterPublicThumbnail(
  rawInfo: unknown,
  assertPublicTarget: (url: string) => Promise<void>
): Promise<string | null> {
    if (
      typeof rawInfo !== 'object' ||
      rawInfo === null ||
      Array.isArray(rawInfo)
    ) {
      return null
    }
    const thumbnail = (rawInfo as Record<string, unknown>).thumbnail
    if (typeof thumbnail !== 'string' || thumbnail.length > 2048) return null
    try {
      const parsed = new URL(thumbnail)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        return null
      }
      const normalized = normalizeMediaSourceUrl(parsed.href)
      await assertPublicTarget(normalized)
      return normalized
    } catch {
      return null
    }
  }

export interface MediaAnalyzerOptions {
  now: () => number
  analysisTtlMs: number
  analysisTimeoutMs: number
  isClosing: () => boolean
  newOpaqueId: (prefix: 'analysis' | 'option') => string
  resolveToolchain: () => Promise<Toolchain>
  runCaptured: (
    command: string,
    args: readonly string[],
    options: {
      timeoutMs: number
      maxOutputBytes: number
      signal?: AbortSignal
    }
  ) => Promise<CapturedProcessResult>
  assertPublicTarget: (url: string) => Promise<void>
  writeCookieFile: (
    directory: string,
    cookieHeader: string,
    targetUrl: string
  ) => Promise<string>
  removeCookieFile: (file: string) => Promise<void>
  cookieTempDir: string
  storeAnalysis: (analysis: StoredAnalysis) => void
  removeExpired: (current: number) => void
}

export interface MediaAnalyzer {
  analyze(
    url: string,
    analyzeOptions?: { cookie?: string; signal?: AbortSignal }
  ): Promise<MediaAnalysis>
}

export function createMediaAnalyzer(
  options: MediaAnalyzerOptions
): MediaAnalyzer {
  const {
    now,
    analysisTtlMs,
    analysisTimeoutMs,
    isClosing,
    newOpaqueId,
    resolveToolchain,
    runCaptured,
    assertPublicTarget,
    writeCookieFile,
    removeCookieFile,
    cookieTempDir,
    storeAnalysis,
    removeExpired
  } = options

  async function analyze(
    url: string,
    analyzeOptions: { cookie?: string; signal?: AbortSignal } = {}
  ): Promise<MediaAnalysis> {
    if (isClosing()) {
      throw new AppError(
        'MEDIA_ANALYSIS_CANCELLED',
        'The analysis was cancelled.'
      )
    }
    const normalized = normalizeMediaSourceUrl(url)
    const targetUrl = normalizeVimeoPlayerUrl(normalized) ?? normalized
    await assertPublicTarget(normalized)
    if (targetUrl !== normalized) await assertPublicTarget(targetUrl)

    const toolchain = await resolveToolchain()
    if (toolchain.ytdlpPath === null) {
      throw toolUnavailableError(toolchain.state)
    }

    const cookie =
      typeof analyzeOptions.cookie === 'string' &&
      analyzeOptions.cookie.trim().length > 0
        ? analyzeOptions.cookie
        : null
    let cookieFile: string | null = null
    if (cookie !== null) {
      try {
        cookieFile = await writeCookieFile(cookieTempDir, cookie, targetUrl)
      } catch {
        throw new AppError(
          'MEDIA_COOKIE_UNAVAILABLE',
          'The browser cookie file could not be prepared for this analysis.'
        )
      }
    }

    let result
    try {
      result = await runCaptured(
        toolchain.ytdlpPath,
        buildAnalyzeArgs(
          targetUrl,
          toolchain.denoPath,
          toolchain.impersonate,
          cookieFile
        ),
        {
          timeoutMs: analysisTimeoutMs,
          maxOutputBytes: MAX_ANALYSIS_OUTPUT_BYTES,
          ...(analyzeOptions.signal === undefined
            ? {}
            : { signal: analyzeOptions.signal })
        }
      )
    } catch (error) {
      if (error instanceof ProcessAbortedError) {
        throw new AppError(
          'MEDIA_ANALYSIS_CANCELLED',
          'The analysis was cancelled.'
        )
      }
      if (error instanceof ProcessTimeoutError) {
        throw new AppError(
          'MEDIA_ANALYSIS_TIMEOUT',
          'The site took too long to analyze. Try again.'
        )
      }
      if (error instanceof ProcessOutputError) {
        throw new AppError(
          'MEDIA_ANALYSIS_FAILED',
          'yt-dlp returned an unexpectedly large response.'
        )
      }
      if (error instanceof ProcessStartError) {
        throw new AppError(
          'MEDIA_TOOL_UNAVAILABLE',
          'yt-dlp could not be started.',
          YTDLP_HINT
        )
      }
      throw new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'yt-dlp could not analyze this page.'
      )
    } finally {
      if (cookieFile !== null) await removeCookieFile(cookieFile)
    }

    if (result.code !== 0) {
      if (looksLikeDrmError(`${result.stderr}\n${result.stdout}`)) {
        throw new AppError(
          'MEDIA_DRM_PROTECTED',
          "This video is DRM-protected and can't be downloaded."
        )
      }
      if (looksLikeSigninError(`${result.stderr}\n${result.stdout}`)) {
        throw new AppError(
          'MEDIA_ANALYSIS_SIGNIN',
          'This video needs a browser sign-in or age verification.'
        )
      }
      // A YouTube extractor change usually appears only in stderr. Mark that
      // category without forwarding the raw output so the job manager can try
      // a verified yt-dlp update before showing the generic failure.
      if (looksLikeExtractorFailure(`${result.stderr}\n${result.stdout}`)) {
        throw new AppError(
          'MEDIA_ANALYSIS_EXTRACTOR_FAILED',
          'yt-dlp could not understand this page. The site may have changed.',
          'Try again after yt-dlp is updated.'
        )
      }
      throw new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'yt-dlp could not analyze this page. The page may be unsupported, private, DRM-protected or require a sign-in.',
        'Only public videos are supported. DonDownload does not use cookies, browser credentials, DRM or CAPTCHA bypass.'
      )
    }

    let rawInfo: unknown
    try {
      rawInfo = JSON.parse(result.stdout)
    } catch {
      throw new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'yt-dlp returned an unreadable response.'
      )
    }

    let built
    try {
      const verifiedInfo = await filterPublicFormatTargets(rawInfo, assertPublicTarget)
      const thumbnailUrl = await filterPublicThumbnail(rawInfo, assertPublicTarget)
      built = buildMediaAnalysis(verifiedInfo, {
        ffmpegAvailable: toolchain.ffmpegPath !== null,
        newOptionId: () => newOpaqueId('option')
      })
      built.thumbnailUrl = thumbnailUrl
    } catch (error) {
      if (error instanceof MediaInfoError) {
        if (error.reason === 'playlist') {
          throw new AppError(
            'MEDIA_UNSUPPORTED_PLAYLIST',
            error.message,
            'Open a single video page instead of a playlist or collection.'
          )
        }
        if (error.reason === 'live') {
          throw new AppError('MEDIA_UNSUPPORTED_LIVE', error.message)
        }
        if (error.reason === 'drm') {
          throw new AppError('MEDIA_DRM_PROTECTED', error.message)
        }
        throw new AppError('MEDIA_UNSUPPORTED_MEDIA', error.message)
      }
      throw new AppError(
        'MEDIA_ANALYSIS_FAILED',
        'The page metadata could not be understood.'
      )
    }

    const current = Math.floor(now())
    removeExpired(current)

    const analysisId = newOpaqueId('analysis')
    const expiresAt = current + analysisTtlMs
    const dto = parseMediaAnalysis({
      analysisId,
      title: built.title,
      thumbnailUrl: built.thumbnailUrl,
      durationSeconds: built.durationSeconds,
      options: built.options.map((option) => option.dto),
      bestVideoOptionId: built.bestVideoOptionId,
      bestAudioOptionId: built.bestAudioOptionId,
      expiresAt
    })

    const storedOptions = new Map<string, InternalMediaOption>()
    for (const option of built.options) {
      storedOptions.set(option.dto.optionId, option)
    }

    storeAnalysis({
      id: analysisId,
      url: normalized,
      targetUrl,
      usedCookies: cookie !== null,
      title: built.title,
      expiresAt,
      options: storedOptions
    })

    return dto
  }

  return { analyze }
}
