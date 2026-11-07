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
  return {
    key: `download:${item.id}`,
    id: item.id,
    source: 'download',
    title: item.filename,
    subtitle: hostnameOf(item.url) ?? item.url,
    url: item.url,
    host: hostnameOf(item.url),
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

export function buildUnifiedRows(
  downloads: readonly DownloadItem[],
  mediaJobs: readonly MediaJob[]
): UnifiedRow[] {
  return [
    ...downloads.map(downloadToRow),
    ...mediaJobs.map(mediaJobToRow)
  ]
}

export function matchesSearch(row: UnifiedRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  const fields = [row.title, row.url, row.host, row.subtitle]
  return fields.some(
    (field) => field !== null && field.toLowerCase().includes(needle)
  )
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
        comparison = left.title.localeCompare(right.title, undefined, {
          sensitivity: 'base',
          numeric: true
        })
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
          comparison = left.statusLabel.localeCompare(right.statusLabel)
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
