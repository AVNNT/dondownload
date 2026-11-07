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
  MediaJobDetails,
  MediaQueueInput,
  MediaSnapshot
} from '@shared/media'
import { normalizeMediaSourceUrl } from '@shared/media'
import {
  CHECKSUM_HEX_LENGTHS,
  parseExpectedHash,
  type ChecksumAlgorithm
} from '@shared/checksum'
import type { DownloadSettings } from '@shared/settings'
import { parseDownloadSettings } from '@shared/settings'
import {
  defaultDesktopSettings,
  parseDesktopSettings,
  type DesktopSettings
} from '@shared/desktopSettings'
import {
  CHROME_NATIVE_HOST_REGISTRY_KEY,
  EDGE_NATIVE_HOST_REGISTRY_KEY,
  type BrowserExtensionStatus
} from '@shared/browserExtension'
import { DONDOWNLOAD_EXTENSION_ID } from '@shared/extensionId'
import {
  defaultMediaToolSettings,
  type MediaToolSettings
} from '@shared/mediaTools'
import {
  defaultAppUpdateSettings,
  type AppUpdateSettings,
  type AppUpdateState
} from '@shared/appUpdate'
import type {
  AddDownloadInput,
  ApiResult,
  AppSnapshot,
  DonDownloadApi,
  DownloadItem,
  SmartBatchSubmitEntry,
  SmartBatchSubmitResult,
  UrlSizeProbe
} from '@shared/types'
import {
  isQueueableScanItem,
  type ScanBrowserScriptSelection,
  type ScanItem,
  type ScanManualMatchInput,
  type ScanManualMatchResult,
  type ScanQueueResult,
  type ScanQueueSelectionInput,
  type ScanQueueSelectionOutcome,
  type ScanQueueSelectionsResult,
  type ScanQueueVideoOption,
  type ScanScriptPairingInput,
  type ScanSession,
  type ScanStartInput
} from '@shared/scanner'
import { buildScanScriptSets } from '@shared/scriptSets'
import { normalizeHttpUrl } from '@shared/validation'

const browserExtensionFixture: BrowserExtensionStatus = {
  registered: true,
  browsers: [
    {
      browser: 'Chrome',
      registered: true,
      registryKey: CHROME_NATIVE_HOST_REGISTRY_KEY,
      shared: true
    },
    {
      browser: 'Helium',
      registered: true,
      registryKey: CHROME_NATIVE_HOST_REGISTRY_KEY,
      shared: true
    },
    {
      browser: 'Edge',
      registered: true,
      registryKey: EDGE_NATIVE_HOST_REGISTRY_KEY,
      shared: false
    }
  ],
  hostPath: 'C:\\Program Files\\DonDownload\\resources\\native\\dondownload-native-host.exe',
  manifestPath:
    'C:\\Users\\preview\\AppData\\Roaming\\DonDownload\\native-messaging\\com.dondownload.bridge.json',
  allowedOrigins: [`chrome-extension://${DONDOWNLOAD_EXTENSION_ID}/`],
  extensionFolder: 'C:\\Program Files\\DonDownload\\resources\\extension',
  extensionId: DONDOWNLOAD_EXTENSION_ID,
  lastError: null
}

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
  version: '1.37.0',
  binaryPath: null,
  message: null,
  hint: null
}

const PREVIEW_MEDIA_TOOL = {
  status: 'ready' as const,
  version: '2026.10.26',
  message: null,
  hint: null
}

const PREVIEW_ANALYSIS_EXPIRY_MS = 15 * 60_000
const PREVIEW_DUPLICATE_CODE = 'DUPLICATE_DOWNLOAD'
const PREVIEW_NOT_FOUND_CODE = 'PREVIEW_NOT_FOUND'
const PREVIEW_INVALID_INPUT_CODE = 'PREVIEW_INVALID_INPUT'

/**
 * Deterministic remote thumbnails for the preview. They exercise the same
 * lazy/no-referrer HTTPS image path as a real analysis thumbnail; if the
 * network is unavailable the renderer falls back to the category icon. Live
 * media jobs do not persist thumbnails yet, so their rows use the icon path.
 */
const PREVIEW_THUMBNAIL_A = 'https://picsum.photos/seed/dondownload-focus/160/90'
const PREVIEW_THUMBNAIL_B = 'https://picsum.photos/seed/dondownload-design/160/90'

export interface PreviewClock {
  now?: () => number
}

/** Controls only the in-memory preview fixtures; never part of the preload API. */
export interface PreviewFixtureControls {
  advanceDownloadFixture: () => string
  /** Emits one extension image session so the picker sheet opens. */
  openImageScanFixture: () => string
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
  let desktopSettings: DesktopSettings = seedDesktopSettings()
  let mediaToolSettings: MediaToolSettings = defaultMediaToolSettings()
  let appUpdateSettings: AppUpdateSettings = defaultAppUpdateSettings()
  const scanSessions: ScanSession[] = []

  const analyses = new Map<string, MediaAnalysis>()
  const previews = new Map<string, CollectionPreview>()
  /** Normalized page URL per analysis, recovered for the details pane. */
  const sourceUrlsByAnalysis = new Map<string, string>()
  /**
   * Display-only source URL/path per media job for the details pane,
   * mirroring the scoped `getMediaJobDetails` accessor on the real backend.
   */
  const mediaDetails = seedMediaJobDetails()

  let sequence = 0

