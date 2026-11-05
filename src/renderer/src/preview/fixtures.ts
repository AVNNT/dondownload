import type {
  AnalyzeCollectionInput,
  Batch,
  BatchItem,
  BatchItemTargetInput,
  BatchMediaQuality,
  BatchTargetInput,
  CollectionPreview,
  CollectionSelectionAvailability,
  CreateCollectionBatchInput
} from '@shared/batches'
import { summarizeBatchItems } from '@shared/batches'
import type {
  AnalyzeMediaInput,
  MediaAnalysis,
  MediaFormatOption,
  MediaJob,
  MediaQueueInput,
  MediaSnapshot
} from '@shared/media'
import { normalizeMediaSourceUrl } from '@shared/media'
import type { DownloadSettings } from '@shared/settings'
import { parseDownloadSettings } from '@shared/settings'
import {
  defaultMediaToolSettings,
  type MediaToolSettings
} from '@shared/mediaTools'
import type {
  AddDownloadInput,
  ApiResult,
  AppSnapshot,
  DonDownloadApi,
  DownloadItem,
  SmartBatchSubmitEntry,
  SmartBatchSubmitResult
} from '@shared/types'
import { normalizeHttpUrl } from '@shared/validation'

/**
 * Development-only fixtures for the browser preview at `/preview.html`.
 *
 * Every value is local to this module's closure: no IPC, filesystem, network or
 * Electron API is touched. Each `createPreviewApi()` call owns an isolated,
 * deterministic state (timestamps are derived from the injected clock) so a
 * reload starts the same demo again.
 */

const PREVIEW_ARIA2 = {
  status: 'ready' as const,
  version: '1.37.0-preview',
  binaryPath: null,
  message: null,
  hint: null
}

const PREVIEW_MEDIA_TOOL = {
  status: 'ready' as const,
  version: 'fixture',
  message: null,
  hint: null
}

const PREVIEW_ANALYSIS_EXPIRY_MS = 15 * 60_000
const PREVIEW_DUPLICATE_CODE = 'DUPLICATE_DOWNLOAD'
const PREVIEW_NOT_FOUND_CODE = 'PREVIEW_NOT_FOUND'
const PREVIEW_INVALID_INPUT_CODE = 'PREVIEW_INVALID_INPUT'

export interface PreviewClock {
  now?: () => number
}

/** Controls only the in-memory preview fixtures; never part of the preload API. */
export interface PreviewFixtureControls {
  advanceDownloadFixture: () => string
}

type Listener<T> = (value: T) => void

