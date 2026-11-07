import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { shell } from 'electron'
import {
  MAX_BATCH_SOURCES,
  MAX_BATCH_TITLE_LENGTH,
  MAX_BATCH_LABEL_LENGTH,
  MAX_COLLECTION_SELECTION,
  BATCH_MEDIA_QUALITIES,
  isActiveBatchItemStatus,
  normalizeBatchSourceUrl,
  parseAnalyzeCollectionInput,
  parseBatch,
  parseBatchId,
  parseBatchItemTargetInput,
  parseBatchTargetInput,
  parseCollectionPreview,
  parseCreateCollectionBatchInput,
  toPublicBatch,
  type AnalyzeCollectionInput,
  type Batch,
  type BatchItemRecord,
  type BatchItemStatus,
  type BatchMediaQuality,
  type BatchRecord,
  type BatchStatus,
  type BatchTargetInput,
  type CollectionPreview,
  type CollectionSelectionAvailability,
  type CreateCollectionBatchInput
} from '@shared/batches'
import { MAX_IMAGE_FOLDER_LENGTH } from '@shared/scanImages'
import { isMediaOutputFormat } from '@shared/media'
import type { SniffedMediaInput } from '@shared/sniffedMedia'
import {
  parseSniffedMediaInput,
  sniffedMediaFilename
} from '@shared/sniffedMedia'
import type {
  MediaAnalysis,
  MediaJob,
  MediaSnapshot,
  MediaJobStatus,
  MediaOutputFormat
} from '@shared/media'
import type {
  AppSnapshot,
  BatchSnapshot,
  DownloadItem,
  DownloadRequestHeaders,
  SmartBatchSubmitEntry,
  SmartBatchSubmitInput,
  SmartBatchSubmitResult
} from '@shared/types'
import { ValidationError, sanitizeFilename } from '@shared/validation'
import { parseFunscriptName } from '@shared/funscriptPairing'
import type {
  PixeldrainFileResolution,
  PixeldrainLink,
  PixeldrainListResolution
} from '../hosts/pixeldrain'
import { AppError } from '../errors'
import {
  PAIR_RENAME_FAILED,
  PAIR_RENAME_SCRIPT_FAILED,
  PAIR_RENAME_VIDEO_FAILED,
  applyPairRename
} from '../scanner/pairRename'

/**
 * Milestone 3B batch orchestration.
 *
 * The manager owns persisted parent batches and their items. It deliberately
 * consumes narrow ports rather than the concrete download/media/engine classes:
 * - downloads: existing `DownloadManager.add` / `pause` (duplicate policy is
 *   therefore reused, not reimplemented),
 * - mediaJobs: existing analyze/queue/cancel path,
 * - collectionEngine: playlist analyze/resolve,
 * - pixeldrain: public metadata adapter.
 *
 * Source URLs stay on internal records for retry only. Public `Batch` and
 * `CollectionPreview` values never contain a URL, path, token, header or raw
 * provider metadata.
 */

export const BATCH_INTERRUPTED_MESSAGE =
  'Interrupted before it finished because DonDownload stopped. Retry individual items to continue.'

const BATCH_ITEM_INTERRUPTED_MESSAGE =
  'Interrupted before it finished because DonDownload stopped.'

const BATCH_NO_MEDIA_OPTION_MESSAGE =
  'No verified video or audio option is available for this entry.'

const PAIR_RENAME_APP_STOPPED =
  'Rename skipped: DonDownload stopped before the scripts finished.'

function selectBatchMediaOption(
  analysis: MediaAnalysis,
  quality: BatchMediaQuality
): MediaAnalysis['options'][number] | null {
  if (quality === 'best') {
    const id = analysis.bestVideoOptionId ?? analysis.bestAudioOptionId
    return id ? analysis.options.find(option => option.optionId === id) ?? null : null
  }
  if (quality === 'audio-only') {
    const id = analysis.bestAudioOptionId
    return id ? analysis.options.find(option => option.optionId === id && option.kind === 'audio') ?? null : null
  }
  const height = Number.parseInt(quality, 10)
  const candidates = analysis.options.filter(
    option => option.kind === 'video' && option.hasAudio && option.height === height
  )
  return candidates.find(option => option.filesizeBytes !== null) ?? candidates[0] ?? null
}

function noQualityMessage(quality: BatchMediaQuality): string {
  if (quality === 'audio-only') return 'No verified audio-only format is available for this entry.'
  if (quality === 'best') return BATCH_NO_MEDIA_OPTION_MESSAGE
  return `No verified ${quality} format is available for this entry. It was not replaced with a different quality.`
}

export const GOFILE_BROWSER_REQUIRED_MESSAGE =
  'Gofile folder/share links require a browser session. Open the original link in your browser; DonDownload does not scrape tokens or bypass access controls.'

const GOFILE_INVALID_LINK_MESSAGE =
  'Only a canonical public https://gofile.io share link can be opened.'

const PIXELDRAIN_INVALID_LIST_MESSAGE =
  'This Pixeldrain link is a file, not a list.'

const PROGRESS_PERSIST_INTERVAL_MS = 2_500
const DEFAULT_POLL_INTERVAL_MS = 1_000
const PREVIEW_TTL_MS = 10 * 60_000
const MAX_STORED_PREVIEWS = 8
const UNSAFE_MESSAGE_TEXT =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/* ------------------------------------------------------------------------- *
 * Ports
 * ------------------------------------------------------------------------- */

export interface BatchDownloadsPort {
  add(input: unknown): Promise<unknown>
  pause(id: string): Promise<unknown>
  getSnapshot(): AppSnapshot
  /** One public child item by id, or null. Cheaper than a full snapshot. */
  getItem(id: string): DownloadItem | null
  /**
   * Drop one child record. Used only to clean up the failed first attempt of an
   * image item that is retried with its fallback URL. Optional so existing test
   * doubles stay valid.
   */
  remove?(id: string): Promise<unknown>
  /**
   * Internal scanner-only variant: downloads one funscript directly into the
   * resolved video folder (inside the normal download root). Optional so
   * existing test doubles stay valid.
   */
  addScanFile?(input: unknown, directory: string): Promise<unknown>
  /**
   * Manual pairing folder: the directory comes from a short-lived opaque token
   * that main resolved from a file the user picked in the native dialog. Never
   * accepts a raw path.
   */
  addPairingFile?(input: unknown, token: string): Promise<unknown>
  /** Final path of a completed child, for the post-download rename. */
  getFilePath?(id: string): string | null
  /** Keep the download record in sync after a script was renamed in place. */
  adoptRenamedFile?(id: string, filePath: string): void
  /** As above, but validates against the user-chosen pairing folder token. */
  adoptRenamedFileInFolder?(id: string, filePath: string, token: string): void
}

export interface BatchMediaJobsPort {
  analyzeMedia(input: unknown): Promise<MediaAnalysis>
  queueMedia(input: unknown): Promise<MediaJob>
  cancelMedia(id: string): Promise<MediaJob>
  getMediaSnapshot(): MediaSnapshot
  /** One sanitized child job by id, or null. Cheaper than a full snapshot. */
  getJob(id: string): MediaJob | null
  /**
   * Additive detected media path (HLS/DASH). The input is the already
   * validated sniffed-media payload; the manager creates a normal media job.
   */
  queueSniffedMedia?(input: unknown): Promise<MediaJob>
  /** Final video path of a completed child, for the post-download rename. */
  getFilePath?(id: string): string | null
}

export interface BatchCollectionTarget {
  entryId: string
  url: string
  title: string
  position: number
}

export interface BatchCollectionEnginePort {
  analyzeCollection(url: string): Promise<CollectionPreview>
  resolveCollectionEntries(
    previewId: string,
    entryIds: readonly string[]
  ): Promise<readonly BatchCollectionTarget[]>
}

export interface BatchPixeldrainPort {
  parseLink(value: unknown): PixeldrainLink
  resolveFile(value: unknown): Promise<PixeldrainFileResolution>
  resolveList(value: unknown): Promise<PixeldrainListResolution>
}

export interface BatchPersistencePort {
  loadBatches(): StoredBatchRecord[]
  saveBatch(record: BatchRecord): void
  saveBatchWithItems(
    record: BatchRecord,
    items: readonly BatchItemRecord[]
  ): void
  saveManyBatchItems(items: readonly BatchItemRecord[]): void
  deleteBatch(id: string): void
}

export interface StoredBatchRecord {
  record: BatchRecord
  items: BatchItemRecord[]
}

export interface BatchManagerOptions {
  downloads: BatchDownloadsPort
  mediaJobs: BatchMediaJobsPort
  collectionEngine: BatchCollectionEnginePort
  pixeldrain: BatchPixeldrainPort
  onUpdate: (snapshot: BatchSnapshot) => void
  database?: BatchPersistencePort | null
  /** Injectable clock for deterministic tests. */
  now?: () => number
  progressPersistIntervalMs?: number
  /** 0 disables background polling; tests can call `refresh()` explicitly. */
  pollIntervalMs?: number
  previewTtlMs?: number
  openExternal?: (url: string) => Promise<void> | void
  /**
   * Scanner video output folder. Paired funscript downloads are placed here so
   * they sit next to the video and can be renamed in place. Must be inside
   * `scanRootDir`.
   */
  scanMediaDir?: string
  /** Scanner download root; every rename path must resolve inside it. */
  scanRootDir?: string
  /**
   * Resolve a short-lived manual pairing folder token to the already validated
   * directory of the file the user picked. Main-only; a raw path is never
   * accepted here.
   */
  resolvePairingFolder?: (token: string) =>
    | { directory: string; filePath: string; filename: string }
    | null
}

interface ManagedBatch {
  record: BatchRecord
  items: Map<string, BatchItemRecord>
}

/**
 * Memory-only pairing chosen by the user for one scanned video. The state is
 * deliberately not persisted: a restart marks the batch interrupted and the
 * scripts keep their original names. Nothing here is sensitive (IDs + names).
 */
interface ManagedScanPairing {
  batchId: string
  /** Batch item of the downloaded video, or null for a manual file match. */
  videoItemId: string | null
  /** Present for a manual match against an existing user-chosen video file. */
  externalVideo?: {
    filePath: string
    directory: string
    filename: string
    token: string
  }
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
  scripts: Map<string, { axis: string | null; variant: string | null }>
  settled: boolean
}

interface StoredPreview {
  id: string
  kind: 'playlist' | 'pixeldrain-list'
  sourceUrl: string
  preview: CollectionPreview
  expiresAt: number
  /** Internal Pixeldrain metadata keyed by the preview's opaque entry IDs. */
  pixeldrainEntries: Map<
    string,
    PixeldrainListResolution['entries'][number]
  > | null
}

export interface DirectTarget {
  entryIndex: number
  itemId: string
  url: string
  kind: 'direct' | 'pixeldrain-file' | 'gofile'
  title: string
  label: string
}

/** Internal input for the explicit Smart Link Scanner queue path. */
export interface BatchScanTarget {
  url: string
  title: string
  filename?: string
  /** Redirect-resolved target proven by the queue-time scanner probe. */
  resolvedUrl?: string
  requestHeaders?: DownloadRequestHeaders
  /** Scanner item ID; used only to wire funscript pairings, never public. */
  scanItemId?: string
  /**
   * Retried once when `url` fails with a 403/404. Pinterest serves the same pin
   * from `/originals/` with an unpredictable extension, so the extension also
   * reports the 736x URL.
   */
  fallbackUrl?: string
}

/** Internal scanner video target with an opaque, fresh analysis selection. */
export interface BatchScanVideoTarget {
  url: string
  title: string
  analysisId: string
  optionId: string
  outputFormat?: MediaOutputFormat
  cookie?: string
  /** Display-only quality label for the queued row. Never a URL or path. */
  qualityLabel?: string
  /** Scanner item ID; used only to wire funscript pairings, never public. */
  scanItemId?: string
}

/** Internal funscript pairing; references scan item IDs, never paths. */
export interface BatchScanPairingTarget {
  videoItemId: string
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
}

/* ------------------------------------------------------------------------- *
 * Small local parsers/helpers
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid batch request.')
  }
  return value as Record<string, unknown>
}

/** Parse the smart multi-URL submit input without normalizing each URL yet. */
export function parseSmartBatchSubmitInput(
  value: unknown
): SmartBatchSubmitInput {
  const record = asRecord(value)
  for (const key of Object.keys(record)) {
    if (key !== 'urls') {
      throw new ValidationError(
        'The smart batch request contains unsupported fields.'
      )
    }
  }
  const raw = record.urls
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_BATCH_SOURCES
  ) {
    throw new ValidationError(
      `Provide between 1 and ${MAX_BATCH_SOURCES} URLs.`
    )
  }
  const urls = raw.map((entry) => {
    if (typeof entry !== 'string') {
      throw new ValidationError('Every batch URL must be text.')
    }
    return entry
  })
  return { urls }
}

/**
 * One folder segment below the download root. Anything that could escape the
 * root (separators, drive letters, `..`) is rejected instead of sanitized: the
 * scanner derives the value from a page title, so a rejection is a bug.
 */
function parseBatchSubfolder(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('The scan batch folder is invalid.')
  }
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_IMAGE_FOLDER_LENGTH ||
    cleaned === '.' ||
    cleaned === '..' ||
    /[<>:"/|?*]/.test(cleaned) ||
    /[.\s]$/.test(cleaned) ||
    /^[A-Za-z]:/.test(cleaned)
  ) {
    throw new ValidationError('The scan batch folder is invalid.')
  }
  return cleaned
}

function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ValidationError('A scan item identifier is invalid.')
  }
  return value
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return null
}

function cleanSafeText(
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
  return Array.from(cleaned).slice(0, maximum).join('').trim() || fallback
}