  const downloadListeners = new Set<Listener<AppSnapshot>>()
  const mediaListeners = new Set<Listener<MediaSnapshot>>()
  const batchListeners = new Set<Listener<{ batches: Batch[] }>>()
  const appUpdateListeners = new Set<Listener<AppUpdateState>>()
  const settingsListeners = new Set<Listener<DownloadSettings>>()
  const scanListeners = new Set<Listener<ScanSession>>()

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
    sourceUrlsByAnalysis.set(analysis.analysisId, url)
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
      kind:
        preview.kind === 'playlist'
          ? 'media-playlist'
          : preview.kind === 'mega-folder'
            ? 'mega-folder'
            : 'pixeldrain-list',
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

  function appUpdateState(): AppUpdateState {
    return {
      status: 'not-configured',
      configured: false,
      currentVersion: '0.1.0',
      latestVersion: null,
      progressPercent: null,
      message: 'Update source not configured',
      releaseNotes: null,
      lastCheckedAt: appUpdateSettings.lastCheckedAt,
      autoCheck: appUpdateSettings.autoCheck,
      canInstall: false
    }
  }

  function emitAppUpdate(): AppUpdateState {
    const state = appUpdateState()
    for (const listener of appUpdateListeners) listener(state)
    return state
  }

  function seedScanItems(): ScanItem[] {
    const videoFormats = [
      {
        optionId: 'preview-scan-option-1080',
        kind: 'video' as const,
        label: '1080p · MP4 · avc1 + aac',
        container: 'mp4',
        width: 1920,
        height: 1080,
        sizeBytes: 112 * 1024 * 1024,
        sizeIsEstimate: true,
        outputFormats: ['auto' as const, 'mp4' as const, 'mkv' as const]
      },
      {
        optionId: 'preview-scan-option-720',
        kind: 'video' as const,
        label: '720p · MP4 · avc1 + aac',
        container: 'mp4',
        width: 1280,
        height: 720,
        sizeBytes: 61 * 1024 * 1024,
        sizeIsEstimate: true,
        outputFormats: ['auto' as const, 'mp4' as const, 'mkv' as const]
      },
      {
        optionId: 'preview-scan-option-audio',
        kind: 'audio' as const,
        label: 'Audio only · M4A · aac',
        container: 'm4a',
        width: null,
        height: null,
        sizeBytes: 9 * 1024 * 1024,
        sizeIsEstimate: false,
        outputFormats: ['auto' as const, 'mp4' as const, 'mkv' as const]
      }
    ]

    const baseItems: ScanItem[] = [
      {
        id: 'preview-scan-video-page',
        category: 'video',
        kind: 'page-link',
        name: 'EroScripts topic video',
        hostname: 'youtube.com',
        sizeBytes: 112 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 2,
        author: 'demo-author',
        durationSeconds: 754,
        width: 1920,
        height: 1080,
        thumbnailUrl: PREVIEW_THUMBNAIL_A,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-video-protected',
        category: 'video',
        kind: 'page-link',
        name: 'Members-only stream',
        hostname: 'vimeo.com',
        sizeBytes: null,
        verified: false,
        status: 'protected',
        postNumber: 3,
        author: 'demo-author',
        unavailableReason: "This video is DRM-protected and can't be downloaded."
      },
      {
        id: 'preview-scan-video-resolving',
        category: 'video',
        kind: 'page-link',
        name: 'Embedded player clip',
        hostname: 'player.example.com',
        sizeBytes: null,
        verified: false,
        status: 'probing',
        postNumber: 4,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-video',
        category: 'video',
        kind: 'file',
        name: 'demo-clip.mp4',
        hostname: 'cdn.example.com',
        sizeBytes: 72_400_000,
        verified: true,
        status: 'ready',
        postNumber: 2,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-funscript',
        category: 'script',
        kind: 'file',
        name: 'x.roll.funscript',
        hostname: 'discuss.example.com',
        sizeBytes: 48_120,
        verified: true,
        status: 'ready',
        postNumber: 4,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-audio',
        category: 'audio',
        kind: 'file',
        name: 'ambience.mp3',
        hostname: 'cdn.example.com',
        sizeBytes: 6_200_000,
        verified: true,
        status: 'ready',
        postNumber: 5,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-image',
        category: 'image',
        kind: 'file',
        name: 'preview.jpg',
        hostname: 'cdn.example.com',
        sizeBytes: 420_000,
        verified: true,
        status: 'ready',
        postNumber: 5,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-document',
        category: 'document',
        kind: 'file',
        name: 'readme.pdf',
        hostname: 'files.example.com',
        sizeBytes: 1_240_000,
        verified: true,
        status: 'ready',
        postNumber: 6,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-archive',
        category: 'archive',
        kind: 'file',
        name: 'pack.zip',
        hostname: 'files.example.com',
        sizeBytes: 12_800_000,
        verified: true,
        status: 'ready',
        postNumber: 7,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-signin',
        category: 'other',
        kind: 'file',
        name: 'attachment.bin',
        hostname: 'discuss.example.com',
        sizeBytes: null,
        verified: false,
        status: 'signin',
        postNumber: 7,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-other-link',
        category: 'page',
        kind: 'page-link',
        name: 'Unrecognised video page',
        hostname: 'media.example.com',
        sizeBytes: null,
        verified: false,
        status: 'found',
        postNumber: 8,
        author: 'demo-author'
      },
      {
        id: 'preview-scan-other-link-2',
        category: 'page',
        kind: 'page-link',
        name: 'Creator page',
        hostname: 'creator.example.com',
        sizeBytes: null,
        verified: false,
        status: 'found',
        postNumber: 8,
        author: 'demo-author'
      }
    ]

    // Six-fancam + mix example: a multi-axis set, a variant set, a missing-main
    // set and an ambiguous pair of videos. Titles are synthetic.
    const fancams: ScanItem[] = [
      {
        id: 'preview-scan-fancam-01',
        category: 'video',
        kind: 'page-link',
        name: 'Fancam 01 Wonyoung',
        hostname: 'youtube.com',
        sizeBytes: 98 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 10,
        author: 'demo-author',
        durationSeconds: 213,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-fancam-02',
        category: 'video',
        kind: 'page-link',
        name: 'Fancam 02 Wonyoung',
        hostname: 'youtube.com',
        sizeBytes: 101 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 11,
        author: 'demo-author',
        durationSeconds: 198,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-fancam-03',
        category: 'video',
        kind: 'page-link',
        name: 'Fancam 03 Wonyoung',
        hostname: 'youtube.com',
        sizeBytes: 95 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 12,
        author: 'demo-author',
        durationSeconds: 187,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-fancam-04',
        category: 'video',
        kind: 'page-link',
        name: 'Fancam 04 Wonyoung',
        hostname: 'youtube.com',
        sizeBytes: 104 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 13,
        author: 'demo-author',
        durationSeconds: 205,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-fancam-04-alt',
        category: 'video',
        kind: 'page-link',
        name: 'Fancam 04 Wonyoung Full',
        hostname: 'youtube.com',
        sizeBytes: 108 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 13,
        author: 'demo-author',
        durationSeconds: 224,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-fancam-05',
        category: 'video',
        kind: 'page-link',
        name: 'Fancam 05 Wonyoung',
        hostname: 'youtube.com',
        sizeBytes: 99 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 14,
        author: 'demo-author',
        durationSeconds: 191,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-mix',
        category: 'video',
        kind: 'page-link',
        name: 'Stage Mix Wonyoung',
        hostname: 'youtube.com',
        sizeBytes: 126 * 1024 * 1024,
        verified: true,
        status: 'ready',
        postNumber: 16,
        author: 'demo-author',
        durationSeconds: 402,
        width: 1920,
        height: 1080,
        bestResolution: '1080p',
        sizeIsEstimate: true,
        formats: videoFormats,
        bestOptionId: 'preview-scan-option-1080'
      },
      {
        id: 'preview-scan-hanime1',
        category: 'video',
        kind: 'page-link',
        name: 'Hanime1 Watch Video',
        hostname: 'hanime1.me',
        sizeBytes: null,
        verified: false,
        status: 'browser-only',
        postNumber: 20,
        author: 'demo-author',
        unavailableReason:
          "Can't be read automatically — open it in your browser."
      }
    ]

    const scriptFiles = (
      base: string,
      postNumber: number,
      names: string[]
    ): ScanItem[] =>
      names.map((suffix, index) => ({
        id: `preview-scan-script-${postNumber}-${index}`,
        category: 'script',
        kind: 'file',
        name: `${base}${suffix}.funscript`,
        hostname: 'discuss.example.com',
        sizeBytes: 42_000 + index * 1_500,
        verified: true,
        status: 'ready',
        postNumber,
        author: 'demo-author'
      }))

    const scripts = [
      ...scriptFiles('Fancam 01 Wonyoung', 10, [
        '',
        '.roll',
        '.surge',
        '.twist'
      ]),
      ...scriptFiles('Fancam 02 Wonyoung', 11, ['', '.hard', '.hard.roll']),
      ...scriptFiles('Fancam 03 Wonyoung', 12, ['.roll', '.pitch']),
      ...scriptFiles('Fancam 04 Wonyoung', 13, ['', '.roll']),
      ...scriptFiles('Stage Mix Wonyoung', 16, ['', '.roll']),
      ...scriptFiles('Hanime1 Watch Video', 20, ['', '.roll', '.surge'])
    ]

    return [...baseItems, ...fancams, ...scripts]
  }