export function createPreviewApi(
  options: PreviewClock = {}
): DonDownloadApi & PreviewFixtureControls {
  const now = options.now ?? (() => Date.now())
  const anchor = now()

  let downloads = seedDownloads(anchor)
  let mediaJobs = seedMediaJobs(anchor)
  let batches = seedBatches(anchor)
  let settings = seedSettings()
  let mediaToolSettings: MediaToolSettings = defaultMediaToolSettings()

  const analyses = new Map<string, MediaAnalysis>()
  const previews = new Map<string, CollectionPreview>()
  let sequence = 0

  const downloadListeners = new Set<Listener<AppSnapshot>>()
  const mediaListeners = new Set<Listener<MediaSnapshot>>()
  const batchListeners = new Set<Listener<{ batches: Batch[] }>>()

  const nextId = (prefix: string): string => `${prefix}-${++sequence}`

  function downloadSnapshot(): AppSnapshot {
    return {
      aria2: { ...PREVIEW_ARIA2 },
      downloads: downloads.map(cloneDownload)
    }
  }

  function mediaSnapshot(): MediaSnapshot {
    return {
      tool: { ...PREVIEW_MEDIA_TOOL },
      jobs: mediaJobs.map(cloneMediaJob)
    }
  }

  function batchSnapshot(): { batches: Batch[] } {
    return { batches: batches.map(cloneBatch) }
  }

  function emitDownloads(): AppSnapshot {
    const snapshot = downloadSnapshot()
    for (const listener of downloadListeners) listener(snapshot)
    return snapshot
  }

  function emitMedia(): MediaSnapshot {
    const snapshot = mediaSnapshot()
    for (const listener of mediaListeners) listener(snapshot)
    return snapshot
  }

  function emitBatches(): { batches: Batch[] } {
    const snapshot = batchSnapshot()
    for (const listener of batchListeners) listener(snapshot)
    return snapshot
  }

  function findDownload(id: string): DownloadItem | undefined {
    return downloads.find((item) => item.id === id)
  }

  function findMediaJob(id: string): MediaJob | undefined {
    return mediaJobs.find((job) => job.id === id)
  }

  function findBatch(id: string): Batch | undefined {
    return batches.find((batch) => batch.id === id)
  }

  function analyzeMedia(input: AnalyzeMediaInput): ApiResult<MediaAnalysis> {
    let url: string
    try {
      url = normalizeMediaSourceUrl(input.url)
    } catch (error) {
      return fail(
        PREVIEW_INVALID_INPUT_CODE,
        error instanceof Error ? error.message : 'Enter a media page URL.'
      )
    }

    const analysis = seedAnalysis(nextId('preview-analysis'), url, now())
    analyses.set(analysis.analysisId, analysis)
    return ok(analysis)
  }

  function analyzeBatchCollection(
    input: AnalyzeCollectionInput
  ): ApiResult<CollectionPreview> {
    try {
      normalizeHttpUrl(input.url)
    } catch (error) {
      return fail(
        PREVIEW_INVALID_INPUT_CODE,
        error instanceof Error ? error.message : 'Enter a collection URL.'
      )
    }
    const preview = createCollectionPreview(nextId('preview-collection'))
    previews.set(preview.id, preview)
    return ok(preview)
  }

  function analyzeCollectionSelection(
    input: CreateCollectionBatchInput
  ): ApiResult<CollectionSelectionAvailability> {
    const preview = previews.get(input.previewId)
    if (!preview) {
      return fail(PREVIEW_NOT_FOUND_CODE, 'That collection preview has expired.')
    }

    const selected = new Set(input.selectedEntryIds)
    const entries = preview.entries
      .filter((entry) => selected.has(entry.id))
      .map((entry) => ({
        entryId: entry.id,
        title: entry.title,
        qualities: collectionQualities()
      }))

    return ok({ previewId: preview.id, entries })
  }

  function submitSmartBatch(input: {
    urls: string[]
  }): ApiResult<SmartBatchSubmitResult> {
    const entries: SmartBatchSubmitEntry[] = []
    const direct: Array<{ index: number; url: string }> = []
    const collectionPreviews: CollectionPreview[] = []

    input.urls.forEach((raw, index) => {
      let url: string
      try {
        url = normalizeHttpUrl(raw)
      } catch (error) {
        entries.push({
          index,
          outcome: 'invalid',
          batchId: null,
          itemId: null,
          previewId: null,
          code: PREVIEW_INVALID_INPUT_CODE,
          message:
            error instanceof Error ? error.message : 'Not a valid HTTP(S) URL.'
        })
        return
      }

      if (isCollectionUrl(url)) {
        const preview = createCollectionPreview(nextId('preview-collection'))
        previews.set(preview.id, preview)
        collectionPreviews.push(preview)
        entries.push({
          index,
          outcome: 'collection-preview',
          batchId: null,
          itemId: null,
          previewId: preview.id,
          code: null,
          message: 'Preview ready. Nothing is queued until you select items.'
        })
        return
      }

      if (/gofile\.io/i.test(url)) {
        entries.push({
          index,
          outcome: 'unsupported',
          batchId: null,
          itemId: null,
          previewId: null,
          code: 'GOFILE_BROWSER_REQUIRED',
          message: 'This fixture leaves Gofile handling to the real Electron app.'
        })
        return
      }

      direct.push({ index, url })
    })

    let batch: Batch | null = null
    if (direct.length > 0) {
      const batchId = nextId('preview-batch')
      const items = direct.map((entry, position) =>
        makeBatchItem({
          id: nextId('preview-item'),
          batchId,
          position,
          kind: 'download',
          status: 'queued',
          title: filenameOf(entry.url),
          label: hostnameOf(entry.url),
          childId: null,
          completedBytes: 0,
          totalBytes: null,
          errorMessage: null,
          createdAt: now(),
          updatedAt: now(),
          completedAt: null
        })
      )
      batch = finalizeBatch({
        id: batchId,
        kind: 'direct-urls',
        title: `Direct batch · ${direct.length} ${
          direct.length === 1 ? 'URL' : 'URLs'
        }`,
        status: 'queued',
        progress: summarizeBatchItems(items),
        errorMessage: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
        items
      })
      batches.unshift(batch)
      emitBatches()

      for (const entry of direct) {
        const item = items[direct.indexOf(entry)]
        entries.push({
          index: entry.index,
          outcome: 'batch-item',
          batchId,
          itemId: item?.id ?? null,
          previewId: null,
          code: null,
          message: 'Queued as a direct download item.'
        })
      }
    }

    entries.sort((left, right) => left.index - right.index)
    return ok({ batch, previews: collectionPreviews, entries })
  }

  function createCollectionBatch(
    input: CreateCollectionBatchInput
  ): ApiResult<Batch> {
    const preview = previews.get(input.previewId)
    if (!preview) {
      return fail(PREVIEW_NOT_FOUND_CODE, 'That collection preview has expired.')
    }

    const selected = new Set(input.selectedEntryIds)
    const selectedEntries = preview.entries.filter((entry) =>
      selected.has(entry.id)
    )
    if (selectedEntries.length === 0) {
      return fail(
        PREVIEW_INVALID_INPUT_CODE,
        'Select at least one available collection entry.'
      )
    }

    const batchId = nextId('preview-batch')
    const items = selectedEntries.map((entry, position) => {
      const available = entry.availability === 'available'
      const timestamp = now()
      return makeBatchItem({
        id: nextId('preview-item'),
        batchId,
        position,
        kind: 'media',
        status: available ? 'queued' : 'unavailable',
        title: entry.title,
        label: collectionItemLabel(preview, input.mediaQuality),
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: available
          ? null
          : (entry.errorReason ?? 'This entry is not available.'),
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: available ? null : timestamp
      })
    })
    const batch = finalizeBatch({
      id: batchId,
      kind: preview.kind === 'playlist' ? 'media-playlist' : 'pixeldrain-list',
      title: `${preview.title} · selected`,
      status: 'queued',
      progress: summarizeBatchItems(items),
      errorMessage: null,
      createdAt: now(),
      updatedAt: now(),
      completedAt: null,
      items
    })

    previews.delete(preview.id)
    batches.unshift(batch)
    emitBatches()
    return ok(cloneBatch(batch))
  }

  function runBatchItemAction(
    input: BatchItemTargetInput,
    action: (item: BatchItem) => boolean
  ): ApiResult<{ batches: Batch[] }> {
    const batch = findBatch(input.batchId)
    const item = batch?.items.find((candidate) => candidate.id === input.itemId)
    if (!batch || !item) {
      return fail(PREVIEW_NOT_FOUND_CODE, 'That batch item no longer exists.')
    }
    if (!action(item)) return ok(batchSnapshot())

    item.updatedAt = now()
    recomputeBatch(batch, now())
    return ok(emitBatches())
  }

  return {
    advanceDownloadFixture: () => {
      const item = downloads.find(
        (download) =>
          download.status === 'active' ||
          download.status === 'queued' ||
          (download.status === 'waiting' && download.blockReason === null)
      )
      if (!item) {
        return 'No active, queued or unblocked waiting fixture download is available.'
      }

      if (item.status === 'queued' || item.status === 'waiting') {
        item.status = 'active'
        item.blockReason = null
        item.completedBytes = Math.min(
          Math.max(item.totalBytes, 1),
          Math.max(item.completedBytes, Math.floor(item.totalBytes * 0.6))
        )
        item.speedBps = 2_400_000
        item.etaSeconds = item.totalBytes > 0
          ? Math.ceil((item.totalBytes - item.completedBytes) / item.speedBps)
          : null
        item.updatedAt = now()
        emitDownloads()
        return `Simulated progress: ${item.filename} is active.`
      }

      item.status = 'complete'
      item.completedBytes = item.totalBytes
      item.speedBps = 0
      item.etaSeconds = null
      item.completedAt = now()
      item.filePath ??= `Downloads/DonDownload/${item.filename}`
      item.updatedAt = now()
      emitDownloads()
      return `Simulated completion: ${item.filename} is complete.`
    },

    getSnapshot: async () => ok(downloadSnapshot()),

    addDownload: async (input: AddDownloadInput) => {
      let url: string
      try {
        url = normalizeHttpUrl(input.url)
      } catch (error) {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          error instanceof Error ? error.message : 'Enter a download URL.'
        )
      }

      const duplicate = downloads.find(
        (item) => item.url === url && item.status !== 'complete'
      )
      if (duplicate && input.force !== true) {
        return fail(
          PREVIEW_DUPLICATE_CODE,
          'This URL is already in the preview queue.',
          'Choose Download again to create a deliberate second copy.'
        )
      }

      const controls = input.controls ?? null
      const scheduledAt = controls?.scheduledAt ?? null
      const blocked = scheduledAt !== null && scheduledAt > now()
      const item: DownloadItem = {
        id: nextId('preview-download'),
        gid: nextId('preview-gid'),
        url,
        filename: input.filename ?? filenameOf(url),
        dir: 'Downloads/DonDownload',
        filePath: null,
        status: blocked ? 'waiting' : 'queued',
        totalBytes: 0,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        attempts: 0,
        maxAttempts: 5,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
        scheduledAt,
        speedLimitBps: controls?.speedLimitBps ?? null,
        connections: controls?.connections ?? null,
        blockReason: blocked ? 'scheduled' : null
      }
      downloads.unshift(item)
      return ok(emitDownloads())
    },

    pauseDownload: async (id: string) => {
      const item = findDownload(id)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status === 'active' || item.status === 'waiting' || item.status === 'queued') {
        item.status = 'paused'
        item.blockReason = null
        item.speedBps = 0
        item.etaSeconds = null
        item.updatedAt = now()
      }
      return ok(emitDownloads())
    },

    resumeDownload: async (id: string) => {
      const item = findDownload(id)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status === 'paused') {
        item.status = 'waiting'
        item.errorMessage = null
        item.completedAt = null
        item.blockReason = null
        item.updatedAt = now()
      }
      return ok(emitDownloads())
    },

    startDownloadNow: async (id: string) => {
      const item = findDownload(id)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status === 'waiting') {
        item.status = 'active'
        item.blockReason = null
        item.speedBps = 4_800_000
        item.etaSeconds = 90
        item.updatedAt = now()
      }
      return ok(emitDownloads())
    },

    retryDownload: async (id: string) => {
      const item = findDownload(id)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status === 'error' || item.status === 'interrupted') {
        // Recovering an interrupted transfer is not a new user attempt; an
        // ordinary failed retry is. Both restart from a clean progress state.
        const interruptedRecovery = item.status === 'interrupted'
        item.gid = nextId('preview-gid')
        item.status = 'queued'
        item.completedBytes = 0
        item.speedBps = 0
        item.etaSeconds = null
        item.errorMessage = null
        item.filePath = null
        item.attempts = interruptedRecovery ? item.attempts : item.attempts + 1
        item.completedAt = null
        item.blockReason = null
        item.updatedAt = now()
      }
      return ok(emitDownloads())
    },

    removeDownload: async (id: string) => {
      downloads = downloads.filter((item) => item.id !== id)
      return ok(emitDownloads())
    },

    showInFolder: async (id: string) =>
      findDownload(id)
        ? ok(null)
        : fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.'),

    restartAria2: async () => ok(emitDownloads()),

    onSnapshotChanged: (listener) => {
      downloadListeners.add(listener)
      return () => downloadListeners.delete(listener)
    },

    analyzeMedia: async (input) => analyzeMedia(input),

    queueMedia: async (input: MediaQueueInput) => {
      const analysis = analyses.get(input.analysisId)
      const option = analysis?.options.find(
        (candidate) => candidate.optionId === input.optionId
      )
      if (!analysis || !option) {
        return fail(
          PREVIEW_NOT_FOUND_CODE,
          'That media analysis has expired. Analyze the page again.'
        )
      }

      const outputFormat = input.outputFormat ?? 'auto'
      const job: MediaJob = {
        id: nextId('preview-media'),
        analysisId: analysis.analysisId,
        optionId: option.optionId,
        kind: option.kind,
        title: analysis.title,
        label:
          outputFormat === 'auto'
            ? option.label
            : `${option.label} · ${outputFormat.toUpperCase()}`,
        status: 'queued',
        completedBytes: 0,
        totalBytes: option.estimatedBytes ?? option.filesizeBytes ?? null,
        speedBps: 0,
        errorMessage: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null
      }
      mediaJobs.unshift(job)
      return ok(emitMedia())
    },

    getMediaSnapshot: async () => ok(mediaSnapshot()),

    getMediaJob: async (jobId: string) => {
      const job = findMediaJob(jobId)
      return job
        ? ok(cloneMediaJob(job))
        : fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
    },

    cancelMedia: async (jobId: string) => {
      const job = findMediaJob(jobId)
      if (!job) return fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
      if (
        job.status === 'queued' ||
        job.status === 'analyzing' ||
        job.status === 'downloading' ||
        job.status === 'merging'
      ) {
        job.status = 'cancelled'
        job.speedBps = 0
        job.updatedAt = now()
      }
      return ok(emitMedia())
    },

    removeMedia: async (jobId: string) => {
      mediaJobs = mediaJobs.filter((job) => job.id !== jobId)
      return ok(emitMedia())
    },

    showMediaInFolder: async (jobId: string) =>
      findMediaJob(jobId)
        ? ok(null)
        : fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.'),

    onMediaSnapshotChanged: (listener) => {
      mediaListeners.add(listener)
      return () => mediaListeners.delete(listener)
    },

    analyzeBatchCollection: async (input) => analyzeBatchCollection(input),

    analyzeCollectionSelection: async (input) =>
      analyzeCollectionSelection(input),

    submitSmartBatch: async (input) => submitSmartBatch(input),

    createCollectionBatch: async (input) => createCollectionBatch(input),

    getBatchSnapshot: async () => ok(batchSnapshot()),

    getBatch: async (batchId: string) => {
      const batch = findBatch(batchId)
      return batch
        ? ok(cloneBatch(batch))
        : fail(PREVIEW_NOT_FOUND_CODE, 'That batch is gone.')
    },

    cancelBatchItem: async (input) =>
      runBatchItemAction(input, (item) => {
        if (item.status !== 'queued' && item.status !== 'running') return false
        item.status = 'cancelled'
        return true
      }),

    cancelBatch: async (input: BatchTargetInput) => {
      const batch = findBatch(input.batchId)
      if (!batch) return fail(PREVIEW_NOT_FOUND_CODE, 'That batch is gone.')
      if (batch.status === 'queued' || batch.status === 'running') {
        for (const item of batch.items) {
          if (item.status === 'queued' || item.status === 'running') {
            item.status = 'cancelled'
            item.updatedAt = now()
          }
        }
        batch.status = 'cancelled'
        batch.completedAt = now()
        batch.updatedAt = now()
      }
      return ok(emitBatches())
    },

    retryBatchItem: async (input) =>
      runBatchItemAction(input, (item) => {
        if (item.status !== 'error' && item.status !== 'interrupted') {
          return false
        }
        item.status = 'queued'
        item.errorMessage = null
        item.completedAt = null
        return true
      }),

    removeBatch: async (input: BatchTargetInput) => {
      batches = batches.filter((batch) => batch.id !== input.batchId)
      return ok(emitBatches())
    },

    openBatchSource: async (input) =>
      findBatch(input.batchId)
        ? ok(null)
        : fail(PREVIEW_NOT_FOUND_CODE, 'That batch is gone.'),

    onBatchSnapshotChanged: (listener) => {
      batchListeners.add(listener)
      return () => batchListeners.delete(listener)
    },

    getSettings: async () => ok(cloneSettings(settings)),

    updateSettings: async (value: DownloadSettings) => {
      try {
        settings = parseDownloadSettings(value)
      } catch (error) {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          error instanceof Error ? error.message : 'Invalid settings.'
        )
      }
      return ok(cloneSettings(settings))
    },

    getMediaToolSettings: async () => ok({ ...mediaToolSettings }),

    updateMediaToolSettings: async (input: { autoUpdateYtdlp: boolean }) => {
      mediaToolSettings = {
        ...mediaToolSettings,
        autoUpdateYtdlp: input.autoUpdateYtdlp
      }
      return ok({ ...mediaToolSettings })
    },

    getYtdlpUpdateState: async () =>
      ok({
        status: 'idle' as const,
        currentVersion: '2026.10.26',
        latestVersion: null,
        message: null,
        lastCheckedAt: mediaToolSettings.lastYtdlpCheckAt
      }),

    checkYtdlpUpdate: async () =>
      ok({
        status: 'up-to-date' as const,
        currentVersion: '2026.10.26',
        latestVersion: '2026.10.26',
        message: 'Up to date.',
        lastCheckedAt: now()
      })
  }
}