function isSafeMessage(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_000 &&
    !CONTROL_CHARACTERS.test(value) &&
    !UNSAFE_MESSAGE_TEXT.test(value)
  )
}

/** Map an error to a stable, renderer-safe per-item message. */
export function describeBatchFailure(error: unknown, fallback: string): string {
  const code = errorCode(error)

  if (code === 'DUPLICATE_DOWNLOAD' || code === 'MEDIA_DUPLICATE_JOB') {
    return 'This item is already queued or downloading.'
  }
  if (code === 'PIXELDRAIN_RATE_LIMITED') {
    return 'The provider rate-limited this request. Try again later.'
  }
  if (code === 'PIXELDRAIN_CAPTCHA_REQUIRED') {
    return 'The provider requires a CAPTCHA. DonDownload does not bypass CAPTCHAs.'
  }
  if (code === 'PIXELDRAIN_HOTLINK_REQUIRED') {
    return 'The provider blocks hotlinked downloads for this item.'
  }
  if (code === 'PIXELDRAIN_PRIVATE') {
    return 'This item is not publicly available.'
  }
  if (code === 'PIXELDRAIN_NOT_FOUND') {
    return 'This item could not be found. It may have been removed.'
  }
  if (
    code === 'PIXELDRAIN_UNSUPPORTED' ||
    code === 'PIXELDRAIN_INVALID_LINK'
  ) {
    return 'This provider link is not supported.'
  }
  if (code === 'PIXELDRAIN_TOO_MANY_FILES') {
    return 'This provider list has too many files to preview.'
  }
  if (code === 'MEDIA_TOOL_UNAVAILABLE') {
    return 'The media tool is not available.'
  }
  if (code === 'MEDIA_ANALYSIS_FAILED' || code === 'MEDIA_ENGINE_ERROR') {
    return 'This media entry could not be analyzed.'
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const message = cleanSafeText(
      (error as { message: string }).message,
      2_000,
      ''
    )
    if (message.length > 0 && isSafeMessage(message)) return message
  }
  return fallback
}

function isGofileHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'gofile.io' || host === 'www.gofile.io'
}

/**
 * Accept only a canonical public https://gofile.io share URL. Credentials,
 * query parameters, fragments and non-share paths are rejected so `openExternal`
 * can never receive an injected or token-bearing URL.
 */
export function canonicalGofileUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (!isGofileHost(parsed.hostname)) return null
  if (parsed.username || parsed.password) return null
  if (parsed.search !== '' || parsed.hash !== '') return null

  const match = /^\/(d|f)\/([A-Za-z0-9_-]{4,64})\/?$/.exec(parsed.pathname)
  if (!match) return null
  const kind = match[1]
  const id = match[2]
  if (!kind || !id) return null
  return `https://gofile.io/${kind}/${id}`
}

/** Deliberately conservative: only obvious playlist-shaped URLs are probed. */
export function looksLikePlaylistUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.searchParams.has('list')) return true
  const path = parsed.pathname.toLowerCase()
  return (
    /\/playlists?\//.test(path) ||
    /\/playlist\/?$/.test(path) ||
    /\/(?:sets?|albums?)\//.test(path)
  )
}

function safeTitleFromUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'Direct download'
  }
  const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // Keep the raw segment if it is not valid percent-encoding.
  }
  const title = cleanSafeText(decoded, 240, '')
  return title.length > 0 ? title : cleanSafeText(parsed.hostname, 240, 'Direct download')
}

/**
 * File name of one URL, used when an image item is retried with its fallback
 * URL. The originals URL only guesses the extension, so the retry must keep the
 * name the fallback URL actually serves (e.g. `<hash>.jpg`). Returns null when
 * the URL has no usable last segment.
 */
function filenameFromUrl(value: string): string | null {
  let segment: string
  try {
    const parsed = new URL(value)
    segment = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1)
  } catch {
    return null
  }
  if (segment.length === 0) return null
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // Keep the raw segment if it is not valid percent-encoding.
  }
  try {
    return sanitizeFilename(decoded)
  } catch {
    return null
  }
}

function safeMessageForBatch(error: unknown, fallback: string): string {
  const text = describeBatchFailure(error, fallback)
  return isSafeMessage(text) ? text : fallback
}

function clampBytes(reported: unknown, fallback: number): number {
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
    return fallback
  }
  return Math.trunc(reported)
}

function terminalItemStatus(status: BatchItemStatus): boolean {
  return (
    status === 'complete' ||
    status === 'error' ||
    status === 'unavailable' ||
    status === 'skipped' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}

function statusFromMediaJob(status: MediaJobStatus): BatchItemStatus {
  if (status === 'complete') return 'complete'
  if (status === 'error') return 'error'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'interrupted') return 'interrupted'
  return 'running'
}

function statusFromDownload(status: DownloadItem['status']): BatchItemStatus {
  if (status === 'complete') return 'complete'
  if (status === 'error') return 'error'
  if (status === 'interrupted') return 'interrupted'
  return 'running'
}

/* ------------------------------------------------------------------------- *
 * Manager
 * ------------------------------------------------------------------------- */

export class BatchManager {
  private readonly downloads: BatchDownloadsPort
  private readonly mediaJobs: BatchMediaJobsPort
  private readonly collectionEngine: BatchCollectionEnginePort
  private readonly pixeldrain: BatchPixeldrainPort
  private readonly onUpdate: (snapshot: BatchSnapshot) => void
  private readonly database: BatchPersistencePort | null
  private readonly now: () => number
  private readonly progressPersistIntervalMs: number
  private readonly pollIntervalMs: number
  private readonly previewTtlMs: number
  private readonly openExternal: (url: string) => Promise<void> | void
  private readonly resolvePairingFolder:
    | ((token: string) => { directory: string; filePath: string; filename: string } | null)
    | null

  private readonly batches = new Map<string, ManagedBatch>()
  private readonly previews = new Map<string, StoredPreview>()
  private readonly dirtyItems = new Map<string, BatchItemRecord>()
  /**
   * One-job scanner headers. Deliberately memory-only: a restart marks active
   * items interrupted and never resumes them, so a Cookie can never touch disk.
   */
  private readonly scanRequestHeaders = new Map<string, DownloadRequestHeaders>()
  /** Redirect-resolved targets proven by the scanner probe, memory-only. */
  private readonly scanResolvedUrls = new Map<string, string>()
  private readonly scanFilenames = new Map<string, string>()
  /** Memory-only 403/404 fallback URLs reported for image batch items. */
  private readonly scanFallbacks = new Map<string, string>()
  /** Memory-only per-item target folder (a single segment below the root). */
  private readonly scanSubfolders = new Map<string, string>()
  /** Memory-only scanner video selections; never persisted. */
  private readonly scanMediaSelections = new Map<
    string,
    {
      analysisId: string
      optionId: string
      outputFormat?: MediaOutputFormat
      cookie?: string
    }
  >()
  /** Memory-only funscript pairings, keyed by parent batch ID. */
  private readonly scanPairings = new Map<string, ManagedScanPairing[]>()
  /** Detected HLS/DASH inputs for browser-matched batch items. Memory-only. */
  private readonly scanSniffedMediaSelections = new Map<string, SniffedMediaInput>()
  private readonly pairingTasks = new Set<Promise<void>>()
  private readonly scanMediaDir: string | null
  private readonly scanRootDir: string | null
  private readonly idleWaiters: Array<() => void> = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pumping = false
  private pumpScheduled = false
  private closed = false
  private lastPublished: string | null = null
  private persistenceErrorLogged = false

  constructor(options: BatchManagerOptions) {
    this.downloads = options.downloads
    this.mediaJobs = options.mediaJobs
    this.collectionEngine = options.collectionEngine
    this.pixeldrain = options.pixeldrain
    this.onUpdate = options.onUpdate
    this.database = options.database ?? null
    this.now = options.now ?? Date.now
    this.progressPersistIntervalMs =
      options.progressPersistIntervalMs ?? PROGRESS_PERSIST_INTERVAL_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.previewTtlMs = options.previewTtlMs ?? PREVIEW_TTL_MS
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.scanMediaDir = options.scanMediaDir ?? null
    this.scanRootDir = options.scanRootDir ?? null
    this.resolvePairingFolder = options.resolvePairingFolder ?? null

    this.loadPersistedBatches()
  }

  /* ----------------------------- reads ----------------------------- */

  getBatchSnapshot(): BatchSnapshot {
    const batches = [...this.batches.values()]
      .sort(
        (left, right) =>
          right.record.createdAt - left.record.createdAt ||
          right.record.updatedAt - left.record.updatedAt
      )
      .map((batch) => this.toPublicBatch(batch))
    return { batches }
  }

  getBatch(rawId: unknown): Batch {
    return this.toPublicBatch(this.requireBatch(parseBatchId(rawId)))
  }

  /* -------------------------- collection previews -------------------------- */

  async analyzeCollection(rawInput: unknown): Promise<CollectionPreview> {
    this.assertOpen()
    const input: AnalyzeCollectionInput = parseAnalyzeCollectionInput(rawInput)

    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      throw new AppError('BATCH_COLLECTION_INVALID', 'Enter a valid URL.')
    }

    if (isGofileHost(parsed.hostname)) {
      throw new AppError(
        'GOFILE_BROWSER_REQUIRED',
        GOFILE_BROWSER_REQUIRED_MESSAGE
      )
    }

    if (parsed.hostname.toLowerCase() === 'pixeldrain.com') {
      let link: PixeldrainLink
      try {
        link = this.pixeldrain.parseLink(input.url)
      } catch (error) {
        throw this.pixeldrainError(
          error,
          'PIXELDRAIN_INVALID_LINK',
          'Enter a public Pixeldrain file link or list link.'
        )
      }
      if (link.kind !== 'list') {
        throw new AppError(
          'BATCH_COLLECTION_NOT_LIST',
          PIXELDRAIN_INVALID_LIST_MESSAGE
        )
      }
      return this.resolvePixeldrainList(link.sourceUrl)
    }