  function emitScan(session: ScanSession): ScanSession {
    const index = scanSessions.findIndex(
      (candidate) => candidate.sessionId === session.sessionId
    )
    if (index >= 0) scanSessions[index] = session
    else scanSessions.push(session)
    for (const listener of scanListeners) listener(session)
    return session
  }

  function findScanSession(sessionId: string): ScanSession | undefined {
    return scanSessions.find((session) => session.sessionId === sessionId)
  }

  function countersFor(items: readonly ScanItem[]): ScanSession['counters'] {
    return {
      found: items.filter((item) => item.status === 'found').length,
      probing: items.filter((item) => item.status === 'probing').length,
      ready: items.filter((item) => item.status === 'ready').length,
      signin: items.filter((item) => item.status === 'signin').length,
      protected: items.filter((item) => item.status === 'protected').length,
      unavailable: items.filter((item) => item.status === 'unavailable').length,
      toolUnavailable: items.filter(
        (item) => item.status === 'tool-unavailable'
      ).length
    }
  }

  function previewTopicTitle(url: string): string {
    try {
      const parsed = new URL(url)
      const match = /\/t\/([^/]+)\//.exec(parsed.pathname)
      const slug = match?.[1]
      if (slug !== undefined && slug.length > 0) {
        return decodeURIComponent(slug).replace(/[-_]+/g, ' ').slice(0, 120)
      }
      return parsed.hostname
    } catch {
      return 'Scanned topic'
    }
  }