function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function fail<T>(
  code: string,
  message: string,
  hint?: string
): ApiResult<T> {
  return {
    ok: false,
    error: { code, message, ...(hint === undefined ? {} : { hint }) }
  }
}

function seedSettings(): DownloadSettings {
  return {
    maxConcurrentDownloads: 4,
    perHostConnections: 8,
    globalSpeedLimitBps: 8_000_000,
    allowedHours: {
      enabled: true,
      start: '22:00',
      end: '06:00'
    },
    theme: 'dark'
  }
}

function seedDownloads(anchor: number): DownloadItem[] {
  const minute = 60_000
  const mib = 1024 * 1024

  return [
    {
      id: 'preview-download-active',
      gid: 'preview-gid-active',
      url: 'https://example.com/ubuntu-24.04.1-desktop-amd64.iso',
      filename: 'ubuntu-24.04.1-desktop-amd64.iso',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'active',
      totalBytes: 6_100 * mib,
      completedBytes: 2_300 * mib,
      speedBps: 12_500_000,
      etaSeconds: 318,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 18 * minute,
      updatedAt: anchor - 2_000,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 8,
      blockReason: null
    },
    {
      id: 'preview-download-scheduled',
      gid: 'preview-gid-scheduled',
      url: 'https://example.com/studio-assets.zip',
      filename: 'studio-assets.zip',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'waiting',
      totalBytes: 1_800 * mib,
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 0,
      maxAttempts: 5,
      createdAt: anchor - 40 * minute,
      updatedAt: anchor - 6 * minute,
      completedAt: null,
      scheduledAt: anchor + 2 * 60 * minute,
      speedLimitBps: 5 * mib,
      connections: 4,
      blockReason: 'scheduled'
    },
    {
      id: 'preview-download-allowed-hours',
      gid: 'preview-gid-allowed-hours',
      url: 'https://example.com/dataset-2026.tar.gz',
      filename: 'dataset-2026.tar.gz',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'waiting',
      totalBytes: 3_400 * mib,
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 0,
      maxAttempts: 5,
      createdAt: anchor - 55 * minute,
      updatedAt: anchor - 9 * minute,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 16,
      blockReason: 'allowed-hours'
    },
    {
      id: 'preview-download-paused',
      gid: 'preview-gid-paused',
      url: 'https://example.com/podcast-episode-42.mp3',
      filename: 'podcast-episode-42.mp3',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'paused',
      totalBytes: 92 * mib,
      completedBytes: 37 * mib,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 75 * minute,
      updatedAt: anchor - 11 * minute,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: 2 * mib,
      connections: 2,
      blockReason: null
    },
    {
      id: 'preview-download-complete',
      gid: 'preview-gid-complete',
      url: 'https://example.com/release-notes.pdf',
      filename: 'release-notes.pdf',
      dir: 'Downloads/DonDownload',
      filePath: 'Downloads/DonDownload/release-notes.pdf',
      status: 'complete',
      totalBytes: 4 * mib,
      completedBytes: 4 * mib,
      speedBps: 0,
      etaSeconds: 0,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 3 * 60 * minute,
      updatedAt: anchor - 2 * 60 * minute,
      completedAt: anchor - 2 * 60 * minute,
      scheduledAt: null,
      speedLimitBps: null,
      connections: null,
      blockReason: null
    },
    {
      id: 'preview-download-error',
      gid: 'preview-gid-error',
      url: 'https://example.com/nightly-build.zip',
      filename: 'nightly-build.zip',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'error',
      totalBytes: 512 * mib,
      completedBytes: 88 * mib,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: 'The fixture connection was interrupted.',
      attempts: 2,
      maxAttempts: 5,
      createdAt: anchor - 4 * 60 * minute,
      updatedAt: anchor - 3 * 60 * minute,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 4,
      blockReason: null
    }
  ]
}

