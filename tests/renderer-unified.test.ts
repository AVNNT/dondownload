import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, AppSnapshot, DownloadItem } from '../src/shared/types'
import type { MediaJob, MediaSnapshot } from '../src/shared/media'
import {
  buildUnifiedRows,
  categoryCounts,
  categoryFromFilename,
  categoryFromMime,
  classifyCategory,
  downloadToRow,
  filterRows,
  isRunningRow,
  mediaJobToRow,
  retryCountdownText,
  retrySecondsLeft,
  rowStatusGroup,
  runningCount,
  sortRows,
  statusCounts,
  totalSpeed,
  type UnifiedRow
} from '../src/renderer/src/lib/unified'
import {
  EMPTY_SELECTION,
  jumpFocus,
  moveFocus,
  pruneSelection,
  selectAllRows,
  selectSingle,
  selectedRows,
  updateSelection
} from '../src/renderer/src/lib/selection'
import {
  buildContextActions,
  canAnalyzeAgainRow,
  canOpenRow,
  canPauseRow,
  canResumeRow,
  clearCompletedConfirmation,
  clearListConfirmation,
  executeActionPlan,
  executeBulkRemoval,
  isClearListRow,
  planBulkAction,
  planRowAction,
  removalIds,
  removeConfirmation,
  type ActionApi
} from '../src/renderer/src/lib/actions'
import {
  IDLE_DRAG_ORIGIN,
  extractDroppedUrl,
  isLikelyMediaUrl,
  reduceDragOrigin,
  routeDroppedUrl
} from '../src/renderer/src/lib/dnd'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)

function download(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'download-1',
    gid: 'gid-1',
    url: 'https://example.com/files/archive.zip',
    filename: 'archive.zip',
    dir: 'Downloads/DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 1_000,
    completedBytes: 250,
    speedBps: 100,
    etaSeconds: 8,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    completedAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 4,
    blockReason: null,
    ...overrides
  }
}

function mediaJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: 'media-1',
    analysisId: 'analysis-1',
    optionId: 'option-1',
    kind: 'video',
    title: 'Fixture video',
    label: '1080p · MP4',
    status: 'downloading',
    completedBytes: 50,
    totalBytes: 100,
    speedBps: 20,
    errorMessage: null,
    createdAt: NOW - 30_000,
    updatedAt: NOW - 500,
    completedAt: null,
    ...overrides
  }
}

function rowFor(overrides: Partial<DownloadItem> = {}): UnifiedRow {
  return downloadToRow(download(overrides))
}

function mediaRow(overrides: Partial<MediaJob> = {}): UnifiedRow {
  return mediaJobToRow(mediaJob(overrides))
}

function snapshotFixture(): AppSnapshot {
  return {
    aria2: {
      status: 'ready',
      version: 'test',
      binaryPath: null,
      message: null,
      hint: null
    },
    downloads: []
  }
}

function mediaFixture(): MediaSnapshot {
  return {
    tool: {
      status: 'ready',
      version: 'test',
      message: null,
      hint: null
    },
    jobs: []
  }
}

function fakeApi() {
  const snapshot = snapshotFixture()
  const media = mediaFixture()
  return {
    pauseDownload: vi.fn<ActionApi['pauseDownload']>(async () => ok(snapshot)),
    resumeDownload: vi.fn<ActionApi['resumeDownload']>(async () => ok(snapshot)),
    startDownloadNow: vi.fn<ActionApi['startDownloadNow']>(async () => ok(snapshot)),
    retryDownload: vi.fn<ActionApi['retryDownload']>(async () => ok(snapshot)),
    removeDownload: vi.fn<ActionApi['removeDownload']>(async () => ok(snapshot)),
    pauseMedia: vi.fn<ActionApi['pauseMedia']>(async () => ok(media)),
    resumeMedia: vi.fn<ActionApi['resumeMedia']>(async () => ok(media)),
    retryMedia: vi.fn<ActionApi['retryMedia']>(async () => ok(media)),
    removeMedia: vi.fn<ActionApi['removeMedia']>(async () => ok(media)),
    deleteDownloadFile: vi.fn<ActionApi['deleteDownloadFile']>(async () =>
      ok(snapshot)
    ),
    deleteMediaFile: vi.fn<ActionApi['deleteMediaFile']>(async () => ok(media)),
    openFile: vi.fn<ActionApi['openFile']>(async () => ok(null)),
    openMediaFile: vi.fn<ActionApi['openMediaFile']>(async () => ok(null)),
    showInFolder: vi.fn<ActionApi['showInFolder']>(async () => ok(null)),
    showMediaInFolder: vi.fn<ActionApi['showMediaInFolder']>(async () => ok(null))
  }
}