  function createScanSession(url: string): ScanSession {
    let hostname = 'example.com'
    try {
      hostname = new URL(url).hostname
    } catch {
      // Validation already succeeded, so this is unreachable in practice.
    }
    const suffix = nextId('topic')
    const items = seedScanItems().map((item) => ({
      ...item,
      id: `${item.id}-${suffix}`
    }))
    return {
      sessionId: nextId('scan-session'),
      status: 'scanning',
      origin: 'paste',
      hostname,
      title: previewTopicTitle(url),
      message: null,
      signinRequired: false,
      counters: countersFor(items),
      progress: {
        fetchedPages: 1,
        totalItems: items.length,
        queueableItems: items.filter(isQueueableScanItem).length
      },
      items,
      scriptSets: buildScanScriptSets(items),
      removedItemIds: [],
      revision: 1,
      updatedAt: now()
    }
  }

  /**
   * One extension image session, mirroring what the desktop builds from a
   * Pinterest board walk: category `image`, ready items and a small thumbnail
   * URL for the grid.
   */
  function seedImageScanSession(): ScanSession {
    const seeds: Array<[string, number, number]> = [
      ['aabbccddeeff0011', 1200, 1800],
      ['aabbccddeeff0022', 736, 1104],
      ['aabbccddeeff0033', 564, 846],
      ['aabbccddeeff0044', 1200, 1600],
      ['aabbccddeeff0055', 736, 981],
      ['aabbccddeeff0066', 1080, 1350],
      ['aabbccddeeff0077', 736, 920],
      ['aabbccddeeff0088', 1200, 1200],
      ['aabbccddeeff0099', 564, 564],
      ['aabbccddeeff00aa', 1080, 1620],
      ['aabbccddeeff00bb', 736, 1104],
      ['aabbccddeeff00cc', 1200, 1800]
    ]
    const items: ScanItem[] = seeds.map(([hash, width, height], index) => {
      const dir = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4, 6)}`
      return {
        id: `preview-scan-image-${index}`,
        category: 'image',
        kind: 'file',
        name: `pin-${index + 1}.jpg`,
        hostname: 'i.pinimg.com',
        sizeBytes: null,
        verified: false,
        status: 'ready',
        postNumber: null,
        author: null,
        width,
        height,
        thumbnailUrl: `https://i.pinimg.com/736x/${dir}/${hash}.jpg`
      }
    })
    return {
      sessionId: nextId('scan-session'),
      status: 'done',
      origin: 'extension',
      mode: 'images',
      hostname: 'www.pinterest.com',
      title: 'Autumn outfit ideas',
      message: null,
      signinRequired: false,
      counters: countersFor(items),
      progress: {
        fetchedPages: 0,
        totalItems: items.length,
        queueableItems: items.filter(isQueueableScanItem).length
      },
      items,
      scriptSets: [],
      removedItemIds: [],
      revision: 1,
      updatedAt: now()
    }
  }

  function scheduleScanCompletion(sessionId: string): void {
    setTimeout(() => {
      const session = findScanSession(sessionId)
      if (session === undefined || session.status !== 'scanning') return
      emitScan({
        ...session,
        status: 'done',
        revision: session.revision + 1,
        updatedAt: now(),
        items: []
      })
    }, 250)
  }

  function queueForSession(
    sessionId: string,
    itemIds: string[]
  ): ApiResult<ScanQueueResult> {
    const session = findScanSession(sessionId)
    if (session === undefined) {
      return fail(PREVIEW_NOT_FOUND_CODE, 'Scan the page again.')
    }
    const selected = new Set(itemIds)
    const queueable = session.items.filter(
      (item) => selected.has(item.id) && isQueueableScanItem(item)
    )
    if (queueable.length === 0) {
      return fail(
        PREVIEW_INVALID_INPUT_CODE,
        'Select at least one downloadable item.'
      )
    }
    return ok({
      batch: batches[0] ?? null,
      queuedItemIds: queueable.map((item) => item.id),
      skipped: []
    })
  }

  return {
    openImageScanFixture: () => {
      const session = seedImageScanSession()
      emitScan(session)
      return `Opened an image session with ${session.items.length} images.`
    },
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

    probeUrlSize: async (url: string) => {
      // Deterministic pseudo-size so preview rows show a plausible value.
      let hash = 7
      for (let index = 0; index < url.length; index += 1) {
        hash = (hash * 31 + url.charCodeAt(index)) >>> 0
      }
      return ok<UrlSizeProbe>({ size: 1_500_000 + (hash % 998_500_000) })
    },

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

    removeDownloads: async (ids: string[]) => {
      const gone = new Set(ids)
      downloads = downloads.filter((item) => !gone.has(item.id))
      return ok(emitDownloads())
    },

    showInFolder: async (id: string) =>
      findDownload(id)
        ? ok(null)
        : fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.'),

    deleteDownloadFile: async (id: string) => {
      const item = findDownload(id)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status !== 'complete') {
        return fail('FILE_NOT_READY', 'Only a finished download can be deleted.')
      }
      downloads = downloads.filter((candidate) => candidate.id !== id)
      return ok(emitDownloads())
    },

    openFile: async (id: string) => {
      const item = findDownload(id)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status !== 'complete' || !item.filePath) {
        return fail('FILE_NOT_READY', 'The file is not ready yet.')
      }
      return ok(null)
    },

    verifyChecksum: async (downloadId: string, expectedHash: string) => {
      const item = findDownload(downloadId)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status !== 'complete') {
        return fail('FILE_NOT_READY', 'The file is not ready yet.')
      }
      const parsed = parseExpectedHash(expectedHash)
      if (parsed === null) {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          'Enter a valid MD5, SHA-1, SHA-256 or SHA-512 hex hash.'
        )
      }
      const computed = previewHash(parsed.algorithm, item.filename)
      const result = {
        algorithm: parsed.algorithm,
        ok: computed === parsed.hash,
        computed,
        checkedAt: now()
      }
      item.checksum = result
      emitDownloads()
      return ok(result)
    },

    computeChecksum: async (downloadId: string) => {
      const item = findDownload(downloadId)
      if (!item) return fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.')
      if (item.status !== 'complete') {
        return fail('FILE_NOT_READY', 'The file is not ready yet.')
      }
      const result = {
        algorithm: 'sha256' as const,
        ok: null,
        computed: previewHash('sha256', item.filename),
        checkedAt: now()
      }
      item.checksum = result
      emitDownloads()
      return ok(result)
    },

    cancelChecksum: async (downloadId: string) =>
      findDownload(downloadId)
        ? ok(null)
        : fail(PREVIEW_NOT_FOUND_CODE, 'That download is gone.'),

    onChecksumProgress: () => () => undefined,

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
      mediaDetails.set(job.id, {
        sourceUrl: sourceUrlsByAnalysis.get(analysis.analysisId) ?? null,
        filePath: null
      })
      return ok(emitMedia())
    },

    getMediaSnapshot: async () => ok(mediaSnapshot()),

    getMediaJobDetails: async (jobId: string) => {
      const details = mediaDetails.get(jobId)
      return details !== undefined
        ? ok({ ...details })
        : fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
    },

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

    pauseMedia: async (jobId: string) => {
      const job = findMediaJob(jobId)
      if (!job) return fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
      if (
        job.status === 'queued' ||
        job.status === 'analyzing' ||
        job.status === 'downloading' ||
        job.status === 'merging'
      ) {
        job.status = 'paused'
        job.speedBps = 0
        job.updatedAt = now()
      }
      return ok(emitMedia())
    },

    resumeMedia: async (jobId: string) => {
      const job = findMediaJob(jobId)
      if (!job) return fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
      if (job.status === 'paused') {
        job.status = 'queued'
        job.errorMessage = null
        job.completedAt = null
        job.updatedAt = now()
      }
      return ok(emitMedia())
    },

    retryMedia: async (jobId: string) => {
      const job = findMediaJob(jobId)
      if (!job) return fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
      if (
        job.status === 'error' ||
        job.status === 'cancelled' ||
        job.status === 'interrupted'
      ) {
        job.status = 'queued'
        job.completedBytes = 0
        job.errorMessage = null
        job.completedAt = null
        job.updatedAt = now()
      }
      return ok(emitMedia())
    },

    removeMedia: async (jobId: string) => {
      mediaJobs = mediaJobs.filter((job) => job.id !== jobId)
      return ok(emitMedia())
    },

    removeMediaJobs: async (ids: string[]) => {
      const gone = new Set(ids)
      mediaJobs = mediaJobs.filter((job) => !gone.has(job.id))
      return ok(emitMedia())
    },

    deleteMediaFile: async (jobId: string) => {
      const job = findMediaJob(jobId)
      if (!job) return fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
      if (job.status !== 'complete') {
        return fail('FILE_NOT_READY', 'Only a finished media job can be deleted.')
      }
      mediaJobs = mediaJobs.filter((candidate) => candidate.id !== jobId)
      return ok(emitMedia())
    },

    showMediaInFolder: async (jobId: string) =>
      findMediaJob(jobId)
        ? ok(null)
        : fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.'),

    openMediaFile: async (jobId: string) => {
      const job = findMediaJob(jobId)
      if (!job) return fail(PREVIEW_NOT_FOUND_CODE, 'That media job is gone.')
      if (job.status !== 'complete') {
        return fail('FILE_NOT_READY', 'The media file is not ready yet.')
      }
      return ok(null)
    },

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
      const snapshot = cloneSettings(settings)
      for (const listener of settingsListeners) listener(snapshot)
      return ok(cloneSettings(settings))
    },

    onSettingsChanged: (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },

    getDesktopSettings: async () => ok({ ...desktopSettings }),

    updateDesktopSettings: async (value: DesktopSettings) => {
      try {
        desktopSettings = parseDesktopSettings(value)
      } catch (error) {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          error instanceof Error ? error.message : 'Invalid settings.'
        )
      }
      return ok({ ...desktopSettings })
    },

    onDesktopSettingsChanged: () => () => undefined,

    copyText: async (_text: string) => ok(null),

    onClipboardLink: () => () => undefined,

    onRevealRow: () => () => undefined,

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
      }),

    getBrowserExtensionStatus: async () => ok(browserExtensionFixture),
    repairBrowserExtension: async () => ok(browserExtensionFixture),
    openBrowserExtensionFolder: async () => ok(null),
    copyBrowserExtensionFolderPath: async () => ok(null),
    getAppUpdateState: async () => ok(appUpdateState()),

    checkAppUpdate: async () => ok(emitAppUpdate()),

    installAppUpdate: async () => ok(emitAppUpdate()),

    setAppUpdateAutoCheck: async (input: { autoCheck: boolean }) => {
      appUpdateSettings = {
        ...appUpdateSettings,
        autoCheck: input.autoCheck
      }
      return ok(emitAppUpdate())
    },

    onAppUpdateStateChanged: (listener) => {
      appUpdateListeners.add(listener)
      return () => appUpdateListeners.delete(listener)
    },

    startScan: async (input: ScanStartInput) => {
      let url: string
      try {
        url = normalizeHttpUrl(input.url)
      } catch (error) {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          error instanceof Error ? error.message : 'Enter a page URL to scan.'
        )
      }
      const created = createScanSession(url)
      emitScan(created)
      scheduleScanCompletion(created.sessionId)
      return ok(created)
    },

    startScans: async (urls: string[]) => {
      const sessions: ScanSession[] = []
      for (const rawUrl of urls.slice(0, 10)) {
        let url: string
        try {
          url = normalizeHttpUrl(rawUrl)
        } catch (error) {
          return fail(
            PREVIEW_INVALID_INPUT_CODE,
            error instanceof Error ? error.message : 'Enter a page URL to scan.'
          )
        }
        const created = createScanSession(url)
        emitScan(created)
        scheduleScanCompletion(created.sessionId)
        sessions.push(created)
      }
      if (sessions.length === 0) {
        return fail(PREVIEW_INVALID_INPUT_CODE, 'Enter at least one page URL.')
      }
      return ok(sessions)
    },

    cancelScan: async (sessionId: string) => {
      const session = findScanSession(sessionId)
      if (session === undefined) {
        return fail(PREVIEW_NOT_FOUND_CODE, 'That scan no longer exists.')
      }
      const cancelled: ScanSession = {
        ...session,
        status: 'cancelled',
        message: 'The scan was cancelled.',
        revision: session.revision + 1,
        updatedAt: now(),
        items: []
      }
      emitScan(cancelled)
      return ok(cancelled)
    },

    queueScanSelection: async (
      sessionId: string,
      itemIds: string[],
      _videoOptions?: ScanQueueVideoOption[],
      _pairings?: ScanScriptPairingInput[]
    ): Promise<ApiResult<ScanQueueResult>> =>
      queueForSession(sessionId, itemIds),

    queueScanSelections: async (
      selections: ScanQueueSelectionInput[]
    ): Promise<ApiResult<ScanQueueSelectionsResult>> => {
      const results: ScanQueueSelectionOutcome[] = []
      for (const selection of selections) {
        const result = queueForSession(selection.sessionId, selection.itemIds)
        results.push(
          result.ok
            ? {
                sessionId: selection.sessionId,
                ok: true,
                value: result.value
              }
            : {
                sessionId: selection.sessionId,
                ok: false,
                error: result.error
              }
        )
      }
      return ok({ results })
    },

    openScanInBrowser: async (
      sessionId: string,
      itemId: string,
      pairing?: ScanBrowserScriptSelection
    ): Promise<ApiResult<null>> => {
      const session = findScanSession(sessionId)
      if (session === undefined) {
        return fail(PREVIEW_NOT_FOUND_CODE, 'Scan the page again.')
      }
      const item = session.items.find((candidate) => candidate.id === itemId)
      if (!item || item.status !== 'browser-only') {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          'Only a browser-only video card can be opened this way.'
        )
      }
      if (pairing !== undefined) {
        const updated: ScanItem = { ...item, browserMatchPending: true }
        const updatedSession: ScanSession = {
          ...session,
          items: session.items.map((candidate) =>
            candidate.id === itemId ? updated : candidate
          ),
          revision: session.revision + 1,
          updatedAt: now()
        }
        emitScan(updatedSession)
      }
      return ok(null)
    },

    markScanItemAsVideo: async (
      sessionId: string,
      itemId: string
    ): Promise<ApiResult<ScanSession>> => {
      const session = findScanSession(sessionId)
      if (session === undefined) {
        return fail(PREVIEW_NOT_FOUND_CODE, 'Scan the page again.')
      }
      const item = session.items.find((candidate) => candidate.id === itemId)
      if (!item) {
        return fail(PREVIEW_INVALID_INPUT_CODE, 'That link is not in this scan.')
      }
      if (item.kind === 'page-link' && item.category === 'video') {
        return ok(session)
      }
      if (item.kind !== 'page-link') {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          'Only a link on the page can be marked as a video.'
        )
      }
      const probing: ScanItem = {
        ...item,
        category: 'video',
        status: 'probing',
        verified: false
      }
      emitScan({
        ...session,
        items: session.items.map((candidate) =>
          candidate.id === itemId ? probing : candidate
        ),
        revision: session.revision + 1,
        updatedAt: now()
      })
      const template = session.items.find(
        (candidate) =>
          candidate.category === 'video' &&
          candidate.kind === 'page-link' &&
          candidate.status === 'ready'
      )
      await new Promise((resolve) => setTimeout(resolve, 350))
      const ready: ScanItem = {
        ...probing,
        status: 'ready',
        verified: true,
        durationSeconds: template?.durationSeconds ?? 180,
        width: template?.width ?? 1920,
        height: template?.height ?? 1080,
        bestResolution: template?.bestResolution ?? '1080p',
        sizeIsEstimate: true,
        sizeBytes: template?.sizeBytes ?? 100 * 1024 * 1024,
        ...(template?.formats === undefined
          ? {}
          : { formats: template.formats }),
        ...(template?.bestOptionId === undefined
          ? {}
          : { bestOptionId: template.bestOptionId })
      }
      const live = findScanSession(sessionId)
      if (live === undefined) return fail(PREVIEW_NOT_FOUND_CODE, 'Scan the page again.')
      const done: ScanSession = {
        ...live,
        items: live.items.map((candidate) =>
          candidate.id === itemId ? ready : candidate
        ),
        revision: live.revision + 1,
        updatedAt: now()
      }
      emitScan(done)
      return ok(done)
    },
    pickScanMatchVideo: async (
      input: ScanManualMatchInput
    ): Promise<ApiResult<ScanManualMatchResult | null>> => {
      const session = findScanSession(input.sessionId)
      if (session === undefined) {
        return fail(PREVIEW_NOT_FOUND_CODE, 'Scan the page again.')
      }
      const scripts = session.items.filter((item) =>
        input.scriptItemIds.includes(item.id)
      )
      if (scripts.length === 0) {
        return fail(
          PREVIEW_INVALID_INPUT_CODE,
          'Choose at least one script to match.'
        )
      }
      const batchId = nextId('preview-batch')
      const createdAt = now()
      const items = scripts.map((script, position) =>
        makeBatchItem({
          id: nextId('preview-item'),
          batchId,
          position,
          kind: 'download',
          status: 'queued',
          title: script.name,
          label: 'Scanned file',
          childId: null,
          completedBytes: 0,
          totalBytes: null,
          errorMessage: null,
          createdAt,
          updatedAt: createdAt,
          completedAt: null
        })
      )
      const batch = finalizeBatch({
        id: batchId,
        kind: 'direct-urls',
        title: `Scan: ${input.setId.replace(/^set:/u, '')}`,
        status: 'queued',
        progress: summarizeBatchItems(items),
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        items
      })
      batches.unshift(batch)
      for (const listener of batchListeners) listener(batchSnapshot())
      return ok({
        batchId,
        filename: `${session.items.find((item) => item.id === input.videoItemId)?.name ?? 'Hanime1 Watch Video'}.mp4`
      })
    },

    onScanUpdated: (listener) => {
      scanListeners.add(listener)
      return () => scanListeners.delete(listener)
    }
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
    theme: 'dark',
    sortDownloadsByType: false
  }
}