function seedMediaJobs(anchor: number): MediaJob[] {
  const minute = 60_000
  const mib = 1024 * 1024

  return [
    {
      id: 'preview-media-downloading',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-1080',
      kind: 'video',
      title: 'Deep Work: Focus Session (preview)',
      label: '1080p · MP4 · video + audio',
      status: 'downloading',
      completedBytes: 74 * mib,
      totalBytes: 420 * mib,
      speedBps: 3_200_000,
      errorMessage: null,
      createdAt: anchor - 24 * minute,
      updatedAt: anchor - 1_000,
      completedAt: null
    },
    {
      id: 'preview-media-merging',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-720',
      kind: 'video',
      title: 'Design systems in practice (preview)',
      label: '720p · MP4 · video + audio',
      status: 'merging',
      completedBytes: 268 * mib,
      totalBytes: 268 * mib,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 45 * minute,
      updatedAt: anchor - 4_000,
      completedAt: null
    },
    {
      id: 'preview-media-complete',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-audio',
      kind: 'audio',
      title: 'Ambient coding mix (preview)',
      label: 'Audio only · M4A',
      status: 'complete',
      completedBytes: 46 * mib,
      totalBytes: 46 * mib,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 3 * 60 * minute,
      updatedAt: anchor - 2 * 60 * minute,
      completedAt: anchor - 2 * 60 * minute
    },
    {
      id: 'preview-media-error',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-480',
      kind: 'video',
      title: 'Conference keynote archive (preview)',
      label: '480p · MP4 · video + audio',
      status: 'error',
      completedBytes: 12 * mib,
      totalBytes: 180 * mib,
      speedBps: 0,
      errorMessage: 'The fixture media engine stopped before merging.',
      createdAt: anchor - 5 * 60 * minute,
      updatedAt: anchor - 4 * 60 * minute,
      completedAt: null
    }
  ]
}

