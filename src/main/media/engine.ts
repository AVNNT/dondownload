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
import { lookup as nodeLookup } from 'node:dns/promises'
import { promises as fs } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { AppError } from '../errors'
import {
  normalizeMediaSourceUrl,
  parseMediaAnalysis,
  parseMediaAnalysisId,
  parseMediaJobId,
  parseMediaOptionId
} from '@shared/media'
import type { MediaAnalysis, MediaToolState } from '@shared/media'
import { ValidationError, sanitizeFilename } from '@shared/validation'
import {
  buildAnalyzeArgs,
  buildDownloadArgs,
  isMergingLine,
  parseProgressLine
} from './args'
import {
  MediaInfoError,
  buildMediaAnalysis
} from './formats'
import type { InternalMediaOption } from './formats'
import { isFile, locateMediaTool } from './locator'
import {
  ProcessOutputError,
  ProcessStartError,
  ProcessTimeoutError,
  defaultMediaSpawn,
  runCapturedProcess,
  terminateProcessTree
} from './process'
import type { MediaProcess, MediaSpawn } from './process'

const DEFAULT_ANALYSIS_TTL_MS = 10 * 60_000
const DEFAULT_ANALYSIS_TIMEOUT_MS = 60_000
const DEFAULT_CANCEL_GRACE_MS = 5_000
const TOOL_PROBE_TIMEOUT_MS = 5_000
const MAX_ANALYSIS_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_ANALYSES = 32
const MAX_BASE_LENGTH = 100
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const SAFE_SELECTOR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\+[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/

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

export interface MediaDownloadRequest {
  jobId: string
  sourceUrl: string
  analysisId: string
  optionId: string
  dir: string
}

export interface MediaDownloadResult {
  filePath: string
  totalBytes: number | null
}

export interface MediaEngine {
  getToolState(): Promise<MediaToolState>
  analyze(url: string): Promise<MediaAnalysis>
  download(
    request: MediaDownloadRequest,
    onProgress: (update: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult>
  cancel(jobId: string): void
}

export interface MediaLookupAddress {
  address: string
  family: number
}

export type MediaLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<readonly MediaLookupAddress[]>

/**
 * Production callers only pass `env` and `platform`. The other fields exist so
 * tests can inject a fake child process, DNS resolver and clock without using
 * a real network or real binaries.
 */
export interface MediaEngineOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: string
  spawn?: MediaSpawn
  lookup?: MediaLookup
  now?: () => number
  analysisTtlMs?: number
  analysisTimeoutMs?: number
  cancellationGraceMs?: number
  createId?: (prefix: string) => string
}

interface StoredAnalysis {
  id: string
  url: string
  title: string
  expiresAt: number
  options: Map<string, InternalMediaOption>
}

interface Toolchain {
  state: MediaToolState
  ytdlpPath: string | null
  ffmpegPath: string | null
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

function defaultLookup(
  hostname: string,
  options: { all: true; verbatim: true }
): Promise<readonly MediaLookupAddress[]> {
  return nodeLookup(hostname, options)
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

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map((entry) => Number(entry))
  const [a, b, c] = parts
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return false
  }

  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 192 && b === 31 && c === 196) return false
  if (a === 192 && b === 52 && c === 193) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 192 && b === 175 && c === 48) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

function ipv6IsPublic(address: string): boolean {
  const withoutZone = address.split('%')[0] ?? ''
  const normalized = withoutZone.toLowerCase()
  if (normalized.length === 0 || normalized === '::' || normalized === '::1') {
    return false
  }

  // Allow only global unicast 2000::/3. This excludes loopback, link-local,
  // unique-local, multicast, IPv4-mapped addresses and transition mechanisms.
  const first = normalized.split(':')[0]
  if (!first) return false
  const value = Number.parseInt(first, 16)
  if (!Number.isInteger(value)) return false
  if (value < 0x2000 || value > 0x3fff) return false
  if (value === 0x2002) return false
  if (value === 0x2001 && normalized.startsWith('2001:0:')) return false
  if (value === 0x2001) {
    const groups = normalized.split(':')
    const second = Number.parseInt(groups[1] || '0', 16)
    const third = Number.parseInt(groups[2] || '0', 16)
    if (second === 0x0db8) return false
    if (second === 0x0002 && third === 0) return false
    if ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020) {
      return false
    }
  }
  return true
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return ipv4IsPublic(address)
  if (family === 6) return ipv6IsPublic(address)
  return false
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

function buildOutputBase(title: string, jobId: string): string {
  let stem: string
  try {
    stem = sanitizeFilename(title)
  } catch {
    stem = 'media'
  }

  stem = stem
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[. ]+$/g, '')
  if (stem.length === 0) stem = 'media'

  const jobPart =
    jobId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'job'
  return `${stem} [${jobPart}]`
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

export function createMediaEngine(
  options: MediaEngineOptions = {}
): MediaEngine {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const cwd = options.cwd ?? process.cwd()
  const spawn = options.spawn ?? defaultMediaSpawn
  const lookup = options.lookup ?? defaultLookup
  const now = options.now ?? Date.now
  const createId = options.createId ?? defaultCreateId
  const analysisTtlMs =
    options.analysisTtlMs !== undefined && options.analysisTtlMs > 0
      ? options.analysisTtlMs
      : DEFAULT_ANALYSIS_TTL_MS
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
  const activeDownloads = new Map<string, ActiveDownload>()
  const pendingDownloads = new Map<string, PendingDownload>()

  function newOpaqueId(prefix: 'analysis' | 'option'): string {
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

  async function probeTool(
    command: string,
    args: string[],
    versionParser: (output: string) => string | null
  ): Promise<{ ok: boolean; version: string | null }> {
    try {
      const result = await runCapturedProcess(command, args, {
        spawn,
        platform,
        env,
        cwd,
        timeoutMs: TOOL_PROBE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024
      })
      if (result.code !== 0) return { ok: false, version: null }
      return { ok: true, version: versionParser(result.stdout) }
    } catch {
      return { ok: false, version: null }
    }
  }

  async function resolveToolchain(): Promise<Toolchain> {
    const locationOptions = { env, platform, cwd }
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
        ffmpegPath: null
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
        ffmpegPath: null
      }
    }

    const ffmpeg = await locateMediaTool('ffmpeg', locationOptions)
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
      ffmpegPath
    }
  }

  async function assertPublicTarget(url: string): Promise<void> {
    // DNS is checked once immediately before yt-dlp starts. yt-dlp resolves the
    // host again through its own network stack, so DNS rebinding between these
    // two steps is a residual risk. Pinning would require replacing yt-dlp's
    // resolver or forcing every connection through a controlled proxy.
    const parsed = new URL(url)
    let host = parsed.hostname
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1)
    }
    host = host.replace(/\.$/, '').toLowerCase()

    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new AppError(
        'MEDIA_TARGET_NOT_PUBLIC',
        'Local and private network addresses are not supported.'
      )
    }

    if (host.includes('%')) {
      throw new AppError(
        'MEDIA_TARGET_NOT_PUBLIC',
        'Local and private network addresses are not supported.'
      )
    }

    const literalFamily = isIP(host)
    if (literalFamily !== 0) {
      if (!isPublicAddress(host)) {
        throw new AppError(
          'MEDIA_TARGET_NOT_PUBLIC',
          'Local and private network addresses are not supported.'
        )
      }
      return
    }

    let addresses: readonly MediaLookupAddress[]
    try {
      addresses = await lookup(host, { all: true, verbatim: true })
    } catch {
      throw new AppError(
        'MEDIA_TARGET_UNRESOLVED',
        'The site address could not be resolved.'
      )
    }

    if (addresses.length === 0) {
      throw new AppError(
        'MEDIA_TARGET_UNRESOLVED',
        'The site address could not be resolved.'
      )
    }

    for (const entry of addresses) {
      if (!isPublicAddress(entry.address)) {
        throw new AppError(
          'MEDIA_TARGET_NOT_PUBLIC',
          'Local and private network addresses are not supported.'
        )
      }
    }
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

  async function getToolState(): Promise<MediaToolState> {
    const toolchain = await resolveToolchain()
    return { ...toolchain.state }
  }

  async function analyze(url: string): Promise<MediaAnalysis> {
    const normalized = normalizeMediaSourceUrl(url)
    await assertPublicTarget(normalized)

    const toolchain = await resolveToolchain()
    if (toolchain.ytdlpPath === null) {
      throw toolUnavailableError(toolchain.state)
    }

    let result
    try {
      result = await runCapturedProcess(
        toolchain.ytdlpPath,
        buildAnalyzeArgs(normalized),
        {
          spawn,
          platform,
          env,
          cwd,
          timeoutMs: analysisTimeoutMs,
          maxOutputBytes: MAX_ANALYSIS_OUTPUT_BYTES
        }
      )
    } catch (error) {
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
      built = buildMediaAnalysis(verifiedInfo, {
        ffmpegAvailable: toolchain.ffmpegPath !== null,
        newOptionId: () => newOpaqueId('option')
      })
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
      title: built.title,
      expiresAt,
      options: storedOptions
    })

    return dto
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
    try {
      return await runDownload(request, jobId, pending, onProgress)
    } finally {
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

    const option = analysis.options.get(optionId)
    if (!option) {
      throw new AppError(
        'MEDIA_OPTION_INVALID',
        'Choose one of the formats from a fresh analysis.'
      )
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
    if (option.mergeOutputFormat !== null && toolchain.ffmpegPath === null) {
      throw new AppError(
        'MEDIA_MERGE_UNAVAILABLE',
        'FFmpeg is required to merge this format but is not available.',
        FFMPEG_HINT
      )
    }

    const outputDir = await prepareOutputDir(record.dir)
    if (pending.cancelRequested) {
      throw new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
    }
    const base = buildOutputBase(analysis.title, jobId)
    const outputTemplate = path.join(
      outputDir,
      `${escapeOutputTemplate(base)}.%(ext)s`
    )
    if (!isInsideDirectory(outputDir, outputTemplate)) {
      throw new AppError(
        'MEDIA_OUTPUT_UNAVAILABLE',
        'The download path is not inside the selected folder.'
      )
    }

    const formatSelector = option.formatIds.join('+')
    if (!SAFE_SELECTOR.test(formatSelector)) {
      throw new AppError(
        'MEDIA_OPTION_INVALID',
        'The selected format is no longer valid. Analyze the page again.'
      )
    }

    const args = buildDownloadArgs({
      sourceUrl,
      formatSelector,
      outputTemplate,
      mergeOutputFormat: option.mergeOutputFormat,
      ffmpegLocation:
        option.mergeOutputFormat === null ? null : toolchain.ffmpegPath
    })

    const safeProgress: (update: MediaDownloadProgress) => void =
      typeof onProgress === 'function' ? onProgress : () => undefined

    return new Promise<MediaDownloadResult>((resolve, reject) => {
      let settled = false
      let stdoutRemainder = ''
      let stderrRemainder = ''
      let mergingSeen = false
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
        return {
          completed,
          total: streams.size > 0 && totalKnown ? total : null,
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
            const finalPath = await findFinalFile(
              outputDir,
              base,
              option.outputExt
            )
            if (finalPath === null) throw new Error('missing output')
            const stat = await fs.stat(finalPath)
            if (!stat.isFile()) throw new Error('not a file')
            emit(
              mergingSeen ? 'merging' : 'downloading',
              stat.size,
              stat.size,
              0,
              finalPath
            )
            resolve({ filePath: finalPath, totalBytes: stat.size })
          } catch {
            reject(
              new AppError(
                'MEDIA_DOWNLOAD_FAILED',
                'The download finished but the output file could not be verified.',
                'Check the download folder and try again.'
              )
            )
          }
          return
        }

        if (outcome === 'cancelled') {
          reject(
            new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
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

        const progress = parseProgressLine(line)
        if (progress !== null) {
          const previous = streams.get(progress.streamId)
          streams.set(progress.streamId, {
            completed: progress.completedBytes,
            total: progress.totalBytes ?? previous?.total ?? null,
            speed: progress.speedBps
          })
          emitSnapshot(mergingSeen ? 'merging' : 'downloading', null)
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

      emit(
        'downloading',
        0,
        option.dto.filesizeBytes,
        0,
        null
      )

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

  return { getToolState, analyze, download, cancel }
}