function seedDesktopSettings(): DesktopSettings {
  return {
    ...defaultDesktopSettings(),
    watchClipboard: true,
    interfaceSizePercent: 110
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
    },
    {
      id: 'preview-download-document',
      gid: 'preview-gid-document',
      url: 'https://files.example.org/reports/quarterly-report-2026.pdf',
      filename: 'quarterly-report-2026.pdf',
      dir: 'Downloads/DonDownload',
      filePath: 'Downloads/DonDownload/quarterly-report-2026.pdf',
      status: 'complete',
      totalBytes: 6 * mib,
      completedBytes: 6 * mib,
      speedBps: 0,
      etaSeconds: 0,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 26 * minute,
      updatedAt: anchor - 24 * minute,
      completedAt: anchor - 24 * minute,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 8,
      blockReason: null
    },
    {
      id: 'preview-download-archive',
      gid: 'preview-gid-archive',
      url: 'https://cdn.example.net/brand/brand-assets-2026.7z',
      filename: 'brand-assets-2026.7z',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'queued',
      totalBytes: 1_220 * mib,
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 0,
      maxAttempts: 5,
      createdAt: anchor - 12 * minute,
      updatedAt: anchor - 12 * minute,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 4,
      blockReason: null
    },
    {
      id: 'preview-download-program',
      gid: 'preview-gid-program',
      url: 'https://downloads.example.com/toolbox-setup-2.4.exe',
      filename: 'toolbox-setup-2.4.exe',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'queued',
      totalBytes: 84 * mib,
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 0,
      maxAttempts: 5,
      createdAt: anchor - 8 * minute,
      updatedAt: anchor - 8 * minute,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: 1 * mib,
      connections: 2,
      blockReason: null
    },
    {
      id: 'preview-download-video',
      gid: 'preview-gid-video',
      url: 'https://media.example.com/launch/launch-teaser.mp4',
      filename: 'launch-teaser.mp4',
      dir: 'Downloads/DonDownload',
      filePath: 'Downloads/DonDownload/launch-teaser.mp4',
      status: 'complete',
      totalBytes: 148 * mib,
      completedBytes: 148 * mib,
      speedBps: 0,
      etaSeconds: 0,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 34 * minute,
      updatedAt: anchor - 32 * minute,
      completedAt: anchor - 32 * minute,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 8,
      blockReason: null
    },
    {
      id: 'preview-download-audio-active',
      gid: 'preview-gid-audio-active',
      url: 'https://audio.example.com/scores/documentary-score.flac',
      filename: 'documentary-score.flac',
      dir: 'Downloads/DonDownload',
      filePath: null,
      status: 'active',
      totalBytes: 240 * mib,
      completedBytes: 108 * mib,
      speedBps: 1_150_000,
      etaSeconds: 120,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 14 * minute,
      updatedAt: anchor - 1_000,
      completedAt: null,
      scheduledAt: null,
      speedLimitBps: null,
      connections: 6,
      blockReason: null
    },
    {
      id: 'preview-download-other',
      gid: 'preview-gid-other',
      url: 'https://mirror.example.org/releases/checksums',
      filename: 'checksums',
      dir: 'Downloads/DonDownload',
      filePath: 'Downloads/DonDownload/checksums',
      status: 'complete',
      totalBytes: 12_400,
      completedBytes: 12_400,
      speedBps: 0,
      etaSeconds: 0,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 5,
      createdAt: anchor - 42 * minute,
      updatedAt: anchor - 42 * minute,
      completedAt: anchor - 42 * minute,
      scheduledAt: null,
      speedLimitBps: null,
      connections: null,
      blockReason: null
    }
  ]
}