function seedAnalysis(
  analysisId: string,
  url: string,
  startedAt: number
): MediaAnalysis {
  const mib = 1024 * 1024
  const options: MediaFormatOption[] = [
    {
      kind: 'video',
      optionId: 'preview-option-2160',
      label: '2160p · MP4 · video + audio',
      container: 'mp4',
      width: 3840,
      height: 2160,
      fps: 30,
      videoCodec: 'avc1',
      audioCodec: 'aac',
      hasAudio: true,
      requiresMerge: true,
      filesizeBytes: null,
      estimatedBytes: 1_450 * mib,
      sizeIsEstimate: true,
      outputFormats: ['auto', 'mp4', 'mkv']
    },
    {
      kind: 'video',
      optionId: 'preview-option-1080',
      label: '1080p · MP4 · video + audio',
      container: 'mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: 'avc1',
      audioCodec: 'aac',
      hasAudio: true,
      requiresMerge: true,
      filesizeBytes: null,
      estimatedBytes: 420 * mib,
      sizeIsEstimate: true,
      outputFormats: ['auto', 'mp4', 'mkv']
    },
    {
      kind: 'video',
      optionId: 'preview-option-720',
      label: '720p · MP4 · video + audio',
      container: 'mp4',
      width: 1280,
      height: 720,
      fps: 30,
      videoCodec: 'avc1',
      audioCodec: 'aac',
      hasAudio: true,
      requiresMerge: true,
      filesizeBytes: null,
      estimatedBytes: 268 * mib,
      sizeIsEstimate: true,
      outputFormats: ['auto', 'mp4', 'mkv']
    },
    {
      kind: 'video',
      optionId: 'preview-option-480',
      label: '480p · MP4 · video + audio',
      container: 'mp4',
      width: 854,
      height: 480,
      fps: 30,
      videoCodec: 'avc1',
      audioCodec: 'aac',
      hasAudio: true,
      requiresMerge: false,
      filesizeBytes: 180 * mib,
      estimatedBytes: 180 * mib,
      sizeIsEstimate: false,
      outputFormats: ['auto', 'mp4', 'mkv']
    },
    {
      kind: 'video',
      optionId: 'preview-option-360',
      label: '360p · MP4 · video + audio',
      container: 'mp4',
      width: 640,
      height: 360,
      fps: 30,
      videoCodec: 'avc1',
      audioCodec: 'aac',
      hasAudio: true,
      requiresMerge: false,
      filesizeBytes: 96 * mib,
      estimatedBytes: 96 * mib,
      sizeIsEstimate: false,
      outputFormats: ['auto', 'mp4', 'mkv']
    },
    {
      kind: 'audio',
      optionId: 'preview-option-audio',
      label: 'Audio only · M4A',
      container: 'm4a',
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      audioCodec: 'aac',
      hasAudio: true,
      requiresMerge: false,
      filesizeBytes: 46 * mib,
      estimatedBytes: 46 * mib,
      sizeIsEstimate: false,
      outputFormats: ['auto', 'mp4', 'mkv']
    }
  ]

  return {
    analysisId,
    title: `Fixture media · ${hostnameOf(url)}`,
    durationSeconds: 1_456,
    options,
    bestVideoOptionId: 'preview-option-2160',
    bestAudioOptionId: 'preview-option-audio',
    expiresAt: startedAt + PREVIEW_ANALYSIS_EXPIRY_MS
  }
}