function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

describe('unified category classification', () => {
  it.each([
    ['movie.mkv', 'video'],
    ['track.flac', 'audio'],
    ['report.PDF', 'documents'],
    ['setup.exe', 'programs'],
    ['bundle.tar.gz', 'compressed'],
    ['README', 'other'],
    ['checksums', 'other']
  ] as const)('classifies %s as %s', (filename, expected) => {
    expect(categoryFromFilename(filename)).toBe(expected)
  })

  it('maps media jobs by declared kind and falls back to MIME/URL', () => {
    expect(classifyCategory({ source: 'media', kind: 'audio' })).toBe('audio')
    expect(classifyCategory({ source: 'media', kind: 'video' })).toBe('video')
    expect(
      classifyCategory({ source: 'download', filename: 'unknown', mime: 'video/mp4' })
    ).toBe('video')
    expect(
      classifyCategory({
        source: 'download',
        filename: 'unknown',
        url: 'https://example.com/file.7z'
      })
    ).toBe('compressed')
    expect(categoryFromMime('application/pdf')).toBe('documents')
    expect(categoryFromMime('application/zip')).toBe('compressed')
  })

  it('classifies preview fixtures and keeps media thumbnails optional', () => {
    const withThumb = mediaRow({ thumbnailUrl: 'https://example.com/thumb.jpg' })
    const withoutThumb = mediaRow({ thumbnailUrl: null })
    expect(withThumb.thumbnailUrl).toBe('https://example.com/thumb.jpg')
    expect(withoutThumb.thumbnailUrl).toBeNull()
    expect(withThumb.category).toBe('video')
  })
})

describe('unified row status projection', () => {
  it('keeps scheduled and allowed-hours states in the queued filter', () => {
    expect(
      rowFor({ status: 'waiting', blockReason: 'scheduled' }).statusLabel
    ).toBe('Scheduled')
    expect(
      rowFor({ status: 'waiting', blockReason: 'allowed-hours' }).statusLabel
    ).toBe('Allowed hours')
    expect(
      rowFor({ status: 'waiting', blockReason: 'scheduled' }).statusGroup
    ).toBe('queued')
  })

  it('shows merging and starting as active media work', () => {
    const merging = mediaRow({ status: 'merging' })
    expect(merging.statusLabel).toBe('Merging')
    expect(merging.statusGroup).toBe('active')
    expect(merging.indeterminate).toBe(true)

    const starting = mediaRow({
      status: 'downloading',
      completedBytes: 0,
      speedBps: 0,
      totalBytes: null
    })
    expect(starting.statusLabel).toBe('Starting')
    expect(starting.statusGroup).toBe('active')
  })

  it('treats paused downloads as in-progress but not as running speed', () => {
    const paused = rowFor({ status: 'paused', speedBps: 0 })
    expect(paused.statusGroup).toBe('active')
    expect(isRunningRow(paused)).toBe(false)
  })

  it('computes aggregate running count and speed across both sources', () => {
    const activeDownload = rowFor({ status: 'active', speedBps: 100 })
    const activeMedia = mediaRow({ status: 'downloading', speedBps: 40 })
    const paused = rowFor({ id: 'p', status: 'paused', speedBps: 0 })
    expect(runningCount([activeDownload, activeMedia, paused])).toBe(2)
    expect(totalSpeed([activeDownload, activeMedia, paused])).toBe(140)
  })
})