/** Display-only details pane data keyed by the seeded media job IDs. */
function seedMediaJobDetails(): Map<string, MediaJobDetails> {
  return new Map<string, MediaJobDetails>([
    [
      'preview-media-downloading',
      {
        sourceUrl: 'https://videos.example.com/watch/deep-work-focus-session',
        filePath: null
      }
    ],
    [
      'preview-media-merging',
      {
        sourceUrl: 'https://videos.example.com/watch/design-systems-in-practice',
        filePath: null
      }
    ],
    [
      'preview-media-merging-unknown',
      {
        sourceUrl: 'https://videos.example.com/watch/field-recordings-harbour',
        filePath: null
      }
    ],
    [
      'preview-media-complete',
      {
        sourceUrl: 'https://audio.example.com/mixes/ambient-coding-mix',
        filePath: 'Downloads/DonDownload/Ambient coding mix.m4a'
      }
    ],
    [
      'preview-media-error',
      {
        sourceUrl:
          'https://videos.example.com/watch/conference-keynote-archive',
        filePath: null
      }
    ],
    [
      'preview-media-queued-video',
      {
        sourceUrl: 'https://videos.example.com/watch/product-launch-keynote',
        filePath: null
      }
    ],
    [
      'preview-media-starting',
      {
        sourceUrl: 'https://videos.example.com/watch/aerial-coastline-in-4k',
        filePath: null
      }
    ],
    [
      'preview-media-queued-audio',
      {
        sourceUrl: 'https://audio.example.com/episodes/weekly-design-notes-12',
        filePath: null
      }
    ]
  ])
}

