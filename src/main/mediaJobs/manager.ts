import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import {
  isActiveMediaJobStatus,
  normalizeMediaSourceUrl,
  parseAnalyzeMediaInput,
  parseMediaAnalysis,
  parseMediaJobId,
  parseMediaJobIds,
  parseMediaQueueInput,
  parseMediaToolState,
  type MediaAnalysis,
  type MediaFormatOption,
  type MediaJob,
  type MediaJobDetails,
  type MediaJobRecord,
  type MediaJobStatus,
  type MediaMergeProgress,
  type MediaOutputFormat,
  type MediaSnapshot,
  type MediaToolState
} from '@shared/media'
import { mediaOutputFormatsForOption } from '@shared/mediaOutput'
import {
  parseSniffedMediaInput,
  type SniffedMediaInput
} from '@shared/sniffedMedia'
import { AppError } from '../errors'
import {
  checkDeleteTarget,
  deleteTargetError,
  type DeleteTargetEntry
} from '../downloads/deleteFile'
import { MERGE_PROGRESS_POLL_MS, readMergeProgress } from './mergeProgress'
import type { TaskbarActiveProgress } from '../taskbar/progress'

/**
 * Product-side media job orchestration for Milestone 3A.
 *
 * The manager owns only the lifecycle and persistence of jobs. Analysis and
 * downloads are delegated to an injected engine port so this module does not
 * depend on the engine worktree. Source URLs, output directory/paths, raw
 * selectors and analysis metadata never leave this module: `MediaJob` and
 * `MediaSnapshot` are sanitized copies that cross IPC/native boundaries.
 */

export interface MediaDirectDownloadRequest {
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
  outputFormat?: MediaOutputFormat
  /** Analysis cookies for this one download; memory-only. */
  cookie?: string
  /** Present only for a detected HLS/DASH job. Memory-only. */
  direct?: MediaDirectDownloadRequest
  /** Known total for progress; used with `direct` only. */
  expectedBytes?: number | null
}

export interface MediaDownloadProgress {
  status: 'downloading' | 'merging'
  completedBytes: number
  totalBytes: number | null
  speedBps: number
  filePath: string | null
}

export interface MediaDownloadResult {
  filePath: string
  totalBytes: number | null
}

/**
 * Structural engine port. Keep this local so the manager can be built before
 * the engine module is integrated; the engine worker only has to satisfy this
 * shape.
 */
export interface MediaEnginePort {
  getToolState(): Promise<MediaToolState>
  analyze(
    url: string,
    options?: { cookie?: string; signal?: AbortSignal }
  ): Promise<MediaAnalysis>
  download(
    request: MediaDownloadRequest,
    onProgress: (progress: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult>
  cancel(jobId: string): void
  /**
   * Stop the child but keep staging/partial files for an explicit resume.
   * Optional so narrow test doubles remain valid engine ports.
   */
  pause?(jobId: string): void
  /** Optional so narrow test doubles remain valid engine ports. */
  cancelAll?(): void | Promise<void>
}

/**
 * Narrow persistence port satisfied structurally by `DownloadDatabase`.
 * `sourceUrl`, `dir` and `filePath` are internal-only record fields.
 */
export interface MediaJobsPersistence {
  loadMediaJobs(): MediaJobRecord[]
  saveMediaJob(record: MediaJobRecord): void
  saveManyMediaJobs(records: readonly MediaJobRecord[]): void
  deleteMediaJob(id: string): void
  /** One transaction for a bulk removal; files on disk are never touched. */
  deleteMediaJobs(ids: readonly string[]): void
}

export interface MediaJobsManagerOptions {
  engine: MediaEnginePort
  mediaDir: string
  /**
   * Resolves the output directory for a new job (video or audio). Defaults to
   * `mediaDir` so callers that do not offer type sorting are unchanged.
   */
  outputDirFor?: (kind: 'video' | 'audio') => string
  /**
   * Root that completed outputs may live under. Defaults to `mediaDir`; the
   * desktop app passes the download root when type sorting is available.
   */
  outputRootDir?: string
  onUpdate: (snapshot: MediaSnapshot) => void
  database?: MediaJobsPersistence | null
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Bounded progress persistence interval; critical transitions write at once. */
  progressPersistIntervalMs?: number
  /**
   * Global start gate (currently the allowed-hours window). The default always
   * allows starts so narrow tests and non-policy callers keep working.
   */
  startAllowed?: (now: number) => boolean
  /**
   * Called for an extractor-style analysis failure. It may run a verified
   * yt-dlp update and resolves true when a newer binary was activated.
   */
  onExtractorFailure?: () => Promise<boolean>
}

export const MEDIA_INTERRUPTED_MESSAGE =
  'Interrupted before it finished because DonDownload stopped. Partial files are kept; download again to start a new job.'

const MEDIA_DOWNLOAD_FAILED_MESSAGE =
  'The media download failed. Analyze the page again and retry.'

const MEDIA_ANALYSIS_FAILED_MESSAGE = 'The media could not be analyzed.'
const MEDIA_DRM_PROTECTED_MESSAGE =
  "This video is DRM-protected and can't be downloaded."
const MEDIA_INVALID_ANALYSIS_MESSAGE =
  'The media analyzer returned an invalid result.'
const MEDIA_TOOL_STATE_FAILED_MESSAGE =
  'The media tool state could not be read.'

const PROGRESS_PERSIST_INTERVAL_MS = 2_500
/**
 * Same-status progress lines arrive far faster than the renderer can paint.
 * Coalesce them into one trailing publish; status transitions and terminal
 * states still publish immediately.
 */
const PROGRESS_PUBLISH_COALESCE_MS = 200
// Keep this aligned with the engine's 32-entry analysis cache. A larger cache
// here would expose an opaque analysis ID that the engine has already evicted,
// turning a valid queue request into a confusing download-time failure.
const MAX_CACHED_ANALYSES = 32

interface ManagedMediaJob {
  record: MediaJobRecord
  /** Transient progress speed; not persisted by the database schema. */
  speedBps: number
  /**
   * Transient merge-phase byte progress, sampled from the merge output file.
   * Never persisted: it is only meaningful while the merge is running.
   */
  mergeProgress: MediaMergeProgress | null
  /** Memory-only detected-stream headers; never persisted. */
  direct: MediaDirectDownloadRequest | null
  /** Memory-only analysis cookie; never persisted. */
  cookie: string | null
  /**
   * Transient duplicate-guard identity. It is derived from the normalized page
   * URL and visible format invariants, never from random analysis/option IDs.
   */
  optionFingerprint: string
  /**
   * True only for a job queued by this process while the start gate was closed.
   * Persisted queued rows loaded at startup are intentionally not started
   * automatically.
   */
  awaitingPolicy: boolean
  /** Explicit Resume/Retry this process bypasses the allowed-hours gate once. */
  startNow: boolean
  /** Increments for every run so a paused run cannot fail its successor. */
  runId: number
}

interface CachedMediaAnalysis {
  /** Normalized http(s) page URL. Never persisted by this cache. */
  sourceUrl: string
  /** Cookie decision belongs to the analysis identity. */
  usedCookies: boolean
  analysis: MediaAnalysis
}

const TERMINAL_STATUSES: ReadonlySet<MediaJobStatus> = new Set<MediaJobStatus>([
  'complete',
  'error',
  'cancelled',
  'interrupted'
])

function isTerminalStatus(status: MediaJobStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback
  }
  return Math.trunc(value)
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.trunc(value)
}

function copyAnalysis(analysis: MediaAnalysis): MediaAnalysis {
  return {
    ...analysis,
    options: analysis.options.map((option) => ({ ...option }))
  }
}

/**
 * Stable duplicate identity for a download choice. Opaque analysis and option
 * IDs change on every fresh analysis, so they cannot detect the same format of
 * the same page. Only visible invariants are hashed; opaque IDs and volatile
 * byte-size estimates are deliberately excluded.
 */
function mediaOptionFingerprint(
  sourceUrl: string,
  option: MediaFormatOption,
  outputFormat: MediaOutputFormat
): string {
  const invariants = [
    normalizeMediaSourceUrl(sourceUrl),
    option.kind,
    option.label,
    option.container,
    option.width,
    option.height,
    option.fps,
    option.videoCodec,
    option.audioCodec,
    option.hasAudio,
    option.requiresMerge,
    outputFormat
  ]
  return createHash('sha256').update(JSON.stringify(invariants)).digest('hex')
}

/** Preserve the engine's safe `MEDIA_*` category without leaking its message. */
function sanitizedEngineError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string
): AppError {
  if (error instanceof AppError && /^MEDIA_[A-Z0-9_]+$/.test(error.code)) {
    return new AppError(error.code, fallbackMessage)
  }
  return new AppError(fallbackCode, fallbackMessage)
}