describe('search, filters and counts', () => {
  const rows = [
    rowFor({
      id: 'a',
      filename: 'movie.mp4',
      url: 'https://cdn.example.com/a',
      status: 'complete',
      completedAt: NOW
    }),
    rowFor({
      id: 'b',
      filename: 'report.pdf',
      url: 'https://files.example.org/b',
      status: 'complete',
      completedAt: NOW
    }),
    mediaRow({ id: 'c', title: 'Audio show', kind: 'audio', status: 'downloading' }),
    rowFor({ id: 'd', filename: 'broken.mp4', status: 'error' })
  ]

  it('matches name, URL and host case-insensitively', () => {
    expect(filterRows(rows, { category: 'all', status: 'all', query: 'MOVIE' })).toHaveLength(1)
    expect(
      filterRows(rows, { category: 'all', status: 'all', query: 'example.org' })
    ).toHaveLength(1)
    expect(
      filterRows(rows, { category: 'all', status: 'all', query: 'cdn.example.com' })
    ).toHaveLength(1)
  })

  it('combines category, status and search filters', () => {
    expect(
      filterRows(rows, { category: 'documents', status: 'completed', query: '' })
    ).toHaveLength(1)
    expect(
      filterRows(rows, { category: 'audio', status: 'active', query: 'audio' })
    ).toHaveLength(1)
    expect(
      filterRows(rows, { category: 'video', status: 'failed', query: '' })
    ).toHaveLength(1)
  })

  it('builds category and status counts scoped to category and search', () => {
    const categories = categoryCounts(rows)
    expect(categories).toMatchObject({
      all: 4,
      video: 2,
      audio: 1,
      documents: 1
    })
    const counts = statusCounts(rows, 'all', '')
    expect(counts).toEqual({ all: 4, active: 1, queued: 0, completed: 2, failed: 1 })
    const videoCounts = statusCounts(rows, 'video', '')
    expect(videoCounts).toEqual({ all: 2, active: 0, queued: 0, completed: 1, failed: 1 })
  })
})

describe('rows waiting for an automatic retry', () => {
  const retrying = rowFor({
    id: 'retrying',
    filename: 'retrying.mp4',
    status: 'error',
    errorMessage: 'Connection reset',
    retryAt: NOW + 8_000
  })
  const failed = rowFor({
    id: 'failed',
    filename: 'broken.mp4',
    status: 'error',
    errorMessage: 'Not found'
  })
  const rows = [retrying, failed]

  it('counts a pending retry as queued, not failed', () => {
    expect(rowStatusGroup(retrying)).toBe('queued')
    expect(rowStatusGroup(failed)).toBe('failed')
    expect(statusCounts(rows, 'all', '')).toEqual({
      all: 2,
      active: 0,
      queued: 1,
      completed: 0,
      failed: 1
    })
  })

  it('filters a pending retry out of Failed and into Queued', () => {
    expect(
      filterRows(rows, { category: 'all', status: 'failed', query: '' }).map(
        (row) => row.id
      )
    ).toEqual(['failed'])
    expect(
      filterRows(rows, { category: 'all', status: 'queued', query: '' }).map(
        (row) => row.id
      )
    ).toEqual(['retrying'])
  })

  it('derives a clamped retry countdown', () => {
    expect(retrySecondsLeft(NOW + 8_000, NOW)).toBe(8)
    expect(retrySecondsLeft(NOW + 8_100, NOW)).toBe(9)
    expect(retrySecondsLeft(NOW - 5_000, NOW)).toBe(0)
    expect(retrySecondsLeft(null, NOW)).toBeNull()
    expect(retryCountdownText(NOW + 8_000, NOW)).toBe('Retrying in 8s…')
    expect(retryCountdownText(NOW - 1_000, NOW)).toBe('Retrying now…')
    expect(retryCountdownText(null, NOW)).toBeNull()
  })

  it('keeps the status label and tone of a pending retry', () => {
    expect(retrying.statusLabel).toBe('Failed')
    expect(retrying.statusTone).toBe('failed')
  })
})

