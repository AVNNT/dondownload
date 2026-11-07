import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Batch, BatchItemRecord, BatchRecord } from '../src/shared/batches'
import type { MediaJob, MediaJobRecord } from '../src/shared/media'
import {
  DAY_MS,
  HISTORY_CLEANUP_INTERVAL_MS,
  HISTORY_CLEANUP_STARTUP_DELAY_MS,
  HistoryCleanupService,
  selectExpiredHistory,
  type HistoryCleanupBatchesPort,
  type HistoryCleanupDownloadsPort,
  type HistoryCleanupMediaPort
} from '../src/main/history/cleanup'
import { openDownloadDatabase } from '../src/main/db/database'
import { defaultDownloadSettings } from '../src/shared/settings'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const OLD = NOW - 31 * DAY_MS
const CUTOFF = NOW - 30 * DAY_MS

const tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function download(
  overrides: Partial<DownloadItem> = {}
): DownloadItem {
  return {
    id: 'download-1',
    gid: 'gid-download-1',
    url: 'https://example.com/file.bin',
    filename: 'file.bin',
    dir: 'C:\\Downloads',
    filePath: null,
    status: 'complete',
    totalBytes: 10,
    completedBytes: 10,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: OLD,
    updatedAt: OLD,
    completedAt: OLD,
    ...overrides
  }
}

function mediaJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: 'media-1',
    analysisId: 'analysis-1',
    optionId: 'option-1',
    kind: 'video',
    title: 'Clip',
    label: '720p',
    status: 'complete',
    completedBytes: 10,
    totalBytes: 10,
    speedBps: 0,
    errorMessage: null,
    createdAt: OLD,
    updatedAt: OLD,
    completedAt: OLD,
    ...overrides
  }
}

function batchItem(
  id: string,
  childId: string | null,
  status: Batch['items'][number]['status'] = 'complete'
): Batch['items'][number] {
  return {
    id,
    batchId: 'batch-1',
    position: 0,
    kind: 'download',
    status,
    title: 'Item',
    label: 'Direct',
    childId,
    completedBytes: 10,
    totalBytes: 10,
    errorMessage: null,
    createdAt: OLD,
    updatedAt: OLD,
    completedAt: status === 'queued' || status === 'running' ? null : OLD
  }
}

function batch(
  overrides: Partial<Batch> = {},
  items: Batch['items'] = []
): Batch {
  return {
    id: 'batch-1',
    kind: 'direct-urls',
    title: 'Batch',
    status: 'complete',
    progress: {
      totalItems: items.length,
      completedItems: items.length,
      failedItems: 0,
      skippedItems: 0,
      completedBytes: 0,
      totalBytes: null
    },
    errorMessage: null,
    createdAt: OLD,
    updatedAt: OLD,
    completedAt: OLD,
    items,
    ...overrides
  }
}

function downloadsPort(initial: DownloadItem[]): HistoryCleanupDownloadsPort & {
  items: DownloadItem[]
} {
  const state = { items: [...initial] }
  return {
    get items() {
      return state.items
    },
    getSnapshot: (): AppSnapshot => ({
      aria2: {
        status: 'stopped',
        version: null,
        binaryPath: null,
        message: null,
        hint: null
      },
      downloads: state.items
    }),
    forgetHistoryEntries: (ids: readonly string[]) => {
      state.items = state.items.filter((item) => !ids.includes(item.id))
    }
  }
}

function mediaPort(initial: MediaJob[]): HistoryCleanupMediaPort & {
  jobs: MediaJob[]
} {
  const state = { jobs: [...initial] }
  return {
    get jobs() {
      return state.jobs
    },
    getMediaSnapshot: () => ({
      tool: {
        status: 'stopped',
        version: null,
        message: null,
        hint: null
      },
      jobs: state.jobs
    }),
    forgetHistoryEntries: (ids: readonly string[]) => {
      state.jobs = state.jobs.filter((job) => !ids.includes(job.id))
    }
  }
}

function batchPort(initial: Batch[]): HistoryCleanupBatchesPort & {
  batches: Batch[]
} {
  const state = { batches: [...initial] }
  return {
    get batches() {
      return state.batches
    },
    getBatchSnapshot: () => ({ batches: state.batches }),
    forgetHistoryEntries: (ids: readonly string[]) => {
      state.batches = state.batches.filter((item) => !ids.includes(item.id))
    }
  }
}

