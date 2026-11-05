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
  parseMediaQueueInput,
  parseMediaToolState,
  type MediaAnalysis,
  type MediaFormatOption,
  type MediaJob,
  type MediaJobRecord,
  type MediaJobStatus,
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
  analyze(url: string, options?: { cookie?: string }): Promise<MediaAnalysis>
  download(
    request: MediaDownloadRequest,
    onProgress: (progress: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult>
  cancel(jobId: string): void
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
}

export interface MediaJobsManagerOptions {
  engine: MediaEnginePort
  mediaDir: string
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
// Keep this aligned with the engine's 32-entry analysis cache. A larger cache
// here would expose an opaque analysis ID that the engine has already evicted,
// turning a valid queue request into a confusing download-time failure.
const MAX_CACHED_ANALYSES = 32

interface ManagedMediaJob {
  record: MediaJobRecord
  /** Transient progress speed; not persisted by the database schema. */
  speedBps: number
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
  private readonly onUpdate: (snapshot: MediaSnapshot) => void
  private readonly database: MediaJobsPersistence | null
  private readonly now: () => number
  private readonly progressPersistIntervalMs: number
  private readonly startAllowed: (now: number) => boolean
  private readonly onExtractorFailure:
    | (() => Promise<boolean>)
    | null

  private readonly jobs = new Map<string, ManagedMediaJob>()
  private readonly analyses = new Map<string, CachedMediaAnalysis>()
  private readonly dirtyIds = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastPublished: string | null = null
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

  async getMediaStatus(rawId: unknown): Promise<MediaJob> {
    return this.getMediaJob(rawId)
  }

  async analyzeMedia(rawInput: unknown): Promise<MediaAnalysis> {
    if (this.closed) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is shutting down.')
    }
    const input = parseAnalyzeMediaInput(rawInput)

    let raw: unknown
    try {
      raw = await this.engine.analyze(
        input.url,
        input.cookie === undefined ? {} : { cookie: input.cookie }
      )
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
      dir: this.mediaDir,
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
      direct: null,
      cookie: input.cookie ?? null,
      optionFingerprint,
      awaitingPolicy: !allowedNow
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
      dir: this.mediaDir,
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
      direct: {
        kind: input.kind,
        referer: input.referer,
        userAgent: input.userAgent,
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
        title: input.title
      },
      cookie: null,
      optionFingerprint: fingerprint,
      awaitingPolicy: !allowedNow
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
    if (!isActiveMediaJobStatus(job.record.status)) {
      return this.toMediaJob(job)
    }

    const updatedAt = this.now()
    job.record.status = 'cancelled'
    job.record.errorMessage = null
    job.record.updatedAt = updatedAt
    job.speedBps = 0
    this.persistNow(job)
    this.publish(true)

    try {
      this.engine.cancel(job.record.id)
    } catch {
      // The job is already cancelled locally; a missing engine job is fine.
    }

    return this.toMediaJob(job)
  }

  /** Remove only the database row. Media files are intentionally never deleted. */
  async removeMedia(rawId: unknown): Promise<MediaSnapshot> {
    const job = this.requireJob(rawId)

    if (isActiveMediaJobStatus(job.record.status)) {
      try {
        this.engine.cancel(job.record.id)
      } catch {
        // Best effort; the row still disappears from this app.
      }
    }

    this.jobs.delete(job.record.id)
    this.dirtyIds.delete(job.record.id)
    this.stopFlushIfIdle()
    this.removePersisted(job.record.id)
    this.publish(true)
    return this.getMediaSnapshot()
  }

  /** Validated completed output only; Electron `shell` stays in the main process. */
  async showMediaInFolder(rawId: unknown): Promise<null> {
    const job = this.requireJob(rawId)
    const record = job.record
    if (record.status !== 'complete' || !record.filePath) {
      throw new AppError('FILE_NOT_READY', 'The media file is not ready yet.')
    }
    if (!isInsideDirectory(this.mediaDir, record.filePath)) {
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
    if (!isInsideDirectory(this.mediaDir, record.filePath)) {
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
    this.publish()
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
  }

  /**
   * Interrupt active children, preserve partial files and flush before DB
   * close. Resolves only after the engine has terminated its in-flight
   * download, analysis and probe children (or the bounded grace elapsed).
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const updatedAt = this.now()
    let changed = false
    for (const job of this.jobs.values()) {
      if (!isActiveMediaJobStatus(job.record.status)) continue

      job.record.status = 'interrupted'
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

  publish(force = false): void {
    const snapshot = this.getMediaSnapshot()
    const serialized = JSON.stringify(snapshot)
    if (!force && serialized === this.lastPublished) return
    this.lastPublished = serialized
    try {
      this.onUpdate(snapshot)
    } catch {
      // A closing window must not break job state or persistence.
    }
  }

  private async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || job.record.status !== 'queued' || this.closed) return

    if (!this.startAllowed(this.now())) {
      job.awaitingPolicy = true
      return
    }
    job.awaitingPolicy = false

    job.record.status = 'downloading'
    job.record.updatedAt = this.now()
    this.persistNow(job)
    this.publish()

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
          this.handleProgress(id, progress)
        }
      )
      this.completeJob(id, result)
    } catch (error) {
      this.failJob(id, error)
    }
  }

  private handleProgress(id: string, progress: MediaDownloadProgress): void {
    const job = this.jobs.get(id)
    if (!job || isTerminalStatus(job.record.status)) return

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

    job.record.status = nextStatus
    job.record.totalBytes = totalBytes
    job.record.completedBytes =
      totalBytes === null
        ? completedBytes
        : Math.min(completedBytes, totalBytes)
    job.speedBps = nextStatus === 'merging' ? 0 : speedBps
    if (filePath !== null) job.record.filePath = filePath
    job.record.updatedAt = this.now()

    const critical =
      previousStatus !== nextStatus ||
      (filePath !== null && filePath !== previousFilePath)
    if (critical) {
      this.persistNow(job)
    } else {
      this.markDirty(job)
    }
    this.publish()
  }

  private completeJob(id: string, result: MediaDownloadResult): void {
    const job = this.jobs.get(id)
    if (!job || isTerminalStatus(job.record.status)) return

    const filePath =
      result && typeof result.filePath === 'string' ? result.filePath.trim() : ''
    if (filePath.length === 0) {
      this.failJob(id)
      return
    }

    if (
      job.record.maxBytes != null &&
      result.totalBytes !== null &&
      result.totalBytes > job.record.maxBytes
    ) {
      this.failJob(id, new AppError('MEDIA_SIZE_CAP_EXCEEDED', 'The media output exceeded the configured per-job size limit.'))
      return
    }

    const reportedTotal = nullableNonNegativeInteger(result.totalBytes)
    const totalBytes =
      reportedTotal !== null && reportedTotal > 0
        ? reportedTotal
        : job.record.totalBytes
    const completedAt = this.now()

    job.record.status = 'complete'
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

  private failJob(id: string, error?: unknown): void {
    const job = this.jobs.get(id)
    if (!job || isTerminalStatus(job.record.status)) return

    job.record.status = 'error'
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
      completedAt: record.completedAt
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
        direct: null,
        cookie: null,
        optionFingerprint: '',
        // Persisted queued jobs are not silently restarted after a relaunch.
        awaitingPolicy: false
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
