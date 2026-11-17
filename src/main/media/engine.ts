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
 *
 * Staging, progress parsing, analysis/format parsing, collection previews and
 * tool probing live in sibling modules; this file keeps the public engine
 * surface and the single download lifecycle.
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppError } from '../errors'
import {
  assertPublicTarget as assertPublicTargetWithLookup,
  defaultPublicTargetLookup,
  type PublicLookupAddress,
  type PublicTargetLookup
} from '../net/publicTarget'
import type { CollectionPreview } from '@shared/batches'
import {
  isMediaOutputFormat,
  normalizeMediaSourceUrl,
  parseMediaAnalysisId,
  parseMediaJobId,
  parseMediaOptionId
} from '@shared/media'
import type { MediaAnalysis, MediaOutputFormat, MediaToolState } from '@shared/media'
import { ValidationError } from '@shared/validation'
import {
  FFMPEG_HINT,
  cleanDisplayText,
  createMediaAnalyzer,
  parseDirectDownload,
  readOptionalCookie,
  toolUnavailableError
} from './analysis'
import type { MediaDirectDownload, StoredAnalysis } from './analysis'
import { buildDownloadArgs } from './args'
import { createCollectionStore } from './collections'
import type { MediaCollectionTarget } from './collections'
import { COOKIE_FILE_PREFIX, buildNetscapeCookieFile } from './cookies'
import {
  defaultMediaSpawn,
  ProcessAbortedError,
  runCapturedProcess,
  terminateProcessTree
} from './process'
import type { CapturedProcessResult, MediaProcess, MediaSpawn } from './process'
import type { InternalOutputChoice } from './formats'
import {
  createDownloadProgressTracker,
  type MediaDownloadProgress
} from './progress'
import {
  buildOutputBase,
  buildStagingBase,
  createStagingManager,
  escapeOutputTemplate,
  findFinalFile,
  isInsideDirectory,
  moveToUniqueFinalPath,
  prepareOutputDir,
  stagingDirName
} from './staging'
import { createJsRuntime, needsJsRuntime } from './jsRuntime'
import type { JsRuntime } from './jsRuntime'
import { createToolchainResolver } from './toolchain'
import { lowerProcessPriority } from '../processPriority'

export type { MediaDirectDownload } from './analysis'
export type { MediaCollectionTarget } from './collections'
export type { MediaDownloadProgress } from './progress'
export { looksLikeDrmError, normalizeVimeoPlayerUrl } from './analysis'