export class MediaJobsManager {
  private readonly engine: MediaEnginePort
  private readonly mediaDir: string
  private readonly outputDirFor: (kind: 'video' | 'audio') => string
  private readonly outputRootDir: string
  private readonly onUpdate: (snapshot: MediaSnapshot) => void
  private readonly database: MediaJobsPersistence | null
  private readonly now: () => number
  private readonly progressPersistIntervalMs: number
  private readonly startAllowed: (now: number) => boolean
  private readonly onExtractorFailure:
    | (() => Promise<boolean>)
    | null

  private readonly jobs = new Map<string, ManagedMediaJob>()
  /** Only jobs currently `downloading`; taskbar aggregation is O(active). */
  private readonly taskbarActiveIds = new Set<string>()
  private readonly analyses = new Map<string, CachedMediaAnalysis>()
  private readonly dirtyIds = new Set<string>()
  /** One merge-output size poller per job, active only while merging. */
  private readonly mergePollers = new Map<string, ReturnType<typeof setInterval>>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by every change that the published snapshot must reflect. */
  private revision = 0
  private publishedRevision = 0
  private persistenceErrorLogged = false
  private closed = false
  private tool: MediaToolState = {
    status: 'stopped',
    version: null,
    message: null,
    hint: null
  }

  constructor(options: MediaJobsManagerOptions) {
    this.engine = options.engine
    this.mediaDir = options.mediaDir
    this.outputDirFor = options.outputDirFor ?? (() => this.mediaDir)
    this.outputRootDir = options.outputRootDir ?? options.mediaDir
    this.onUpdate = options.onUpdate
    this.database = options.database ?? null
    this.now = options.now ?? Date.now
    this.progressPersistIntervalMs =
      options.progressPersistIntervalMs ?? PROGRESS_PERSIST_INTERVAL_MS
    this.startAllowed = options.startAllowed ?? (() => true)
    this.onExtractorFailure = options.onExtractorFailure ?? null

    this.loadPersistedJobs()
  }

  getMediaSnapshot(): MediaSnapshot {
    const jobs = [...this.jobs.values()]
      .sort(
        (left, right) =>
          right.record.createdAt - left.record.createdAt ||
          right.record.updatedAt - left.record.updatedAt
      )
      .map((job) => this.toMediaJob(job))
    const tool = Object.freeze({ ...this.tool })
    const frozenJobs = Object.freeze(jobs) as MediaJob[]
    return Object.freeze({ tool, jobs: frozenJobs })
  }

  getMediaJob(rawId: unknown): MediaJob {
    return this.toMediaJob(this.requireJob(rawId))
  }

  /**
   * Display-only details for one exact job, fetched on demand by the details
   * pane. Unlike `MediaJob` publication above, this recovers the persisted
   * sourceUrl verbatim and the output path once known; snapshots stay clean.
   */
  getMediaJobDetails(rawId: unknown): MediaJobDetails {
    const job = this.requireJob(rawId)
    return Object.freeze({
      sourceUrl: job.record.sourceUrl,
      filePath: job.record.filePath
    })
  }

  /** Final output path of a completed job, for the scanner rename step. */
  getFilePath(id: string): string | null {
    const job = this.jobs.get(id)
    return job && job.record.status === 'complete' ? job.record.filePath : null
  }

  /**
   * Output directory of a job as soon as it exists. Paired funscripts use this
   * instead of a fixed scanner root so they follow the Job's Video/Audio
   * folder when type sorting is enabled.
   */
  getJobDirectory(id: string): string | null {
    return this.jobs.get(id)?.record.dir ?? null
  }

  /**
   * One sanitized job by exact id, or null. A cheap alternative to building the
   * whole snapshot when a caller only needs a single child record.
   */
  getJob(id: string): MediaJob | null {
    const job = this.jobs.get(id)
    return job ? this.toMediaJob(job) : null
  }