describe('history cleanup eligibility', () => {
  it('selects only terminal download states without a pending retry', () => {
    const selection = selectExpiredHistory({
      cutoff: CUTOFF,
      mediaJobs: [],
      batches: [],
      downloads: [
        download({ id: 'complete' }),
        download({ id: 'error', status: 'error', completedAt: null }),
        download({ id: 'interrupted', status: 'interrupted' }),
        download({ id: 'queued', status: 'queued' }),
        download({ id: 'active', status: 'active' }),
        download({ id: 'waiting', status: 'waiting' }),
        download({ id: 'paused', status: 'paused' }),
        download({
          id: 'retrying',
          status: 'error',
          retryAt: NOW + 60_000
        })
      ]
    })

    expect(selection.downloadIds).toEqual([
      'complete',
      'error',
      'interrupted'
    ])
  })

  it('selects only terminal media states', () => {
    const selection = selectExpiredHistory({
      cutoff: CUTOFF,
      downloads: [],
      batches: [],
      mediaJobs: [
        mediaJob({ id: 'complete' }),
        mediaJob({ id: 'error', status: 'error' }),
        mediaJob({ id: 'cancelled', status: 'cancelled' }),
        mediaJob({ id: 'interrupted', status: 'interrupted' }),
        mediaJob({ id: 'queued', status: 'queued' }),
        mediaJob({ id: 'analyzing', status: 'analyzing' }),
        mediaJob({ id: 'downloading', status: 'downloading' }),
        mediaJob({ id: 'merging', status: 'merging' }),
        mediaJob({ id: 'paused', status: 'paused' })
      ]
    })

    expect(selection.mediaJobIds).toEqual([
      'complete',
      'error',
      'cancelled',
      'interrupted'
    ])
  })

  it('keeps a row finished exactly at the cutoff and removes one just older', () => {
    const selection = selectExpiredHistory({
      cutoff: CUTOFF,
      mediaJobs: [mediaJob({ id: 'exact', completedAt: CUTOFF, updatedAt: CUTOFF })],
      batches: [],
      downloads: [
        download({ id: 'older', completedAt: CUTOFF - 1, updatedAt: CUTOFF - 1 }),
        download({ id: 'exact', completedAt: CUTOFF, updatedAt: CUTOFF })
      ]
    })

    expect(selection.downloadIds).toEqual(['older'])
    expect(selection.mediaJobIds).toEqual([])
  })

  it('never removes children of a batch that still has unfinished items', () => {
    const selection = selectExpiredHistory({
      cutoff: CUTOFF,
      mediaJobs: [mediaJob({ id: 'media-child' })],
      batches: [
        batch({ status: 'running', completedAt: null }, [
          batchItem('item-1', 'download-child', 'running'),
          batchItem('item-2', 'media-child', 'complete')
        ])
      ],
      downloads: [
        download({ id: 'download-child' }),
        download({ id: 'standalone' })
      ]
    })

    expect(selection.downloadIds).toEqual(['standalone'])
    expect(selection.mediaJobIds).toEqual([])
    // The unfinished parent itself is kept.
    expect(selection.batchIds).toEqual([])
  })

  it('removes finished batches with only terminal items, but not before the cutoff', () => {
    const selection = selectExpiredHistory({
      cutoff: CUTOFF,
      downloads: [],
      mediaJobs: [],
      batches: [
        batch({ id: 'finished-old' }, [batchItem('a', null, 'complete')]),
        batch(
          { id: 'finished-exact', completedAt: CUTOFF, updatedAt: CUTOFF },
          [batchItem('b', null, 'error')]
        ),
        batch({ id: 'has-queued' }, [batchItem('c', null, 'queued')])
      ]
    })

    expect(selection.batchIds).toEqual(['finished-old'])
  })
})

