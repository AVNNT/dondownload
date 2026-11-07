import type { DownloadItem } from '@shared/types'
import type { MediaJob } from '@shared/media'
import { formatPercent } from '@shared/format'

/**
 * Renderer-only adapters that project the two existing backend collections
 * (direct downloads and media jobs) into one presentation list.
 *
 * Nothing here changes either backend contract: a `UnifiedRow` always keeps a
 * reference to the original `DownloadItem` or `MediaJob`, and every action is
 * executed through the existing IPC methods.
 */

export const CATEGORY_IDS = [
  'all',
  'video',
  'audio',
  'documents',
  'programs',
  'compressed',
  'other'
] as const
export type CategoryId = (typeof CATEGORY_IDS)[number]
export type ItemCategory = Exclude<CategoryId, 'all'>

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  all: 'All',
  video: 'Video',
  audio: 'Audio',
  documents: 'Documents',
  programs: 'Programs',
  compressed: 'Compressed',
  other: 'Other'
}

export const STATUS_FILTER_IDS = [
  'all',
  'active',
  'queued',
  'completed',
  'failed'
] as const
export type StatusFilterId = (typeof STATUS_FILTER_IDS)[number]
export type RowStatusGroup = Exclude<StatusFilterId, 'all'>

export const STATUS_FILTER_LABELS: Record<StatusFilterId, string> = {
  all: 'All items',
  active: 'Active',
  queued: 'Queued',
  completed: 'Completed',
  failed: 'Failed'
}

export const SORT_KEYS = ['date', 'name', 'size', 'progress', 'status'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

export const SORT_LABELS: Record<SortKey, string> = {
  date: 'Date added',
  name: 'Name',
  size: 'Size',
  progress: 'Progress',
  status: 'Status'
}

export type UnifiedSource = 'download' | 'media'
export type StatusTone =
  | 'active'
  | 'queued'
  | 'paused'
  | 'complete'
  | 'warning'
  | 'failed'

export interface UnifiedRow {
  /** Stable composite key: downloads and media jobs can share an id space. */
  key: string
  id: string
  source: UnifiedSource
  title: string
  /** Media quality label or the download host, whichever is meaningful. */
  subtitle: string
  url: string | null
  host: string | null
  category: ItemCategory
  sizeBytes: number | null
  completedBytes: number
  progress: number
  indeterminate: boolean
  speedBps: number
  etaSeconds: number | null
  statusLabel: string
  statusGroup: RowStatusGroup
  statusTone: StatusTone
  createdAt: number
  updatedAt: number
  completedAt: number | null
  scheduledAt: number | null
  speedLimitBps: number | null
  connections: number | null
  attempts: number | null
  maxAttempts: number | null
  errorMessage: string | null
  /** Raw technical failure text, shown only in the details pane. */
  errorDetail: string | null
  /** Epoch ms of a pending automatic retry, if any. */
  retryAt: number | null
  filePath: string | null
  /** Optional and renderer-only for now; the live backend does not persist a
   * job thumbnail, so most live rows use the category icon fallback. */
  thumbnailUrl: string | null
  download: DownloadItem | null
  media: MediaJob | null
}

const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'txt',
  'rtf',
  'md',
  'odt',
  'xls',
  'xlsx',
  'csv',
  'ods',
  'ppt',
  'pptx',
  'odp',
  'epub',
  'mobi',
  'azw3',
  'pages',
  'numbers',
  'key'
])

const PROGRAM_EXTENSIONS = new Set([
  'exe',
  'msi',
  'msix',
  'appx',
  'app',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'appimage',
  'apk',
  'iso',
  'img'
])

const COMPRESSED_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  'zst',
  'lz4',
  'cab',
  'cpio'
])

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'avi',
  'mov',
  'webm',
  'm4v',
  'mpg',
  'mpeg',
  'ts',
  'flv',
  'wmv',
  'ogv',
  '3gp'
])

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'aac',
  'flac',
  'wav',
  'ogg',
  'opus',
  'wma',
  'aiff',
  'alac'
])

