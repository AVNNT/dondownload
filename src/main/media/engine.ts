/**
 * Milestone 3A media engine (yt-dlp + FFmpeg).
 *
 * Integration surface for the media job manager:
 * - `getToolState()` probes yt-dlp/FFmpeg without downloading anything.
 * - `analyze(url)` returns opaque analysis/option IDs. Raw URLs, format IDs
 *   and selectors stay in an in-memory map and never enter public DTOs.
 * - `download(request, onProgress)` revalidates the analysis association,
 *   expiration and page URL before running a fixed, shell-free yt-dlp child.
 * - `cancel(jobId)` terminates the child tree and is bounded on Windows.
 *
 * Fixed subprocess arguments, `--ignore-config`, no cookies/browser profile,
 * no aria2, and no user-controlled flags/templates are core security
 * requirements. Subprocess output is never logged or surfaced verbatim.
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AppError } from '../errors'
import {
  assertPublicTarget as assertPublicTargetWithLookup,
  defaultPublicTargetLookup,
  type PublicLookupAddress,
  type PublicTargetLookup
} from '../net/publicTarget'
import {
  MAX_COLLECTION_ENTRIES,
  MAX_COLLECTION_ENTRY_TITLE_LENGTH,
  MAX_COLLECTION_TITLE_LENGTH,
  parseCollectionPreview,
  parseCreateCollectionBatchInput
} from '@shared/batches'
import type {
  CollectionEntry,
  CollectionEntryErrorCode,
  CollectionPreview
} from '@shared/batches'
import {
  isMediaOutputFormat,
  normalizeMediaSourceUrl,
  parseMediaAnalysis,
  parseMediaAnalysisId,
  parseMediaJobId,
  parseMediaOptionId
} from '@shared/media'
import type {
  MediaAnalysis,
  MediaOutputFormat,
  MediaToolState
} from '@shared/media'
import { ValidationError, sanitizeFilename } from '@shared/validation'
import {
  buildAnalyzeArgs,
  buildDownloadArgs,
  buildPlaylistArgs,
  isMergingLine,
  parseProgressLine
} from './args'
import {
  MediaInfoError,
  buildMediaAnalysis
} from './formats'
import type {
  InternalMediaOption,
  InternalOutputChoice
} from './formats'
import { isFile, locateMediaTool } from './locator'
import { looksLikeExtractorFailure } from './updater'
import {
  ProcessAbortedError,
  ProcessOutputError,
  ProcessStartError,
  ProcessTimeoutError,
  defaultMediaSpawn,
  runCapturedProcess,
  terminateProcessTree
} from './process'
import type {
  CapturedProcessResult,
  MediaProcess,
  MediaSpawn
} from './process'

const DEFAULT_ANALYSIS_TTL_MS = 10 * 60_000
const DEFAULT_COLLECTION_TTL_MS = 10 * 60_000
const DEFAULT_ANALYSIS_TIMEOUT_MS = 60_000
const DEFAULT_CANCEL_GRACE_MS = 5_000
const DOWNLOAD_SETTLE_MARGIN_MS = 250
const TOOL_PROBE_TIMEOUT_MS = 5_000
const MAX_ANALYSIS_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_ANALYSES = 32
const MAX_COLLECTIONS = 8
const MAX_BASE_LENGTH = 100
const MAX_RAW_COLLECTION_TITLE_LENGTH = 4096
const FALLBACK_COLLECTION_TITLE = 'Playlist'
const FALLBACK_ENTRY_TITLE = 'Untitled entry'
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/** Reject URL- and path-shaped display text before it reaches a public DTO. */
const UNSAFE_DISPLAY_TEXT =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i
const SAFE_SELECTOR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\+[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/
/**
 * Application-generated selector for a detected HLS/DASH manifest. `bestvideo*`
 * includes combined streams, `bestaudio` fills the audio track, and `best` is
 * the single-file fallback. This value never comes from the page or the user.
 */
const DIRECT_FORMAT_SELECTOR = 'bestvideo*+bestaudio/best'
const MAX_DIRECT_HEADER_LENGTH = 8192

const YTDLP_HINT =
  'Install yt-dlp (for example: winget install yt-dlp.yt-dlp or pip install -U yt-dlp), place yt-dlp.exe in vendor/yt-dlp/, or set DONDOWNLOAD_YTDLP_PATH. yt-dlp is not bundled or downloaded by DonDownload.'

const FFMPEG_HINT =
  'Install FFmpeg (for example: winget install Gyan.FFmpeg), place ffmpeg.exe in vendor/ffmpeg/ or vendor/ffmpeg/bin/, or set DONDOWNLOAD_FFMPEG_PATH. FFmpeg is not bundled or downloaded by DonDownload.'

export interface MediaDownloadProgress {
  status: 'downloading' | 'merging'
  completedBytes: number
  totalBytes: number | null
  speedBps: number
  filePath: string | null
}

export interface MediaDirectDownload {
  kind: 'hls' | 'dash'
  referer: string
  userAgent: string
  cookie?: string
  title: string
}

export interface MediaDownloadRequest {
  jobId: string
  sourceUrl: string
  analysisId: string
  optionId: string
  dir: string
  maxBytes?: number | null
  /** Requested output container; omitted means `auto`. */
  outputFormat?: MediaOutputFormat
  /**
   * NDM-style stream download. When present there is no opaque analysis; the
   * source URL is already the detected manifest or pinned HLS variant.
   */
  direct?: MediaDirectDownload
  /** Known total for progress/validation; used with `direct` only. */
  expectedBytes?: number | null
}

export interface MediaDownloadResult {
  filePath: string
  totalBytes: number | null
}

/**
 * INTERNAL selection target. It is returned only to main-process orchestration
 * code and must never cross IPC or the native bridge. `url` is a normalized
 * public page URL, not a yt-dlp selector or raw metadata value.
 */
export interface MediaCollectionTarget {
  entryId: string
  url: string
  title: string
  durationSeconds: number | null
  position: number
}

export interface MediaEngine {
  getToolState(): Promise<MediaToolState>
  analyze(url: string): Promise<MediaAnalysis>
  /**
   * Resolve an explicit playlist page into an ephemeral, renderer-safe
   * preview. Uses a flat metadata listing only; nothing is downloaded.
   */
  analyzeCollection(url: string): Promise<CollectionPreview>
  /**
   * INTERNAL: resolve explicitly selected preview entries to normalized page
   * URLs after revalidating their public target. Queueing is intentionally not
   * part of this step.
   */
  resolveCollectionEntries(
    previewId: string,
    entryIds: readonly string[]
  ): Promise<MediaCollectionTarget[]>
  download(
    request: MediaDownloadRequest,
    onProgress: (update: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult>
  cancel(jobId: string): void
  /**
   * Stop every in-flight download, analysis and tool probe. Resolves after
   * downloads have settled and captured children have closed, or the bounded
   * abort/cancel grace elapsed. Once called, no new engine work can start.
   */
  cancelAll(): Promise<void>
}

export type MediaLookupAddress = PublicLookupAddress
export type MediaLookup = PublicTargetLookup

/**
 * Production callers only pass `env` and `platform`. The other fields exist so
 * tests can inject a fake child process, DNS resolver and clock without using
 * a real network or real binaries.
 */
export interface MediaEngineOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: string
  /** `<userData>/tools/yt-dlp`; managed copies newer than bundled win. */
  managedToolsDir?: string | null
  spawn?: MediaSpawn
  lookup?: MediaLookup
  now?: () => number
  analysisTtlMs?: number
  collectionTtlMs?: number
  analysisTimeoutMs?: number
  cancellationGraceMs?: number
  createId?: (prefix: string) => string
}

interface StoredAnalysis {
  id: string
  /** Normalized page URL exactly as the user supplied it. */
  url: string
  /** yt-dlp target; differs only for a normalized Vimeo player URL. */
  targetUrl: string
  title: string
  expiresAt: number
  options: Map<string, InternalMediaOption>
}

interface StoredCollection {
  id: string
  /** Normalized playlist page URL. Never returned from the public API. */
  url: string
  expiresAt: number
  entryIds: string[]
}

interface StoredCollectionEntry {
  previewId: string
  position: number
  /** Normalized entry page URL; null when the entry is unavailable. */
  url: string | null
  title: string
  durationSeconds: number | null
}

interface PlaylistEntryDraft {
  dto: CollectionEntry
  url: string | null
  durationSeconds: number | null
}

interface Toolchain {
  state: MediaToolState
  ytdlpPath: string | null
  ffmpegPath: string | null
  denoPath: string | null
  /** True only when the active yt-dlp build lists a Chrome impersonate target. */
  impersonate: boolean
}

interface ActiveDownload {
  child: MediaProcess | null
  cancelRequested: boolean
  cancelTimer: NodeJS.Timeout | null
  forceCancel: (() => void) | null
}

interface PendingDownload {
  cancelRequested: boolean
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

function firstLineVersion(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) return null
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > 0 ? clean.slice(0, 100) : null
}

function ffmpegVersion(output: string): string | null {
  const first = firstLineVersion(output)
  if (first === null) return null
  const match = /ffmpeg version\s+(\S+)/i.exec(first)
  return (match?.[1] ?? first).slice(0, 100)
}

function toolUnavailableError(state: MediaToolState): AppError {
  return new AppError(
    'MEDIA_TOOL_UNAVAILABLE',
    state.message ?? 'yt-dlp is not available.',
    state.hint ?? YTDLP_HINT
  )
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate)
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function escapeOutputTemplate(value: string): string {
  // yt-dlp treats '%' as the start of a template placeholder. A sanitized
  // title may still contain '%', so escape it rather than allowing the title
  // to alter the output template.
  return value.replace(/%/g, '%%')
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/**
 * Produce bounded display text that cannot smuggle a URL or filesystem path
 * through a renderer-safe title field.
 */
function parseDirectDownload(value: unknown): MediaDirectDownload | null {
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

function cleanDisplayText(
  value: unknown,
  maximum: number,
  fallback: string
): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value
    .normalize('NFKC')
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

/** yt-dlp's own `--max-filesize` refusal is the app's size-cap outcome. */
const MAX_FILESIZE_ERROR_TEXT = /max[-\s]?filesize|larger than the (?:maximum|allowed)/i

function looksLikeMaxFilesizeError(output: string): boolean {
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

function buildPlaylistEntryDraft(
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

/**
 * Every download runs inside its own hidden staging directory below the
 * selected output folder. The job ID keeps concurrent downloads of the same
 * title apart while only yt-dlp intermediates live there; the visible final
 * file is moved to the output folder without any bracketed ID.
 */
const STAGING_DIR_PREFIX = '.dondownload-'
const MAX_FINAL_NAME_ATTEMPTS = 1_000

function buildStem(title: string, maximum: number): string {
  let stem: string
  try {
    stem = sanitizeFilename(title)
  } catch {
    stem = 'media'
  }

  stem = stem
    .replace(/[. ]+$/g, '')
    .slice(0, maximum)
    .replace(/[. ]+$/g, '')
  return stem.length === 0 ? 'media' : stem
}

/** Visible final file name: the sanitized title, never the job ID. */
function buildOutputBase(title: string): string {
  return buildStem(title, MAX_BASE_LENGTH)
}

function jobPathPart(jobId: string): string {
  // Keep hyphens/underscores so distinct opaque job IDs stay distinct after
  // sanitizing, while never allowing path separators into the staging name.
  return jobId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 36) || 'job'
}

function stagingDirName(jobId: string): string {
  return `${STAGING_DIR_PREFIX}${jobPathPart(jobId)}`
}

/**
 * Keep the whole `staging/<title>.%(ext)s` template within the historical
 * filename budget so long titles do not grow Windows paths past the limit.
 */
function buildStagingBase(title: string, stagingDirectory: string): string {
  const available =
    MAX_BASE_LENGTH - path.basename(stagingDirectory).length - 1
  return buildStem(title, Math.max(1, Math.min(MAX_BASE_LENGTH, available)))
}

function finalExtension(filePath: string, fallbackExt: string): string {
  const extension = path.extname(filePath)
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension)
    ? extension
    : `.${fallbackExt}`
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Move a finished download out of staging without ever replacing an existing
 * file. A hard link is an atomic same-volume reservation (EEXIST on collision);
 * volumes without hard-link support fall back to a check-then-rename loop,
 * because Windows rename would otherwise overwrite the destination.
 */
async function moveToUniqueFinalPath(
  stagingFile: string,
  outputDir: string,
  base: string,
  fallbackExt: string
): Promise<string> {
  const extension = finalExtension(stagingFile, fallbackExt)

  for (let index = 1; index <= MAX_FINAL_NAME_ATTEMPTS; index += 1) {
    const suffix = index === 1 ? '' : ` (${index})`
    const candidate = path.join(outputDir, `${base}${suffix}${extension}`)
    if (!isInsideDirectory(outputDir, candidate)) {
      throw new AppError(
        'MEDIA_OUTPUT_UNAVAILABLE',
        'The download path is not inside the selected folder.'
      )
    }

    try {
      await fs.link(stagingFile, candidate)
      await fs.unlink(stagingFile).catch(() => undefined)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      // Unsupported cross-device/privileged links fall through to rename.
    }

    if (await pathExists(candidate)) continue
    try {
      await fs.rename(stagingFile, candidate)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') continue
      throw error
    }
  }

  throw new AppError(
    'MEDIA_DOWNLOAD_FAILED',
    'A unique output file name could not be chosen.',
    'Remove some old files from the download folder and try again.'
  )
}

async function prepareOutputDir(value: unknown): Promise<string> {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    CONTROL_CHARACTERS.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new ValidationError('Choose a valid download folder.')
  }

  const resolved = path.resolve(value)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AppError(
        'MEDIA_OUTPUT_UNAVAILABLE',
        'The download folder is not available.'
      )
    }
    try {
      await fs.mkdir(resolved, { recursive: true })
    } catch {
      throw new AppError(
        'MEDIA_OUTPUT_UNAVAILABLE',
        'The download folder could not be created.'
      )
    }
    return resolved
  }

  if (!stat.isDirectory()) {
    throw new AppError(
      'MEDIA_OUTPUT_UNAVAILABLE',
      'The download folder is not a directory.'
    )
  }
  return resolved
}

async function findFinalFile(
  directory: string,
  base: string,
  outputExt: string
): Promise<string | null> {
  const expected = path.join(directory, `${base}.${outputExt}`)
  if (isInsideDirectory(directory, expected) && (await isFile(expected))) {
    return expected
  }

  const prefix = `${base}.`
  const candidates: string[] = []
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      if (entry.name.endsWith('.part') || entry.name.endsWith('.ytdl')) continue
      candidates.push(path.join(directory, entry.name))
    }
  } catch {
    return null
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0] ?? null

  const withStats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stat = await fs.stat(candidate)
        return { candidate, modified: stat.mtimeMs }
      } catch {
        return { candidate, modified: 0 }
      }
    })
  )
  withStats.sort((a, b) => b.modified - a.modified)
  return withStats[0]?.candidate ?? null
}