describe('sorting', () => {
  const rows = [
    rowFor({
      id: 'small',
      filename: 'b.zip',
      totalBytes: 100,
      completedBytes: 10,
      createdAt: 1
    }),
    rowFor({
      id: 'large',
      filename: 'a.zip',
      totalBytes: 900,
      completedBytes: 720,
      createdAt: 3
    }),
    rowFor({
      id: 'done',
      filename: 'c.zip',
      status: 'complete',
      totalBytes: 500,
      createdAt: 2
    })
  ]

  it('sorts by name, size, progress and date in both directions', () => {
    expect(sortRows(rows, 'name', 'asc').map((row) => row.title)).toEqual([
      'a.zip',
      'b.zip',
      'c.zip'
    ])
    expect(sortRows(rows, 'size', 'desc').map((row) => row.title)).toEqual([
      'a.zip',
      'c.zip',
      'b.zip'
    ])
    expect(sortRows(rows, 'progress', 'asc').map((row) => row.title)[0]).toBe('b.zip')
    expect(sortRows(rows, 'date', 'desc').map((row) => row.title)[0]).toBe('a.zip')
  })

  it('sorts status by active, queued, failed, completed', () => {
    const failed = rowFor({ id: 'failed', filename: 'd.zip', status: 'error' })
    const queued = rowFor({ id: 'queued', filename: 'e.zip', status: 'queued' })
    const sorted = sortRows([...rows, failed, queued], 'status', 'asc')
    expect(sorted.map((row) => row.statusGroup)).toEqual([
      'active',
      'active',
      'queued',
      'failed',
      'completed'
    ])
  })
})

describe('selection behaviour', () => {
  const rows = buildUnifiedRows(
    ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      download({
        id,
        filename: `${id}.zip`,
        createdAt: NOW - index * 1_000
      })
    ),
    []
  )
  const ordered = sortRows(rows, 'name', 'asc')

  it('selects one row, toggles with Ctrl and extends with Shift', () => {
    const single = selectSingle(ordered[1]!)
    expect(single.selected).toEqual([ordered[1]!.key])
    expect(single.anchor).toBe(ordered[1]!.key)

    const toggled = updateSelection(ordered, single, ordered[3]!.key, 'toggle')
    expect(toggled.selected).toEqual([ordered[1]!.key, ordered[3]!.key])

    const range = updateSelection(ordered, single, ordered[3]!.key, 'range')
    expect(range.selected).toEqual([
      ordered[1]!.key,
      ordered[2]!.key,
      ordered[3]!.key
    ])
    expect(range.anchor).toBe(ordered[1]!.key)
  })

  it('selects all, prunes hidden rows and returns ordered rows', () => {
    const all = selectAllRows(ordered)
    expect(all.selected).toHaveLength(5)
    expect(selectedRows(ordered, all)).toHaveLength(5)

    const pruned = pruneSelection(ordered.slice(0, 2), all)
    expect(pruned.selected).toEqual(ordered.slice(0, 2).map((row) => row.key))
    expect(pruned.anchor).toBe(ordered[0]!.key)
  })

  it('moves keyboard focus with clamping and Shift extension', () => {
    const first = moveFocus(ordered, EMPTY_SELECTION, null, 1, false)
    expect(first.focus).toBe(ordered[1]!.key)
    expect(first.selection.selected).toEqual([ordered[1]!.key])

    const last = jumpFocus(ordered, first.selection, 'end', false)
    expect(last.focus).toBe(ordered[4]!.key)

    const extended = moveFocus(ordered, first.selection, first.focus, 2, true)
    expect(extended.focus).toBe(ordered[3]!.key)
    expect(extended.selection.selected).toEqual(ordered.slice(1, 4).map((row) => row.key))
  })
})