describe('HistoryCleanupService', () => {
  it('does nothing when the setting is Never', () => {
    const downloads = downloadsPort([download()])
    const media = mediaPort([mediaJob()])
    const batches = batchPort([batch()])
    const store = { deleteHistoryEntries: vi.fn() }
    const service = new HistoryCleanupService({
      downloads,
      mediaJobs: media,
      batches,
      store,
      settings: () => ({
        ...defaultDownloadSettings(),
        historyRetentionDays: 0
      }),
      now: () => NOW
    })

    expect(service.runNow()).toEqual({
      downloadIds: [],
      mediaJobIds: [],
      batchIds: []
    })
    expect(store.deleteHistoryEntries).not.toHaveBeenCalled()
    expect(downloads.items).toHaveLength(1)
    expect(media.jobs).toHaveLength(1)
    expect(batches.batches).toHaveLength(1)
  })

  it('runs 30 seconds after start, then every six hours, until stopped', () => {
    vi.useFakeTimers()
    const service = new HistoryCleanupService({
      downloads: downloadsPort([]),
      settings: () => ({
        ...defaultDownloadSettings(),
        historyRetentionDays: 7
      }),
      now: () => NOW
    })
    const run = vi.spyOn(service, 'runNow')

    service.start()
    vi.advanceTimersByTime(HISTORY_CLEANUP_STARTUP_DELAY_MS - 1)
    expect(run).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(HISTORY_CLEANUP_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(2)

    service.stop()
    vi.advanceTimersByTime(HISTORY_CLEANUP_INTERVAL_MS * 2)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('removes old rows in one store call and keeps files on disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-cleanup-'))
    tempDirs.push(dir)
    const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))

    const oldFilePath = path.join(dir, 'old.bin')
    const oldMediaPath = path.join(dir, 'old.mp4')
    const activeFilePath = path.join(dir, 'active.bin')
    await writeFile(oldFilePath, 'old')
    await writeFile(oldMediaPath, 'media')
    await writeFile(activeFilePath, 'active')

    const oldDownload = download({
      id: 'download-old',
      filePath: oldFilePath,
      dir
    })
    const activeDownload = download({
      id: 'download-active',
      status: 'active',
      filePath: activeFilePath,
      dir,
      completedAt: null
    })
    const protectedDownload = download({
      id: 'download-protected',
      filePath: path.join(dir, 'protected.bin'),
      dir
    })
    await writeFile(path.join(dir, 'protected.bin'), 'protected')

    database.save({ record: oldDownload, explicitFilename: null })
    database.save({ record: activeDownload, explicitFilename: null })
    database.save({ record: protectedDownload, explicitFilename: null })

    const mediaRecord: MediaJobRecord = {
      id: 'media-old',
      sourceUrl: 'https://example.com/watch',
      analysisId: 'analysis-1',
      optionId: 'option-1',
      kind: 'video',
      title: 'Clip',
      label: '720p',
      status: 'complete',
      completedBytes: 10,
      totalBytes: 10,
      errorMessage: null,
      dir,
      filePath: oldMediaPath,
      createdAt: OLD,
      updatedAt: OLD,
      completedAt: OLD
    }
    database.saveMediaJob(mediaRecord)

    const finishedBatch: BatchRecord = {
      id: 'batch-finished',
      kind: 'direct-urls',
      title: 'Finished',
      status: 'complete',
      sourceUrl: null,
      mediaQuality: null,
      maxBytesPerItem: null,
      errorMessage: null,
      createdAt: OLD,
      updatedAt: OLD,
      completedAt: OLD
    }
    const unfinishedBatch: BatchRecord = {
      ...finishedBatch,
      id: 'batch-unfinished',
      title: 'Unfinished',
      status: 'running',
      completedAt: null
    }
    const unfinishedItem: BatchItemRecord = {
      id: 'item-unfinished',
      batchId: 'batch-unfinished',
      position: 0,
      kind: 'download',
      status: 'running',
      childId: 'download-protected',
      title: 'Running',
      label: 'Direct',
      completedBytes: 0,
      totalBytes: null,
      errorMessage: null,
      sourceUrl: null,
      createdAt: OLD,
      updatedAt: OLD,
      completedAt: null
    }
    database.saveBatchWithItems(finishedBatch, [])
    database.saveBatchWithItems(unfinishedBatch, [unfinishedItem])

    const downloads = downloadsPort([
      oldDownload,
      activeDownload,
      protectedDownload
    ])
    const media = mediaPort([
      mediaJob({
        id: 'media-old'
      })
    ])
    const batches = batchPort([
      batch({ id: 'batch-finished' }),
      batch(
        { id: 'batch-unfinished', status: 'running', completedAt: null },
        [batchItem('item-unfinished', 'download-protected', 'running')]
      )
    ])

    const service = new HistoryCleanupService({
      downloads,
      mediaJobs: media,
      batches,
      store: database,
      settings: () => ({
        ...defaultDownloadSettings(),
        historyRetentionDays: 30
      }),
      now: () => NOW
    })

    const removed = service.runNow()
    expect(removed.downloadIds).toEqual(['download-old'])
    expect(removed.mediaJobIds).toEqual(['media-old'])
    expect(removed.batchIds).toEqual(['batch-finished'])

    // In-memory snapshots match the transaction.
    expect(downloads.items.map((item) => item.id)).toEqual([
      'download-active',
      'download-protected'
    ])
    expect(media.jobs).toHaveLength(0)
    expect(batches.batches.map((item) => item.id)).toEqual([
      'batch-unfinished'
    ])

    // The database rows are gone, in one transaction.
    expect(database.loadAll().map((entry) => entry.record.id)).toEqual([
      'download-active',
      'download-protected'
    ])
    expect(database.loadMediaJobs()).toHaveLength(0)
    expect(database.loadBatches().map((entry) => entry.record.id)).toEqual([
      'batch-unfinished'
    ])

    // Files were never touched.
    await expect(access(oldFilePath)).resolves.toBeUndefined()
    await expect(access(oldMediaPath)).resolves.toBeUndefined()
    await expect(access(activeFilePath)).resolves.toBeUndefined()
    await expect(access(path.join(dir, 'protected.bin'))).resolves.toBeUndefined()

    database.close()
  })
})