/** Remove a staging directory and everything yt-dlp left in it. */
async function removeStagingArtifacts(stagingDir: string): Promise<void> {
  const resolved = path.resolve(stagingDir)
  await fs.rm(resolved, { recursive: true, force: true }).catch(() => undefined)
}

export function createMediaEngine(
  options: MediaEngineOptions = {}
): MediaEngine {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const cwd = options.cwd ?? process.cwd()
  const managedToolsDir = options.managedToolsDir ?? null
  const spawn = options.spawn ?? defaultMediaSpawn
  const lookup = options.lookup ?? defaultPublicTargetLookup
  const now = options.now ?? Date.now
  const createId = options.createId ?? defaultCreateId
  const analysisTtlMs =
    options.analysisTtlMs !== undefined && options.analysisTtlMs > 0
      ? options.analysisTtlMs
      : DEFAULT_ANALYSIS_TTL_MS
  const collectionTtlMs =
    options.collectionTtlMs !== undefined && options.collectionTtlMs > 0
      ? options.collectionTtlMs
      : DEFAULT_COLLECTION_TTL_MS
  const analysisTimeoutMs =
    options.analysisTimeoutMs !== undefined && options.analysisTimeoutMs > 0
      ? options.analysisTimeoutMs
      : DEFAULT_ANALYSIS_TIMEOUT_MS
  const cancellationGraceMs =
    options.cancellationGraceMs !== undefined &&
    options.cancellationGraceMs > 0
      ? options.cancellationGraceMs
      : DEFAULT_CANCEL_GRACE_MS

  const analyses = new Map<string, StoredAnalysis>()
  // Ephemeral preview state. Page and entry URLs are retained only in memory,
  // keyed by opaque IDs, and are never persisted or returned from the public
  // preview API.
  const collections = new Map<string, StoredCollection>()
  const collectionEntries = new Map<string, StoredCollectionEntry>()
  const activeDownloads = new Map<string, ActiveDownload>()
  const pendingDownloads = new Map<string, PendingDownload>()
  // Every in-flight download run promise. `cancel(jobId)` only signals the
  // child; shutdown also needs to know when the run promise has settled so a
  // late finalize/progress callback cannot race persistence close.
  const downloadTasks = new Set<Promise<unknown>>()
  // Staging directories owned by in-flight downloads in this process. Stale
  // `.dondownload-*` directories left by a previous run are removed lazily when
  // the next download targets the same output folder; recovery marks those
  // interrupted jobs terminal and never resumes them.
  const activeStagingDirs = new Set<string>()
  const outputDirLocks = new Map<string, Promise<void>>()
  // Impersonation support is probed once per yt-dlp path *and* version: the
  // verified updater may swap the executable, and an older build does not know
  // `--list-impersonate-targets` at all.
  const impersonationSupport = new Map<string, boolean>()

  function withOutputDirLock<T>(
    directory: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = outputDirLocks.get(directory) ?? Promise.resolve()
    const run = previous.then(task, task)
    outputDirLocks.set(
      directory,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  async function prepareStagingDir(
    outputDir: string,
    stagingDir: string
  ): Promise<void> {
    const resolvedStaging = path.resolve(stagingDir)
    activeStagingDirs.add(resolvedStaging)
    try {
      await withOutputDirLock(outputDir, async () => {
        const entries = await fs
          .readdir(outputDir, { withFileTypes: true })
          .catch(() => [])
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith(STAGING_DIR_PREFIX)) {
            continue
          }
          const candidate = path.resolve(outputDir, entry.name)
          if (!isInsideDirectory(outputDir, candidate)) continue
          if (candidate !== resolvedStaging && activeStagingDirs.has(candidate)) {
            continue
          }
          // Only private staging directories are ever removed here.
          await removeStagingArtifacts(candidate)
        }
        await fs.mkdir(resolvedStaging, { recursive: true })
      })
    } catch (error) {
      activeStagingDirs.delete(resolvedStaging)
      throw error
    }
  }

  async function discardStagingDir(stagingDir: string): Promise<void> {
    const resolved = path.resolve(stagingDir)
    activeStagingDirs.delete(resolved)
    await removeStagingArtifacts(resolved)
  }


  // Captured subprocesses (tool probes and analyses) must be terminable during
  // shutdown, because those calls are not represented by a managed download.
  interface ActiveCapture {
    controller: AbortController
    done: Promise<void>
  }
  const activeCaptures = new Set<ActiveCapture>()
  let closing = false

  async function runTrackedCapturedProcess(
    command: string,
    args: readonly string[],
    captureOptions: {
      cwd?: string
      timeoutMs: number
      maxOutputBytes: number
    }
  ): Promise<CapturedProcessResult> {
    if (closing) throw new ProcessAbortedError()

    const controller = new AbortController()
    let release: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const capture: ActiveCapture = { controller, done }
    activeCaptures.add(capture)
    try {
      return await runCapturedProcess(command, args, {
        spawn,
        platform,
        env,
        cwd: captureOptions.cwd ?? cwd,
        timeoutMs: captureOptions.timeoutMs,
        maxOutputBytes: captureOptions.maxOutputBytes,
        abortSignal: controller.signal,
        abortGraceMs: cancellationGraceMs
      })
    } finally {
      activeCaptures.delete(capture)
      release()
    }
  }

  function newOpaqueId(
    prefix: 'analysis' | 'option' | 'preview' | 'entry'
  ): string {
    const id = createId(prefix)
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new AppError(
        'MEDIA_ENGINE_ERROR',
        'The media engine could not generate an identifier.'
      )
    }
    return id
  }

  function removeExpired(current: number): void {
    for (const [id, analysis] of analyses) {
      if (analysis.expiresAt <= current) analyses.delete(id)
    }
  }

  function storeAnalysis(analysis: StoredAnalysis): void {
    while (analyses.size >= MAX_ANALYSES) {
      const oldest = analyses.keys().next()
      if (oldest.done) break
      analyses.delete(oldest.value)
    }
    analyses.set(analysis.id, analysis)
  }

  function deleteCollection(id: string): void {
    const collection = collections.get(id)
    if (!collection) return
    collections.delete(id)
    for (const entryId of collection.entryIds) {
      collectionEntries.delete(entryId)
    }
  }

  function removeExpiredCollections(current: number): void {
    for (const [id, collection] of collections) {
      if (collection.expiresAt <= current) deleteCollection(id)
    }
  }

  function newPreviewId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = newOpaqueId('preview')
      if (!collections.has(id)) return id
    }
    throw new AppError(
      'MEDIA_ENGINE_ERROR',
      'The media engine could not generate a collection identifier.'
    )
  }

  function storeCollection(collection: StoredCollection): void {
    while (collections.size >= MAX_COLLECTIONS) {
      const oldest = collections.keys().next()
      if (oldest.done) break
      deleteCollection(oldest.value)
    }
    collections.set(collection.id, collection)
  }

  async function probeTool(
    command: string,
    args: string[],
    versionParser: (output: string) => string | null
  ): Promise<{ ok: boolean; version: string | null }> {
    try {
      const result = await runTrackedCapturedProcess(command, args, {
        timeoutMs: TOOL_PROBE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024
      })
      if (result.code !== 0) return { ok: false, version: null }
      return { ok: true, version: versionParser(result.stdout) }
    } catch {
      return { ok: false, version: null }
    }
  }

  async function probeImpersonation(
    ytdlpPath: string,
    version: string | null
  ): Promise<boolean> {
    const key = `${ytdlpPath}\u0000${version ?? ''}`
    const cached = impersonationSupport.get(key)
    if (cached !== undefined) return cached

    let supported = false
    try {
      const result = await runTrackedCapturedProcess(
        ytdlpPath,
        ['--ignore-config', '--list-impersonate-targets'],
        { timeoutMs: TOOL_PROBE_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
      )
      supported =
        result.code === 0 && /^\s*Chrome(?:-|\s)/im.test(result.stdout)
    } catch {
      supported = false
    }
    impersonationSupport.set(key, supported)
    return supported
  }

  async function resolveToolchain(): Promise<Toolchain> {
    const locationOptions = { env, platform, cwd, managedToolsDir }
    const ytdlp = await locateMediaTool('ytdlp', locationOptions)
    if (ytdlp.path === null) {
      const message = ytdlp.missingExplicit
        ? 'The configured yt-dlp path does not exist.'
        : 'yt-dlp was not found on this computer.'
      return {
        state: {
          status: 'unavailable',
          version: null,
          message,
          hint: YTDLP_HINT
        },
        ytdlpPath: null,
        ffmpegPath: null,
        denoPath: null,
        impersonate: false
      }
    }

    const ytdlpProbe = await probeTool(
      ytdlp.path,
      ['--ignore-config', '--version'],
      firstLineVersion
    )
    if (!ytdlpProbe.ok) {
      return {
        state: {
          status: 'error',
          version: null,
          message: 'yt-dlp was found but could not be started.',
          hint: YTDLP_HINT
        },
        ytdlpPath: null,
        ffmpegPath: null,
        denoPath: null,
        impersonate: false
      }
    }

    const impersonate = await probeImpersonation(
      ytdlp.path,
      ytdlpProbe.version
    )
    const ffmpeg = await locateMediaTool('ffmpeg', locationOptions)
    const deno = await locateMediaTool('deno', locationOptions)
    let ffmpegPath: string | null = null
    let ffmpegVersionValue: string | null = null
    let ffmpegProblem: string | null = null

    if (ffmpeg.path === null) {
      ffmpegProblem = ffmpeg.missingExplicit
        ? 'The configured FFmpeg path does not exist; merged video and audio formats are unavailable.'
        : 'FFmpeg was not found; merged video and audio formats are unavailable.'
    } else {
      const ffmpegProbe = await probeTool(
        ffmpeg.path,
        ['-version'],
        ffmpegVersion
      )
      if (ffmpegProbe.ok) {
        ffmpegPath = ffmpeg.path
        ffmpegVersionValue = ffmpegProbe.version
      } else {
        ffmpegProblem =
          'FFmpeg was found but could not be started; merged video and audio formats are unavailable.'
      }
    }

    const version = ffmpegVersionValue
      ? `yt-dlp ${ytdlpProbe.version ?? 'unknown'}; ffmpeg ${ffmpegVersionValue}`.slice(
          0,
          100
        )
      : `yt-dlp ${ytdlpProbe.version ?? 'unknown'}`.slice(0, 100)

    return {
      state: {
        status: 'ready',
        version,
        message: ffmpegProblem,
        hint: ffmpegProblem === null ? null : FFMPEG_HINT
      },
      ytdlpPath: ytdlp.path,
      ffmpegPath,
      denoPath: deno.path,
      impersonate
    }
  }

  function assertPublicTarget(url: string): Promise<void> {
    return assertPublicTargetWithLookup(url, lookup)
  }

  async function filterPublicFormatTargets(rawInfo: unknown): Promise<unknown> {
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

  async function filterPublicThumbnail(rawInfo: unknown): Promise<string | null> {
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

  async function getToolState(): Promise<MediaToolState> {
    const toolchain = await resolveToolchain()
    return { ...toolchain.state }
  }

  async function analyze(url: string): Promise<MediaAnalysis> {
    if (closing) {
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

    let result
    try {
      result = await runTrackedCapturedProcess(
        toolchain.ytdlpPath,
        buildAnalyzeArgs(targetUrl, toolchain.denoPath, toolchain.impersonate),
        {
          timeoutMs: analysisTimeoutMs,
          maxOutputBytes: MAX_ANALYSIS_OUTPUT_BYTES
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
    }

    if (result.code !== 0) {
      if (looksLikeDrmError(`${result.stderr}\n${result.stdout}`)) {
        throw new AppError(
          'MEDIA_DRM_PROTECTED',
          "This video is DRM-protected and can't be downloaded."
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
      const verifiedInfo = await filterPublicFormatTargets(rawInfo)
      const thumbnailUrl = await filterPublicThumbnail(rawInfo)
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
      title: built.title,
      expiresAt,
      options: storedOptions
    })

    return dto
  }

  async function analyzeCollection(url: string): Promise<CollectionPreview> {
    if (closing) {
      throw new AppError(
        'MEDIA_COLLECTION_CANCELLED',
        'The playlist analysis was cancelled.'
      )
    }
    const normalized = normalizeMediaSourceUrl(url)
    await assertPublicTarget(normalized)

    const toolchain = await resolveToolchain()
    if (toolchain.ytdlpPath === null) {
      throw toolUnavailableError(toolchain.state)
    }

    let result: CapturedProcessResult
    try {
      result = await runTrackedCapturedProcess(
        toolchain.ytdlpPath,
        buildPlaylistArgs(normalized, toolchain.denoPath),
        {
          timeoutMs: analysisTimeoutMs,
          maxOutputBytes: MAX_ANALYSIS_OUTPUT_BYTES
        }
      )
    } catch (error) {
      if (error instanceof ProcessAbortedError) {
        throw new AppError(
          'MEDIA_COLLECTION_CANCELLED',
          'The playlist analysis was cancelled.'
        )
      }
      if (error instanceof ProcessTimeoutError) {
        throw new AppError(
          'MEDIA_COLLECTION_TIMEOUT',
          'The playlist took too long to analyze. Try again.'
        )
      }
      if (error instanceof ProcessOutputError) {
        throw new AppError(
          'MEDIA_COLLECTION_TOO_LARGE',
          'The playlist is too large to preview safely.'
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
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp could not read this playlist.'
      )
    }

    if (result.code !== 0) {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp could not read this playlist. It may be private, unavailable, or require a sign-in.',
        'Only public playlists are supported. DonDownload does not use cookies, browser credentials, DRM or CAPTCHA bypass.'
      )
    }

    let rawInfo: unknown
    try {
      rawInfo = JSON.parse(result.stdout)
    } catch {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp returned an unreadable playlist response.'
      )
    }

    const info = asPlainRecord(rawInfo)
    if (info === null) {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp returned an unreadable playlist response.'
      )
    }

    const rawEntries = info.entries
    if (!Array.isArray(rawEntries) || info._type === 'video') {
      throw new AppError(
        'MEDIA_COLLECTION_NOT_PLAYLIST',
        'This page is not a playlist.',
        'Open a playlist page or analyze the video on its own.'
      )
    }
    if (
      info._type !== undefined &&
      info._type !== 'playlist' &&
      info._type !== 'multi_video'
    ) {
      throw new AppError(
        'MEDIA_COLLECTION_NOT_PLAYLIST',
        'This page is not a playlist.',
        'Open a playlist page or analyze the video on its own.'
      )
    }
    if (rawEntries.length === 0) {
      throw new AppError(
        'MEDIA_COLLECTION_EMPTY',
        'This playlist does not contain any entries.'
      )
    }
    if (rawEntries.length > MAX_COLLECTION_ENTRIES) {
      throw new AppError(
        'MEDIA_COLLECTION_TOO_LARGE',
        `This playlist has more than ${MAX_COLLECTION_ENTRIES} entries and cannot be previewed.`
      )
    }

    const usedEntryIds = new Set<string>()
    const newEntryId = (): string => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const id = newOpaqueId('entry')
        if (!usedEntryIds.has(id) && !collectionEntries.has(id)) {
          usedEntryIds.add(id)
          return id
        }
      }
      throw new AppError(
        'MEDIA_ENGINE_ERROR',
        'The media engine could not generate a collection entry identifier.'
      )
    }

    const drafts = rawEntries.map((raw, position) =>
      buildPlaylistEntryDraft(raw, position, newEntryId())
    )

    const current = Math.floor(now())
    removeExpiredCollections(current)

    const previewId = newPreviewId()
    const expiresAt = current + collectionTtlMs
    const availableCount = drafts.filter(
      (draft) => draft.dto.availability === 'available'
    ).length
    const dto = parseCollectionPreview({
      id: previewId,
      kind: 'playlist',
      title: cleanDisplayText(
        info.title ?? info.playlist_title,
        MAX_COLLECTION_TITLE_LENGTH,
        FALLBACK_COLLECTION_TITLE
      ),
      entryCount: drafts.length,
      availableCount,
      unavailableCount: drafts.length - availableCount,
      entries: drafts.map((draft) => draft.dto)
    })

    storeCollection({
      id: previewId,
      url: normalized,
      expiresAt,
      entryIds: drafts.map((draft) => draft.dto.id)
    })
    for (const draft of drafts) {
      collectionEntries.set(draft.dto.id, {
        previewId,
        position: draft.dto.position,
        url: draft.url,
        title: draft.dto.title,
        durationSeconds: draft.durationSeconds
      })
    }

    return dto
  }

  async function resolveCollectionEntries(
    previewId: string,
    entryIds: readonly string[]
  ): Promise<MediaCollectionTarget[]> {
    if (closing) {
      throw new AppError(
        'MEDIA_COLLECTION_CANCELLED',
        'The playlist selection was cancelled.'
      )
    }

    const selection = parseCreateCollectionBatchInput({
      previewId,
      selectedEntryIds: entryIds
    })

    const current = Math.floor(now())
    const collection = collections.get(selection.previewId)
    if (!collection) {
      removeExpiredCollections(current)
      throw new AppError(
        'MEDIA_COLLECTION_NOT_FOUND',
        'Preview this playlist again before selecting entries.'
      )
    }
    if (collection.expiresAt <= current) {
      deleteCollection(selection.previewId)
      removeExpiredCollections(current)
      throw new AppError(
        'MEDIA_COLLECTION_EXPIRED',
        'This playlist preview has expired. Preview the playlist again.'
      )
    }
    removeExpiredCollections(current)

    const targets: MediaCollectionTarget[] = []
    const checkedHosts = new Map<string, Promise<void>>()
    for (const entryId of selection.selectedEntryIds) {
      const entry = collectionEntries.get(entryId)
      if (!entry || entry.previewId !== selection.previewId) {
        throw new AppError(
          'MEDIA_COLLECTION_ENTRY_INVALID',
          'The selected entry does not belong to this preview.'
        )
      }
      if (entry.url === null) {
        throw new AppError(
          'MEDIA_COLLECTION_ENTRY_UNAVAILABLE',
          'The selected entry is not available for download.'
        )
      }

      const host = new URL(entry.url).hostname.toLowerCase()
      let check = checkedHosts.get(host)
      if (!check) {
        check = assertPublicTarget(entry.url)
        checkedHosts.set(host, check)
      }
      await check

      targets.push({
        entryId,
        url: entry.url,
        title: entry.title,
        durationSeconds: entry.durationSeconds,
        position: entry.position
      })
    }

    return targets
  }

  async function download(
    request: MediaDownloadRequest,
    onProgress: (update: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult> {
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request)
    ) {
      throw new ValidationError('Invalid media download request.')
    }
    if (closing) {
      throw new AppError(
        'MEDIA_DOWNLOAD_CANCELLED',
        'The download was cancelled.'
      )
    }

    const record = request as unknown as Record<string, unknown>
    const jobId = parseMediaJobId(record.jobId)
    if (activeDownloads.has(jobId) || pendingDownloads.has(jobId)) {
      throw new AppError(
        'MEDIA_JOB_ACTIVE',
        'A download with this identifier is already running.'
      )
    }

    // Reserve the identifier before the first await so two concurrent calls
    // cannot both start a download with the same job ID.
    const pending: PendingDownload = { cancelRequested: false }
    pendingDownloads.set(jobId, pending)
    const task = runDownload(request, jobId, pending, onProgress)
    downloadTasks.add(task)
    try {
      return await task
    } finally {
      downloadTasks.delete(task)
      pendingDownloads.delete(jobId)
    }
  }

  async function runDownload(
    request: MediaDownloadRequest,
    jobId: string,
    pending: PendingDownload,
    onProgress: (update: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult> {
    const record = request as unknown as Record<string, unknown>
    const sourceUrl = normalizeMediaSourceUrl(record.sourceUrl)
    const analysisId = parseMediaAnalysisId(record.analysisId)
    const optionId = parseMediaOptionId(record.optionId)

    const direct = parseDirectDownload(record.direct)
    const maxBytes = request.maxBytes ?? null
    let title: string
    let outputChoice: InternalOutputChoice
    let downloadTargetUrl = sourceUrl
    let selectedSize: { bytes: number | null; isEstimate: boolean }
    let directHeaders: {
      referer?: string
      userAgent?: string
      cookie?: string
    } = {}

    if (direct !== null) {
      // Detected manifest download: no analysis cache, no opaque option. The
      // extension/bridge already validated the URL; re-resolve it immediately
      // before yt-dlp starts.
      title = cleanDisplayText(direct.title, 180, 'Detected media')
      await assertPublicTarget(sourceUrl)
      if (direct.kind === 'dash' || direct.kind === 'hls') {
        // A merge/remux needs FFmpeg; fail before staging a huge partial file.
      }
      const expectedBytes =
        typeof record.expectedBytes === 'number' &&
        Number.isSafeInteger(record.expectedBytes) &&
        record.expectedBytes > 0
          ? record.expectedBytes
          : null
      if (
        maxBytes !== null &&
        expectedBytes !== null &&
        expectedBytes > maxBytes
      ) {
        throw new AppError(
          'MEDIA_SIZE_CAP_EXCEEDED',
          'The reported media size exceeds the configured per-job size limit.'
        )
      }
      selectedSize = { bytes: expectedBytes, isEstimate: false }
      outputChoice = {
        outputFormat: 'mp4',
        formatIds: [DIRECT_FORMAT_SELECTOR],
        mergeOutputFormat: 'mp4',
        remuxOutputFormat: 'mp4',
        outputExt: 'mp4'
      }
      directHeaders = {
        referer: direct.referer,
        userAgent: direct.userAgent,
        ...(direct.cookie === undefined ? {} : { cookie: direct.cookie })
      }
    } else {
      const current = Math.floor(now())

      const analysis = analyses.get(analysisId)
      if (!analysis) {
        removeExpired(current)
        throw new AppError(
          'MEDIA_ANALYSIS_NOT_FOUND',
          'Analyze the page again before downloading.'
        )
      }
      if (analysis.expiresAt <= current) {
        analyses.delete(analysisId)
        removeExpired(current)
        throw new AppError(
          'MEDIA_ANALYSIS_EXPIRED',
          'This analysis has expired. Analyze the page again.'
        )
      }
      removeExpired(current)
      if (analysis.url !== sourceUrl) {
        throw new AppError(
          'MEDIA_ANALYSIS_MISMATCH',
          'The analysis does not match this page. Analyze the page again.'
        )
      }

      // Re-resolve the page target immediately before starting a download. The
      // URL came from an earlier analysis and DNS may have changed since then.
      await assertPublicTarget(sourceUrl)
      downloadTargetUrl = analysis.targetUrl
      if (downloadTargetUrl !== sourceUrl) {
        await assertPublicTarget(downloadTargetUrl)
      }

      const option = analysis.options.get(optionId)
      if (!option) {
        throw new AppError(
          'MEDIA_OPTION_INVALID',
          'Choose one of the formats from a fresh analysis.'
        )
      }

      const rawOutputFormat = record.outputFormat
      if (rawOutputFormat !== undefined && !isMediaOutputFormat(rawOutputFormat)) {
        throw new AppError(
          'MEDIA_OUTPUT_FORMAT_UNSUPPORTED',
          'Choose a supported output format.'
        )
      }
      const requestedOutputFormat: MediaOutputFormat =
        rawOutputFormat === undefined ? 'auto' : rawOutputFormat
      const chosen = option.choices.get(requestedOutputFormat)
      if (!chosen) {
        throw new AppError(
          'MEDIA_OUTPUT_FORMAT_UNSUPPORTED',
          'This option cannot produce the selected output format without transcoding. Choose Auto or another format.'
        )
      }
      outputChoice = chosen
      title = analysis.title
      selectedSize =
        option.dto.outputSizes?.[requestedOutputFormat] ?? {
          bytes: option.dto.estimatedBytes ?? option.dto.filesizeBytes,
          isEstimate: option.dto.sizeIsEstimate === true
        }
      if (
        maxBytes !== null &&
        selectedSize.bytes !== null &&
        selectedSize.bytes > maxBytes
      ) {
        throw new AppError(
          'MEDIA_SIZE_CAP_EXCEEDED',
          'The reported or estimated media size exceeds the configured per-job size limit.'
        )
      }
    }

    if (pending.cancelRequested) {
      throw new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
    }

    const toolchain = await resolveToolchain()
    if (pending.cancelRequested) {
      throw new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
    }
    if (toolchain.ytdlpPath === null) {
      throw toolUnavailableError(toolchain.state)
    }
    if (
      (outputChoice.mergeOutputFormat !== null ||
        outputChoice.remuxOutputFormat !== null) &&
      toolchain.ffmpegPath === null
    ) {
      throw new AppError(
        'MEDIA_MERGE_UNAVAILABLE',
        'FFmpeg is required to merge or remux this format but is not available.',
        FFMPEG_HINT
      )
    }

    const outputDir = await prepareOutputDir(record.dir)
    if (pending.cancelRequested) {
      throw new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
    }

    const formatSelector = outputChoice.formatIds.join('+')
    if (
      (direct === null && !SAFE_SELECTOR.test(formatSelector)) ||
      (direct !== null && formatSelector !== DIRECT_FORMAT_SELECTOR)
    ) {
      throw new AppError(
        'MEDIA_OPTION_INVALID',
        'The selected format is no longer valid. Analyze the page again.'
      )
    }

    const base = buildOutputBase(title)
    const stagingDir = path.join(outputDir, stagingDirName(jobId))
    if (!isInsideDirectory(outputDir, stagingDir)) {
      throw new AppError(
        'MEDIA_OUTPUT_UNAVAILABLE',
        'The download path is not inside the selected folder.'
      )
    }
    const stagingBase = buildStagingBase(title, stagingDir)
    const outputTemplate = path.join(
      stagingDir,
      `${escapeOutputTemplate(stagingBase)}.%(ext)s`
    )
    if (!isInsideDirectory(stagingDir, outputTemplate)) {
      throw new AppError(
        'MEDIA_OUTPUT_UNAVAILABLE',
        'The download path is not inside the selected folder.'
      )
    }

    await prepareStagingDir(outputDir, stagingDir)
    if (pending.cancelRequested) {
      await discardStagingDir(stagingDir)
      throw new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
    }

    const needsFfmpeg =
      outputChoice.mergeOutputFormat !== null ||
      outputChoice.remuxOutputFormat !== null
    const args = buildDownloadArgs({
      sourceUrl: downloadTargetUrl,
      formatSelector,
      outputTemplate,
      mergeOutputFormat: outputChoice.mergeOutputFormat,
      remuxOutputFormat: outputChoice.remuxOutputFormat,
      ffmpegLocation: needsFfmpeg ? toolchain.ffmpegPath : null,
      denoPath: toolchain.denoPath,
      impersonate: toolchain.impersonate,
      maxBytes,
      ...directHeaders
    })

    const safeProgress: (update: MediaDownloadProgress) => void =
      typeof onProgress === 'function' ? onProgress : () => undefined

    return new Promise<MediaDownloadResult>((resolve, reject) => {
      let settled = false
      let stdoutRemainder = ''
      let stderrRemainder = ''
      let mergingSeen = false
      let sizeCapExceeded = false
      let drmDetected = false
      // The analysis estimate keeps combined video+audio progress from
      // reaching 100% while only the first stream has reported a total.
      const expectedTotal = selectedSize.bytes
      const expectedStreamCount = outputChoice.formatIds.length
      const streams = new Map<
        string,
        { completed: number; total: number | null; speed: number }
      >()

      const job: ActiveDownload = {
        child: null,
        cancelRequested: false,
        cancelTimer: null,
        forceCancel: null
      }
      activeDownloads.set(jobId, job)

      const emit = (
        status: 'downloading' | 'merging',
        completedBytes: number,
        totalBytes: number | null,
        speedBps: number,
        filePath: string | null
      ): void => {
        try {
          safeProgress({
            status,
            completedBytes: Math.max(0, Math.floor(completedBytes)),
            totalBytes:
              totalBytes === null ? null : Math.max(0, Math.floor(totalBytes)),
            speedBps: Math.max(0, speedBps),
            filePath
          })
        } catch {
          // A UI callback must never break the download lifecycle.
        }
      }

      const snapshot = (): {
        completed: number
        total: number | null
        speed: number
      } => {
        let completed = 0
        let total = 0
        let speed = 0
        let totalKnown = true
        for (const stream of streams.values()) {
          completed += stream.completed
          speed += stream.speed
          if (stream.total === null) totalKnown = false
          else total += stream.total
        }
        let resolvedTotal =
          streams.size > 0 && totalKnown ? total : null
        if (expectedTotal !== null && expectedTotal > 0) {
          if (resolvedTotal === null) {
            resolvedTotal = expectedTotal
          } else if (
            streams.size < expectedStreamCount &&
            resolvedTotal < expectedTotal
          ) {
            resolvedTotal = expectedTotal
          }
        }
        return {
          completed,
          total: resolvedTotal,
          speed
        }
      }

      const emitSnapshot = (
        status: 'downloading' | 'merging',
        filePath: string | null
      ): void => {
        const currentSnapshot = snapshot()
        emit(
          status,
          currentSnapshot.completed,
          currentSnapshot.total,
          currentSnapshot.speed,
          filePath
        )
      }

      const finalize = async (
        outcome: 'success' | 'failure' | 'cancelled'
      ): Promise<void> => {
        if (settled) return
        settled = true
        activeDownloads.delete(jobId)
        if (job.cancelTimer) {
          clearTimeout(job.cancelTimer)
          job.cancelTimer = null
        }

        if (outcome === 'success') {
          try {
            const stagedPath = await findFinalFile(
              stagingDir,
              stagingBase,
              outputChoice.outputExt
            )
            if (stagedPath === null) throw new Error('missing output')
            const stat = await fs.stat(stagedPath)
            if (!stat.isFile()) throw new Error('not a file')
            if (maxBytes !== null && stat.size > maxBytes) {
              sizeCapExceeded = true
              throw new AppError(
                'MEDIA_SIZE_CAP_EXCEEDED',
                'The media output exceeded the configured per-job size limit.'
              )
            }
            const finalPath = await moveToUniqueFinalPath(
              stagedPath,
              outputDir,
              base,
              outputChoice.outputExt
            )
            await discardStagingDir(stagingDir)
            emit(
              mergingSeen ? 'merging' : 'downloading',
              stat.size,
              stat.size,
              0,
              finalPath
            )
            resolve({ filePath: finalPath, totalBytes: stat.size })
          } catch (error) {
            await discardStagingDir(stagingDir)
            reject(
              error instanceof AppError
                ? error
                : new AppError(
                    'MEDIA_DOWNLOAD_FAILED',
                    'The download finished but the output file could not be verified.',
                    'Check the download folder and try again.'
                  )
            )
          }
          return
        }

        await discardStagingDir(stagingDir)
        if (outcome === 'cancelled') {
          reject(
            new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
          )
        } else if (sizeCapExceeded) {
          reject(new AppError('MEDIA_SIZE_CAP_EXCEEDED', 'The media output exceeded the configured per-job size limit.'))
        } else if (drmDetected) {
          reject(
            new AppError(
              'MEDIA_DRM_PROTECTED',
              "This video is DRM-protected and can't be downloaded."
            )
          )
        } else {
          reject(
            new AppError(
              'MEDIA_DOWNLOAD_FAILED',
              'yt-dlp could not download this format. The page may be unavailable, private, or require a sign-in.',
              'Only public videos are supported. DonDownload does not use cookies, browser credentials, DRM or CAPTCHA bypass.'
            )
          )
        }
      }

      job.forceCancel = () => {
        void finalize('cancelled')
      }

      const markMerging = (): void => {
        if (mergingSeen) return
        mergingSeen = true
        emitSnapshot('merging', null)
      }

      const handleStdoutLine = (line: string): void => {
        // yt-dlp writes post-processing markers such as `[Merger] Merging
        // formats into ...` to stdout (older releases used stderr).
        if (isMergingLine(line)) markMerging()
        if (looksLikeDrmError(line)) drmDetected = true
        if (looksLikeMaxFilesizeError(line)) sizeCapExceeded = true

        const progress = parseProgressLine(line)
        if (progress !== null) {
          const previous = streams.get(progress.streamId)
          // HLS/DASH fragment downloads often have no byte total. Estimate one
          // from the fragment position so the bar still advances, and replace
          // it as soon as yt-dlp reports a real total.
          const fragmentTotal =
            progress.totalBytes === null &&
            progress.fragmentIndex !== null &&
            progress.fragmentCount !== null &&
            progress.fragmentIndex > 0 &&
            progress.fragmentCount > 0
              ? Math.round(
                  (progress.completedBytes * progress.fragmentCount) /
                    progress.fragmentIndex
                )
              : null
          streams.set(progress.streamId, {
            completed: progress.completedBytes,
            total:
              progress.totalBytes ??
              (fragmentTotal !== null && Number.isSafeInteger(fragmentTotal)
                ? fragmentTotal
                : previous?.total ?? null),
            speed: progress.speedBps
          })
          emitSnapshot(mergingSeen ? 'merging' : 'downloading', null)
          if (maxBytes !== null && snapshot().completed > maxBytes && !sizeCapExceeded) {
            sizeCapExceeded = true
            if (job.child !== null) terminateProcessTree(job.child, platform, spawn, env)
          }
        }
      }

      const handleStdoutText = (text: string): void => {
        stdoutRemainder += text
        let newline = stdoutRemainder.indexOf('\n')
        while (newline >= 0) {
          const line = stdoutRemainder.slice(0, newline).replace(/\r$/, '')
          stdoutRemainder = stdoutRemainder.slice(newline + 1)
          handleStdoutLine(line)
          newline = stdoutRemainder.indexOf('\n')
        }
        if (stdoutRemainder.length > 256 * 1024) {
          stdoutRemainder = stdoutRemainder.slice(-64 * 1024)
        }
      }

      const handleStderrText = (text: string): void => {
        stderrRemainder += text
        if (looksLikeDrmError(stderrRemainder)) drmDetected = true
        if (looksLikeMaxFilesizeError(stderrRemainder)) sizeCapExceeded = true
        const lines = stderrRemainder.split(/\r?\n/)
        stderrRemainder = lines.pop() ?? ''
        for (const line of lines) {
          if (isMergingLine(line)) {
            markMerging()
            break
          }
        }
        if (stderrRemainder.length > 16 * 1024) {
          stderrRemainder = stderrRemainder.slice(-4 * 1024)
        }
      }

      let child: MediaProcess
      try {
        child = spawn(toolchain.ytdlpPath as string, args, {
          cwd: outputDir,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch {
        void finalize('failure')
        return
      }
      job.child = child

      child.stdout?.on('data', (chunk: unknown) =>
        handleStdoutText(typeof chunk === 'string' ? chunk : String(chunk))
      )
      child.stdout?.on('error', () => undefined)
      child.stderr?.on('data', (chunk: unknown) =>
        handleStderrText(typeof chunk === 'string' ? chunk : String(chunk))
      )
      child.stderr?.on('error', () => undefined)
      child.on('error', () => {
        void finalize('failure')
      })
      child.on('close', (code: number | null) => {
        if (stdoutRemainder.length > 0) {
          handleStdoutLine(stdoutRemainder.replace(/\r$/, ''))
          stdoutRemainder = ''
        }
        if (stderrRemainder.length > 0) {
          if (isMergingLine(stderrRemainder)) markMerging()
          stderrRemainder = ''
        }
        if (job.cancelRequested) {
          void finalize('cancelled')
        } else if (code === 0) {
          void finalize('success')
        } else {
          void finalize('failure')
        }
      })

      emit('downloading', 0, selectedSize.bytes, 0, null)

      if (job.cancelRequested) {
        terminateProcessTree(child, platform, spawn, env)
      }
    })
  }

  function cancel(jobId: string): void {
    let id: string
    try {
      id = parseMediaJobId(jobId)
    } catch {
      return
    }

    const pending = pendingDownloads.get(id)
    if (pending) pending.cancelRequested = true

    const job = activeDownloads.get(id)
    if (!job || job.cancelRequested) return

    job.cancelRequested = true
    if (job.child !== null) {
      terminateProcessTree(job.child, platform, spawn, env)
    }

    job.cancelTimer = setTimeout(() => {
      if (job.child !== null) {
        terminateProcessTree(job.child, platform, spawn, env)
      }
      job.forceCancel?.()
    }, cancellationGraceMs)
    job.cancelTimer.unref?.()
  }

  /**
   * Await the currently tracked download run promises, but never longer than
   * `timeoutMs`. Each download already has its own bounded cancellation timer;
   * this outer bound protects shutdown from a child that never closes or a
   * pending download stuck before its child exists.
   */
  function waitForDownloads(timeoutMs: number): Promise<void> {
    const tasks = [...downloadTasks]
    if (tasks.length === 0) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
      void Promise.allSettled(tasks).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async function cancelAll(): Promise<void> {
    closing = true

    // Managed downloads already have a bounded cancellation path.
    for (const jobId of [...pendingDownloads.keys()]) cancel(jobId)
    for (const jobId of [...activeDownloads.keys()]) cancel(jobId)

    // Analyses and probes have no job ID. Abort each tracked capture and wait
    // for its child to close (or for the bounded abort grace) so the caller can
    // safely close persistence afterwards.
    const captures = [...activeCaptures]
    for (const capture of captures) capture.controller.abort()

    // A cancelled download settles when its child closes or the cancel grace
    // force-finalizes it. Wait for those run promises as well, so close() does
    // not resolve while a late finalize/progress callback can still run. The
    // extra margin caps the wait if a child or pending validation never settles.
    await Promise.allSettled([
      ...captures.map((capture) => capture.done),
      waitForDownloads(cancellationGraceMs + DOWNLOAD_SETTLE_MARGIN_MS)
    ])
  }

  return {
    getToolState,
    analyze,
    analyzeCollection,
    resolveCollectionEntries,
    download,
    cancel,
    cancelAll
  }
}