    return this.analyzePlaylist(input.url)
  }

  /** Analyze only explicitly selected playlist entries and expose safe format availability. */
  async analyzeCollectionSelection(rawInput: unknown): Promise<CollectionSelectionAvailability> {
    this.assertOpen()
    const input = parseCreateCollectionBatchInput(rawInput)
    const stored = this.requirePreview(input.previewId)
    if (stored.kind !== 'playlist') {
      throw new AppError('BATCH_MEDIA_QUALITY_UNSUPPORTED', 'Quality selection is only available for playlists.')
    }
    const selected = new Set(input.selectedEntryIds)
    const resolved = await this.collectionEngine.resolveCollectionEntries(stored.id, [...selected])
    const targets = new Map(resolved.map(target => [target.entryId, target]))
    const entries: CollectionSelectionAvailability['entries'] = []
    for (const entryId of input.selectedEntryIds) {
      const entry = stored.preview.entries.find(item => item.id === entryId)
      if (!entry || entry.availability !== 'available') continue
      const target = targets.get(entryId)
      if (!target) continue
      const analysis = await this.mediaJobs.analyzeMedia({ url: target.url })
      const optionById = new Map(analysis.options.map(option => [option.optionId, option]))
      const qualities: CollectionSelectionAvailability['entries'][number]['qualities'] = []
      const displayBytes = (option: MediaAnalysis['options'][number]): number | null =>
        option.estimatedBytes ?? option.filesizeBytes
      const qualityEntry = (quality: BatchMediaQuality, option: MediaAnalysis['options'][number]): CollectionSelectionAvailability['entries'][number]['qualities'][number] => ({
        quality,
        estimatedBytes: displayBytes(option),
        ...(option.sizeIsEstimate ? { sizeIsEstimate: true } : {})
      })
      const bestId = analysis.bestVideoOptionId ?? analysis.bestAudioOptionId
      if (bestId) {
        const best = optionById.get(bestId)
        if (best) qualities.push(qualityEntry('best', best))
      }
      for (const quality of BATCH_MEDIA_QUALITIES.filter(value => ['1080p','720p','480p','360p'].includes(value))) {
        const selectedOption = selectBatchMediaOption(analysis, quality)
        if (selectedOption) qualities.push(qualityEntry(quality, selectedOption))
      }
      if (analysis.bestAudioOptionId && optionById.get(analysis.bestAudioOptionId)?.kind === 'audio') {
        qualities.push(qualityEntry('audio-only', optionById.get(analysis.bestAudioOptionId)!))
      }
      entries.push({ entryId, title: entry.title, qualities })
    }
    return { previewId: stored.id, entries }
  }

  /* ---------------------------- smart submit ---------------------------- */

  async submitSmartBatch(rawInput: unknown): Promise<SmartBatchSubmitResult> {
    this.assertOpen()
    const input = parseSmartBatchSubmitInput(rawInput)

    const entries: Array<SmartBatchSubmitEntry | undefined> = new Array(
      input.urls.length
    )
    const previews: CollectionPreview[] = []
    const directTargets: DirectTarget[] = []

    for (let index = 0; index < input.urls.length; index += 1) {
      const raw = input.urls[index] ?? ''
      let url: string
      try {
        url = normalizeBatchSourceUrl(raw)
      } catch (error) {
        entries[index] = {
          index,
          outcome: 'invalid',
          batchId: null,
          itemId: null,
          previewId: null,
          code: errorCode(error) ?? 'INVALID_INPUT',
          message: safeMessageForBatch(error, 'Enter a valid HTTP(S) URL.')
        }
        continue
      }

      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        entries[index] = {
          index,
          outcome: 'invalid',
          batchId: null,
          itemId: null,
          previewId: null,
          code: 'INVALID_INPUT',
          message: 'Enter a valid HTTP(S) URL.'
        }
        continue
      }

      const host = parsed.hostname.toLowerCase()

      if (isGofileHost(host)) {
        const canonical = canonicalGofileUrl(url)
        if (canonical === null) {
          entries[index] = {
            index,
            outcome: 'unsupported',
            batchId: null,
            itemId: null,
            previewId: null,
            code: 'GOFILE_BROWSER_REQUIRED',
            message: GOFILE_INVALID_LINK_MESSAGE
          }
          continue
        }
        directTargets.push({
          entryIndex: index,
          itemId: newOpaqueId('bitem'),
          url: canonical,
          kind: 'gofile',
          title: 'Gofile link',
          label: 'Browser required'
        })
        continue
      }

      if (host === 'pixeldrain.com') {
        let link: PixeldrainLink
        try {
          link = this.pixeldrain.parseLink(url)
        } catch (error) {
          entries[index] = {
            index,
            outcome: 'failed',
            batchId: null,
            itemId: null,
            previewId: null,
            code: errorCode(error) ?? 'PIXELDRAIN_INVALID_LINK',
            message: safeMessageForBatch(
              error,
              'Enter a public Pixeldrain file link or list link.'
            )
          }
          continue
        }

        if (link.kind === 'list') {
          try {
            const preview = await this.resolvePixeldrainList(link.sourceUrl)
            previews.push(preview)
            entries[index] = {
              index,
              outcome: 'collection-preview',
              batchId: null,
              itemId: null,
              previewId: preview.id,
              code: null,
              message: null
            }
          } catch (error) {
            entries[index] = {
              index,
              outcome: 'failed',
              batchId: null,
              itemId: null,
              previewId: null,
              code: errorCode(error) ?? 'PIXELDRAIN_UNAVAILABLE',
              message: safeMessageForBatch(
                error,
                'This Pixeldrain list could not be previewed.'
              )
            }
          }
          continue
        }

        directTargets.push({
          entryIndex: index,
          itemId: newOpaqueId('bitem'),
          url: link.sourceUrl,
          kind: 'pixeldrain-file',
          title: 'Pixeldrain file',
          label: 'Pixeldrain'
        })
        continue
      }

      if (looksLikePlaylistUrl(url)) {
        try {
          const preview = await this.analyzePlaylist(url)
          previews.push(preview)
          entries[index] = {
            index,
            outcome: 'collection-preview',
            batchId: null,
            itemId: null,
            previewId: preview.id,
            code: null,
            message: null
          }
          continue
        } catch (error) {
          const code = errorCode(error)
          const notPlaylist =
            code === 'MEDIA_COLLECTION_NOT_PLAYLIST' ||
            code === 'MEDIA_COLLECTION_EMPTY'
          if (!notPlaylist) {
            entries[index] = {
              index,
              outcome: 'failed',
              batchId: null,
              itemId: null,
              previewId: null,
              code: code ?? 'MEDIA_COLLECTION_FAILED',
              message: safeMessageForBatch(
                error,
                'This playlist could not be previewed.'
              )
            }
            continue
          }
        }
      }

      directTargets.push({
        entryIndex: index,
        itemId: newOpaqueId('bitem'),
        url,
        kind: 'direct',
        title: safeTitleFromUrl(url),
        label: 'Direct download'
      })
    }

    let createdBatch: Batch | null = null
    if (directTargets.length > 0) {
      const batch = this.createDirectBatch(directTargets)
      createdBatch = this.toPublicBatch(batch)
      for (const target of directTargets) {
        entries[target.entryIndex] = {
          index: target.entryIndex,
          outcome: target.kind === 'gofile' ? 'unsupported' : 'batch-item',
          batchId: batch.record.id,
          itemId: target.itemId,
          previewId: null,
          code: target.kind === 'gofile' ? 'GOFILE_BROWSER_REQUIRED' : null,
          message: target.kind === 'gofile' ? GOFILE_BROWSER_REQUIRED_MESSAGE : null
        }
      }

      if (batch.items.size > 0) this.schedulePump()
    }

    this.ensurePolling()

    return {
      batch: createdBatch,
      previews,
      entries: entries.filter(
        (entry): entry is SmartBatchSubmitEntry => entry !== undefined
      )
    }
  }

  private createDirectBatch(targets: readonly DirectTarget[]): ManagedBatch {
    const createdAt = this.now()
    const batchId = newOpaqueId('batch')
    const items = new Map<string, BatchItemRecord>()

    for (const [position, target] of targets.entries()) {
      const gofile = target.kind === 'gofile'
      items.set(target.itemId, {
        id: target.itemId,
        batchId,
        position,
        kind: 'download',
        status: gofile ? 'unavailable' : 'queued',
        title: target.title,
        label: target.label,
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: gofile ? GOFILE_BROWSER_REQUIRED_MESSAGE : null,
        sourceUrl: target.url,
        createdAt,
        updatedAt: createdAt,
        completedAt: gofile ? createdAt : null
      })
    }

    const record: BatchRecord = {
      id: batchId,
      kind: 'direct-urls',
      title: 'Smart batch',
      status: 'queued',
      sourceUrl: null,
      mediaQuality: null,
      maxBytesPerItem: null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }

    const batch = this.insertBatch(record, [...items.values()])
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    return batch
  }

  /* ---------------------- scanner direct queue path ---------------------- */

  /**
   * Create one persisted direct-file batch from the scanner's explicit
   * selection. This is not reachable from the renderer: the scanner resolves
   * opaque item IDs, re-probes the URLs and passes normalized internal targets.
   *
   * `requestHeaders` (only an opted-in exact-host Cookie) is retained in memory
   * for the one child job. It is never persisted, and a restart never resumes
   * the item.
   */
  async createScanBatch(rawInput: unknown): Promise<Batch> {
    this.assertOpen()
    const record = asRecord(rawInput)
    for (const key of Object.keys(record)) {
      if (key !== 'title' && key !== 'targets' && key !== 'subfolder') {
        throw new ValidationError('The scan batch contains unsupported fields.')
      }
    }
    // A single folder segment below the download root. The scanner derives it
    // from the page title; it is never a path and never leaves the root.
    const subfolder =
      record.subfolder === undefined
        ? undefined
        : parseBatchSubfolder(record.subfolder)
    if (
      typeof record.title !== 'string' ||
      record.title.trim().length === 0 ||
      record.title.length > MAX_BATCH_TITLE_LENGTH
    ) {
      throw new ValidationError('The scan batch title is invalid.')
    }
    const rawTargets = record.targets
    if (
      !Array.isArray(rawTargets) ||
      rawTargets.length === 0 ||
      rawTargets.length > MAX_COLLECTION_SELECTION
    ) {
      throw new ValidationError('The scan batch selection is invalid.')
    }

    const targets: BatchScanTarget[] = rawTargets.map((rawTarget) => {
      const target = asRecord(rawTarget)
      for (const key of Object.keys(target)) {
        if (
          key !== 'url' &&
          key !== 'title' &&
          key !== 'filename' &&
          key !== 'resolvedUrl' &&
          key !== 'requestHeaders' &&
          key !== 'scanItemId' &&
          key !== 'fallbackUrl'
        ) {
          throw new ValidationError(
            'A scan batch target contains unsupported fields.'
          )
        }
      }
      const url = normalizeBatchSourceUrl(target.url)
      const title = cleanSafeText(target.title, MAX_BATCH_TITLE_LENGTH, 'Scanned file')
      let filename: string | undefined
      if (target.filename !== undefined) {
        if (typeof target.filename !== 'string') {
          throw new ValidationError('The scan batch filename is invalid.')
        }
        filename = sanitizeFilename(target.filename)
      }
      let resolvedUrl: string | undefined
      if (target.resolvedUrl !== undefined) {
        resolvedUrl = normalizeBatchSourceUrl(target.resolvedUrl)
      }
      let requestHeaders: DownloadRequestHeaders | undefined
      if (target.requestHeaders !== undefined) {
        const headers = asRecord(target.requestHeaders)
        for (const key of Object.keys(headers)) {
          if (key !== 'cookie') {
            throw new ValidationError(
              'A scan batch header contains unsupported fields.'
            )
          }
        }
        const cookie = headers.cookie
        if (
          typeof cookie !== 'string' ||
          cookie.length === 0 ||
          cookie.length > 8192 ||
          // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
          /[\u0000-\u001f\u007f]/.test(cookie)
        ) {
          throw new ValidationError('The scan batch cookie header is invalid.')
        }
        requestHeaders = { cookie }
      }
      let fallbackUrl: string | undefined
      if (target.fallbackUrl !== undefined) {
        fallbackUrl = normalizeBatchSourceUrl(target.fallbackUrl)
      }
      if (target.scanItemId !== undefined) opaqueId(target.scanItemId)
      return {
        url,
        title,
        ...(filename === undefined ? {} : { filename }),
        ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
        ...(requestHeaders === undefined ? {} : { requestHeaders }),
        ...(fallbackUrl === undefined || fallbackUrl === url ? {} : { fallbackUrl })
      }
    })

    const createdAt = this.now()
    const batchId = newOpaqueId('batch')
    const items = new Map<string, BatchItemRecord>()
    for (const [position, target] of targets.entries()) {
      const itemId = newOpaqueId('bitem')
      items.set(itemId, {
        id: itemId,
        batchId,
        position,
        kind: 'download',
        status: 'queued',
        title: target.title,
        label: 'Scanned file',
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        sourceUrl: target.url,
        createdAt,
        updatedAt: createdAt,
        completedAt: null
      })
      if (target.requestHeaders !== undefined) {
        this.scanRequestHeaders.set(itemId, target.requestHeaders)
      }
      if (target.resolvedUrl !== undefined) {
        this.scanResolvedUrls.set(itemId, target.resolvedUrl)
      }
      if (target.filename !== undefined) {
        this.scanFilenames.set(itemId, target.filename)
      }
      if (target.fallbackUrl !== undefined) {
        this.scanFallbacks.set(itemId, target.fallbackUrl)
      }
      if (subfolder !== undefined) {
        this.scanSubfolders.set(itemId, subfolder)
      }
    }

    const batchRecord: BatchRecord = {
      id: batchId,
      kind: 'direct-urls',
      title: cleanSafeText(record.title, MAX_BATCH_TITLE_LENGTH, 'Scanned page'),
      status: 'queued',
      sourceUrl: null,
      mediaQuality: null,
      maxBytesPerItem: null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }

    const batch = this.insertBatch(batchRecord, [...items.values()])
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.schedulePump()
    this.ensurePolling()
    this.publish(true)
    return this.toPublicBatch(batch)
  }

  /**
   * Create one mixed scanner batch: verified direct files plus resolved video
   * page links whose analysis/option pair was revalidated by the queue service.
   * The scanner-side contracts stay memory-only: a Cookie is attached to the
   * exact-host child and is never persisted.
   */
  async createScanMediaBatch(rawInput: unknown): Promise<Batch> {
    this.assertOpen()
    const record = asRecord(rawInput)
    for (const key of Object.keys(record)) {
      if (
        key !== 'title' &&
        key !== 'files' &&
        key !== 'videos' &&
        key !== 'pairings'
      ) {
        throw new ValidationError(
          'The scan media batch contains unsupported fields.'
        )
      }
    }
    if (
      typeof record.title !== 'string' ||
      record.title.trim().length === 0 ||
      record.title.length > MAX_BATCH_TITLE_LENGTH
    ) {
      throw new ValidationError('The scan batch title is invalid.')
    }
    const rawFiles = record.files
    const rawVideos = record.videos
    if (!Array.isArray(rawFiles) || !Array.isArray(rawVideos)) {
      throw new ValidationError('The scan media batch selection is invalid.')
    }
    if (
      rawFiles.length + rawVideos.length === 0 ||
      rawFiles.length + rawVideos.length > MAX_COLLECTION_SELECTION
    ) {
      throw new ValidationError('The scan media batch selection is invalid.')
    }

    const readCookie = (value: unknown): string => {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8192 ||
        // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        throw new ValidationError('The scan batch cookie header is invalid.')
      }
      return value
    }

    const files: BatchScanTarget[] = rawFiles.map((rawTarget) => {
      const target = asRecord(rawTarget)
      for (const key of Object.keys(target)) {
        if (
          key !== 'url' &&
          key !== 'title' &&
          key !== 'filename' &&
          key !== 'resolvedUrl' &&
          key !== 'requestHeaders' &&
          key !== 'scanItemId'
        ) {
          throw new ValidationError(
            'A scan batch target contains unsupported fields.'
          )
        }
      }
      const url = normalizeBatchSourceUrl(target.url)
      const title = cleanSafeText(target.title, MAX_BATCH_TITLE_LENGTH, 'Scanned file')
      let filename: string | undefined
      if (target.filename !== undefined) {
        if (typeof target.filename !== 'string') {
          throw new ValidationError('The scan batch filename is invalid.')
        }
        filename = sanitizeFilename(target.filename)
      }
      // Redirect-resolved target from the queue-time probe. DownloadManager
      // still enforces exact host+scheme before it sends any Cookie.
      const resolvedUrl =
        target.resolvedUrl === undefined
          ? undefined
          : normalizeBatchSourceUrl(target.resolvedUrl)
      let requestHeaders: DownloadRequestHeaders | undefined
      if (target.requestHeaders !== undefined) {
        const headers = asRecord(target.requestHeaders)
        for (const key of Object.keys(headers)) {
          if (key !== 'cookie') {
            throw new ValidationError(
              'A scan batch header contains unsupported fields.'
            )
          }
        }
        requestHeaders = { cookie: readCookie(headers.cookie) }
      }
      return {
        url,
        title,
        ...(filename === undefined ? {} : { filename }),
        ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
        ...(requestHeaders === undefined ? {} : { requestHeaders }),
        ...(target.scanItemId === undefined
          ? {}
          : { scanItemId: opaqueId(target.scanItemId) })
      }
    })

    const videos: BatchScanVideoTarget[] = rawVideos.map((rawTarget) => {
      const target = asRecord(rawTarget)
      for (const key of Object.keys(target)) {
        if (
          key !== 'url' &&
          key !== 'title' &&
          key !== 'analysisId' &&
          key !== 'optionId' &&
          key !== 'outputFormat' &&
          key !== 'cookie' &&
          key !== 'qualityLabel' &&
          key !== 'scanItemId'
        ) {
          throw new ValidationError(
            'A scan video target contains unsupported fields.'
          )
        }
      }
      const opaque = (value: unknown): string => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
          throw new ValidationError('A scan video identifier is invalid.')
        }
        return value
      }
      let outputFormat: MediaOutputFormat | undefined
      if (target.outputFormat !== undefined) {
        if (!isMediaOutputFormat(target.outputFormat)) {
          throw new ValidationError('The scan video output format is invalid.')
        }
        outputFormat = target.outputFormat
      }
      let qualityLabel: string | undefined
      if (target.qualityLabel !== undefined) {
        qualityLabel = cleanSafeText(target.qualityLabel, 120, 'Scanned video')
      }
      return {
        url: normalizeBatchSourceUrl(target.url),
        title: cleanSafeText(target.title, MAX_BATCH_TITLE_LENGTH, 'Scanned video'),
        analysisId: opaque(target.analysisId),
        optionId: opaque(target.optionId),
        ...(outputFormat === undefined ? {} : { outputFormat }),
        ...(qualityLabel === undefined ? {} : { qualityLabel }),
        ...(target.cookie === undefined
          ? {}
          : { cookie: readCookie(target.cookie) }),
        ...(target.scanItemId === undefined
          ? {}
          : { scanItemId: opaqueId(target.scanItemId) })
      }
    })

    const createdAt = this.now()
    const batchId = newOpaqueId('batch')
    const items = new Map<string, BatchItemRecord>()
    const scanItemIdToBatch = new Map<string, string>()

    for (const target of files) {
      const itemId = newOpaqueId('bitem')
      items.set(itemId, {
        id: itemId,
        batchId,
        position: items.size,
        kind: 'download',
        status: 'queued',
        title: target.title,
        label: 'Scanned file',
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        sourceUrl: target.url,
        createdAt,
        updatedAt: createdAt,
        completedAt: null
      })
      if (target.scanItemId !== undefined) {
        scanItemIdToBatch.set(target.scanItemId, itemId)
      }
      if (target.requestHeaders !== undefined) {
        this.scanRequestHeaders.set(itemId, target.requestHeaders)
      }
      if (target.resolvedUrl !== undefined) {
        this.scanResolvedUrls.set(itemId, target.resolvedUrl)
      }
      if (target.filename !== undefined) {
        this.scanFilenames.set(itemId, target.filename)
      }
    }

    for (const target of videos) {
      const itemId = newOpaqueId('bitem')
      items.set(itemId, {
        id: itemId,
        batchId,
        position: items.size,
        kind: 'media',
        status: 'queued',
        title: target.title,
        label:
          target.qualityLabel !== undefined
            ? `Scanned video · ${target.qualityLabel}`
            : target.outputFormat === undefined
              ? 'Scanned video'
              : `Scanned video · ${target.outputFormat.toUpperCase()}`,
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        sourceUrl: target.url,
        createdAt,
        updatedAt: createdAt,
        completedAt: null
      })
      if (target.scanItemId !== undefined) {
        scanItemIdToBatch.set(target.scanItemId, itemId)
      }
      this.scanMediaSelections.set(itemId, {
        analysisId: target.analysisId,
        optionId: target.optionId,
        ...(target.outputFormat === undefined
          ? {}
          : { outputFormat: target.outputFormat }),
        ...(target.cookie === undefined ? {} : { cookie: target.cookie })
      })
    }

    const parsedPairings = this.parseScanPairings(
      record.pairings,
      batchId,
      items,
      scanItemIdToBatch
    )

    const batchRecord: BatchRecord = {
      id: batchId,
      kind: 'direct-urls',
      title: cleanSafeText(record.title, MAX_BATCH_TITLE_LENGTH, 'Scanned page'),
      status: 'queued',
      sourceUrl: null,
      mediaQuality: null,
      maxBytesPerItem: null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }

    const batch = this.insertBatch(batchRecord, [...items.values()])
    if (parsedPairings.length > 0) {
      this.scanPairings.set(batchId, parsedPairings)
    }
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.schedulePump()
    this.ensurePolling()
    this.publish(true)
    return this.toPublicBatch(batch)
  }

  /**
   * Create a scanner batch for a manual "Match to video file…" action. The
   * scripts are downloaded into the user-chosen folder (resolved from an
   * opaque token, never a renderer path) and renamed after completion against
   * the picked video's basename.
   */
  async createManualMatchBatch(rawInput: unknown): Promise<Batch> {
    this.assertOpen()
    const record = asRecord(rawInput)
    for (const key of Object.keys(record)) {
      if (key !== 'title' && key !== 'scripts' && key !== 'pairing' && key !== 'folderToken') {
        throw new ValidationError('The manual match batch contains unsupported fields.')
      }
    }
    const title = this.readBatchTitle(record.title)
    const scripts = this.parsePairingScripts(record.scripts, 'manual match')
    const pairing = this.readPairingSelection(record.pairing, 'manual match')
    const token = typeof record.folderToken === 'string' ? record.folderToken : ''
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      throw new ValidationError('The manual match folder token is invalid.')
    }
    const folder = this.resolvePairingFolder?.(token) ?? null
    if (folder === null) {
      throw new AppError(
        'PAIR_FOLDER_UNAVAILABLE',
        'The chosen video folder is no longer available. Choose the video again.'
      )
    }
    const filePath = folder.filePath
    if (path.dirname(path.resolve(filePath)) !== path.resolve(folder.directory)) {
      throw new ValidationError('The manual match video is not inside its folder.')
    }

    const createdAt = this.now()
    const batchId = newOpaqueId('batch')
    const items = new Map<string, BatchItemRecord>()
    const scanItemIdToBatch = this.addScriptItems(items, batchId, createdAt, scripts)
    if (scanItemIdToBatch === null) {
      throw new ValidationError('The manual match script list is invalid.')
    }
    const managed = this.buildPairing({
      batchId,
      videoItemId: null,
      externalVideo: {
        filePath,
        directory: folder.directory,
        filename: folder.filename,
        token
      },
      pairing,
      scanItemIdToBatch,
      scanItems: scripts,
      items
    })

    const batchRecord = this.newDirectBatchRecord(batchId, title, createdAt)
    const batch = this.insertBatch(batchRecord, [...items.values()])
    this.scanPairings.set(batchId, [managed])
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.schedulePump()
    this.ensurePolling()
    this.publish(true)
    return this.toPublicBatch(batch)
  }

  /**
   * Create one scanner batch from a browser hand-off that matched an armed
   * browser-only card: the detected video plus the chosen scripts. No cookie or
   * header beyond the existing sniffed-media payload is added.
   */
  async createBrowserMatchBatch(rawInput: unknown): Promise<Batch> {
    this.assertOpen()
    const record = asRecord(rawInput)
    for (const key of Object.keys(record)) {
      if (key !== 'title' && key !== 'video' && key !== 'scripts' && key !== 'pairing') {
        throw new ValidationError('The browser match batch contains unsupported fields.')
      }
    }
    const title = this.readBatchTitle(record.title)
    const video = parseSniffedMediaInput(record.video)
    const scripts = this.parsePairingScripts(record.scripts, 'browser match')
    const pairing = this.readPairingSelection(record.pairing, 'browser match')

    const createdAt = this.now()
    const batchId = newOpaqueId('batch')
    const items = new Map<string, BatchItemRecord>()
    const videoItemId = newOpaqueId('bitem')
    const filename = sniffedMediaFilename(video)
    const isFile = video.kind === 'file'
    items.set(videoItemId, {
      id: videoItemId,
      batchId,
      position: 0,
      kind: isFile ? 'download' : 'media',
      status: 'queued',
      title: video.title,
      label: isFile ? 'Detected video' : video.kind === 'hls' ? 'HLS stream' : 'DASH stream',
      childId: null,
      completedBytes: 0,
      totalBytes: null,
      errorMessage: null,
      sourceUrl: video.url,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    })
    if (isFile) {
      this.scanFilenames.set(videoItemId, filename)
      this.scanRequestHeaders.set(videoItemId, {
        referer: video.referer,
        userAgent: video.userAgent,
        ...(video.cookie === undefined ? {} : { cookie: video.cookie })
      })
    } else {
      this.scanSniffedMediaSelections.set(videoItemId, video)
    }

    const scanItemIdToBatch = this.addScriptItems(items, batchId, createdAt, scripts, 1)
    if (scanItemIdToBatch === null) {
      throw new ValidationError('The browser match script list is invalid.')
    }
    const managed = this.buildPairing({
      batchId,
      videoItemId,
      pairing,
      scanItemIdToBatch,
      scanItems: scripts,
      items
    })

    const batchRecord = this.newDirectBatchRecord(batchId, title, createdAt)
    const batch = this.insertBatch(batchRecord, [...items.values()])
    this.scanPairings.set(batchId, [managed])
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.schedulePump()
    this.ensurePolling()
    this.publish(true)
    return this.toPublicBatch(batch)
  }

  private readBatchTitle(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.trim().length === 0
    ) {
      throw new ValidationError('The scan batch title is invalid.')
    }
    return cleanSafeText(value, MAX_BATCH_TITLE_LENGTH, 'Scanned page')
  }

  private newDirectBatchRecord(
    batchId: string,
    title: string,
    createdAt: number
  ): BatchRecord {
    return {
      id: batchId,
      kind: 'direct-urls',
      title,
      status: 'queued',
      sourceUrl: null,
      mediaQuality: null,
      maxBytesPerItem: null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }
  }

  private parsePairingScripts(
    rawValue: unknown,
    subject: string
  ): BatchScanTarget[] {
    if (
      !Array.isArray(rawValue) ||
      rawValue.length === 0 ||
      rawValue.length > MAX_COLLECTION_SELECTION
    ) {
      throw new ValidationError(`The ${subject} script list is invalid.`)
    }
    const seen = new Set<string>()
    return rawValue.map((rawTarget) => {
      const target = asRecord(rawTarget)
      for (const key of Object.keys(target)) {
        if (
          key !== 'url' &&
          key !== 'title' &&
          key !== 'filename' &&
          key !== 'resolvedUrl' &&
          key !== 'requestHeaders' &&
          key !== 'scanItemId'
        ) {
          throw new ValidationError(`A ${subject} script contains unsupported fields.`)
        }
      }
      const url = normalizeBatchSourceUrl(target.url)
      const title = cleanSafeText(target.title, MAX_BATCH_TITLE_LENGTH, 'Scanned script')
      let filename: string | undefined
      if (target.filename !== undefined) {
        if (typeof target.filename !== 'string') {
          throw new ValidationError(`The ${subject} script filename is invalid.`)
        }
        filename = sanitizeFilename(target.filename)
      }
      const resolvedUrl =
        target.resolvedUrl === undefined
          ? undefined
          : normalizeBatchSourceUrl(target.resolvedUrl)
      let requestHeaders: DownloadRequestHeaders | undefined
      if (target.requestHeaders !== undefined) {
        const headers = asRecord(target.requestHeaders)
        for (const key of Object.keys(headers)) {
          if (key !== 'cookie') {
            throw new ValidationError(
              `A ${subject} script header contains unsupported fields.`
            )
          }
        }
        const cookie = headers.cookie
        if (
          typeof cookie !== 'string' ||
          cookie.length === 0 ||
          cookie.length > 8192 ||
          // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
          /[\u0000-\u001f\u007f]/.test(cookie)
        ) {
          throw new ValidationError(`The ${subject} script cookie is invalid.`)
        }
        requestHeaders = { cookie }
      }
      if (target.scanItemId === undefined) {
        throw new ValidationError(`A ${subject} script has no item identifier.`)
      }
      const scanItemId = opaqueId(target.scanItemId)
      if (seen.has(scanItemId)) {
        throw new ValidationError(`Duplicate ${subject} script item.`)
      }
      seen.add(scanItemId)
      return {
        url,
        title,
        ...(filename === undefined ? {} : { filename }),
        ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
        ...(requestHeaders === undefined ? {} : { requestHeaders }),
        scanItemId
      }
    })
  }

  private readPairingSelection(
    value: unknown,
    subject: string
  ): {
    setId: string
    scriptItemIds: string[]
    primaryVariant: string | null
    rename: boolean
  } {
    const pairing = asRecord(value)
    for (const key of Object.keys(pairing)) {
      if (
        key !== 'setId' &&
        key !== 'scriptItemIds' &&
        key !== 'primaryVariant' &&
        key !== 'rename'
      ) {
        throw new ValidationError(`A ${subject} pairing contains unsupported fields.`)
      }
    }
    if (
      typeof pairing.setId !== 'string' ||
      pairing.setId.length > 300 ||
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
      !/^set:[^\s\u0000-\u001f\u007f/\\]{1,300}$/u.test(pairing.setId)
    ) {
      throw new ValidationError(`A ${subject} pairing set is invalid.`)
    }
    if (
      !Array.isArray(pairing.scriptItemIds) ||
      pairing.scriptItemIds.length === 0 ||
      pairing.scriptItemIds.length > MAX_COLLECTION_SELECTION
    ) {
      throw new ValidationError(`A ${subject} pairing has no scripts.`)
    }
    const scriptItemIds = pairing.scriptItemIds.map((id) => opaqueId(id))
    if (new Set(scriptItemIds).size !== scriptItemIds.length) {
      throw new ValidationError(`Duplicate ${subject} script item.`)
    }
    const primaryVariant =
      pairing.primaryVariant === null
        ? null
        : cleanSafeText(pairing.primaryVariant, 32, 'script version').toLowerCase()
    if (typeof pairing.rename !== 'boolean') {
      throw new ValidationError(`A ${subject} rename flag is invalid.`)
    }
    return {
      setId: pairing.setId,
      scriptItemIds,
      primaryVariant,
      rename: pairing.rename
    }
  }

  private addScriptItems(
    items: Map<string, BatchItemRecord>,
    batchId: string,
    createdAt: number,
    scripts: readonly BatchScanTarget[],
    positionOffset = 0
  ): Map<string, string> {
    const scanItemIdToBatch = new Map<string, string>()
    for (const target of scripts) {
      const itemId = newOpaqueId('bitem')
      items.set(itemId, {
        id: itemId,
        batchId,
        position: positionOffset + items.size,
        kind: 'download',
        status: 'queued',
        title: target.title,
        label: 'Scanned file',
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        sourceUrl: target.url,
        createdAt,
        updatedAt: createdAt,
        completedAt: null
      })
      if (target.scanItemId !== undefined) {
        if (scanItemIdToBatch.has(target.scanItemId)) {
          throw new ValidationError('Duplicate script item identifier.')
        }
        scanItemIdToBatch.set(target.scanItemId, itemId)
      }
      if (target.requestHeaders !== undefined) {
        this.scanRequestHeaders.set(itemId, target.requestHeaders)
      }
      if (target.resolvedUrl !== undefined) {
        this.scanResolvedUrls.set(itemId, target.resolvedUrl)
      }
      if (target.filename !== undefined) {
        this.scanFilenames.set(itemId, target.filename)
      }
    }
    return scanItemIdToBatch
  }

  private buildPairing(input: {
    batchId: string
    videoItemId: string | null
    externalVideo?: ManagedScanPairing['externalVideo']
    pairing: {
      setId: string
      scriptItemIds: string[]
      primaryVariant: string | null
      rename: boolean
    }
    scanItemIdToBatch: ReadonlyMap<string, string>
    scanItems: readonly BatchScanTarget[]
    items: ReadonlyMap<string, BatchItemRecord>
  }): ManagedScanPairing {
    const scriptBatchIds: string[] = []
    const scripts = new Map<string, { axis: string | null; variant: string | null }>()
    for (const scanItemId of input.pairing.scriptItemIds) {
      const batchId = input.scanItemIdToBatch.get(scanItemId)
      const item = batchId === undefined ? undefined : input.items.get(batchId)
      if (!item) {
        throw new ValidationError(
          'A scan script pairing file is not part of this batch.'
        )
      }
      if (scriptBatchIds.includes(item.id)) {
        throw new ValidationError('Duplicate scan script item identifier.')
      }
      const filename = this.scanFilenames.get(item.id) ?? item.title
      const parsed = parseFunscriptName(filename)
      if (parsed === null) {
        throw new ValidationError('A scan script pairing file is not a funscript.')
      }
      scriptBatchIds.push(item.id)
      scripts.set(item.id, { axis: parsed.axis, variant: parsed.variant })
    }
    return {
      batchId: input.batchId,
      videoItemId: input.videoItemId,
      ...(input.externalVideo === undefined
        ? {}
        : { externalVideo: input.externalVideo }),
      setId: input.pairing.setId,
      scriptItemIds: scriptBatchIds,
      primaryVariant: input.pairing.primaryVariant,
      rename: input.pairing.rename,
      scripts,
      settled: false
    }
  }

  private parseScanPairings(
    rawValue: unknown,
    batchId: string,
    items: ReadonlyMap<string, BatchItemRecord>,
    scanItemIdToBatch: ReadonlyMap<string, string>,
    fileVideoItemIds: ReadonlySet<string> = new Set()
  ): ManagedScanPairing[] {
    if (rawValue === undefined) return []
    if (!Array.isArray(rawValue) || rawValue.length > MAX_COLLECTION_SELECTION) {
      throw new ValidationError('The scan script pairings are invalid.')
    }
    const pairings: ManagedScanPairing[] = []
    const seenVideos = new Set<string>()
    const seenSets = new Set<string>()
    const claimedScripts = new Set<string>()

    for (const entry of rawValue) {
      const pairing = asRecord(entry)
      for (const key of Object.keys(pairing)) {
        if (
          key !== 'videoItemId' &&
          key !== 'setId' &&
          key !== 'scriptItemIds' &&
          key !== 'primaryVariant' &&
          key !== 'rename'
        ) {
          throw new ValidationError(
            'A scan script pairing contains unsupported fields.'
          )
        }
      }
      const videoScanId = opaqueId(pairing.videoItemId)
      const videoBatchId = scanItemIdToBatch.get(videoScanId)
      const videoItem = videoBatchId === undefined ? undefined : items.get(videoBatchId)
      if (
        !videoItem ||
        (videoItem.kind !== 'media' &&
          !(videoBatchId !== undefined && fileVideoItemIds.has(videoBatchId)))
      ) {
        throw new ValidationError(
          'A scan script pairing video is not part of this batch.'
        )
      }
      if (seenVideos.has(videoScanId)) {
        throw new ValidationError('Duplicate scan script pairing video.')
      }
      seenVideos.add(videoScanId)

      if (
        typeof pairing.setId !== 'string' ||
        pairing.setId.length > 300 ||
        // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
        !/^set:[^\s\u0000-\u001f\u007f/\\]{1,300}$/u.test(pairing.setId)
      ) {
        throw new ValidationError('A scan script pairing set is invalid.')
      }
      if (seenSets.has(pairing.setId)) {
        throw new ValidationError('Duplicate scan script pairing set.')
      }
      seenSets.add(pairing.setId)

      const rawScripts = pairing.scriptItemIds
      if (
        !Array.isArray(rawScripts) ||
        rawScripts.length === 0 ||
        rawScripts.length > MAX_COLLECTION_SELECTION
      ) {
        throw new ValidationError('A scan script pairing has no scripts.')
      }
      const scriptItems: string[] = []
      const scripts = new Map<string, { axis: string | null; variant: string | null }>()
      for (const rawScriptId of rawScripts) {
        const scriptScanId = opaqueId(rawScriptId)
        if (claimedScripts.has(scriptScanId)) {
          throw new ValidationError('A script cannot belong to two pairings.')
        }
        claimedScripts.add(scriptScanId)
        const scriptBatchId = scanItemIdToBatch.get(scriptScanId)
        const scriptItem = scriptBatchId === undefined ? undefined : items.get(scriptBatchId)
        if (!scriptItem || scriptItem.kind !== 'download') {
          throw new ValidationError(
            'A scan script pairing file is not part of this batch.'
          )
        }
        if (scriptItems.includes(scriptItem.id)) {
          throw new ValidationError('Duplicate scan script item identifier.')
        }
        const filename =
          this.scanFilenames.get(scriptItem.id) ?? scriptItem.title
        const parsed = parseFunscriptName(filename)
        if (parsed === null) {
          throw new ValidationError(
            'A scan script pairing file is not a funscript.'
          )
        }
        scriptItems.push(scriptItem.id)
        scripts.set(scriptItem.id, {
          axis: parsed.axis,
          variant: parsed.variant
        })
      }

      let primaryVariant: string | null = null
      if (pairing.primaryVariant !== null) {
        primaryVariant = cleanSafeText(
          pairing.primaryVariant,
          32,
          'script version'
        ).toLowerCase()
      }
      if (typeof pairing.rename !== 'boolean') {
        throw new ValidationError('A scan script rename flag is invalid.')
      }

      pairings.push({
        batchId,
        videoItemId: videoBatchId as string,
        setId: pairing.setId,
        scriptItemIds: scriptItems,
        primaryVariant,
        rename: pairing.rename,
        scripts,
        settled: false
      })
    }

    return pairings
  }

  /* ---------------------- batch creation from a preview ---------------------- */

  async createCollectionBatch(rawInput: unknown): Promise<Batch> {
    this.assertOpen()
    const input: CreateCollectionBatchInput =
      parseCreateCollectionBatchInput(rawInput)
    const stored = this.requirePreview(input.previewId)
    if (stored.kind === 'pixeldrain-list' && (input.mediaQuality !== undefined || input.maxBytesPerItem != null)) {
      throw new AppError('BATCH_MEDIA_POLICY_UNSUPPORTED', 'Media quality and size limits apply only to playlist media jobs.')
    }

    const entryById = new Map(
      stored.preview.entries.map((entry) => [entry.id, entry])
    )
    const selected = input.selectedEntryIds.map((entryId) => {
      const entry = entryById.get(entryId)
      if (!entry) {
        throw new AppError(
          'BATCH_PREVIEW_ENTRY_UNKNOWN',
          'The selected entry does not belong to this preview.'
        )
      }
      return entry
    })

    const available = selected.filter(
      (entry) => entry.availability === 'available'
    )
    const targets = new Map<string, string>()
    if (stored.kind === 'playlist' && available.length > 0) {
      let resolved: readonly BatchCollectionTarget[]
      try {
        resolved = await this.collectionEngine.resolveCollectionEntries(
          stored.id,
          available.map((entry) => entry.id)
        )
      } catch (error) {
        throw this.collectionError(
          error,
          'BATCH_COLLECTION_RESOLVE_FAILED',
          'The selected playlist entries could not be resolved.'
        )
      }
      for (const target of resolved) {
        if (
          typeof target.url === 'string' &&
          target.url.length > 0 &&
          target.url.length <= 4_096
        ) {
          targets.set(target.entryId, target.url)
        }
      }
    }

    const createdAt = this.now()
    const batchId = newOpaqueId('batch')
    const items = new Map<string, BatchItemRecord>()

    for (const [position, entry] of selected.entries()) {
      const isAvailable = entry.availability === 'available'
      let sourceUrl: string | null = null
      if (isAvailable) {
        sourceUrl =
          stored.kind === 'playlist'
            ? targets.get(entry.id) ?? null
            : stored.pixeldrainEntries?.get(entry.id)?.sourceUrl ?? null
      }

      const canQueue = isAvailable && sourceUrl !== null
      const status: BatchItemStatus = !isAvailable
        ? 'unavailable'
        : canQueue
          ? 'queued'
          : 'error'
      const errorMessage =
        !isAvailable
          ? entry.errorReason ?? 'This entry is not available.'
          : canQueue
            ? null
            : 'The selected entry could not be resolved.'

      const itemId = newOpaqueId('bitem')
      items.set(itemId, {
        id: itemId,
        batchId,
        position,
        kind: stored.kind === 'playlist' ? 'media' : 'download',
        status,
        title: entry.title,
        label: stored.kind === 'playlist' ? 'Playlist item' : 'Pixeldrain file',
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage,
        sourceUrl,
        createdAt,
        updatedAt: createdAt,
        completedAt: terminalItemStatus(status) ? createdAt : null
      })
    }

    const record: BatchRecord = {
      id: batchId,
      kind: stored.kind === 'playlist' ? 'media-playlist' : 'pixeldrain-list',
      title: stored.preview.title,
      status: 'queued',
      sourceUrl: stored.sourceUrl,
      mediaQuality: stored.kind === 'playlist' ? input.mediaQuality ?? 'best' : null,
      maxBytesPerItem: stored.kind === 'playlist' ? input.maxBytesPerItem ?? null : null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null
    }

    const batch = this.insertBatch(record, [...items.values()])
    this.previews.delete(input.previewId)
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.schedulePump()
    this.publish(true)
    return this.toPublicBatch(batch)
  }

  /* ------------------------------ mutations ------------------------------ */

  async cancelBatchItem(rawInput: unknown): Promise<BatchSnapshot> {
    this.assertOpen()
    const input = parseBatchItemTargetInput(rawInput)
    const { batch, item } = this.requireItem(input)

    if (!isActiveBatchItemStatus(item.status)) {
      return this.getBatchSnapshot()
    }

    await this.cancelChild(item)
    this.markItemTerminal(item, 'cancelled', null)
    this.persistItemNow(item)
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.publish(true)
    return this.getBatchSnapshot()
  }

  async cancelBatch(rawInput: unknown): Promise<BatchSnapshot> {
    this.assertOpen()
    const input: BatchTargetInput = parseBatchTargetInput(rawInput)
    const batch = this.requireBatch(input.batchId)

    if (batch.record.status === 'cancelled') {
      return this.getBatchSnapshot()
    }

    const cancelledAt = this.now()
    for (const item of batch.items.values()) {
      if (!isActiveBatchItemStatus(item.status)) continue
      await this.cancelChild(item)
      this.markItemTerminal(item, 'cancelled', null, cancelledAt)
      this.persistItemNow(item)
    }

    batch.record.status = 'cancelled'
    batch.record.errorMessage = null
    batch.record.completedAt = cancelledAt
    batch.record.updatedAt = cancelledAt
    this.persistBatchNow(batch)
    this.stopPollingIfIdle()
    this.publish(true)
    return this.getBatchSnapshot()
  }

  async retryBatchItem(rawInput: unknown): Promise<BatchSnapshot> {
    this.assertOpen()
    const input = parseBatchItemTargetInput(rawInput)
    const { batch, item } = this.requireItem(input)

    if (item.status !== 'error' && item.status !== 'interrupted') {
      throw new AppError(
        'BATCH_ITEM_NOT_RETRYABLE',
        'Only failed or interrupted batch items can be retried.'
      )
    }

    const updatedAt = this.now()
    item.status = 'queued'
    item.childId = null
    item.completedBytes = 0
    item.totalBytes = null
    item.errorMessage = null
    item.completedAt = null
    item.updatedAt = updatedAt

    if (
      batch.record.status === 'cancelled' ||
      batch.record.completedAt !== null
    ) {
      batch.record.status = 'queued'
      batch.record.completedAt = null
      batch.record.errorMessage = null
      batch.record.updatedAt = updatedAt
    }

    this.persistItemNow(item)
    this.recomputeBatch(batch)
    this.persistBatchNow(batch)
    this.schedulePump()
    this.ensurePolling()
    this.publish(true)
    return this.getBatchSnapshot()
  }

  /** Remove only the parent DB row (items cascade). Child jobs/files stay. */
  async removeBatch(rawInput: unknown): Promise<BatchSnapshot> {
    this.assertOpen()
    const input: BatchTargetInput = parseBatchTargetInput(rawInput)
    const batch = this.requireBatch(input.batchId)

    this.batches.delete(batch.record.id)
    this.scanPairings.delete(batch.record.id)
    for (const item of batch.items.values()) {
      this.dirtyItems.delete(item.id)
      this.scanRequestHeaders.delete(item.id)
      this.scanResolvedUrls.delete(item.id)
      this.scanFilenames.delete(item.id)
      this.scanFallbacks.delete(item.id)
      this.scanSubfolders.delete(item.id)
      this.scanMediaSelections.delete(item.id)
      this.scanSniffedMediaSelections.delete(item.id)
    }
    this.removePersistedBatch(batch.record.id)
    this.stopPollingIfIdle()
    this.publish(true)
    return this.getBatchSnapshot()
  }

  /**
   * Explicit safe browser-open action for a stored Gofile share link. The URL
   * comes from the internal item record, never from the renderer, and must be an
   * exact canonical https://gofile.io/{d|f}/{id} value with no credentials,
   * query or fragment.
   */
  async openBatchSource(rawInput: unknown): Promise<null> {
    this.assertOpen()
    const input = parseBatchItemTargetInput(rawInput)
    const { item } = this.requireItem(input)
    const sourceUrl = item.sourceUrl
    if (sourceUrl === null) {
      throw new AppError(
        'BATCH_SOURCE_NOT_OPENABLE',
        'This batch item has no openable source link.'
      )
    }

    const canonical = canonicalGofileUrl(sourceUrl)
    if (canonical === null || canonical !== sourceUrl) {
      throw new AppError(
        'BATCH_SOURCE_NOT_OPENABLE',
        'Only a canonical public Gofile link can be opened in the browser.'
      )
    }

    try {
      await this.openExternal(canonical)
    } catch {
      throw new AppError(
        'BATCH_SOURCE_OPEN_FAILED',
        'The link could not be opened in the browser.'
      )
    }
    return null
  }

  /* ---------------------------- observation ---------------------------- */

  /** Reconcile child state into batch item progress. Safe to call often. */
  refresh(): void {
    if (this.closed) return
    let changed = false

    for (const batch of this.batches.values()) {
      if (batch.record.status === 'cancelled') continue
      for (const item of batch.items.values()) {
        if (!isActiveBatchItemStatus(item.status)) continue
        if (item.childId === null) continue

        // One child lookup per item instead of rebuilding both full snapshots
        // on every tick.
        if (item.kind === 'media') {
          const child = this.mediaJobs.getJob(item.childId)
          if (child && this.applyMediaChild(item, child)) changed = true
        } else {
          const child = this.downloads.getItem(item.childId)
          if (child && this.applyDownloadChild(item, child)) changed = true
        }
      }
      if (this.maybeSchedulePairRename(batch)) changed = true
      if (this.recomputeBatch(batch)) {
        this.persistBatchNow(batch)
        changed = true
      }
    }

    if (changed) this.publish()
    this.schedulePump()
    this.ensurePolling()
    this.stopPollingIfIdle()
  }

  /** Flush progress writes. Call before closing the database. */
  flushPersistence(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending()
  }

  /**
   * Mark active parents/items interrupted and persist. Never re-queues, resumes
   * or deletes a child. Child cancellation during shutdown is owned by the
   * download/media managers.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    const updatedAt = this.now()
    for (const batch of this.batches.values()) {
      let batchChanged = false
      for (const item of batch.items.values()) {
        if (!isActiveBatchItemStatus(item.status)) continue
        this.markItemTerminal(
          item,
          'interrupted',
          BATCH_ITEM_INTERRUPTED_MESSAGE,
          updatedAt
        )
        this.persistItemNow(item)
        batchChanged = true
      }
      if (
        batchChanged ||
        batch.record.status === 'queued' ||
        batch.record.status === 'running'
      ) {
        batch.record.status = 'interrupted'
        batch.record.errorMessage = BATCH_INTERRUPTED_MESSAGE
        batch.record.completedAt = updatedAt
        batch.record.updatedAt = updatedAt
        this.persistBatchNow(batch)
      }
    }

    // A graceful shutdown before the video/scripts finish leaves a clear item
    // label. A hard crash simply keeps the original script names.
    for (const [batchId, pairings] of this.scanPairings) {
      const batch = this.batches.get(batchId)
      if (!batch) continue
      for (const pairing of pairings) {
        if (pairing.settled) continue
        this.updatePairLabels(batch, pairing, PAIR_RENAME_APP_STOPPED)
      }
    }

    this.flushPersistence()
    this.scanRequestHeaders.clear()
    this.scanResolvedUrls.clear()
    this.scanFilenames.clear()
    this.scanMediaSelections.clear()
    this.scanSniffedMediaSelections.clear()
    this.scanPairings.clear()
    this.resolveIdleWaiters()
  }

  /** Resolves when no scheduler pass is running or queued on the microtask. */
  async waitForIdle(): Promise<void> {
    if (this.pumping || this.pumpScheduled) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve)
      })
    }
    // Pair renames run after the child status is reconciled; wait for them so
    // tests and shutdown observe the final labels.
    while (this.pairingTasks.size > 0) {
      await Promise.allSettled([...this.pairingTasks])
    }
  }

  publish(force = false): void {
    const snapshot = this.getBatchSnapshot()
    const serialized = JSON.stringify(snapshot)
    if (!force && serialized === this.lastPublished) return
    this.lastPublished = serialized
    try {
      this.onUpdate(snapshot)
    } catch {
      // A closing window must never break orchestration or persistence.
    }
  }

  /* ------------------------------ scheduler ------------------------------ */

  private schedulePump(): void {
    if (this.closed || this.pumping || this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      void this.pump()
    })
  }

  /**
   * Direct children are added one at a time; aria2's own concurrency still
   * governs the actual transfers. Media children are strictly serialized to one
   * active item so a playlist cannot fan out into unbounded yt-dlp processes.
   */
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return
    this.pumping = true
    try {
      for (;;) {
        if (this.closed) break

        const direct = this.nextQueuedDownload()
        if (direct) {
          await this.startDownloadItem(direct.batch, direct.item)
          continue
        }

        if (this.hasActiveMediaItem()) break

        const media = this.nextQueuedMedia()
        if (media) {
          await this.startMediaItem(media.batch, media.item)
          continue
        }
        break
      }
    } finally {
      this.pumping = false
      this.ensurePolling()
      this.stopPollingIfIdle()
      if (!this.pumpScheduled) this.resolveIdleWaiters()
      this.publish()
    }
  }

  private nextQueuedDownload(): { batch: ManagedBatch; item: BatchItemRecord } | null {
    for (const batch of this.sortedBatches()) {
      if (batch.record.status === 'cancelled') continue
      for (const item of this.sortedItems(batch)) {
        if (item.kind === 'download' && item.status === 'queued') {
          return { batch, item }
        }
      }
    }
    return null
  }

  private nextQueuedMedia(): { batch: ManagedBatch; item: BatchItemRecord } | null {
    for (const batch of this.sortedBatches()) {
      if (batch.record.status === 'cancelled') continue
      for (const item of this.sortedItems(batch)) {
        if (item.kind === 'media' && item.status === 'queued') {
          return { batch, item }
        }
      }
    }
    return null
  }

  private hasActiveMediaItem(): boolean {
    for (const batch of this.batches.values()) {
      if (batch.record.status === 'cancelled') continue
      for (const item of batch.items.values()) {
        if (item.kind === 'media' && item.status === 'running') return true
      }
    }
    return false
  }

  private async startDownloadItem(
    batch: ManagedBatch,
    item: BatchItemRecord
  ): Promise<void> {
    const startedAt = this.now()
    item.status = 'running'
    item.errorMessage = null
    item.updatedAt = startedAt
    this.markBatchRunning(batch, startedAt)
    this.persistItemNow(item)
    this.persistBatchNow(batch)
    this.publish()

    try {
      const sourceUrl = item.sourceUrl
      if (sourceUrl === null) {
        throw new AppError(
          'BATCH_ITEM_SOURCE_MISSING',
          'This batch item has no source URL.'
        )
      }

      let targetUrl = sourceUrl
      let filename: string | undefined = this.scanFilenames.get(item.id)
      let parsed: URL
      try {
        parsed = new URL(sourceUrl)
      } catch {
        throw new AppError(
          'BATCH_ITEM_SOURCE_INVALID',
          'This batch item does not have a valid source URL.'
        )
      }

      if (parsed.hostname.toLowerCase() === 'pixeldrain.com') {
        const resolution = await this.pixeldrain.resolveFile(sourceUrl)
        targetUrl = resolution.downloadUrl
        filename = resolution.name
      }

      const resolvedScanUrl =
        targetUrl === sourceUrl ? this.scanResolvedUrls.get(item.id) : undefined
      const addInput = {
        url: targetUrl,
        ...(filename ? { filename } : {}),
        ...(resolvedScanUrl === undefined
          ? {}
          : { resolvedUrl: resolvedScanUrl }),
        ...(this.scanRequestHeaders.has(item.id)
          ? { requestHeaders: this.scanRequestHeaders.get(item.id) }
          : {})
      }
      // Paired funscripts go directly into the video's folder so the
      // post-download rename never moves a file across folders. A manual
      // match uses its opaque folder token; a browser-matched direct video
      // uses the normal download root; a media job uses the media output dir.
      const pairing = this.pairingForScript(batch, item.id)
      let snapshot: AppSnapshot
      if (pairing?.externalVideo !== undefined) {
        if (typeof this.downloads.addPairingFile !== 'function') {
          throw new AppError(
            'PAIR_FOLDER_UNAVAILABLE',
            'The chosen video folder is not available.'
          )
        }
        snapshot = (await this.downloads.addPairingFile(
          addInput,
          pairing.externalVideo.token
        )) as AppSnapshot
      } else {
        // An image batch downloads into its own folder below the root; every
        // other scanner item keeps the normal root or its paired folder.
        const imageDir = this.imageBatchDirectory(batch, item)
        const pairedScriptDir =
          imageDir ?? this.pairedScriptDirectory(batch, pairing)
        snapshot = (pairedScriptDir === null
          ? await this.downloads.add(addInput)
          : await this.downloads.addScanFile!(addInput, pairedScriptDir)) as AppSnapshot
      }
      if (!this.batches.has(batch.record.id)) {
        // The parent row was removed while `add` was in flight. The child row
        // is never deleted by a batch removal; pause it best effort so it does
        // not continue as an untracked batch download.
        const orphan = this.findAddedDownload(snapshot, targetUrl)
        if (orphan) {
          try {
            await this.downloads.pause(orphan.id)
          } catch {
            // The child may already have finished.
          }
        }
        return
      }
      const child = this.findAddedDownload(snapshot, targetUrl)
      if (!child) {
        throw new AppError(
          'BATCH_CHILD_NOT_CREATED',
          'The download was added but its record could not be found.'
        )
      }

      item.childId = child.id
      item.totalBytes = child.totalBytes > 0 ? child.totalBytes : item.totalBytes
      item.completedBytes = child.completedBytes

      if (item.status !== 'running') {
        // Cancelled while `add` was in flight: never leave an untracked child
        // running. Pause is best effort and keeps files on disk.
        try {
          await this.downloads.pause(child.id)
        } catch {
          // The child may already have finished or stopped.
        }
        this.persistItemNow(item)
        return
      }

      this.applyDownloadChild(item, child)
      this.persistItemNow(item)
      this.persistBatchNow(batch)
    } catch (error) {
      if (item.status !== 'running' || !this.batches.has(batch.record.id)) return
      const failedAt = this.now()
      this.markItemTerminal(
        item,
        'error',
        describeBatchFailure(error, 'The download could not be started.'),
        failedAt
      )
      this.persistItemNow(item)
      this.recomputeBatch(batch)
      this.persistBatchNow(batch)
    }
  }

  private async startMediaItem(
    batch: ManagedBatch,
    item: BatchItemRecord
  ): Promise<void> {
    const startedAt = this.now()
    item.status = 'running'
    item.errorMessage = null
    item.updatedAt = startedAt
    this.markBatchRunning(batch, startedAt)
    this.persistItemNow(item)
    this.persistBatchNow(batch)
    this.publish()

    try {
      const sourceUrl = item.sourceUrl
      if (sourceUrl === null) {
        throw new AppError(
          'BATCH_ITEM_SOURCE_MISSING',
          'This batch item has no source URL.'
        )
      }

      const pinned = this.scanMediaSelections.get(item.id)
      if (pinned !== undefined) {
        const job = await this.mediaJobs.queueMedia({
          analysisId: pinned.analysisId,
          optionId: pinned.optionId,
          ...(pinned.outputFormat === undefined
            ? {}
            : { outputFormat: pinned.outputFormat }),
          ...(pinned.cookie === undefined ? {} : { cookie: pinned.cookie })
        })
        if (!this.batches.has(batch.record.id)) {
          try {
            await this.mediaJobs.cancelMedia(job.id)
          } catch {
            // The child may already be terminal.
          }
          return
        }
        item.childId = job.id
        item.totalBytes = job.totalBytes
        item.completedBytes = job.completedBytes
        item.label = cleanSafeText(job.label, 240, 'Media')
        if (item.status !== 'running') {
          try {
            await this.mediaJobs.cancelMedia(job.id)
          } catch {
            // Best effort; the item stays cancelled.
          }
          this.persistItemNow(item)
          return
        }
        this.applyMediaChild(item, job)
        this.persistItemNow(item)
        this.persistBatchNow(batch)
        return
      }

      const sniffed = this.scanSniffedMediaSelections.get(item.id)
      if (sniffed !== undefined) {
        if (typeof this.mediaJobs.queueSniffedMedia !== 'function') {
          throw new AppError(
            'MEDIA_UNAVAILABLE',
            'Stream downloads are not available in this build.'
          )
        }
        const job = await this.mediaJobs.queueSniffedMedia(sniffed)
        if (!this.batches.has(batch.record.id)) {
          try {
            await this.mediaJobs.cancelMedia(job.id)
          } catch {
            // The child may already be terminal.
          }
          return
        }
        item.childId = job.id
        item.totalBytes = job.totalBytes
        item.completedBytes = job.completedBytes
        item.label = cleanSafeText(job.label, 240, 'Media')
        if (item.status !== 'running') {
          try {
            await this.mediaJobs.cancelMedia(job.id)
          } catch {
            // Best effort; the item stays cancelled.
          }
          this.persistItemNow(item)
          return
        }
        this.applyMediaChild(item, job)
        this.persistItemNow(item)
        this.persistBatchNow(batch)
        return
      }

      const analysis = await this.mediaJobs.analyzeMedia({ url: sourceUrl })
      if (!this.batches.has(batch.record.id)) return
      const quality = batch.record.mediaQuality ?? 'best'
      const option = selectBatchMediaOption(analysis, quality)
      const optionId = option?.optionId ?? null
      if (optionId === null) {
        this.markItemTerminal(item, 'skipped', noQualityMessage(quality))
        this.persistItemNow(item)
        this.recomputeBatch(batch)
        this.persistBatchNow(batch)
        return
      }
      const maxBytes = batch.record.maxBytesPerItem ?? null
      if (!option || (maxBytes !== null && option.filesizeBytes !== null && option.filesizeBytes > maxBytes)) {
        this.markItemTerminal(item, 'skipped', 'The verified format size exceeds the per-job limit.')
        this.persistItemNow(item)
        this.recomputeBatch(batch)
        this.persistBatchNow(batch)
        return
      }

      if (item.status !== 'running') return

      const job = await this.mediaJobs.queueMedia({
        analysisId: analysis.analysisId,
        optionId,
        ...(maxBytes === null ? {} : { maxBytes })
      })

      if (!this.batches.has(batch.record.id)) {
        try {
          await this.mediaJobs.cancelMedia(job.id)
        } catch {
          // The child may already be terminal.
        }
        return
      }

      item.childId = job.id
      item.totalBytes = job.totalBytes
      item.completedBytes = job.completedBytes
      item.label = cleanSafeText(job.label, 240, 'Media')

      if (item.status !== 'running') {
        // Cancelled while analysis/queueing was in flight.
        try {
          await this.mediaJobs.cancelMedia(job.id)
        } catch {
          // Best effort; the item stays cancelled.
        }
        this.persistItemNow(item)
        return
      }

      this.applyMediaChild(item, job)
      this.persistItemNow(item)
      this.persistBatchNow(batch)
    } catch (error) {
      if (item.status !== 'running' || !this.batches.has(batch.record.id)) return
      const failedAt = this.now()
      this.markItemTerminal(
        item,
        'error',
        describeBatchFailure(error, 'The media download could not be started.'),
        failedAt
      )
      this.persistItemNow(item)
      this.recomputeBatch(batch)
      this.persistBatchNow(batch)
    }
  }

  /* --------------------------- child reconciliation --------------------------- */

  private applyDownloadChild(
    item: BatchItemRecord,
    child: DownloadItem
  ): boolean {
    const nextStatus = statusFromDownload(child.status)
    if (nextStatus === 'error' && this.retryWithFallback(item)) return true
    const total = child.totalBytes > 0 ? child.totalBytes : item.totalBytes
    let completed = clampBytes(child.completedBytes, item.completedBytes)
    if (total !== null) completed = Math.min(completed, total)

    let message: string | null = null
    if (nextStatus === 'error') {
      message = describeBatchFailure(
        { message: child.errorMessage ?? '' },
        'The download failed.'
      )
    } else if (nextStatus === 'interrupted') {
      message = BATCH_ITEM_INTERRUPTED_MESSAGE
    }

    return this.applyChildState(item, {
      status: nextStatus,
      completedBytes: completed,
      totalBytes: total,
      errorMessage: message
    })
  }

  /**
   * Retry one image item with its fallback URL. Pinterest serves the same pin
   * from `/originals/` with an unpredictable extension, so a 403/404 there is
   * expected and the 736x URL is tried exactly once.
   */
  private retryWithFallback(item: BatchItemRecord): boolean {
    const fallback = this.scanFallbacks.get(item.id)
    if (fallback === undefined) return false
    this.scanFallbacks.delete(item.id)
    if (item.status !== 'running') return false
    const failedChildId = item.childId
    // The originals URL only guesses the extension, so the retry follows the
    // fallback URL's own file name instead of keeping the wrong one. The
    // subfolder is keyed by item id and therefore unchanged.
    const fallbackFilename = filenameFromUrl(fallback)
    if (fallbackFilename !== null) {
      this.scanFilenames.set(item.id, fallbackFilename)
    }
    item.sourceUrl = fallback
    item.childId = null
    item.status = 'queued'
    item.errorMessage = null
    item.completedBytes = 0
    item.updatedAt = this.now()
    this.persistItemNow(item)
    // This retry replaces the failed first attempt, so its child row must not
    // stay in the downloads list as a separate failed download.
    if (failedChildId !== null) this.discardFailedChild(failedChildId)
    return true
  }

  /**
   * Remove the failed child record of a superseded first attempt. Best effort
   * only: the item is already re-queued, so a missing or failing remove API
   * must never block the fallback retry.
   */
  private discardFailedChild(childId: string): void {
    const remove = this.downloads.remove
    if (typeof remove !== 'function') return
    void Promise.resolve()
      .then(() => remove.call(this.downloads, childId))
      .catch(() => {
        // The row may already be gone, or the manager may be closing.
      })
  }

  private applyMediaChild(item: BatchItemRecord, child: MediaJob): boolean {
    const nextStatus = statusFromMediaJob(child.status)
    const total = child.totalBytes !== null ? child.totalBytes : null
    let completed = clampBytes(child.completedBytes, item.completedBytes)
    if (total !== null) completed = Math.min(completed, total)

    let message: string | null = null
    if (nextStatus === 'error') {
      message = describeBatchFailure(
        { message: child.errorMessage ?? '' },
        'The media download failed.'
      )
    } else if (nextStatus === 'interrupted') {
      message = BATCH_ITEM_INTERRUPTED_MESSAGE
    } else if (nextStatus === 'cancelled') {
      message = null
    }

    return this.applyChildState(item, {
      status: nextStatus,
      completedBytes: completed,
      totalBytes: total,
      errorMessage: message
    })
  }

  private applyChildState(
    item: BatchItemRecord,
    next: {
      status: BatchItemStatus
      completedBytes: number
      totalBytes: number | null
      errorMessage: string | null
    }
  ): boolean {
    if (!isActiveBatchItemStatus(item.status)) return false

    const changed =
      item.status !== next.status ||
      item.completedBytes !== next.completedBytes ||
      item.totalBytes !== next.totalBytes ||
      item.errorMessage !== next.errorMessage

    if (!changed) return false

    const updatedAt = this.now()
    item.status = next.status
    item.completedBytes = Math.max(0, next.completedBytes)
    item.totalBytes = next.totalBytes
    item.errorMessage = next.errorMessage
    item.updatedAt = updatedAt
    if (terminalItemStatus(next.status)) {
      item.completedAt = updatedAt
    }

    if (terminalItemStatus(next.status)) {
      this.persistItemNow(item)
    } else {
      this.markItemDirty(item)
    }
    return true
  }

  /**
   * Trigger the post-download rename once the video and every chosen script
   * are terminal. Failures settle the pair immediately with a safe label.
   * Memory-only: after a restart the pair is gone and scripts keep their
   * original names.
   */
  private maybeSchedulePairRename(batch: ManagedBatch): boolean {
    const pairings = this.scanPairings.get(batch.record.id)
    if (!pairings || pairings.length === 0) return false
    let changed = false
    for (const pairing of pairings) {
      if (pairing.settled) continue
      const video =
        pairing.videoItemId === null
          ? null
          : batch.items.get(pairing.videoItemId)
      const scripts = pairing.scriptItemIds.map((id) => batch.items.get(id))
      if (
        (pairing.videoItemId !== null && !video) ||
        scripts.some((script) => script === undefined) ||
        (pairing.videoItemId !== null &&
          (!video || !terminalItemStatus(video.status))) ||
        scripts.some((script) => !terminalItemStatus(script!.status))
      ) {
        continue
      }
      pairing.settled = true
      if (
        pairing.videoItemId !== null &&
        video !== undefined &&
        video !== null &&
        video.status !== 'complete'
      ) {
        changed =
          this.updatePairLabels(batch, pairing, PAIR_RENAME_VIDEO_FAILED) ||
          changed
        continue
      }
      if (scripts.some((script) => script!.status !== 'complete')) {
        changed =
          this.updatePairLabels(
            batch,
            pairing,
            PAIR_RENAME_SCRIPT_FAILED
          ) || changed
        continue
      }
      const task = this.runPairRename(batch, pairing)
        .catch(() => {
          this.applyPairLabels(batch, pairing, PAIR_RENAME_FAILED)
        })
        .finally(() => {
          this.pairingTasks.delete(task)
        })
      this.pairingTasks.add(task)
    }
    if (changed) this.persistPairLabels(batch)
    return changed
  }

  private async runPairRename(
    batch: ManagedBatch,
    pairing: ManagedScanPairing
  ): Promise<void> {
    if (!this.batches.has(batch.record.id)) return
    let root: string | null
    let videoPath: string | null
    let videoStatus: string
    if (pairing.externalVideo !== undefined) {
      root = pairing.externalVideo.directory
      videoPath = pairing.externalVideo.filePath
      videoStatus = 'complete'
    } else {
      const video =
        pairing.videoItemId === null
          ? null
          : batch.items.get(pairing.videoItemId)
      if (!video) return
      root = this.scanRootDir ?? this.scanMediaDir
      videoPath =
        video.childId === null
          ? null
          : video.kind === 'media'
            ? this.mediaJobs.getFilePath?.(video.childId) ?? null
            : this.downloads.getFilePath?.(video.childId) ?? null
      videoStatus = video.status
    }
    if (root === null) {
      this.applyPairLabels(batch, pairing, PAIR_RENAME_SCRIPT_FAILED)
      return
    }
    const files = pairing.scriptItemIds.map((itemId) => {
      const item = batch.items.get(itemId)
      const script = pairing.scripts.get(itemId)
      const path =
        item?.childId == null
          ? null
          : this.downloads.getFilePath?.(item.childId) ?? null
      return {
        itemId,
        filePath: path,
        axis: script?.axis ?? null,
        variant: script?.variant ?? null,
        status: item?.status ?? 'error'
      }
    })
    const result = await applyPairRename({
      rootDir: root,
      videoPath,
      videoStatus,
      files,
      primaryVariant: pairing.primaryVariant,
      rename: pairing.rename
    })
    if (result.status === 'renamed') {
      for (const entry of result.renamed) {
        const item = batch.items.get(entry.itemId)
        if (item?.childId != null) {
          if (pairing.externalVideo !== undefined) {
            this.downloads.adoptRenamedFileInFolder?.(
              item.childId,
              entry.path,
              pairing.externalVideo.token
            )
          } else {
            this.downloads.adoptRenamedFile?.(item.childId, entry.path)
          }
        }
      }
      this.applyPairLabels(batch, pairing, 'Renamed to match video')
      return
    }
    this.applyPairLabels(batch, pairing, result.reason)
  }

  private updatePairLabels(
    batch: ManagedBatch,
    pairing: ManagedScanPairing,
    label: string
  ): boolean {
    let changed = false
    const text = cleanSafeText(label, MAX_BATCH_LABEL_LENGTH, 'Scanned script')
    for (const itemId of pairing.scriptItemIds) {
      const item = batch.items.get(itemId)
      if (!item || item.label === text) continue
      item.label = text
      item.updatedAt = this.now()
      this.persistItemNow(item)
      changed = true
    }
    return changed
  }

  private persistPairLabels(batch: ManagedBatch): void {
    this.persistBatchNow(batch)
    this.publish()
  }

  private applyPairLabels(
    batch: ManagedBatch,
    pairing: ManagedScanPairing,
    label: string
  ): void {
    if (this.updatePairLabels(batch, pairing, label)) {
      this.recomputeBatch(batch)
      this.persistBatchNow(batch)
      this.publish()
    }
  }

  private pairingForScript(
    batch: ManagedBatch,
    itemId: string
  ): ManagedScanPairing | null {
    const pairings = this.scanPairings.get(batch.record.id)
    if (!pairings) return null
    return (
      pairings.find((pairing) => pairing.scriptItemIds.includes(itemId)) ?? null
    )
  }

  /**
   * Folder for paired scripts that are downloaded next to their video. Returns
   * null when the download should use the normal download root or when the
   * optional scanner download path is unavailable.
   */
  private pairedScriptDirectory(
    batch: ManagedBatch,
    pairing: ManagedScanPairing | null
  ): string | null {
    if (pairing === null || pairing.videoItemId === null) return null
    if (typeof this.downloads.addScanFile !== 'function') return null
    const video = batch.items.get(pairing.videoItemId)
    if (!video) return null
    if (video.kind === 'media') return this.scanMediaDir
    // A browser-matched direct file is downloaded into the normal root, so its
    // scripts must land in that same folder.
    return this.scanRootDir ?? this.scanMediaDir
  }

  /**
   * Folder for one image batch item: `<download root>/<page title>`. The
   * subfolder is a single validated segment, so the result always stays inside
   * the scanner root. Returns null when the item has no subfolder.
   */
  private imageBatchDirectory(
    batch: ManagedBatch,
    item: BatchItemRecord
  ): string | null {
    const subfolder = this.scanSubfolders.get(item.id)
    if (subfolder === undefined) return null
    if (typeof this.downloads.addScanFile !== 'function') return null
    const root = this.scanRootDir ?? this.scanMediaDir
    if (root === null) return null
    const directory = path.resolve(root, subfolder)
    const relative = path.relative(path.resolve(root), directory)
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null
    }
    if (relative.includes(path.sep)) return null
    return directory
  }

  /* ------------------------------ aggregate ------------------------------ */

  private recomputeBatch(batch: ManagedBatch): boolean {
    if (batch.record.status === 'cancelled') return false

    const items = [...batch.items.values()]
    const anyRunning = items.some((item) => item.status === 'running')
    const anyQueued = items.some((item) => item.status === 'queued')

    let next: BatchStatus
    if (anyRunning || anyQueued) {
      next = anyRunning ? 'running' : 'queued'
    } else if (items.length === 0) {
      next = 'complete'
    } else {
      let completed = 0
      let failed = 0
      let skipped = 0
      let cancelled = 0
      let interrupted = 0
      for (const item of items) {
        if (item.status === 'complete') completed += 1
        else if (item.status === 'error') failed += 1
        else if (item.status === 'unavailable' || item.status === 'skipped') {
          skipped += 1
        } else if (item.status === 'cancelled') cancelled += 1
        else if (item.status === 'interrupted') interrupted += 1
      }

      if (completed === items.length) next = 'complete'
      else if (interrupted > 0 && completed === 0 && failed === 0) {
        next = 'interrupted'
      } else if (cancelled > 0 && completed === 0 && failed === 0 && skipped === 0) {
        next = 'cancelled'
      } else if (failed > 0 && completed === 0 && skipped === 0) {
        next = 'error'
      } else {
        next = 'partial'
      }
    }

    const updatedAt = this.now()
    let changed = false
    if (batch.record.status !== next) {
      batch.record.status = next
      changed = true
    }
    if (anyRunning || anyQueued) {
      if (batch.record.completedAt !== null) {
        batch.record.completedAt = null
        changed = true
      }
      if (batch.record.errorMessage !== null) {
        batch.record.errorMessage = null
        changed = true
      }
    } else if (batch.record.completedAt === null) {
      batch.record.completedAt = updatedAt
      changed = true
    }
    if (changed) batch.record.updatedAt = updatedAt
    return changed
  }

  private markBatchRunning(batch: ManagedBatch, updatedAt: number): void {
    if (batch.record.status === 'cancelled') return
    if (batch.record.status !== 'running') {
      batch.record.status = 'running'
      batch.record.completedAt = null
      batch.record.errorMessage = null
      batch.record.updatedAt = updatedAt
    }
  }

  private markItemTerminal(
    item: BatchItemRecord,
    status: 'cancelled' | 'interrupted' | 'error' | 'skipped',
    errorMessage: string | null,
    at = this.now()
  ): void {
    item.status = status
    item.errorMessage = errorMessage
    item.updatedAt = at
    item.completedAt = at
  }

  /* ------------------------------ persistence ------------------------------ */

  private loadPersistedBatches(): void {
    if (!this.database) return

    let stored: StoredBatchRecord[]
    try {
      stored = this.database.loadBatches()
    } catch {
      this.logPersistenceError('could not be loaded')
      return
    }

    const now = this.now()
    for (const entry of stored) {
      const record = entry.record
      let repaired = false

      if (record.sourceUrl !== null) {
        try {
          record.sourceUrl = normalizeBatchSourceUrl(record.sourceUrl)
        } catch {
          record.sourceUrl = null
          repaired = true
        }
      }

      const items = new Map<string, BatchItemRecord>()
      let hadActiveItem = false
      for (const loadedItem of entry.items) {
        const item = { ...loadedItem }
        if (item.sourceUrl !== null) {
          try {
            item.sourceUrl = normalizeBatchSourceUrl(item.sourceUrl)
          } catch {
            item.sourceUrl = null
          }
        }
        if (isActiveBatchItemStatus(item.status)) {
          item.status = 'interrupted'
          item.errorMessage = BATCH_ITEM_INTERRUPTED_MESSAGE
          item.completedAt = now
          item.updatedAt = now
          hadActiveItem = true
          repaired = true
        }
        items.set(item.id, item)
      }

      if (
        record.status === 'queued' ||
        record.status === 'running' ||
        hadActiveItem
      ) {
        record.status = 'interrupted'
        record.errorMessage = BATCH_INTERRUPTED_MESSAGE
        record.completedAt = now
        record.updatedAt = now
        repaired = true
      }

      const batch: ManagedBatch = { record, items }
      this.batches.set(record.id, batch)

      if (repaired) {
        this.persistBatchWithItems(batch)
      }
    }
  }

  private insertBatch(
    record: BatchRecord,
    items: readonly BatchItemRecord[]
  ): ManagedBatch {
    const batch: ManagedBatch = {
      record,
      items: new Map(items.map((item) => [item.id, item]))
    }
    this.batches.set(record.id, batch)
    this.persistBatchWithItems(batch)
    return batch
  }

  private persistBatchWithItems(batch: ManagedBatch): void {
    if (!this.database) return
    try {
      this.database.saveBatchWithItems(batch.record, [...batch.items.values()])
      for (const item of batch.items.values()) this.dirtyItems.delete(item.id)
    } catch {
      this.logPersistenceError('could not be saved')
    }
  }

  private persistBatchNow(batch: ManagedBatch): void {
    if (!this.database) return
    try {
      this.database.saveBatch(batch.record)
    } catch {
      this.logPersistenceError('could not be saved')
    }
  }

  private persistItemNow(item: BatchItemRecord): void {
    if (!this.database) return
    try {
      this.database.saveManyBatchItems([{ ...item }])
      this.dirtyItems.delete(item.id)
    } catch {
      this.logPersistenceError('could not be saved')
      this.markItemDirty(item)
    }
  }

  private removePersistedBatch(id: string): void {
    if (!this.database) return
    try {
      this.database.deleteBatch(id)
    } catch {
      this.logPersistenceError('could not be removed')
    }
  }

  private markItemDirty(item: BatchItemRecord): void {
    if (!this.database) return
    this.dirtyItems.set(item.id, { ...item })
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

  private flushPending(): void {
    if (!this.database || this.dirtyItems.size === 0) return
    const records = [...this.dirtyItems.values()].map((item) => ({ ...item }))
    try {
      this.database.saveManyBatchItems(records)
      this.dirtyItems.clear()
    } catch {
      this.logPersistenceError('could not be saved')
      this.scheduleFlush()
    }
  }

  private logPersistenceError(context: string): void {
    if (this.persistenceErrorLogged) return
    this.persistenceErrorLogged = true
    // Never include URLs, paths or record payloads in logs.
    console.error(`Batch history ${context}.`)
  }

  /* -------------------------------- polling -------------------------------- */

  private ensurePolling(): void {
    if (this.pollTimer !== null || this.closed || this.pollIntervalMs <= 0) {
      return
    }
    if (!this.hasWorkToObserve()) return
    this.pollTimer = setInterval(() => {
      this.refresh()
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPollingIfIdle(): void {
    if (this.pollTimer !== null && !this.hasWorkToObserve()) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private hasWorkToObserve(): boolean {
    for (const batch of this.batches.values()) {
      if (batch.record.status === 'cancelled') continue
      for (const item of batch.items.values()) {
        if (item.status === 'queued' || item.status === 'running') return true
      }
    }
    return false
  }

  /* -------------------------------- helpers -------------------------------- */

  private requireBatch(batchId: string): ManagedBatch {
    const batch = this.batches.get(batchId)
    if (!batch) {
      throw new AppError('BATCH_NOT_FOUND', 'That batch no longer exists.')
    }
    return batch
  }

  private requireItem(input: {
    batchId: string
    itemId: string
  }): { batch: ManagedBatch; item: BatchItemRecord } {
    const batch = this.requireBatch(input.batchId)
    const item = batch.items.get(input.itemId)
    if (!item) {
      throw new AppError(
        'BATCH_ITEM_NOT_FOUND',
        'That batch item no longer exists.'
      )
    }
    return { batch, item }
  }

  private requirePreview(previewId: string): StoredPreview {
    this.prunePreviews()
    const preview = this.previews.get(previewId)
    if (!preview) {
      throw new AppError(
        'BATCH_PREVIEW_NOT_FOUND',
        'Preview this collection again before selecting entries.'
      )
    }
    return preview
  }

  private storePreview(preview: StoredPreview): void {
    this.prunePreviews()
    preview.preview = parseCollectionPreview(preview.preview)
    this.previews.set(preview.id, preview)
  }

  private prunePreviews(): void {
    const now = this.now()
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id)
    }
    while (this.previews.size > MAX_STORED_PREVIEWS) {
      const oldest = this.previews.keys().next().value
      if (oldest === undefined) break
      this.previews.delete(oldest)
    }
  }

  private toPublicBatch(batch: ManagedBatch): Batch {
    return parseBatch(
      toPublicBatch(batch.record, [...batch.items.values()])
    )
  }

  private sortedBatches(): ManagedBatch[] {
    return [...this.batches.values()].sort(
      (left, right) => left.record.createdAt - right.record.createdAt
    )
  }

  private sortedItems(batch: ManagedBatch): BatchItemRecord[] {
    return [...batch.items.values()].sort(
      (left, right) => left.position - right.position
    )
  }

  private findAddedDownload(
    snapshot: AppSnapshot,
    targetUrl: string
  ): DownloadItem | null {
    const matches = snapshot.downloads.filter(
      (entry) => entry.url === targetUrl
    )
    if (matches.length === 0) return null
    return matches.sort(
      (left, right) => right.createdAt - left.createdAt
    )[0] ?? null
  }

  private async cancelChild(item: BatchItemRecord): Promise<void> {
    if (item.childId === null) return
    if (item.kind === 'media') {
      try {
        await this.mediaJobs.cancelMedia(item.childId)
      } catch {
        // The child may already be terminal or gone.
      }
      return
    }
    try {
      await this.downloads.pause(item.childId)
    } catch {
      // A completed/removed child cannot be paused; files are never deleted.
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError(
        'BATCH_UNAVAILABLE',
        'Batch support is shutting down.'
      )
    }
  }

  private resolveIdleWaiters(): void {
    if (this.pumping || this.pumpScheduled) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private pixeldrainError(
    error: unknown,
    fallbackCode: string,
    fallbackMessage: string
  ): AppError {
    if (error instanceof AppError) return error
    const code = errorCode(error)
    return new AppError(
      code && code.startsWith('PIXELDRAIN_') ? code : fallbackCode,
      safeMessageForBatch(error, fallbackMessage)
    )
  }

  private collectionError(
    error: unknown,
    fallbackCode: string,
    fallbackMessage: string
  ): AppError {
    if (error instanceof AppError) return error
    const code = errorCode(error)
    if (code !== null && code.startsWith('MEDIA_')) {
      return new AppError(code, safeMessageForBatch(error, fallbackMessage))
    }
    return new AppError(fallbackCode, fallbackMessage)
  }

  /* --------------------------- collection sources --------------------------- */

  private async analyzePlaylist(url: string): Promise<CollectionPreview> {
    let preview: CollectionPreview
    try {
      preview = await this.collectionEngine.analyzeCollection(url)
    } catch (error) {
      throw this.collectionError(
        error,
        'MEDIA_COLLECTION_FAILED',
        'The playlist could not be previewed.'
      )
    }

    let parsed: CollectionPreview
    try {
      parsed = parseCollectionPreview(preview)
    } catch {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'The playlist preview was not valid.'
      )
    }

    this.storePreview({
      id: parsed.id,
      kind: 'playlist',
      sourceUrl: url,
      preview: parsed,
      expiresAt: this.now() + this.previewTtlMs,
      pixeldrainEntries: null
    })
    return parsed
  }

  private async resolvePixeldrainList(url: string): Promise<CollectionPreview> {
    let resolution: PixeldrainListResolution
    try {
      resolution = await this.pixeldrain.resolveList(url)
    } catch (error) {
      throw this.pixeldrainError(
        error,
        'PIXELDRAIN_UNAVAILABLE',
        'This Pixeldrain list could not be previewed.'
      )
    }

    let preview: CollectionPreview
    try {
      preview = parseCollectionPreview(resolution.preview)
    } catch {
      throw new AppError(
        'PIXELDRAIN_INVALID_RESPONSE',
        'Pixeldrain returned an unexpected preview.'
      )
    }

    const entries = new Map<
      string,
      PixeldrainListResolution['entries'][number]
    >()
    for (const entry of resolution.entries) {
      entries.set(entry.entryId, entry)
    }

    this.storePreview({
      id: preview.id,
      kind: 'pixeldrain-list',
      sourceUrl: resolution.sourceUrl,
      preview,
      expiresAt: this.now() + this.previewTtlMs,
      pixeldrainEntries: entries
    })
    return preview
  }
}

export const BATCH_LIMITS = Object.freeze({
  maxSources: MAX_BATCH_SOURCES,
  maxSelection: MAX_COLLECTION_SELECTION,
  maxStoredPreviews: MAX_STORED_PREVIEWS
})