function createCollectionPreview(id: string): CollectionPreview {
  const entries = [
    collectionEntry(id, 0, 'Focus session one · Setting up the workspace', true),
    collectionEntry(id, 1, 'Focus session two · Deep work blocks', true),
    collectionEntry(id, 2, 'Focus session three · Recovery and review', true),
    collectionEntry(id, 3, 'Members-only bonus session', false)
  ]
  const preview: CollectionPreview = {
    id,
    kind: 'playlist',
    title: 'Focus sessions · fixture playlist',
    entryCount: entries.length,
    availableCount: entries.filter((entry) => entry.availability === 'available')
      .length,
    unavailableCount: entries.filter(
      (entry) => entry.availability === 'unavailable'
    ).length,
    entries
  }
  return preview
}

function collectionEntry(
  previewId: string,
  position: number,
  title: string,
  available: boolean
): CollectionPreview['entries'][number] {
  return {
    id: `${previewId}-entry-${position + 1}`,
    position,
    title,
    availability: available ? 'available' : 'unavailable',
    errorCode: available ? null : 'members-only',
    errorReason: available ? null : 'This fixture entry is not available.'
  }
}

function collectionQualities(): Array<{
  quality: BatchMediaQuality
  estimatedBytes: number | null
  sizeIsEstimate?: boolean
}> {
  const mib = 1024 * 1024
  return [
    { quality: 'best', estimatedBytes: 420 * mib, sizeIsEstimate: true },
    { quality: '1080p', estimatedBytes: 420 * mib, sizeIsEstimate: true },
    { quality: '720p', estimatedBytes: 268 * mib, sizeIsEstimate: true },
    { quality: 'audio-only', estimatedBytes: 46 * mib, sizeIsEstimate: false }
  ]
}