const DEFAULT_ANALYSIS_TTL_MS = 10 * 60_000
const DEFAULT_COLLECTION_TTL_MS = 10 * 60_000
const DEFAULT_ANALYSIS_TIMEOUT_MS = 60_000
const DEFAULT_CANCEL_GRACE_MS = 5_000
const DOWNLOAD_SETTLE_MARGIN_MS = 250
const MAX_ANALYSES = 32
const SAFE_SELECTOR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\+[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/
/**
 * Application-generated selector for a detected HLS/DASH manifest. `bestvideo*`
 * includes combined streams, `bestaudio` fills the audio track, and `best` is
 * the single-file fallback. This value never comes from the page or the user.
 */
const DIRECT_FORMAT_SELECTOR = 'bestvideo*+bestaudio/best'

export interface MediaDownloadRequest {
  jobId: string
  sourceUrl: string
  analysisId: string
  optionId: string
  dir: string
  maxBytes?: number | null
  /** One-job browser Cookie header; memory-only and never persisted. */
  cookie?: string
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

export interface MediaEngine {
  getToolState(): Promise<MediaToolState>
  analyze(
    url: string,
    options?: { cookie?: string; signal?: AbortSignal }
  ): Promise<MediaAnalysis>
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
   * Stop the yt-dlp child while keeping the job's staging directory and
   * `.part` files so a later resume can continue them.
   */
  pause(jobId: string): void
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
  /** Per-user app data dir for short-lived analysis cookie files. */
  userDataPath?: string | null
  /** Optional Deno runtime manager; defaults to the verified on-demand one. */
  jsRuntime?: JsRuntime
  spawn?: MediaSpawn
  lookup?: MediaLookup
  now?: () => number
  analysisTtlMs?: number
  collectionTtlMs?: number
  analysisTimeoutMs?: number
  cancellationGraceMs?: number
  createId?: (prefix: string) => string
}

interface ActiveDownload {
  child: MediaProcess | null
  cancelRequested: boolean
  pauseRequested: boolean
  cancelTimer: NodeJS.Timeout | null
  forceCancel: (() => void) | null
  forcePause: (() => void) | null
}

interface PendingDownload {
  cancelRequested: boolean
  pauseRequested: boolean
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

export function createMediaEngine(
  options: MediaEngineOptions = {}
): MediaEngine {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const cwd = options.cwd ?? process.cwd()
  const managedToolsDir = options.managedToolsDir ?? null
  const userDataPath = options.userDataPath ?? null
  // Deno is not bundled: it is located when installed and downloaded on demand
  // the first time a YouTube job needs a JavaScript runtime.
  const jsRuntime =
    options.jsRuntime ??
    createJsRuntime({
      env,
      platform,
      cwd,
      userDataPath
    })

  async function ensureJsRuntime(targetUrl: string): Promise<string | null> {
    if (!needsJsRuntime(targetUrl)) return null
    try {
      return await jsRuntime.ensure()
    } catch {
      return null
    }
  }
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
  const activeDownloads = new Map<string, ActiveDownload>()
  const pendingDownloads = new Map<string, PendingDownload>()
  /**
   * Staging directories kept by a user pause. They are reused verbatim by the
   * next download call for that job, or discarded if the job is cancelled.
   */
  const pausedStagingDirs = new Map<string, string>()
  // Every in-flight download run promise. `cancel(jobId)` only signals the
  // child; shutdown also needs to know when the run promise has settled so a
  // late finalize/progress callback cannot race persistence close.
  const downloadTasks = new Set<Promise<unknown>>()
  // Staging directories and per-folder locks are owned by the staging manager;
  // stale `.dondownload-*` directories are removed lazily on the next download.
  const staging = createStagingManager()
  // Cookie files live only for the lifetime of one yt-dlp child. Analyses use
  // an isolated temp directory under userData; downloads use the job's private
  // staging directory, which is removed with the job.
  const cookieTempDir =
    options.userDataPath !== null && options.userDataPath !== undefined
      ? path.join(options.userDataPath, 'media-cookies')
      : path.join(os.tmpdir(), 'dondownload-media-cookies')
  const activeCookieFiles = new Set<string>()

  async function cleanStaleCookieFiles(directory: string): Promise<void> {
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(COOKIE_FILE_PREFIX)) {
        continue
      }
      const candidate = path.resolve(directory, entry.name)
      if (activeCookieFiles.has(candidate)) continue
      await fs.rm(candidate, { force: true }).catch(() => undefined)
    }
  }

  async function writeCookieFile(
    directory: string,
    cookieHeader: string,
    targetUrl: string
  ): Promise<string> {
    const hostname = new URL(targetUrl).hostname
    const contents = buildNetscapeCookieFile(cookieHeader, hostname)
    await fs.mkdir(directory, { recursive: true })
    if (path.resolve(directory) === path.resolve(cookieTempDir)) {
      await cleanStaleCookieFiles(cookieTempDir)
    }
    const file = path.join(
      directory,
      `${COOKIE_FILE_PREFIX}${randomBytes(12).toString('hex')}.txt`
    )
    await fs.writeFile(file, contents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    activeCookieFiles.add(path.resolve(file))
    return file
  }

  async function removeCookieFile(file: string): Promise<void> {
    activeCookieFiles.delete(path.resolve(file))
    await fs.rm(file, { force: true }).catch(() => undefined)
  }

  // A previous crash may have left an analysis cookie file behind. Remove any
  // that this process does not own before the first cookie-using operation.
  if (options.userDataPath) {
    void cleanStaleCookieFiles(cookieTempDir).catch(() => undefined)
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
      signal?: AbortSignal
    }
  ): Promise<CapturedProcessResult> {
    if (closing) throw new ProcessAbortedError()

    const controller = new AbortController()
    const externalSignal = captureOptions.signal
    if (externalSignal?.aborted === true) throw new ProcessAbortedError()
    const onExternalAbort = (): void => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
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
      externalSignal?.removeEventListener('abort', onExternalAbort)
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

  const { resolveToolchain } = createToolchainResolver({
    env,
    platform,
    cwd,
    managedToolsDir,
    jsRuntime,
    runCaptured: runTrackedCapturedProcess
  })

  function assertPublicTarget(url: string): Promise<void> {
    return assertPublicTargetWithLookup(url, lookup)
  }

  async function getToolState(): Promise<MediaToolState> {
    const toolchain = await resolveToolchain()
    return { ...toolchain.state }
  }

  const { analyze } = createMediaAnalyzer({
    now,
    analysisTtlMs,
    analysisTimeoutMs,
    isClosing: () => closing,
    newOpaqueId,
    resolveToolchain,
    ensureJsRuntime,
    runCaptured: runTrackedCapturedProcess,
    assertPublicTarget,
    writeCookieFile,
    removeCookieFile,
    cookieTempDir,
    storeAnalysis,
    removeExpired
  })

  const collectionStore = createCollectionStore({
    now,
    ttlMs: collectionTtlMs,
    timeoutMs: analysisTimeoutMs,
    isClosing: () => closing,
    newOpaqueId,
    resolveToolchain,
    ensureJsRuntime,
    runCaptured: runTrackedCapturedProcess,
    assertPublicTarget
  })
  const { analyze: analyzeCollection, resolveEntries: resolveCollectionEntries } =
    collectionStore

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

    // A paused job already owns a staging directory with partial data. Keep it
    // and let yt-dlp continue the `.part` files on this new run.
    pausedStagingDirs.delete(jobId)

    // Reserve the identifier before the first await so two concurrent calls
    // cannot both start a download with the same job ID.
    const pending: PendingDownload = {
      cancelRequested: false,
      pauseRequested: false
    }
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
    const requestCookie = readOptionalCookie(record)
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
      // The cookie decision is part of the analysis identity: a cookie-bearing
      // analysis must not silently download anonymously, and vice versa.
      if (analysis.usedCookies !== (requestCookie !== undefined)) {
        throw new AppError(
          'MEDIA_ANALYSIS_MISMATCH',
          'The analysis no longer matches your cookie choice. Analyze the page again.'
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

    const throwIfStopped = (): void => {
      if (pending.pauseRequested) {
        throw new AppError('MEDIA_DOWNLOAD_PAUSED', 'The download was paused.')
      }
      if (pending.cancelRequested) {
        throw new AppError(
          'MEDIA_DOWNLOAD_CANCELLED',
          'The download was cancelled.'
        )
      }
    }

    throwIfStopped()

    const toolchain = await resolveToolchain()
    throwIfStopped()
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
    throwIfStopped()

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

    await staging.prepare(outputDir, stagingDir)
    if (pending.pauseRequested) {
      // Keep the staging directory and any partial files for a resume.
      throw new AppError('MEDIA_DOWNLOAD_PAUSED', 'The download was paused.')
    }
    if (pending.cancelRequested) {
      await staging.discard(stagingDir)
      throw new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
    }

    let downloadCookieFile: string | null = null
    if (direct === null && requestCookie !== undefined) {
      try {
        downloadCookieFile = await writeCookieFile(
          stagingDir,
          requestCookie,
          downloadTargetUrl
        )
      } catch {
        await staging.discard(stagingDir)
        throw new AppError(
          'MEDIA_COOKIE_UNAVAILABLE',
          'The browser cookie file could not be prepared for this download.'
        )
      }
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
      denoPath:
        toolchain.denoPath ?? (await ensureJsRuntime(downloadTargetUrl)),
      impersonate: toolchain.impersonate,
      maxBytes,
      cookiesPath: downloadCookieFile,
      ...directHeaders
    })

    const safeProgress: (update: MediaDownloadProgress) => void =
      typeof onProgress === 'function' ? onProgress : () => undefined

    return new Promise<MediaDownloadResult>((resolve, reject) => {
      let settled = false

      const job: ActiveDownload = {
        child: null,
        cancelRequested: false,
        pauseRequested: false,
        cancelTimer: null,
        forceCancel: null,
        forcePause: null
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

      // The analysis estimate keeps combined video+audio progress from
      // reaching 100% while only the first stream has reported a total.
      const progress = createDownloadProgressTracker({
        expectedTotal: selectedSize.bytes,
        expectedStreamCount: outputChoice.formatIds.length,
        maxBytes,
        emit,
        onSizeCapExceeded: () => {
          if (job.child !== null) {
            terminateProcessTree(job.child, platform, spawn, env)
          }
        }
      })

      const finalize = async (
        outcome: 'success' | 'failure' | 'cancelled' | 'paused'
      ): Promise<void> => {
        if (settled) return
        settled = true
        activeDownloads.delete(jobId)
        if (job.cancelTimer) {
          clearTimeout(job.cancelTimer)
          job.cancelTimer = null
        }
        if (downloadCookieFile !== null) {
          await removeCookieFile(downloadCookieFile)
          downloadCookieFile = null
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
            await staging.discard(stagingDir)
            emit(
              progress.merging ? 'merging' : 'downloading',
              stat.size,
              stat.size,
              0,
              finalPath
            )
            resolve({ filePath: finalPath, totalBytes: stat.size })
          } catch (error) {
            await staging.discard(stagingDir)
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

        if (outcome === 'paused') {
          // Keep the private staging directory, `.part` files and any merge
          // intermediates. A resume for this job reuses them verbatim.
          pausedStagingDirs.set(jobId, stagingDir)
          reject(new AppError('MEDIA_DOWNLOAD_PAUSED', 'The download was paused.'))
          return
        }

        await staging.discard(stagingDir)
        if (outcome === 'cancelled') {
          reject(
            new AppError('MEDIA_DOWNLOAD_CANCELLED', 'The download was cancelled.')
          )
        } else if (progress.sizeCapExceeded) {
          reject(new AppError('MEDIA_SIZE_CAP_EXCEEDED', 'The media output exceeded the configured per-job size limit.'))
        } else if (progress.drmDetected) {
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
      job.forcePause = () => {
        void finalize('paused')
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
      lowerProcessPriority(child.pid)

      child.stdout?.on('data', (chunk: unknown) =>
        progress.handleStdoutText(typeof chunk === 'string' ? chunk : String(chunk))
      )
      child.stdout?.on('error', () => undefined)
      child.stderr?.on('data', (chunk: unknown) =>
        progress.handleStderrText(typeof chunk === 'string' ? chunk : String(chunk))
      )
      child.stderr?.on('error', () => undefined)
      child.on('error', () => {
        void finalize('failure')
      })
      child.on('close', (code: number | null) => {
        progress.flush()
        if (job.pauseRequested) {
          void finalize('paused')
        } else if (job.cancelRequested) {
          void finalize('cancelled')
        } else if (code === 0) {
          void finalize('success')
        } else {
          void finalize('failure')
        }
      })

      emit('downloading', 0, selectedSize.bytes, 0, null)

      if (job.cancelRequested || job.pauseRequested) {
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

    // Cancelling a paused job discards the staging directory it was keeping.
    const pausedDir = pausedStagingDirs.get(id)
    if (pausedDir !== undefined) {
      pausedStagingDirs.delete(id)
      void staging.discard(pausedDir)
    }

    const pending = pendingDownloads.get(id)
    if (pending) {
      pending.cancelRequested = true
      pending.pauseRequested = false
    }

    const job = activeDownloads.get(id)
    if (!job || job.cancelRequested) return

    job.cancelRequested = true
    job.pauseRequested = false
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

  function pause(jobId: string): void {
    let id: string
    try {
      id = parseMediaJobId(jobId)
    } catch {
      return
    }

    const pending = pendingDownloads.get(id)
    if (pending) pending.pauseRequested = true

    const job = activeDownloads.get(id)
    if (!job || job.pauseRequested || job.cancelRequested) return

    job.pauseRequested = true
    if (job.child !== null) {
      terminateProcessTree(job.child, platform, spawn, env)
    }

    job.cancelTimer = setTimeout(() => {
      if (job.child !== null) {
        terminateProcessTree(job.child, platform, spawn, env)
      }
      job.forcePause?.()
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

    // No child can still need a cookie file after the bounded wait. This is
    // best effort and must not delay shutdown resolution.
    for (const file of [...activeCookieFiles]) {
      void removeCookieFile(file)
    }
    void cleanStaleCookieFiles(cookieTempDir).catch(() => undefined)
  }

  return {
    getToolState,
    analyze,
    analyzeCollection,
    resolveCollectionEntries,
    download,
    cancel,
    pause,
    cancelAll
  }
}