describe('context menu and action plans', () => {
  const active = rowFor({ id: 'active', status: 'active' })
  const paused = rowFor({ id: 'paused', status: 'paused' })
  const complete = rowFor({
    id: 'complete',
    status: 'complete',
    filePath: 'Downloads/DonDownload/archive.zip',
    completedAt: NOW
  })
  const failed = rowFor({ id: 'failed', status: 'error' })
  const mediaComplete = mediaRow({ id: 'media-complete', status: 'complete' })
  const mediaFailed = mediaRow({ id: 'media-failed', status: 'error' })

  it('enables only applicable actions for the selection', () => {
    const single = buildContextActions([complete])
    expect(single.find((action) => action.id === 'open')?.enabled).toBe(true)
    expect(single.find((action) => action.id === 'copy-link')?.enabled).toBe(true)
    expect(single.find((action) => action.id === 'pause')?.enabled).toBe(false)

    const multi = buildContextActions([complete, failed])
    expect(multi.find((action) => action.id === 'open')?.enabled).toBe(false)
    expect(multi.find((action) => action.id === 'retry')?.enabled).toBe(true)
    expect(multi.find((action) => action.id === 'remove')?.label).toBe(
      'Remove selected'
    )
  })

  it('filters bulk pause/resume to compatible rows', () => {
    const rows = [active, paused, complete, failed]
    expect(planBulkAction('pause-all', rows).map((entry) => entry.row.id)).toEqual([
      'active'
    ])
    expect(planBulkAction('resume-all', rows).map((entry) => entry.row.id)).toEqual([
      'paused'
    ])
    expect(canPauseRow(active)).toBe(true)
    expect(canResumeRow(paused)).toBe(true)
    expect(canOpenRow(complete)).toBe(true)
    expect(canAnalyzeAgainRow(mediaFailed)).toBe(true)
  })

  it('maps context actions to the existing IPC methods', async () => {
    const api = fakeApi()

    await executeActionPlan(planRowAction('pause', [active, paused]), api)
    expect(api.pauseDownload).toHaveBeenCalledWith('active')
    expect(api.pauseDownload).toHaveBeenCalledTimes(1)

    await executeActionPlan(planRowAction('resume', [active, paused]), api)
    expect(api.resumeDownload).toHaveBeenCalledWith('paused')

    await executeActionPlan(planRowAction('retry', [failed]), api)
    expect(api.retryDownload).toHaveBeenCalledWith('failed')

    await executeActionPlan(
      planRowAction('remove', [failed, mediaFailed]),
      api
    )
    expect(api.removeDownload).toHaveBeenCalledWith('failed')
    expect(api.removeMedia).toHaveBeenCalledWith('media-failed')

    await executeActionPlan(planRowAction('open', [complete]), api)
    expect(api.openFile).toHaveBeenCalledWith('complete')
    await executeActionPlan(planRowAction('open', [mediaComplete]), api)
    expect(api.openMediaFile).toHaveBeenCalledWith('media-complete')

    await executeActionPlan(planRowAction('show-in-folder', [complete]), api)
    expect(api.showInFolder).toHaveBeenCalledWith('complete')

    await executeActionPlan(planRowAction('copy-link', [active, complete]), api)
  })

  it('routes failed media to the pinned retry IPC, with analyze-again kept as a fallback', async () => {
    const api = fakeApi()
    const retried = await executeActionPlan(
      planRowAction('retry', [mediaFailed, mediaComplete]),
      api
    )
    expect(retried.errors).toEqual([])
    expect(api.retryMedia).toHaveBeenCalledWith('media-failed')
    expect(api.retryDownload).not.toHaveBeenCalled()

    const plan = planRowAction('analyze-again', [mediaFailed, mediaComplete])
    const result = await executeActionPlan(plan, api)
    expect(result.analyzeAgain.map((row) => row.id)).toEqual(['media-failed'])
    expect(api.removeMedia).not.toHaveBeenCalled()
  })

  it('collects copy URLs and reports backend errors', async () => {
    const api = fakeApi()
    api.pauseDownload.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOPE', message: 'Could not pause.' }
    })
    const copied = await executeActionPlan(
      planRowAction('copy-link', [active, complete]),
      api
    )
    expect(copied.copyUrls).toEqual([active.url, complete.url])

    const failedAction = await executeActionPlan(planRowAction('pause', [active]), api)
    expect(failedAction.errors[0]?.code).toBe('NOPE')
  })

  it('clears only completed history entries and keeps file-safety copy', () => {
    const plan = planBulkAction('clear-completed', [
      active,
      complete,
      mediaComplete,
      mediaFailed
    ])
    expect(plan.map((entry) => entry.row.id)).toEqual(['complete', 'media-complete'])
    expect(plan.every((entry) => entry.action === 'remove')).toBe(true)

    const copy = clearCompletedConfirmation(plan.length)
    expect(copy.message).toContain('files stay on disk')
    expect(copy.confirmLabel).toBe('Clear completed')
    expect(removeConfirmation(2).title).toBe('Remove 2 items?')
  })

  it('clears every finished or dead entry and keeps in-flight rows', () => {
    const queued = rowFor({ id: 'queued', status: 'queued' })
    const waiting = rowFor({ id: 'waiting', status: 'waiting' })
    const mediaDownloading = mediaRow({ id: 'media-downloading' })
    const mediaMerging = mediaRow({ id: 'media-merging', status: 'merging' })
    const mediaPaused = mediaRow({ id: 'media-paused', status: 'paused' })
    const mediaCancelled = mediaRow({ id: 'media-cancelled', status: 'cancelled' })
    const interrupted = rowFor({ id: 'interrupted', status: 'interrupted' })

    const rows = [
      active,
      queued,
      waiting,
      paused,
      complete,
      failed,
      interrupted,
      mediaDownloading,
      mediaMerging,
      mediaPaused,
      mediaComplete,
      mediaFailed,
      mediaCancelled
    ]

    const plan = planBulkAction('clear-list', rows)

    expect(plan.map((entry) => entry.row.id)).toEqual([
      'complete',
      'failed',
      'interrupted',
      'media-complete',
      'media-failed',
      'media-cancelled'
    ])
    expect(plan.every((entry) => entry.action === 'remove')).toBe(true)
    // Rows the user can still watch, pause or resume are never cleared.
    for (const kept of [
      active,
      queued,
      waiting,
      paused,
      mediaDownloading,
      mediaMerging,
      mediaPaused
    ]) {
      expect(isClearListRow(kept)).toBe(false)
    }

    const copy = clearListConfirmation(plan.length)
    expect(copy.title).toBe('Remove 6 entries from the list?')
    expect(copy.message).toContain('Files on disk are kept')
    expect(copy.confirmLabel).toBe('Clear list')
    expect(clearListConfirmation(1).title).toBe('Remove 1 entry from the list?')
  })

  it('commits a clear-list plan through one bulk call per source', async () => {
    const plan = planBulkAction('clear-list', [
      complete,
      failed,
      mediaComplete,
      active
    ])
    expect(removalIds(plan)).toEqual({
      downloadIds: ['complete', 'failed'],
      mediaIds: ['media-complete']
    })

    const api = {
      removeDownloads: vi.fn(async () => ok(snapshotFixture())),
      removeMediaJobs: vi.fn(async () => ok(mediaFixture()))
    }
    const result = await executeBulkRemoval(plan, api)

    expect(result.errors).toEqual([])
    expect(api.removeDownloads).toHaveBeenCalledTimes(1)
    expect(api.removeDownloads).toHaveBeenCalledWith(['complete', 'failed'])
    expect(api.removeMediaJobs).toHaveBeenCalledTimes(1)
    expect(api.removeMediaJobs).toHaveBeenCalledWith(['media-complete'])
  })

  it('reports a failed bulk removal instead of throwing', async () => {
    const plan = planBulkAction('clear-list', [complete])
    const api = {
      removeDownloads: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'DB_BUSY', message: 'Could not remove download history.' }
      })),
      removeMediaJobs: vi.fn(async () => ok(mediaFixture()))
    }

    const result = await executeBulkRemoval(plan, api)
    expect(result.errors.map((error) => error.code)).toEqual(['DB_BUSY'])
    // No media ids in the plan: the media channel is never called.
    expect(api.removeMediaJobs).not.toHaveBeenCalled()
  })
})