function seedBatches(anchor: number): Batch[] {
  const minute = 60_000

  const directItems = [
    fixtureItem({
      id: 'preview-item-running',
      batchId: 'preview-batch-direct',
      position: 0,
      kind: 'download',
      status: 'running',
      title: 'ubuntu-24.04.1-desktop-amd64.iso',
      label: 'example.com',
      completedBytes: 2_300 * 1024 * 1024,
      totalBytes: 6_100 * 1024 * 1024,
      createdAt: anchor - 18 * minute,
      updatedAt: anchor - 2_000
    }),
    fixtureItem({
      id: 'preview-item-queued',
      batchId: 'preview-batch-direct',
      position: 1,
      kind: 'download',
      status: 'queued',
      title: 'checksums.txt',
      label: 'example.com',
      completedBytes: 0,
      totalBytes: 12_000,
      createdAt: anchor - 18 * minute,
      updatedAt: anchor - 18 * minute
    }),
    fixtureItem({
      id: 'preview-item-complete',
      batchId: 'preview-batch-direct',
      position: 2,
      kind: 'download',
      status: 'complete',
      title: 'signature.asc',
      label: 'example.com',
      completedBytes: 512,
      totalBytes: 512,
      createdAt: anchor - 18 * minute,
      updatedAt: anchor - 14 * minute,
      completedAt: anchor - 14 * minute
    })
  ]

  const playlistItems = [
    fixtureItem({
      id: 'preview-item-video-1',
      batchId: 'preview-batch-playlist',
      position: 0,
      kind: 'media',
      status: 'complete',
      title: 'Focus session one · Setting up the workspace',
      label: '1080p · MP4 · video + audio',
      completedBytes: 420 * 1024 * 1024,
      totalBytes: 420 * 1024 * 1024,
      createdAt: anchor - 2 * 60 * minute,
      updatedAt: anchor - 90 * minute,
      completedAt: anchor - 90 * minute
    }),
    fixtureItem({
      id: 'preview-item-video-2',
      batchId: 'preview-batch-playlist',
      position: 1,
      kind: 'media',
      status: 'complete',
      title: 'Focus session two · Deep work blocks',
      label: '1080p · MP4 · video + audio',
      completedBytes: 380 * 1024 * 1024,
      totalBytes: 380 * 1024 * 1024,
      createdAt: anchor - 2 * 60 * minute,
      updatedAt: anchor - 70 * minute,
      completedAt: anchor - 70 * minute
    }),
    fixtureItem({
      id: 'preview-item-video-3',
      batchId: 'preview-batch-playlist',
      position: 2,
      kind: 'media',
      status: 'error',
      title: 'Focus session three · Recovery and review',
      label: '1080p · MP4 · video + audio',
      completedBytes: 12 * 1024 * 1024,
      totalBytes: 360 * 1024 * 1024,
      errorMessage: 'The fixture media engine could not merge this item.',
      createdAt: anchor - 2 * 60 * minute,
      updatedAt: anchor - 55 * minute
    }),
    fixtureItem({
      id: 'preview-item-members-only',
      batchId: 'preview-batch-playlist',
      position: 3,
      kind: 'media',
      status: 'unavailable',
      title: 'Members-only bonus session',
      label: 'Browser required',
      completedBytes: 0,
      totalBytes: null,
      errorMessage: 'This fixture entry is not available.',
      createdAt: anchor - 2 * 60 * minute,
      updatedAt: anchor - 2 * 60 * minute
    })
  ]

  const pixeldrainItems = [
    fixtureItem({
      id: 'preview-item-pd-1',
      batchId: 'preview-batch-pixeldrain',
      position: 0,
      kind: 'download',
      status: 'complete',
      title: 'brand-kit.zip',
      label: 'pixeldrain fixture',
      completedBytes: 204 * 1024 * 1024,
      totalBytes: 204 * 1024 * 1024,
      createdAt: anchor - 26 * 60 * minute,
      updatedAt: anchor - 25 * 60 * minute,
      completedAt: anchor - 25 * 60 * minute
    }),
    fixtureItem({
      id: 'preview-item-pd-2',
      batchId: 'preview-batch-pixeldrain',
      position: 1,
      kind: 'download',
      status: 'complete',
      title: 'screenshots.zip',
      label: 'pixeldrain fixture',
      completedBytes: 88 * 1024 * 1024,
      totalBytes: 88 * 1024 * 1024,
      createdAt: anchor - 26 * 60 * minute,
      updatedAt: anchor - 24 * 60 * minute,
      completedAt: anchor - 24 * 60 * minute
    })
  ]

  return [
    finalizeBatch({
      id: 'preview-batch-direct',
      kind: 'direct-urls',
      title: 'Release mirror · nightly',
      status: 'running',
      progress: summarizeBatchItems(directItems),
      errorMessage: null,
      createdAt: anchor - 18 * minute,
      updatedAt: anchor - 2_000,
      completedAt: null,
      items: directItems
    }),
    finalizeBatch({
      id: 'preview-batch-playlist',
      kind: 'media-playlist',
      title: 'Focus sessions · fixture playlist',
      status: 'partial',
      progress: summarizeBatchItems(playlistItems),
      errorMessage: null,
      createdAt: anchor - 2 * 60 * minute,
      updatedAt: anchor - 55 * minute,
      completedAt: null,
      items: playlistItems
    }),
    finalizeBatch({
      id: 'preview-batch-pixeldrain',
      kind: 'pixeldrain-list',
      title: 'Shared assets · Pixeldrain fixture',
      status: 'complete',
      progress: summarizeBatchItems(pixeldrainItems),
      errorMessage: null,
      createdAt: anchor - 26 * 60 * minute,
      updatedAt: anchor - 24 * 60 * minute,
      completedAt: anchor - 24 * 60 * minute,
      items: pixeldrainItems
    })
  ]
}