  /**
   * Aggregate for the Windows taskbar, without building or sorting a snapshot.
   * Only downloading jobs are visited; merging jobs do not count, matching
   * `computeTaskbarProgress`.
   */
  getActiveProgress(): TaskbarActiveProgress {
    let activeCount = 0
    let sizedCount = 0
    let completedBytes = 0
    let totalBytes = 0
    for (const id of this.taskbarActiveIds) {
      const job = this.jobs.get(id)
      const record = job?.record
      if (!job || !record || record.status !== 'downloading') continue
      activeCount += 1
      const total = record.totalBytes
      if (total === null || !(total > 0)) continue
      sizedCount += 1
      totalBytes += total
      completedBytes += Number.isFinite(record.completedBytes)
        ? Math.max(0, record.completedBytes)
        : 0
    }
    return { activeCount, sizedCount, completedBytes, totalBytes }
  }

  private trackTaskbarStatus(
    id: string,
    status: MediaJobStatus
  ): void {
    if (status === 'downloading') {
      this.taskbarActiveIds.add(id)
    } else {
      this.taskbarActiveIds.delete(id)
    }
  }

  async getMediaStatus(rawId: unknown): Promise<MediaJob> {
    return this.getMediaJob(rawId)
  }

  async analyzeMedia(
    rawInput: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<MediaAnalysis> {
    if (this.closed) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is shutting down.')
    }
    const input = parseAnalyzeMediaInput(rawInput)

    let raw: unknown
    try {
      raw = await this.engine.analyze(input.url, {
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    } catch (error) {
      if (
        this.onExtractorFailure !== null &&
        error instanceof AppError &&
        error.code === 'MEDIA_ANALYSIS_EXTRACTOR_FAILED'
      ) {
        let updated = false
        try {
          updated = await this.onExtractorFailure()
        } catch {
          // The update is best effort; the analysis failure is still reported.
        }
        if (updated) {
          throw new AppError(
            'MEDIA_ANALYSIS_EXTRACTOR_FAILED',
            'yt-dlp was updated — try again.',
            'The page was not analyzed with the old yt-dlp. Run the analysis again.'
          )
        }
      }
      if (
        error instanceof AppError &&
        error.code === 'MEDIA_DRM_PROTECTED'
      ) {
        throw new AppError('MEDIA_DRM_PROTECTED', MEDIA_DRM_PROTECTED_MESSAGE)
      }
      throw sanitizedEngineError(
        error,
        'MEDIA_ANALYSIS_FAILED',
        MEDIA_ANALYSIS_FAILED_MESSAGE
      )
    }
    if (this.closed) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is shutting down.')
    }

    let analysis: MediaAnalysis
    try {
      analysis = parseMediaAnalysis(raw)
    } catch {
      throw new AppError('MEDIA_ANALYSIS_FAILED', MEDIA_INVALID_ANALYSIS_MESSAGE)
    }

    this.analyses.set(analysis.analysisId, {
      sourceUrl: input.url,
      usedCookies: input.cookie !== undefined,
      analysis
    })
    this.pruneAnalyses()
    return copyAnalysis(analysis)
  }

  /**
   * Resolve an opaque option against the fresh in-memory analysis, create a
   * new job and start it. Returns the queued job only; callers that need the
   * whole list use `getMediaSnapshot`.
   */
  async queueMedia(rawInput: unknown): Promise<MediaJob> {
    if (this.closed) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is shutting down.')
    }
    const input = parseMediaQueueInput(rawInput)
    const cached = this.requireAnalysis(input.analysisId)
    if (cached.usedCookies !== (input.cookie !== undefined)) {
      throw new AppError(
        'MEDIA_ANALYSIS_MISMATCH',
        'The analysis no longer matches your cookie choice. Analyze the media page again.'
      )
    }

    const option = cached.analysis.options.find(
      (candidate) => candidate.optionId === input.optionId
    )
    if (!option) {
      throw new AppError(
        'MEDIA_OPTION_INVALID',
        'That media format does not belong to this analysis.'
      )
    }

    const outputFormat: MediaOutputFormat = input.outputFormat ?? 'auto'
    if (
      outputFormat !== 'auto' &&
      !mediaOutputFormatsForOption(option).includes(outputFormat)
    ) {
      throw new AppError(
        'MEDIA_OUTPUT_FORMAT_UNSUPPORTED',
        'This option cannot produce the selected output format without transcoding. Choose Auto or another format.'
      )
    }

    const optionFingerprint = mediaOptionFingerprint(
      cached.sourceUrl,
      option,
      outputFormat
    )
    if (input.force !== true) {
      for (const job of this.jobs.values()) {
        if (
          job.optionFingerprint === optionFingerprint &&
          job.record.sourceUrl === cached.sourceUrl &&
          isActiveMediaJobStatus(job.record.status)
        ) {
          throw new AppError(
            'MEDIA_DUPLICATE_JOB',
            'This media format is already queued or downloading.',
            'Use Download again only if you deliberately want a second copy.'
          )
        }
      }
    }

    const createdAt = this.now()
    const formatSize = option.outputSizes?.[outputFormat]
    const knownTotalBytes =
      formatSize !== undefined
        ? formatSize.bytes
        : option.estimatedBytes ?? option.filesizeBytes
    const record: MediaJobRecord = {
      id: randomUUID(),
      sourceUrl: cached.sourceUrl,
      analysisId: cached.analysis.analysisId,
      optionId: option.optionId,
      kind: option.kind,
      title: cached.analysis.title,
      label:
        outputFormat === 'auto'
          ? option.label
          : `${option.label} · ${outputFormat.toUpperCase()}`,
      status: 'queued',
      completedBytes: 0,
      totalBytes:
        knownTotalBytes !== null && knownTotalBytes > 0 ? knownTotalBytes : null,
      errorMessage: null,
      dir: this.outputDirFor(option.kind === 'audio' ? 'audio' : 'video'),
      filePath: null,
      maxBytes: input.maxBytes ?? null,
      outputFormat,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }

    const allowedNow = this.startAllowed(createdAt)
    const job: ManagedMediaJob = {
      record,
      speedBps: 0,
      mergeProgress: null,
      direct: null,
      cookie: input.cookie ?? null,
      optionFingerprint,
      awaitingPolicy: !allowedNow,
      startNow: false,
      runId: 0
    }
    this.jobs.set(record.id, job)
    this.persistNow(job)
    this.publish(true)

    const queued = this.toMediaJob(job)
    if (allowedNow) {
      queueMicrotask(() => {
        void this.runJob(record.id)
      })
    }
    return queued
  }

