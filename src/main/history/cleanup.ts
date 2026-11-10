import {
  isActiveBatchItemStatus,
  isActiveBatchStatus,
  type Batch
} from '@shared/batches'
import type { MediaJob, MediaSnapshot } from '@shared/media'
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  isHistoryRetentionDays,
  type DownloadSettings
} from '@shared/settings'
import type { AppSnapshot, DownloadItem } from '@shared/types'

/**
 * Automatic history cleanup.
 *
 * Finished download/media rows and empty finished batches are removed from the
 * list after the configured retention window. Files on disk are NEVER touched:
 * this module only chooses row ids, and the managers/Database remove rows with
 * exactly the same "remove from list" behavior as the manual actions.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/** Delayed so first paint and startup work are never blocked. */
export const HISTORY_CLEANUP_STARTUP_DELAY_MS = 30_000
export const HISTORY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Download statuses that are finished and can age out of the list. `error`,
 * `cancelled` and `interrupted` are included only when no automatic retry is
 * pending (checked separately). Active/queued/waiting/paused rows are never
 * selected.
 */
const TERMINAL_DOWNLOAD_STATUSES: ReadonlySet<DownloadItem['status']> =
  new Set<DownloadItem['status']>([
    'complete',
    'error',
    'cancelled',
    'interrupted'
  ])

/** Media job statuses that are finished and can age out of the list. */
const TERMINAL_MEDIA_STATUSES: ReadonlySet<MediaJob['status']> =
  new Set<MediaJob['status']>([
    'complete',
    'error',
    'cancelled',
    'interrupted'
  ])

/** Row ids removed by one shared history-cleanup transaction. */
export interface HistoryCleanupDeletion {
  downloadIds: readonly string[]
  mediaJobIds: readonly string[]
  batchIds: readonly string[]
}

export interface HistoryCleanupSelection extends HistoryCleanupDeletion {
  downloadIds: string[]
  mediaJobIds: string[]
  batchIds: string[]
}

export interface HistoryCleanupSelectionInput {
  /** Rows finished before this epoch-ms value are eligible. */
  cutoff: number
  downloads: readonly DownloadItem[]
  mediaJobs: readonly MediaJob[]
  batches: readonly Batch[]
}

function finishedAt(
  completedAt: number | null,
  updatedAt: number
): number {
  return completedAt ?? updatedAt
}

function emptySelection(): HistoryCleanupSelection {
  return { downloadIds: [], mediaJobIds: [], batchIds: [] }
}

/**
 * Strictly older than the cutoff: a row finished exactly at the cutoff stays.
 * Retrying downloads are excluded because their automatic retry is still live.
 */
function isExpired(
  completedAt: number | null,
  updatedAt: number,
  cutoff: number
): boolean {
  return finishedAt(completedAt, updatedAt) < cutoff
}

function hasUnfinishedItems(batch: Batch): boolean {
  return (
    isActiveBatchStatus(batch.status) ||
    batch.items.some((item) => isActiveBatchItemStatus(item.status))
  )
}

/**
 * Pure eligibility rule shared by the service and its tests.
 *
 * - A finished batch with unfinished children protects those child ids, so a
 *   completed row is kept while its batch is still working.
 * - A batch itself is removed only when every item is terminal and the batch's
 *   finished time is older than the cutoff.
 */
export function selectExpiredHistory(
  input: HistoryCleanupSelectionInput
): HistoryCleanupSelection {
  const { cutoff, downloads, mediaJobs, batches } = input
  const selection = emptySelection()

  const protectedChildIds = new Set<string>()
  for (const batch of batches) {
    if (!hasUnfinishedItems(batch)) continue
    for (const item of batch.items) {
      if (item.childId !== null) protectedChildIds.add(item.childId)
    }
  }

  for (const download of downloads) {
    if (!TERMINAL_DOWNLOAD_STATUSES.has(download.status)) continue
    // A pending automatic retry is not finished history yet.
    if (download.retryAt !== null && download.retryAt !== undefined) continue
    if (protectedChildIds.has(download.id)) continue
    if (!isExpired(download.completedAt, download.updatedAt, cutoff)) continue
    selection.downloadIds.push(download.id)
  }

  for (const job of mediaJobs) {
    if (!TERMINAL_MEDIA_STATUSES.has(job.status)) continue
    if (protectedChildIds.has(job.id)) continue
    if (!isExpired(job.completedAt, job.updatedAt, cutoff)) continue
    selection.mediaJobIds.push(job.id)
  }

  for (const batch of batches) {
    if (hasUnfinishedItems(batch)) continue
    if (!isExpired(batch.completedAt, batch.updatedAt, cutoff)) continue
    selection.batchIds.push(batch.id)
  }

  return selection
}