const MIME_CATEGORIES: ReadonlyArray<[RegExp, ItemCategory]> = [
  [/^video\//i, 'video'],
  [/^audio\//i, 'audio'],
  [/^image\//i, 'other'],
  [/pdf|msword|officedocument|opendocument|text\/|rtf|epub/i, 'documents'],
  [/zip|compressed|x-7z|x-rar|x-tar|gzip|x-bzip|x-xz|zstd/i, 'compressed'],
  [/executable|msdownload|msi|x-apple-diskimage|x-deb|x-rpm/i, 'programs']
]

/** Lower-case extension of a filename or URL path, without the dot. */
export function extensionOf(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value
  const name = withoutQuery.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function categoryFromFilename(name: string): ItemCategory {
  const extension = extensionOf(name)
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'documents'
  if (PROGRAM_EXTENSIONS.has(extension)) return 'programs'
  if (COMPRESSED_EXTENSIONS.has(extension)) return 'compressed'
  return 'other'
}

export function categoryFromMime(mime: string): ItemCategory {
  for (const [pattern, category] of MIME_CATEGORIES) {
    if (pattern.test(mime)) return category
  }
  return 'other'
}

/**
 * Category for a row. Media jobs always follow their declared video/audio kind;
 * direct downloads use the filename, then the MIME hint, then the URL path.
 */
export function classifyCategory(input: {
  source: UnifiedSource
  kind?: 'video' | 'audio' | null
  filename?: string | null
  mime?: string | null
  url?: string | null
}): ItemCategory {
  if (input.source === 'media') {
    return input.kind === 'audio' ? 'audio' : 'video'
  }

  const fromName = input.filename ? categoryFromFilename(input.filename) : 'other'
  if (fromName !== 'other') return fromName
  if (input.mime) {
    const fromMime = categoryFromMime(input.mime)
    if (fromMime !== 'other') return fromMime
  }
  if (input.url) return categoryFromFilename(input.url)
  return 'other'
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function downloadStatus(item: DownloadItem): {
  label: string
  group: RowStatusGroup
  tone: StatusTone
} {
  if (item.blockReason === 'scheduled') {
    return { label: 'Scheduled', group: 'queued', tone: 'warning' }
  }
  if (item.blockReason === 'allowed-hours') {
    return { label: 'Allowed hours', group: 'queued', tone: 'warning' }
  }

  switch (item.status) {
    case 'active':
      return { label: 'Downloading', group: 'active', tone: 'active' }
    case 'waiting':
      return { label: 'Waiting', group: 'queued', tone: 'warning' }
    case 'queued':
      return { label: 'Queued', group: 'queued', tone: 'queued' }
    case 'paused':
      return { label: 'Paused', group: 'active', tone: 'paused' }
    case 'complete':
      return { label: 'Complete', group: 'completed', tone: 'complete' }
    case 'error':
      return { label: 'Failed', group: 'failed', tone: 'failed' }
    case 'interrupted':
      return { label: 'Interrupted', group: 'failed', tone: 'warning' }
  }
}

function mediaStatus(job: MediaJob): {
  label: string
  group: RowStatusGroup
  tone: StatusTone
  indeterminate: boolean
} {
  const totalKnown = job.totalBytes !== null && job.totalBytes > 0
  const hasProgress = job.completedBytes > 0 || job.speedBps > 0
  switch (job.status) {
    case 'queued':
      return {
        label: 'Queued',
        group: 'queued',
        tone: 'queued',
        indeterminate: false
      }
    case 'analyzing':
      return {
        label: 'Analyzing',
        group: 'active',
        tone: 'active',
        indeterminate: true
      }
    case 'downloading':
      return {
        label: hasProgress || totalKnown ? 'Downloading' : 'Starting',
        group: 'active',
        tone: 'active',
        indeterminate: !hasProgress || !totalKnown
      }
    case 'merging':
      return {
        label: 'Merging',
        group: 'active',
        tone: 'warning',
        indeterminate: true
      }
    case 'paused':
      return {
        label: 'Paused',
        group: 'active',
        tone: 'paused',
        indeterminate: false
      }
    case 'complete':
      return {
        label: 'Complete',
        group: 'completed',
        tone: 'complete',
        indeterminate: false
      }
    case 'error':
      return {
        label: 'Failed',
        group: 'failed',
        tone: 'failed',
        indeterminate: false
      }
    case 'cancelled':
      return {
        label: 'Cancelled',
        group: 'failed',
        tone: 'paused',
        indeterminate: false
      }
    case 'interrupted':
      return {
        label: 'Interrupted',
        group: 'failed',
        tone: 'warning',
        indeterminate: false
      }
  }
}

export function downloadToRow(item: DownloadItem): UnifiedRow {
  const status = downloadStatus(item)
  const complete = item.status === 'complete'
  // Parse the URL once: subtitle and host share the same hostname, and a
  // 10,000-row rebuild was spending ~9 ms constructing two URL objects each.
  const hostname = hostnameOf(item.url)
  return {
    key: `download:${item.id}`,
    id: item.id,
    source: 'download',
    title: item.filename,
    subtitle: hostname ?? item.url,
    url: item.url,
    host: hostname,
    category: classifyCategory({
      source: 'download',
      filename: item.filename,
      url: item.url
    }),
    sizeBytes: item.totalBytes > 0 ? item.totalBytes : null,
    completedBytes: item.completedBytes,
    progress: complete ? 100 : formatPercent(item.completedBytes, item.totalBytes),
    indeterminate:
      item.status === 'active' && (item.totalBytes <= 0 || item.completedBytes === 0),
    speedBps: item.speedBps,
    etaSeconds: item.etaSeconds,
    statusLabel: status.label,
    statusGroup: status.group,
    statusTone: status.tone,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    scheduledAt: item.scheduledAt ?? null,
    speedLimitBps: item.speedLimitBps ?? null,
    connections: item.connections ?? null,
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    errorMessage: item.errorMessage,
    errorDetail: item.errorDetail ?? null,
    retryAt: item.retryAt ?? null,
    filePath: item.filePath,
    thumbnailUrl: null,
    download: item,
    media: null
  }
}

export function mediaJobToRow(job: MediaJob): UnifiedRow {
  const status = mediaStatus(job)
  const totalKnown = job.totalBytes !== null && job.totalBytes > 0
  const percent =
    job.status === 'complete'
      ? 100
      : totalKnown
        ? formatPercent(job.completedBytes, job.totalBytes ?? 0)
        : 0

  return {
    key: `media:${job.id}`,
    id: job.id,
    source: 'media',
    title: job.title,
    subtitle: job.label,
    url: null,
    host: null,
    category: classifyCategory({ source: 'media', kind: job.kind }),
    sizeBytes: totalKnown ? job.totalBytes : null,
    completedBytes: job.completedBytes,
    progress: percent,
    indeterminate: status.indeterminate,
    speedBps: job.speedBps,
    etaSeconds: null,
    statusLabel: status.label,
    statusGroup: status.group,
    statusTone: status.tone,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    scheduledAt: null,
    speedLimitBps: null,
    connections: null,
    attempts: null,
    maxAttempts: null,
    errorMessage: job.errorMessage,
    errorDetail: null,
    retryAt: null,
    filePath: null,
    thumbnailUrl: job.thumbnailUrl ?? null,
    download: null,
    media: job
  }
}

interface DownloadRowCacheEntry {
  /** Row inputs owned by the record; every one is verified on a cache hit. */
  url: string
  filename: string
  status: DownloadItem['status']
  totalBytes: number
  completedBytes: number
  speedBps: number
  etaSeconds: number | null
  errorMessage: string | null
  errorDetail: string | null
  attempts: number
  maxAttempts: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
  /** The next fields are owned outside the record and keep no `updatedAt`. */
  scheduledAt: number | null
  speedLimitBps: number | null
  connections: number | null
  blockReason: DownloadItem['blockReason']
  retryAt: number | null
  /** Checksum results are published without touching `updatedAt`. */
  checksum: string
  filePath: string | null
  row: UnifiedRow
}

interface MediaRowCacheEntry {
  kind: MediaJob['kind']
  title: string
  label: string
  status: MediaJob['status']
  completedBytes: number
  totalBytes: number | null
  speedBps: number
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  thumbnailUrl: string | null
  /** Merge progress is sampled outside `updatedAt`. */
  mergeCompletedBytes: number | null
  mergeTotalBytes: number | null
  row: UnifiedRow
}

/**
 * Row identity cache.
 *
 * Every backend snapshot re-creates the source items, so without this cache
 * `buildUnifiedRows` rebuilt 10,000 row objects per poll even when nothing had
 * changed, and fresh rows forced memoised table rows to re-diff. The caches
 * below keep the SAME row object for unchanged data:
 *
 *  - a WeakMap keyed by the source item object, for callers that rebuild from
 *    the identical object (fixtures, tests, repeated builds of one snapshot);
 *  - a Map keyed by `${kind}:${id}` plus a full field comparison, because IPC
 *    snapshots deliver fresh item objects for identical data. The entry stores
 *    `updatedAt` together with every other field the row (or its embedded
 *    source item) projects, so a cached row is only reused when all of them are
 *    equal — including the fields that change without bumping `updatedAt`.
 *
 * The Map is bounded: identity reuse is an optimisation, so dropping it
 * wholesale on overflow is safe and keeps memory flat.
 */
const MAX_CACHED_ROWS = 50_000

const DOWNLOAD_ROW_BY_ITEM = new WeakMap<DownloadItem, DownloadRowCacheEntry>()
const DOWNLOAD_ROWS_BY_KEY = new Map<string, DownloadRowCacheEntry>()
const MEDIA_ROW_BY_ITEM = new WeakMap<MediaJob, MediaRowCacheEntry>()
const MEDIA_ROWS_BY_KEY = new Map<string, MediaRowCacheEntry>()

function checksumVersion(checksum: DownloadItem['checksum']): string {
  if (checksum === null || checksum === undefined) return ''
  return `${checksum.algorithm}:${checksum.ok === null ? '?' : checksum.ok ? '1' : '0'}:${checksum.checkedAt}:${checksum.computed}`
}

function downloadEntryOf(
  item: DownloadItem,
  row: UnifiedRow
): DownloadRowCacheEntry {
  return {
    url: item.url,
    filename: item.filename,
    status: item.status,
    totalBytes: item.totalBytes,
    completedBytes: item.completedBytes,
    speedBps: item.speedBps,
    etaSeconds: item.etaSeconds,
    errorMessage: item.errorMessage,
    errorDetail: item.errorDetail ?? null,
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
    scheduledAt: item.scheduledAt ?? null,
    speedLimitBps: item.speedLimitBps ?? null,
    connections: item.connections ?? null,
    blockReason: item.blockReason ?? null,
    retryAt: item.retryAt ?? null,
    checksum: checksumVersion(item.checksum),
    filePath: item.filePath,
    row
  }
}

function sameDownload(entry: DownloadRowCacheEntry, item: DownloadItem): boolean {
  return (
    entry.url === item.url &&
    entry.filename === item.filename &&
    entry.status === item.status &&
    entry.totalBytes === item.totalBytes &&
    entry.completedBytes === item.completedBytes &&
    entry.speedBps === item.speedBps &&
    entry.etaSeconds === item.etaSeconds &&
    entry.errorMessage === item.errorMessage &&
    entry.errorDetail === (item.errorDetail ?? null) &&
    entry.attempts === item.attempts &&
    entry.maxAttempts === item.maxAttempts &&
    entry.createdAt === item.createdAt &&
    entry.updatedAt === item.updatedAt &&
    entry.completedAt === item.completedAt &&
    entry.scheduledAt === (item.scheduledAt ?? null) &&
    entry.speedLimitBps === (item.speedLimitBps ?? null) &&
    entry.connections === (item.connections ?? null) &&
    entry.blockReason === (item.blockReason ?? null) &&
    entry.retryAt === (item.retryAt ?? null) &&
    entry.checksum === checksumVersion(item.checksum) &&
    entry.filePath === item.filePath
  )
}

function mediaEntryOf(job: MediaJob, row: UnifiedRow): MediaRowCacheEntry {
  const merge = job.mergeProgress
  return {
    kind: job.kind,
    title: job.title,
    label: job.label,
    status: job.status,
    completedBytes: job.completedBytes,
    totalBytes: job.totalBytes,
    speedBps: job.speedBps,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    thumbnailUrl: job.thumbnailUrl ?? null,
    mergeCompletedBytes: merge?.completedBytes ?? null,
    mergeTotalBytes: merge?.totalBytes ?? null,
    row
  }
}

function sameMedia(entry: MediaRowCacheEntry, job: MediaJob): boolean {
  const merge = job.mergeProgress
  return (
    entry.kind === job.kind &&
    entry.title === job.title &&
    entry.label === job.label &&
    entry.status === job.status &&
    entry.completedBytes === job.completedBytes &&
    entry.totalBytes === job.totalBytes &&
    entry.speedBps === job.speedBps &&
    entry.errorMessage === job.errorMessage &&
    entry.createdAt === job.createdAt &&
    entry.updatedAt === job.updatedAt &&
    entry.completedAt === job.completedAt &&
    entry.thumbnailUrl === (job.thumbnailUrl ?? null) &&
    entry.mergeCompletedBytes === (merge?.completedBytes ?? null) &&
    entry.mergeTotalBytes === (merge?.totalBytes ?? null)
  )
}

function cachedRow<T extends object, E extends { row: UnifiedRow }>(options: {
  item: T
  key: string
  byItem: WeakMap<T, E>
  byKey: Map<string, E>
  same: (entry: E, item: T) => boolean
  entryOf: (item: T, row: UnifiedRow) => E
  build: (item: T) => UnifiedRow
}): UnifiedRow {
  const { item, key, byItem, byKey, same, entryOf, build } = options

  const known = byItem.get(item)
  if (known !== undefined && same(known, item)) return known.row

  const shared = byKey.get(key)
  if (shared !== undefined && same(shared, item)) {
    byItem.set(item, shared)
    return shared.row
  }

  const row = build(item)
  const entry = entryOf(item, row)
  byItem.set(item, entry)
  if (byKey.size >= MAX_CACHED_ROWS && !byKey.has(key)) byKey.clear()
  byKey.set(key, entry)
  return row
}

/** The array returned by the previous build, reused when nothing changed. */
let previousRows: UnifiedRow[] | null = null

export function buildUnifiedRows(
  downloads: readonly DownloadItem[],
  mediaJobs: readonly MediaJob[]
): UnifiedRow[] {
  const rows: UnifiedRow[] = []
  const total = downloads.length + mediaJobs.length
  let unchanged = previousRows !== null && previousRows.length === total

  for (const item of downloads) {
    const row = cachedRow({
      item,
      key: `download:${item.id}`,
      byItem: DOWNLOAD_ROW_BY_ITEM,
      byKey: DOWNLOAD_ROWS_BY_KEY,
      same: sameDownload,
      entryOf: downloadEntryOf,
      build: downloadToRow
    })
    if (unchanged && previousRows !== null && previousRows[rows.length] !== row) {
      unchanged = false
    }
    rows.push(row)
  }

  for (const job of mediaJobs) {
    const row = cachedRow({
      item: job,
      key: `media:${job.id}`,
      byItem: MEDIA_ROW_BY_ITEM,
      byKey: MEDIA_ROWS_BY_KEY,
      same: sameMedia,
      entryOf: mediaEntryOf,
      build: mediaJobToRow
    })
    if (unchanged && previousRows !== null && previousRows[rows.length] !== row) {
      unchanged = false
    }
    rows.push(row)
  }

  if (unchanged && previousRows !== null) return previousRows
  previousRows = rows
  return rows
}

/**
 * Lower-case haystack for a row, built once per row object.
 *
 * Filtering runs on every snapshot and every keystroke, so rebuilding four
 * lower-case strings for each of 10,000 rows dominated the cost. Rows are
 * immutable per snapshot, which makes a WeakMap keyed on object identity safe:
 * a row that is replaced by a newer snapshot gets a fresh key, and rows that
 * are dropped are collected with the map entry.
 */
const SEARCH_KEYS = new WeakMap<UnifiedRow, string>()

/** Separator that cannot appear in a title or URL, so fields never merge. */
const SEARCH_KEY_SEPARATOR = '\u0000'

export function searchKeyFor(row: UnifiedRow): string {
  const cached = SEARCH_KEYS.get(row)
  if (cached !== undefined) return cached
  const key = [row.title, row.url, row.host, row.subtitle]
    .map((field) => (field === null ? '' : field.toLowerCase()))
    .join(SEARCH_KEY_SEPARATOR)
  SEARCH_KEYS.set(row, key)
  return key
}

export function matchesSearch(row: UnifiedRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return searchKeyFor(row).includes(needle)
}

export interface RowFilter {
  category: CategoryId
  status: StatusFilterId
  query: string
}

/**
 * The status bucket a row belongs to in the filter chips. A download that is
 * waiting for an automatic retry still carries status 'error', but it is not a
 * hard failure: it is counted and filtered with the queued rows instead.
 */
export function rowStatusGroup(row: UnifiedRow): RowStatusGroup {
  if (row.retryAt !== null) return 'queued'
  return row.statusGroup
}

/**
 * Whole seconds left before a pending automatic retry, clamped at zero.
 * Returns null when the row has no scheduled retry.
 */
export function retrySecondsLeft(
  retryAt: number | null,
  now: number
): number | null {
  if (retryAt === null || !Number.isFinite(retryAt)) return null
  return Math.max(0, Math.ceil((retryAt - now) / 1_000))
}

/**
 * Whether a row's rendered text depends on the ticking clock. Only a pending
 * automatic retry counts down, so every other row can be rendered without the
 * once-per-second value and stays memoised.
 */
export function needsRetryClock(row: UnifiedRow): boolean {
  return row.retryAt !== null && Number.isFinite(row.retryAt)
}

/** "Retrying in Ns…" text, or "Retrying now…" once the deadline has passed. */
export function retryCountdownText(
  retryAt: number | null,
  now: number
): string | null {
  const seconds = retrySecondsLeft(retryAt, now)
  if (seconds === null) return null
  return seconds > 0 ? `Retrying in ${seconds}s…` : 'Retrying now…'
}

export function filterRows(
  rows: readonly UnifiedRow[],
  filter: RowFilter
): UnifiedRow[] {
  return rows.filter((row) => {
    if (filter.category !== 'all' && row.category !== filter.category) {
      return false
    }
    if (filter.status !== 'all' && rowStatusGroup(row) !== filter.status) {
      return false
    }
    return matchesSearch(row, filter.query)
  })
}

export function categoryCounts(
  rows: readonly UnifiedRow[]
): Record<CategoryId, number> {
  const counts: Record<CategoryId, number> = {
    all: rows.length,
    video: 0,
    audio: 0,
    documents: 0,
    programs: 0,
    compressed: 0,
    other: 0
  }
  for (const row of rows) counts[row.category] += 1
  return counts
}

/**
 * Status counts are scoped to the current category and search text so the
 * numbers always add up to the list the user is looking at.
 */
export function statusCounts(
  rows: readonly UnifiedRow[],
  category: CategoryId,
  query: string
): Record<StatusFilterId, number> {
  const counts: Record<StatusFilterId, number> = {
    all: 0,
    active: 0,
    queued: 0,
    completed: 0,
    failed: 0
  }
  for (const row of rows) {
    if (category !== 'all' && row.category !== category) continue
    if (!matchesSearch(row, query)) continue
    counts.all += 1
    counts[rowStatusGroup(row)] += 1
  }
  return counts
}

/**
 * Collators are expensive to construct, and sorting 10,000 rows calls
 * `compare` tens of thousands of times. Build them once per process instead of
 * once per comparison (the old `localeCompare` path did an implicit lookup).
 */
const NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true
})
const LABEL_COLLATOR = new Intl.Collator()

const STATUS_SORT_ORDER: Record<RowStatusGroup, number> = {
  active: 0,
  queued: 1,
  failed: 2,
  completed: 3
}

export function sortRows(
  rows: readonly UnifiedRow[],
  key: SortKey,
  direction: SortDirection
): UnifiedRow[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    let comparison = 0
    switch (key) {
      case 'date':
        comparison = left.createdAt - right.createdAt
        break
      case 'name':
        comparison = NAME_COLLATOR.compare(left.title, right.title)
        break
      case 'size':
        comparison =
          (left.sizeBytes ?? left.completedBytes) -
          (right.sizeBytes ?? right.completedBytes)
        break
      case 'progress':
        comparison = left.progress - right.progress
        break
      case 'status':
        comparison =
          STATUS_SORT_ORDER[left.statusGroup] -
          STATUS_SORT_ORDER[right.statusGroup]
        if (comparison === 0) {
          comparison = LABEL_COLLATOR.compare(left.statusLabel, right.statusLabel)
        }
        break
    }
    if (comparison !== 0) return comparison * factor
    // Newest first is a stable tie-breaker for every key.
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    return left.key.localeCompare(right.key)
  })
}

/** Rows that are transferring bytes right now (paused is not counted). */
export function isRunningRow(row: UnifiedRow): boolean {
  if (row.source === 'download') {
    return row.download?.status === 'active'
  }
  return (
    row.media?.status === 'analyzing' ||
    row.media?.status === 'downloading' ||
    row.media?.status === 'merging'
  )
}

export function totalSpeed(rows: readonly UnifiedRow[]): number {
  return rows.reduce((sum, row) => (isRunningRow(row) ? sum + row.speedBps : sum), 0)
}

export function runningCount(rows: readonly UnifiedRow[]): number {
  return rows.reduce((count, row) => (isRunningRow(row) ? count + 1 : count), 0)
}