function seedMediaJobs(anchor: number): MediaJob[] {  const minute = 60_000
  const mib = 1024 * 1024

  return [
    {
      id: 'preview-media-downloading',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-1080',
      kind: 'video',
      title: 'Deep Work: Focus Session',
      label: '1080p · MP4 · video + audio',
      status: 'downloading',
      completedBytes: 74 * mib,
      totalBytes: 420 * mib,
      speedBps: 3_200_000,
      errorMessage: null,
      createdAt: anchor - 24 * minute,
      updatedAt: anchor - 1_000,
      completedAt: null,
      thumbnailUrl: PREVIEW_THUMBNAIL_A
    },
    {
      // Merging with a measured merge output: determinate bar and byte detail.
      id: 'preview-media-merging',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-720',
      kind: 'video',
      title: 'Design systems in practice',
      label: '720p · MP4 · video + audio',
      status: 'merging',
      completedBytes: 268 * mib,
      totalBytes: 268 * mib,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 45 * minute,
      updatedAt: anchor - 4_000,
      completedAt: null,
      mergeProgress: { completedBytes: 104 * mib, totalBytes: 268 * mib },
      thumbnailUrl: PREVIEW_THUMBNAIL_B
    },
    {
      // Merging without a measurable output: the honest indeterminate shimmer.
      id: 'preview-media-merging-unknown',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-1080',
      kind: 'video',
      title: 'Field recordings: harbour at dawn',
      label: '1080p · MKV · video + audio',
      status: 'merging',
      completedBytes: 1_240 * mib,
      totalBytes: 1_240 * mib,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 52 * minute,
      updatedAt: anchor - 3_000,
      completedAt: null
    },
    {
      id: 'preview-media-complete',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-audio',
      kind: 'audio',
      title: 'Ambient coding mix',
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
      title: 'Conference keynote archive',
      label: '480p · MP4 · video + audio',
      status: 'error',
      completedBytes: 12 * mib,
      totalBytes: 180 * mib,
      speedBps: 0,
      errorMessage: 'The fixture media engine stopped before merging.',
      createdAt: anchor - 5 * 60 * minute,
      updatedAt: anchor - 4 * 60 * minute,
      completedAt: null
    },
    {
      id: 'preview-media-queued-video',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-1080',
      kind: 'video',
      title: 'Product launch keynote',
      label: '1080p · MP4 · video + audio',
      status: 'queued',
      completedBytes: 0,
      totalBytes: 640 * mib,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 6 * minute,
      updatedAt: anchor - 6 * minute,
      completedAt: null,
      thumbnailUrl: PREVIEW_THUMBNAIL_B
    },
    {
      id: 'preview-media-starting',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-2160',
      kind: 'video',
      title: 'Aerial coastline in 4K',
      label: '2160p · MKV · video + audio',
      status: 'downloading',
      completedBytes: 0,
      totalBytes: null,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 2 * minute,
      updatedAt: anchor - 30_000,
      completedAt: null
    },
    {
      id: 'preview-media-queued-audio',
      analysisId: 'preview-analysis-seed',
      optionId: 'preview-option-audio',
      kind: 'audio',
      title: 'Weekly design notes, episode 12',
      label: 'Audio only · M4A',
      status: 'queued',
      completedBytes: 0,
      totalBytes: 52 * mib,
      speedBps: 0,
      errorMessage: null,
      createdAt: anchor - 9 * minute,
      updatedAt: anchor - 9 * minute,
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
    title: 'Focus Sessions — Complete Collection',
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
      label: 'Pixeldrain file',
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
      label: 'Pixeldrain file',
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
      title: 'Focus Sessions — Complete Collection',
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
      title: 'Shared assets · Pixeldrain list',
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
    ? `${qualityLabel(selected)} · playlist`
    : preview.kind === 'mega-folder'
      ? 'MEGA file'
      : 'Pixeldrain file'
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

/** Deterministic, correctly sized placeholder digest for the preview only. */
function previewHash(algorithm: ChecksumAlgorithm, seed: string): string {
  const length = CHECKSUM_HEX_LENGTHS[algorithm]
  const alphabet = '0123456789abcdef'
  let state = 17
  let value = ''
  for (let index = 0; index < length; index += 1) {
    const code = seed.length > 0 ? seed.charCodeAt(index % seed.length) : 0
    state = (state * 31 + code + index) >>> 0
    value += alphabet[state % 16]
  }
  return value
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