describe('drag and drop routing', () => {
  it('extracts the first URL from uri-list and plain text', () => {
    expect(
      extractDroppedUrl({
        uriList: '# comment\r\nhttps://example.com/file.zip\r\nhttps://example.com/two'
      })
    ).toBe('https://example.com/file.zip')
    expect(
      extractDroppedUrl({ text: '  check this https://example.com/a.bin, thanks ' })
    ).toBe('https://example.com/a.bin')
    expect(extractDroppedUrl({ text: 'no link here' })).toBeNull()
  })

  it('rejects SVG data URIs from uri-list and plain text', () => {
    const dataUri =
      'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E'
    expect(extractDroppedUrl({ uriList: dataUri })).toBeNull()
    expect(extractDroppedUrl({ text: dataUri })).toBeNull()
    expect(
      extractDroppedUrl({
        uriList: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></svg>'
      })
    ).toBeNull()
  })

  it('rejects raw SVG markup text', () => {
    expect(
      extractDroppedUrl({
        text: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>'
      })
    ).toBeNull()
    expect(
      extractDroppedUrl({ text: '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>' })
    ).toBeNull()
  })

  it('ignores non-web schemes and markup, including data/blob/file/about', () => {
    for (const value of [
      'blob:https://example.com/1234',
      'file:///C:/secret.zip',
      'javascript:alert(1)',
      'about:blank'
    ]) {
      expect(extractDroppedUrl({ uriList: value })).toBeNull()
      expect(extractDroppedUrl({ text: value })).toBeNull()
    }
  })

  it('extracts an HTTP URL that is the whole uri-list line or plain text', () => {
    expect(
      extractDroppedUrl({ uriList: '  https://example.com/file.zip  \r\n' })
    ).toBe('https://example.com/file.zip')
    expect(extractDroppedUrl({ text: 'https://example.com/file.zip' })).toBe(
      'https://example.com/file.zip'
    )
    expect(
      extractDroppedUrl({ text: 'check this https://example.com/file.zip out' })
    ).toBe('https://example.com/file.zip')
  })

  it('rejects a uri-list line that only contains a URL mid-string', () => {
    expect(
      extractDroppedUrl({ uriList: 'see https://example.com/file.zip for details' })
    ).toBeNull()
    expect(
      extractDroppedUrl({ uriList: 'note: https://example.com/file.zip' })
    ).toBeNull()
  })

  it('tracks internal drags so window drops can ignore them', () => {
    let state = IDLE_DRAG_ORIGIN
    expect(state.internal).toBe(false)

    state = reduceDragOrigin(state, 'dragstart')
    expect(state.internal).toBe(true)

    // External drops are unaffected while no internal drag is in flight.
    expect(IDLE_DRAG_ORIGIN.internal).toBe(false)

    state = reduceDragOrigin(state, 'drop')
    expect(state.internal).toBe(false)

    state = reduceDragOrigin(reduceDragOrigin(state, 'dragstart'), 'dragend')
    expect(state.internal).toBe(false)
  })

  it('routes known media pages to the analyzer and direct files to Quick Add', () => {
    expect(isLikelyMediaUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isLikelyMediaUrl('https://vimeo.com/123456')).toBe(true)
    expect(isLikelyMediaUrl('https://example.com/file.zip')).toBe(false)

    expect(routeDroppedUrl('https://youtu.be/abc')).toEqual({
      target: 'media',
      url: 'https://youtu.be/abc'
    })
    expect(routeDroppedUrl('https://cdn.example.com/file.zip')?.target).toBe(
      'direct'
    )
    expect(routeDroppedUrl('file:///secret')).toBeNull()
  })
})