export interface HistoryCleanupDownloadsPort {
  getSnapshot(): AppSnapshot
  /** Drop rows already removed by the shared cleanup transaction. */
  forgetHistoryEntries(ids: readonly string[]): void
}

export interface HistoryCleanupMediaPort {
  getMediaSnapshot(): MediaSnapshot
  forgetHistoryEntries(ids: readonly string[]): void
}

export interface HistoryCleanupBatchesPort {
  getBatchSnapshot(): { batches: readonly Batch[] }
  forgetHistoryEntries(ids: readonly string[]): void
}

/** One transaction for every list source; satisfied by `DownloadDatabase`. */
export interface HistoryCleanupStore {
  deleteHistoryEntries(input: HistoryCleanupDeletion): void
}

export interface HistoryCleanupOptions {
  downloads: HistoryCleanupDownloadsPort
  mediaJobs?: HistoryCleanupMediaPort | null
  batches?: HistoryCleanupBatchesPort | null
  store?: HistoryCleanupStore | null
  /** Always read fresh: a setting change takes effect on the next run. */
  settings: () => DownloadSettings
  now?: () => number
  startupDelayMs?: number
  intervalMs?: number
}

/**
 * Runs the cleanup once shortly after startup, then every six hours. The
 * settings manager also calls `runNow()` immediately after a committed change.
 */
export class HistoryCleanupService {
  private readonly downloads: HistoryCleanupDownloadsPort
  private readonly mediaJobs: HistoryCleanupMediaPort | null
  private readonly batches: HistoryCleanupBatchesPort | null
  private readonly store: HistoryCleanupStore | null
  private readonly settings: () => DownloadSettings
  private readonly now: () => number
  private readonly startupDelayMs: number
  private readonly intervalMs: number

  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(options: HistoryCleanupOptions) {
    this.downloads = options.downloads
    this.mediaJobs = options.mediaJobs ?? null
    this.batches = options.batches ?? null
    this.store = options.store ?? null
    this.settings = options.settings
    this.now = options.now ?? Date.now
    this.startupDelayMs =
      options.startupDelayMs ?? HISTORY_CLEANUP_STARTUP_DELAY_MS
    this.intervalMs = options.intervalMs ?? HISTORY_CLEANUP_INTERVAL_MS
  }

  start(): void {
    if (this.startupTimer !== null || this.intervalTimer !== null) return

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.runNow()
      this.intervalTimer = setInterval(() => {
        this.runNow()
      }, this.intervalMs)
      this.intervalTimer.unref?.()
    }, this.startupDelayMs)
    this.startupTimer.unref?.()
  }

  stop(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  /**
   * Run one sweep. "Never" (0) disables cleanup completely, including a manual
   * settings-triggered run. Any failure keeps the rows so a later run can retry.
   */
  runNow(): HistoryCleanupSelection {
    if (this.running) return emptySelection()

    const settings = this.settings()
    const days = isHistoryRetentionDays(settings.historyRetentionDays)
      ? settings.historyRetentionDays
      : DEFAULT_HISTORY_RETENTION_DAYS
    if (days === 0) return emptySelection()

    this.running = true
    try {
      const cutoff = this.now() - days * DAY_MS
      const selection = selectExpiredHistory({
        cutoff,
        downloads: this.downloads.getSnapshot().downloads,
        mediaJobs: this.mediaJobs?.getMediaSnapshot().jobs ?? [],
        batches: this.batches?.getBatchSnapshot().batches ?? []
      })

      if (
        selection.downloadIds.length === 0 &&
        selection.mediaJobIds.length === 0 &&
        selection.batchIds.length === 0
      ) {
        return selection
      }

      if (this.store) {
        try {
          this.store.deleteHistoryEntries(selection)
        } catch {
          // Keep both the rows and the in-memory list when persistence fails.
          console.error('Old history entries could not be removed.')
          return emptySelection()
        }
      }

      if (selection.downloadIds.length > 0) {
        this.downloads.forgetHistoryEntries(selection.downloadIds)
      }
      if (selection.mediaJobIds.length > 0) {
        this.mediaJobs?.forgetHistoryEntries(selection.mediaJobIds)
      }
      if (selection.batchIds.length > 0) {
        this.batches?.forgetHistoryEntries(selection.batchIds)
      }
      return selection
    } finally {
      this.running = false
    }
  }
}