function fixtureItem(input: {
  id: string
  batchId: string
  position: number
  kind: BatchItem['kind']
  status: BatchItem['status']
  title: string
  label: string
  completedBytes: number
  totalBytes: number | null
  errorMessage?: string | null
  createdAt: number
  updatedAt: number
  completedAt?: number | null
}): BatchItem {
  return {
    id: input.id,
    batchId: input.batchId,
    position: input.position,
    kind: input.kind,
    status: input.status,
    title: input.title,
    label: input.label,
    childId: null,
    completedBytes: input.completedBytes,
    totalBytes: input.totalBytes,
    errorMessage: input.errorMessage ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt ?? null
  }
}

function makeBatchItem(input: BatchItem): BatchItem {
  return { ...input }
}

function finalizeBatch(batch: Batch): Batch {
  return {
    ...batch,
    items: [...batch.items]
      .sort((left, right) => left.position - right.position)
      .map((item) => ({ ...item }))
  }
}

function recomputeBatch(batch: Batch, updatedAt: number): void {
  batch.progress = summarizeBatchItems(batch.items)
  if (batch.items.some((item) => item.status === 'queued' || item.status === 'running')) {
    batch.status = 'running'
  } else if (
    batch.items.some(
      (item) => item.status === 'error' || item.status === 'interrupted'
    )
  ) {
    batch.status = batch.progress.completedItems > 0 ? 'partial' : 'error'
  } else if (
    batch.items.some((item) => item.status === 'cancelled') &&
    batch.progress.completedItems === 0
  ) {
    batch.status = 'cancelled'
  } else if (
    batch.items.every(
      (item) => item.status === 'complete' || item.status === 'unavailable' || item.status === 'skipped'
    )
  ) {
    batch.status = 'complete'
  }
  batch.updatedAt = updatedAt
  batch.completedAt =
    batch.status === 'complete' ||
    batch.status === 'partial' ||
    batch.status === 'error' ||
    batch.status === 'cancelled'
      ? batch.updatedAt
      : null
}

function isCollectionUrl(url: string): boolean {
  return (
    /(?:youtube\.com|youtu\.be)\/playlist/i.test(url) ||
    /[?&]list=/i.test(url) ||
    /pixeldrain\.com\/l\//i.test(url)
  )
}

function collectionItemLabel(
  preview: CollectionPreview,
  quality: BatchMediaQuality | undefined
): string {
  const selected = quality ?? 'best'
  return preview.kind === 'playlist'
    ? `${qualityLabel(selected)} · fixture playlist`
    : 'Pixeldrain fixture item'
}

function qualityLabel(quality: BatchMediaQuality): string {
  switch (quality) {
    case 'best':
      return 'Best quality'
    case 'audio-only':
      return 'Audio only'
    default:
      return quality
  }
}

function filenameOf(url: string): string {
  try {
    const parsed = new URL(url)
    const name = parsed.pathname.split('/').filter(Boolean).pop()
    return name && name.length > 0 ? decodeURIComponent(name) : 'download.bin'
  } catch {
    return 'download.bin'
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'example.com'
  }
}

function cloneDownload(item: DownloadItem): DownloadItem {
  return { ...item }
}

function cloneMediaJob(job: MediaJob): MediaJob {
  return { ...job }
}

function cloneBatch(batch: Batch): Batch {
  return {
    ...batch,
    progress: { ...batch.progress },
    items: batch.items.map((item) => ({ ...item }))
  }
}

function cloneSettings(settings: DownloadSettings): DownloadSettings {
  return {
    ...settings,
    allowedHours: { ...settings.allowedHours }
  }
}