  /**
   * Create a normal media job for a detected HLS/DASH stream. The selected
   * manifest (or pinned HLS variant) is downloaded by yt-dlp's generic
   * extractor, so progress/status/cancel all use the existing media UI.
   *
   * Referer/User-Agent/Cookie stay in memory on this process only. A persisted
   * row never contains them, and a relaunch marks active jobs interrupted.
   */
  async queueSniffedMedia(rawInput: SniffedMediaInput): Promise<MediaJob> {
    if (this.closed) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is shutting down.')
    }
    const input = parseSniffedMediaInput(rawInput)
    if (input.kind === 'file') {
      throw new AppError(
        'MEDIA_OPTION_INVALID',
        'A direct detected file is queued through aria2, not the media engine.'
      )
    }
    const sourceUrl = input.variant?.url ?? input.url
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          normalizeMediaSourceUrl(sourceUrl),
          input.kind,
          input.variant?.url ?? null
        ])
      )
      .digest('hex')

    for (const job of this.jobs.values()) {
      if (
        job.optionFingerprint === fingerprint &&
        job.record.sourceUrl === sourceUrl &&
        isActiveMediaJobStatus(job.record.status)
      ) {
        throw new AppError(
          'MEDIA_DUPLICATE_JOB',
          'This detected stream is already queued or downloading.',
          'Use Download again only if you deliberately want a second copy.'
        )
      }
    }

    const createdAt = this.now()
    const label =
      input.kind === 'hls'
        ? input.variant?.label
          ? `HLS · ${input.variant.label}`
          : 'HLS stream'
        : 'DASH stream'
    const record: MediaJobRecord = {
      id: randomUUID(),
      sourceUrl,
      analysisId: 'sniffed',
      optionId: 'auto',
      kind: 'video',
      title: input.title,
      label,
      status: 'queued',
      completedBytes: 0,
      totalBytes:
        input.expectedBytes !== undefined && input.expectedBytes > 0
          ? input.expectedBytes
          : null,
      errorMessage: null,
      dir: this.outputDirFor('video'),
      filePath: null,
      maxBytes: null,
      outputFormat: 'auto',
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }

    const allowedNow = this.startAllowed(createdAt)
    const job: ManagedMediaJob = {
      record,
      speedBps: 0,
      mergeProgress: null,
      direct: {
        kind: input.kind,
        referer: input.referer,
        userAgent: input.userAgent,
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
        title: input.title
      },
      cookie: null,
      optionFingerprint: fingerprint,
      awaitingPolicy: !allowedNow,
      startNow: false,
      runId: 0
    }
    this.jobs.set(record.id, job)
    this.persistNow(job)
    this.publish(true)

    const queued = this.toMediaJob(job)
    if (allowedNow) {
      queueMicrotask(() => {
        void this.runJob(record.id)
      })
    }
    return queued
  }

  /**
   * Signal the engine (best effort) and reach the `cancelled` terminal state.
   * A late engine progress/result can never move the job out of that state.
   */
  async cancelMedia(rawId: unknown): Promise<MediaJob> {
    const job = this.requireJob(rawId)
    if (
      !isActiveMediaJobStatus(job.record.status) &&
      job.record.status !== 'paused'
    ) {
      return this.toMediaJob(job)
    }

    this.endMergePhase(job)
    const updatedAt = this.now()
    job.record.status = 'cancelled'
    this.trackTaskbarStatus(job.record.id, 'cancelled')
    job.record.errorMessage = null
    job.record.updatedAt = updatedAt
    job.speedBps = 0
    this.persistNow(job)
    this.publish(true)

    try {
      // Cancelling a paused job also removes the staging/partial files it kept.
      this.engine.cancel(job.record.id)
    } catch {
      // The job is already cancelled locally; a missing engine job is fine.
    }

    return this.toMediaJob(job)
  }

  /**
   * Pause a running (or queued) media job. The yt-dlp child is stopped but the
   * private staging directory and `.part` files stay on disk for Resume.
   */
  async pauseMedia(rawId: unknown): Promise<MediaSnapshot> {
    const job = this.requireJob(rawId)
    if (job.record.status === 'paused') return this.getMediaSnapshot()
    if (!isActiveMediaJobStatus(job.record.status)) {
      throw new AppError(
        'MEDIA_NOT_RUNNING',
        'Only a queued or running media job can be paused.'
      )
    }

    this.endMergePhase(job)
    job.record.status = 'paused'
    this.trackTaskbarStatus(job.record.id, 'paused')
    job.record.errorMessage = null
    job.record.updatedAt = this.now()
    job.awaitingPolicy = false
    job.startNow = false
    job.speedBps = 0
    this.persistNow(job)
    this.publish(true)

    try {
      this.engine.pause?.(job.record.id)
    } catch {
      // The job is already paused locally; a missing child is harmless.
    }
    return this.getMediaSnapshot()
  }

  /** Continue a paused job with the same pinned analysis/format selection. */
  async resumeMedia(rawId: unknown): Promise<MediaSnapshot> {
    const job = this.requireJob(rawId)
    if (job.record.status !== 'paused') {
      throw new AppError(
        'MEDIA_NOT_PAUSED',
        'Only a paused media job can be resumed.'
      )
    }
    this.assertSelectionAvailable(job)

    job.record.status = 'queued'
    this.trackTaskbarStatus(job.record.id, 'queued')
    job.record.errorMessage = null
    job.record.completedAt = null
    job.record.updatedAt = this.now()
    job.awaitingPolicy = false
    job.startNow = true
    this.persistNow(job)
    this.publish(true)
    queueMicrotask(() => {
      void this.runJob(job.record.id)
    })
    return this.getMediaSnapshot()
  }

  /**
   * Re-queue a failed, cancelled or interrupted media job without analyzing the
   * page again. Only the already-pinned analysis/option pair is reused; when
   * that in-memory analysis no longer exists the user is asked to analyze
   * again rather than guessing a format.
   */
  async retryMedia(rawId: unknown): Promise<MediaSnapshot> {
    const job = this.requireJob(rawId)
    if (
      job.record.status !== 'error' &&
      job.record.status !== 'cancelled' &&
      job.record.status !== 'interrupted'
    ) {
      throw new AppError(
        'MEDIA_NOT_RETRYABLE',
        'Only a failed, cancelled or interrupted media job can be retried.'
      )
    }
    this.assertSelectionAvailable(job)

    this.endMergePhase(job)
    job.record.status = 'queued'
    this.trackTaskbarStatus(job.record.id, 'queued')
    job.record.completedBytes = 0
    job.record.errorMessage = null
    job.record.filePath = null
    job.record.completedAt = null
    job.record.updatedAt = this.now()
    job.awaitingPolicy = false
    job.startNow = true
    job.speedBps = 0
    this.persistNow(job)
    this.publish(true)
    queueMicrotask(() => {
      void this.runJob(job.record.id)
    })
    return this.getMediaSnapshot()
  }

  /**
   * Move the exact recorded media output to the Recycle Bin, then remove the
   * row. Same safety policy as downloads: finished only, inside the job's
   * recorded directory, symlinks refused, `shell.trashItem` only.
   */
  async deleteMediaFile(rawId: unknown): Promise<MediaSnapshot> {
    const job = this.requireJob(rawId)
    const record = job.record
    let entry: DeleteTargetEntry | null = null
    if (record.filePath !== null) {
      try {
        const stat = await fs.lstat(record.filePath)
        entry = { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() }
      } catch {
        entry = null
      }
    }

    const check = checkDeleteTarget({
      root: record.dir,
      filePath: record.filePath,
      finished: record.status === 'complete',
      entry
    })
    if (!check.ok) {
      const info = deleteTargetError(check.problem)
      throw new AppError(info.code, info.message, info.hint)
    }

    try {
      await shell.trashItem(record.filePath as string)
    } catch {
      throw new AppError(
        'FILE_DELETE_FAILED',
        'The file could not be moved to the Recycle Bin.',
        'The media job was kept.'
      )
    }

    return this.removeJobRow(job)
  }

  /** Remove only the database row. Media files are intentionally kept. */
  async removeMedia(rawId: unknown): Promise<MediaSnapshot> {
    const job = this.requireJob(rawId)

    if (
      isActiveMediaJobStatus(job.record.status) ||
      job.record.status === 'paused'
    ) {
      try {
        this.engine.cancel(job.record.id)
      } catch {
        // Best effort; the row still disappears from this app.
      }
    }

    return this.removeJobRow(job)
  }

  private removeJobRow(job: ManagedMediaJob): MediaSnapshot {
    this.forgetJob(job.record.id)
    this.removePersisted(job.record.id)
    this.stopFlushIfIdle()
    this.publish(true)
    return this.getMediaSnapshot()
  }

  /**
   * Remove many media list entries at once — the "Clear list" path.
   *
   * Media files are never touched: only the history rows go. Unknown ids are
   * skipped, and the rows are deleted in one database transaction followed by a
   * single publish.
   */
  removeMany(rawIds: unknown): MediaSnapshot {
    const ids = parseMediaJobIds(rawIds)
    if (ids.length === 0) return this.getMediaSnapshot()

    const removed: string[] = []
    for (const id of ids) {
      const job = this.jobs.get(id)
      if (!job) continue
      if (
        isActiveMediaJobStatus(job.record.status) ||
        job.record.status === 'paused'
      ) {
        try {
          this.engine.cancel(job.record.id)
        } catch {
          // Best effort; the row still disappears from this app.
        }
      }
      this.forgetJob(job.record.id)
      removed.push(job.record.id)
    }
    if (removed.length === 0) return this.getMediaSnapshot()

    this.removePersistedMany(removed)
    this.stopFlushIfIdle()
    this.publish(true)
    return this.getMediaSnapshot()
  }

  /** Drop every in-memory trace of one job. Media files are untouched. */
  private forgetJob(id: string): void {
    this.stopMergeProgressPolling(id)
    this.jobs.delete(id)
    this.taskbarActiveIds.delete(id)
    this.dirtyIds.delete(id)
  }

  /** Leave the merge phase: stop sampling and drop the transient sample. */
  private endMergePhase(job: ManagedMediaJob): void {
    this.stopMergeProgressPolling(job.record.id)
    job.mergeProgress = null
  }

  /** True when the pinned selection can still be used without a new analysis. */
  private assertSelectionAvailable(job: ManagedMediaJob): void {
    if (job.record.analysisId === 'sniffed') {
      if (job.direct === null) {
        throw new AppError(
          'MEDIA_SOURCE_UNAVAILABLE',
          'This detected stream was not kept in memory. Add it again from the browser.'
        )
      }
      return
    }
    const cached = this.analyses.get(job.record.analysisId)
    if (!cached) {
      throw new AppError(
        'MEDIA_ANALYSIS_NOT_FOUND',
        'The media details are no longer available. Analyze the page again.'
      )
    }
    if (cached.analysis.expiresAt <= this.now()) {
      this.analyses.delete(job.record.analysisId)
      throw new AppError(
        'MEDIA_ANALYSIS_EXPIRED',
        'The media details expired. Analyze the page again.'
      )
    }
    if (
      !cached.analysis.options.some(
        (option) => option.optionId === job.record.optionId
      )
    ) {
      throw new AppError(
        'MEDIA_OPTION_INVALID',
        'That media format is no longer available.'
      )
    }
  }

  /** Validated completed output only; Electron `shell` stays in the main process. */
  async showMediaInFolder(rawId: unknown): Promise<null> {
    const job = this.requireJob(rawId)
    const record = job.record
    if (record.status !== 'complete' || !record.filePath) {
      throw new AppError('FILE_NOT_READY', 'The media file is not ready yet.')
    }
    if (!isInsideDirectory(this.outputRootDir, record.filePath)) {
      throw new AppError(
        'FILE_OUTSIDE_MEDIA_DIR',
        'The reported media file is outside the configured media folder.'
      )
    }

    try {
      await fs.access(record.filePath)
    } catch {
      throw new AppError(
        'FILE_MISSING',
        'The media file is no longer on disk.',
        'It may have been moved or deleted.'
      )
    }

    shell.showItemInFolder(record.filePath)
    return null
  }

  /** Open a completed media output with the OS default application. */
  async openMediaFile(rawId: unknown): Promise<null> {
    const job = this.requireJob(rawId)
    const record = job.record
    if (record.status !== 'complete' || !record.filePath) {
      throw new AppError('FILE_NOT_READY', 'The media file is not ready yet.')
    }
    if (!isInsideDirectory(this.outputRootDir, record.filePath)) {
      throw new AppError(
        'FILE_OUTSIDE_MEDIA_DIR',
        'The reported media file is outside the configured media folder.'
      )
    }

    try {
      await fs.access(record.filePath)
    } catch {
      throw new AppError(
        'FILE_MISSING',
        'The media file is no longer on disk.',
        'It may have been moved or deleted.'
      )
    }

    const failure = await shell.openPath(record.filePath)
    if (failure.length > 0) {
      throw new AppError(
        'FILE_OPEN_FAILED',
        'The media file could not be opened.',
        failure
      )
    }
    return null
  }

  /** Read the engine tool state and publish the new snapshot. */
  async refreshToolState(): Promise<MediaToolState> {
    if (this.closed) return Object.freeze({ ...this.tool })
    try {
      this.tool = parseMediaToolState(await this.engine.getToolState())
    } catch {
      this.tool = {
        status: 'error',
        version: null,
        message: MEDIA_TOOL_STATE_FAILED_MESSAGE,
        hint: null
      }
    }
    this.publish(true)
    return Object.freeze({ ...this.tool })
  }

  /**
   * True while a media job created in this process is waiting for the global
   * start gate. The download manager's existing poll timer uses this to wake
   * the media manager; no separate media scheduler is created.
   */
  /**
   * True while an analysis or download is actually using yt-dlp. A queued job
   * blocked by the start gate is not running, so a verified update may still be
   * activated before that job begins.
   */
  hasActiveJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (
        job.record.status === 'analyzing' ||
        job.record.status === 'downloading' ||
        job.record.status === 'merging'
      ) {
        return true
      }
    }
    return false
  }

  hasPendingPolicyWork(): boolean {
    for (const job of this.jobs.values()) {
      if (job.record.status === 'queued' && job.awaitingPolicy) return true
    }
    return false
  }

  /** Start jobs that were queued while the allowed-hours gate was closed. */
  pumpPolicy(now = this.now()): void {
    if (this.closed || !this.startAllowed(now)) return
    for (const job of this.jobs.values()) {
      if (job.record.status !== 'queued' || !job.awaitingPolicy) continue
      job.awaitingPolicy = false
      queueMicrotask(() => {
        void this.runJob(job.record.id)
      })
    }
  }

  /** Flush bounded progress writes. Call before closing the database. */
  flushPersistence(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending()
    this.flushPublish()
  }

  /**
   * Interrupt active children, preserve partial files and flush before DB
   * close. Resolves only after the engine has terminated its in-flight
   * download, analysis and probe children (or the bounded grace elapsed).
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const id of [...this.mergePollers.keys()]) {
      this.stopMergeProgressPolling(id)
    }

    const updatedAt = this.now()
    let changed = false
    for (const job of this.jobs.values()) {
      if (!isActiveMediaJobStatus(job.record.status)) continue

      job.record.status = 'interrupted'
      this.trackTaskbarStatus(job.record.id, 'interrupted')
      job.record.errorMessage = MEDIA_INTERRUPTED_MESSAGE
      job.record.updatedAt = updatedAt
      job.speedBps = 0
      this.persistNow(job)
      changed = true

      try {
        this.engine.cancel(job.record.id)
      } catch {
        // Shutdown remains bounded even if a child already exited.
      }
    }
    if (changed) this.publish(true)

    // Analyses and tool probes are not tied to a job ID, so cancel them too
    // and wait for their child trees to settle. Callers can then close the
    // database without a late engine callback racing persistence.
    try {
      await this.engine.cancelAll?.()
    } catch {
      // Shutdown must never be blocked by engine cleanup.
    }
    this.flushPersistence()
  }

  /**
   * Publish the current snapshot. `force` publishes synchronously and is used
   * for status transitions and terminal states; a plain call is coalesced into
   * one trailing publish so per-line yt-dlp progress cannot rebuild the full
   * snapshot on every line.
   */
  publish(force = false): void {
    this.revision += 1
    if (force) {
      this.flushPublish()
      return
    }
    if (this.publishTimer !== null) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.flushPublish()
    }, PROGRESS_PUBLISH_COALESCE_MS)
    this.publishTimer.unref?.()
  }

  private flushPublish(): void {
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer)
      this.publishTimer = null
    }
    if (this.revision === this.publishedRevision) return
    this.publishedRevision = this.revision
    const snapshot = this.getMediaSnapshot()
    try {
      this.onUpdate(snapshot)
    } catch {
      // A closing window must not break job state or persistence.
    }
  }

  private async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || job.record.status !== 'queued' || this.closed) return

    // Explicit Resume/Retry bypasses the allowed-hours gate for this one run,
    // matching the download manager's start-now semantics.
    const override = job.startNow
    job.startNow = false
    if (!override && !this.startAllowed(this.now())) {
      job.awaitingPolicy = true
      return
    }
    job.awaitingPolicy = false
    this.endMergePhase(job)
    const runId = job.runId + 1
    job.runId = runId

    job.record.status = 'downloading'
    this.trackTaskbarStatus(job.record.id, 'downloading')
    job.record.updatedAt = this.now()
    this.persistNow(job)
    this.publish(true)

    try {
      const result = await this.engine.download(
        {
          jobId: job.record.id,
          sourceUrl: job.record.sourceUrl,
          analysisId: job.record.analysisId,
          optionId: job.record.optionId,
          dir: job.record.dir,
          maxBytes: job.record.maxBytes ?? null,
          outputFormat: job.record.outputFormat ?? 'auto',
          ...(job.cookie === null ? {} : { cookie: job.cookie }),
          ...(job.direct === null
            ? {}
            : {
                direct: job.direct,
                expectedBytes: job.record.totalBytes
              })
        },
        (progress) => {
          this.handleProgress(id, runId, progress)
        }
      )
      this.completeJob(id, runId, result)
    } catch (error) {
      this.failJob(id, runId, error)
    }
  }

  private handleProgress(
    id: string,
    runId: number,
    progress: MediaDownloadProgress
  ): void {
    const job = this.jobs.get(id)
    if (
      !job ||
      job.runId !== runId ||
      isTerminalStatus(job.record.status) ||
      job.record.status === 'paused'
    ) {
      return
    }

    const reportedStatus = progress?.status
    if (reportedStatus !== 'downloading' && reportedStatus !== 'merging') {
      return
    }
    // `merging` is terminal for the download phase; never step backwards.
    const nextStatus: MediaJobStatus =
      job.record.status === 'merging' ? 'merging' : reportedStatus

    const completedBytes = nonNegativeInteger(progress.completedBytes, 0)
    const reportedTotal = nullableNonNegativeInteger(progress.totalBytes)
    const totalBytes =
      reportedTotal !== null && reportedTotal > 0
        ? reportedTotal
        : job.record.totalBytes
    const speedBps = nonNegativeInteger(progress.speedBps, 0)
    const filePath =
      typeof progress.filePath === 'string' && progress.filePath.length > 0
        ? progress.filePath
        : null

    const previousStatus = job.record.status
    const previousFilePath = job.record.filePath
    const previousCompletedBytes = job.record.completedBytes
    const previousTotalBytes = job.record.totalBytes
    const previousSpeedBps = job.speedBps

    job.record.status = nextStatus
    this.trackTaskbarStatus(job.record.id, nextStatus)
    job.record.totalBytes = totalBytes
    job.record.completedBytes =
      totalBytes === null
        ? completedBytes
        : Math.min(completedBytes, totalBytes)
    job.speedBps = nextStatus === 'merging' ? 0 : speedBps
    if (filePath !== null) job.record.filePath = filePath
    job.record.updatedAt = this.now()

    // The merge output is the only measurable thing in this phase, and it only
    // exists between the merge start and the rename that completes the job.
    if (previousStatus !== nextStatus) {
      if (nextStatus === 'merging') {
        this.startMergeProgressPolling(job)
      } else {
        this.stopMergeProgressPolling(job.record.id)
        job.mergeProgress = null
      }
    }

    const critical =
      previousStatus !== nextStatus ||
      (filePath !== null && filePath !== previousFilePath)
    if (critical) {
      this.persistNow(job)
      this.publish(true)
      return
    }

    // A repeated line with identical numbers is not a change worth publishing.
    if (
      job.record.completedBytes === previousCompletedBytes &&
      job.record.totalBytes === previousTotalBytes &&
      job.speedBps === previousSpeedBps
    ) {
      return
    }
    this.markDirty(job)
    this.publish()
  }

  /**
   * Sample the merge output file about once a second. ffmpeg merges with
   * stream copy, so its size tracks the sum of the downloaded parts and gives
   * the row real progress instead of an opaque "merging" bar.
   */
  private startMergeProgressPolling(job: ManagedMediaJob): void {
    const id = job.record.id
    job.mergeProgress = null
    if (this.mergePollers.has(id)) return

    const since = this.now()
    const timer = setInterval(() => {
      void this.sampleMergeProgress(id, since)
    }, MERGE_PROGRESS_POLL_MS)
    timer.unref?.()
    this.mergePollers.set(id, timer)
  }

  /** Any status change ends the merge phase, so polling stops with it. */
  private stopMergeProgressPolling(id: string): void {
    const timer = this.mergePollers.get(id)
    if (timer === undefined) return
    clearInterval(timer)
    this.mergePollers.delete(id)
  }

  private async sampleMergeProgress(id: string, since: number): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || job.record.status !== 'merging' || this.closed) {
      this.stopMergeProgressPolling(id)
      return
    }

    let sample: MediaMergeProgress | null = null
    try {
      sample = await readMergeProgress({
        dir: job.record.dir,
        since,
        totalBytes: job.record.totalBytes
      })
    } catch {
      // An unreadable output directory is not a job failure.
      sample = null
    }

    const current = this.jobs.get(id)
    // A status change during the read wins: drop the sample and stop polling.
    if (!current || current !== job || current.record.status !== 'merging') {
      this.stopMergeProgressPolling(id)
      return
    }
    if (sample === null) return

    const previous = current.mergeProgress
    if (
      previous !== null &&
      previous.completedBytes === sample.completedBytes &&
      previous.totalBytes === sample.totalBytes
    ) {
      return
    }
    current.mergeProgress = sample
    // Coalesced like every other progress update; the merge lasts minutes.
    this.publish()
  }

  private completeJob(
    id: string,
    runId: number,
    result: MediaDownloadResult
  ): void {
    const job = this.jobs.get(id)
    if (
      !job ||
      job.runId !== runId ||
      isTerminalStatus(job.record.status) ||
      job.record.status === 'paused'
    ) {
      return
    }

    this.endMergePhase(job)
    const filePath =
      result && typeof result.filePath === 'string' ? result.filePath.trim() : ''
    if (filePath.length === 0) {
      this.failJob(id, runId)
      return
    }

    if (
      job.record.maxBytes != null &&
      result.totalBytes !== null &&
      result.totalBytes > job.record.maxBytes
    ) {
      this.failJob(
        id,
        runId,
        new AppError(
          'MEDIA_SIZE_CAP_EXCEEDED',
          'The media output exceeded the configured per-job size limit.'
        )
      )
      return
    }

    const reportedTotal = nullableNonNegativeInteger(result.totalBytes)
    const totalBytes =
      reportedTotal !== null && reportedTotal > 0
        ? reportedTotal
        : job.record.totalBytes
    const completedAt = this.now()

    job.record.status = 'complete'
    this.trackTaskbarStatus(job.record.id, 'complete')
    job.record.filePath = filePath
    job.record.totalBytes = totalBytes
    job.record.completedBytes =
      totalBytes === null ? job.record.completedBytes : totalBytes
    job.record.errorMessage = null
    job.record.completedAt = completedAt
    job.record.updatedAt = completedAt
    job.speedBps = 0

    this.persistNow(job)
    this.publish(true)
  }

  private failJob(id: string, runId: number, error?: unknown): void {
    const job = this.jobs.get(id)
    if (
      !job ||
      job.runId !== runId ||
      isTerminalStatus(job.record.status) ||
      job.record.status === 'paused'
    ) {
      return
    }

    this.endMergePhase(job)
    job.record.status = 'error'
    this.trackTaskbarStatus(job.record.id, 'error')
    job.record.errorMessage =
      error instanceof AppError && error.code === 'MEDIA_SIZE_CAP_EXCEEDED'
        ? error.message
        : error instanceof AppError && error.code === 'MEDIA_DRM_PROTECTED'
          ? MEDIA_DRM_PROTECTED_MESSAGE
          : MEDIA_DOWNLOAD_FAILED_MESSAGE
    job.record.updatedAt = this.now()
    job.speedBps = 0

    this.persistNow(job)
    this.publish(true)
  }

  private requireJob(rawId: unknown): ManagedMediaJob {
    const id = parseMediaJobId(rawId)
    const job = this.jobs.get(id)
    if (!job) {
      throw new AppError('MEDIA_JOB_NOT_FOUND', 'That media job no longer exists.')
    }
    return job
  }

  private requireAnalysis(analysisId: string): CachedMediaAnalysis {
    const cached = this.analyses.get(analysisId)
    if (!cached) {
      throw new AppError(
        'MEDIA_ANALYSIS_NOT_FOUND',
        'Analyze the media page again before downloading.'
      )
    }
    if (cached.analysis.expiresAt <= this.now()) {
      this.analyses.delete(analysisId)
      throw new AppError(
        'MEDIA_ANALYSIS_EXPIRED',
        'The media details expired. Analyze the page again.'
      )
    }
    return cached
  }

  private pruneAnalyses(): void {
    const now = this.now()
    for (const [analysisId, cached] of this.analyses) {
      if (cached.analysis.expiresAt <= now) {
        this.analyses.delete(analysisId)
      }
    }
    while (this.analyses.size > MAX_CACHED_ANALYSES) {
      const oldest = this.analyses.keys().next().value
      if (oldest === undefined) break
      this.analyses.delete(oldest)
    }
  }

  private toMediaJob(job: ManagedMediaJob): MediaJob {
    const record = job.record
    return Object.freeze({
      id: record.id,
      analysisId: record.analysisId,
      optionId: record.optionId,
      kind: record.kind,
      title: record.title,
      label: record.label,
      status: record.status,
      completedBytes: record.completedBytes,
      totalBytes: record.totalBytes,
      speedBps: job.speedBps,
      errorMessage: record.errorMessage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      // Additive and optional: only a running merge can measure its output.
      ...(job.mergeProgress === null
        ? {}
        : { mergeProgress: Object.freeze({ ...job.mergeProgress }) })
    })
  }

  private loadPersistedJobs(): void {
    if (!this.database) return

    let stored: MediaJobRecord[]
    try {
      stored = this.database.loadMediaJobs()
    } catch (error) {
      this.logPersistenceError('could not be loaded')
      return
    }

    const now = this.now()
    const interrupted: MediaJobRecord[] = []

    for (const loaded of stored) {
      if (this.jobs.has(loaded.id)) continue

      let sourceUrl: string
      try {
        // Reject tampered credential-bearing or non-http(s) rows. Never delete
        // them; the row simply stays out of this process's view.
        sourceUrl = normalizeMediaSourceUrl(loaded.sourceUrl)
      } catch {
        continue
      }

      const record: MediaJobRecord = { ...loaded, sourceUrl }
      if (isActiveMediaJobStatus(record.status)) {
        // Conservative recovery: no auto-resume, no re-download, no deletion
        // of partial output. The job becomes an explicit terminal state.
        record.status = 'interrupted'
        record.errorMessage = MEDIA_INTERRUPTED_MESSAGE
        record.updatedAt = now
        interrupted.push(record)
      }

      this.jobs.set(record.id, {
        record,
        speedBps: 0,
        mergeProgress: null,
        direct: null,
        cookie: null,
        optionFingerprint: '',
        // Persisted queued jobs are not silently restarted after a relaunch.
        awaitingPolicy: false,
        startNow: false,
        runId: 0
      })
    }

    if (interrupted.length > 0) {
      try {
        this.database.saveManyMediaJobs(interrupted)
      } catch {
        this.logPersistenceError('could not be saved')
      }
    }
  }

  private persistNow(job: ManagedMediaJob): void {
    if (!this.database) return
    try {
      this.database.saveMediaJob({ ...job.record })
      this.dirtyIds.delete(job.record.id)
    } catch {
      this.logPersistenceError('could not be saved')
      this.markDirty(job)
    }
  }

  private removePersisted(id: string): void {
    if (!this.database) return
    try {
      this.database.deleteMediaJob(id)
    } catch {
      this.logPersistenceError('could not be removed')
    }
  }

  private removePersistedMany(ids: readonly string[]): void {
    if (!this.database || ids.length === 0) return
    try {
      this.database.deleteMediaJobs(ids)
    } catch {
      this.logPersistenceError('could not be removed')
    }
  }

  private markDirty(job: ManagedMediaJob): void {
    if (!this.database) return
    this.dirtyIds.add(job.record.id)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.database) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPending()
    }, this.progressPersistIntervalMs)
    this.flushTimer.unref?.()
  }

  private stopFlushIfIdle(): void {
    if (this.flushTimer !== null && this.dirtyIds.size === 0) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private flushPending(): void {
    if (!this.database || this.dirtyIds.size === 0) return

    const ids = [...this.dirtyIds]
    const records: MediaJobRecord[] = []
    for (const id of ids) {
      const job = this.jobs.get(id)
      if (job) {
        records.push({ ...job.record })
      } else {
        this.dirtyIds.delete(id)
      }
    }
    if (records.length === 0) return

    try {
      this.database.saveManyMediaJobs(records)
      for (const id of ids) {
        this.dirtyIds.delete(id)
      }
    } catch {
      this.logPersistenceError('could not be saved')
      this.scheduleFlush()
    }
  }

  private logPersistenceError(context: string): void {
    if (this.persistenceErrorLogged) return
    this.persistenceErrorLogged = true
    // Never include URLs, paths or record payloads in logs.
    console.error(`Media job history ${context}.`)
  }
}
