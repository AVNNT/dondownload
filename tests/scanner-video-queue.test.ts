import { describe, expect, it, vi } from 'vitest'
import type { MediaAnalysis, MediaJob } from '../src/shared/media'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import {
  parseScanQueueSelectionInput
} from '../src/shared/scanner'
import { BatchManager } from '../src/main/batches/manager'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import { ScanQueueService } from '../src/main/scanner/queue'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const PAGE_URL = 'https://forum.example/thread/video'

function videoAnalysis(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    analysisId: 'analysis_old',
    title: 'Demo video',
    thumbnailUrl: null,
    durationSeconds: 60,
    options: [
      {
        kind: 'video',
        optionId: 'opt_old',
        label: '1080p · MP4',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'aac',
        hasAudio: true,
        requiresMerge: false,
        filesizeBytes: 1000,
        estimatedBytes: 1000,
        sizeIsEstimate: false,
        outputFormats: ['auto', 'mp4']
      }
    ],
    bestVideoOptionId: 'opt_old',
    bestAudioOptionId: null,
    expiresAt: 2_000,
    ...overrides
  }
}

const page: ScanPageFetcher = async () => {
  const body = `
    <iframe src="https://www.youtube.com/embed/AbCdEf12345" title="Demo"></iframe>
    <a class="attachment" href="/uploads/a.zip">a.zip</a>
  `
  return {
    finalUrl: PAGE_URL,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

const readyProbe: ProbeScanItemFn = async (input) => {
  const classification = classifyScanCandidate({
    url: input.url,
    contentType: 'application/zip'
  })
  return {
    status: 'ready',
    verified: true,
    contentType: 'application/zip',
    contentDisposition: null,
    sizeBytes: 2048,
    finalUrl: input.url,
    classification,
    reason: null
  }
}

function mediaJob(input: unknown): MediaJob {
  const record = input as {
    analysisId: string
    optionId: string
  }
  return {
    id: 'media_job_1',
    analysisId: record.analysisId,
    optionId: record.optionId,
    kind: 'video',
    title: 'Demo video',
    label: '1080p · MP4',
    status: 'queued',
    completedBytes: 0,
    totalBytes: 1000,
    speedBps: 0,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null
  }
}

function createBatchManager() {
  const added: unknown[] = []
  const downloads = {
    add: vi.fn(async (input: unknown): Promise<AppSnapshot> => {
      added.push(input)
      const record = input as { url: string; filename?: string }
      const child: DownloadItem = {
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gid: 'gid',
        url: record.url,
        filename: record.filename ?? 'a.zip',
        dir: 'C:\\Downloads',
        filePath: null,
        status: 'queued',
        totalBytes: 2048,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: 1,
        updatedAt: 1,
        completedAt: null
      }
      return {
        aria2: {
          status: 'ready',
          version: '1.37.0',
          binaryPath: null,
          message: null,
          hint: null
        },
        downloads: [child]
      }
    }),
    pause: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({
      aria2: {
        status: 'ready' as const,
        version: '1.37.0',
        binaryPath: null,
        message: null,
        hint: null
      },
      downloads: []
    }))
  }
  const queueMedia = vi.fn(async (input: unknown) => mediaJob(input))
  const analyzeMedia = vi.fn(async () =>
    videoAnalysis({
      analysisId: 'analysis_fresh',
      options: [
        {
          ...videoAnalysis().options[0]!,
          optionId: 'opt_fresh'
        }
      ],
      bestVideoOptionId: 'opt_fresh',
      expiresAt: 99_000
    })
  )
  const batches = new BatchManager({
    downloads,
    mediaJobs: {
      analyzeMedia,
      queueMedia,
      cancelMedia: vi.fn(),
      getMediaSnapshot: vi.fn(() => ({ tool: {} as never, jobs: [] }))
    },
    collectionEngine: {
      analyzeCollection: vi.fn(),
      resolveCollectionEntries: vi.fn()
    },
    pixeldrain: {
      parseLink: vi.fn(),
      resolveFile: vi.fn(),
      resolveList: vi.fn()
    },
    onUpdate: () => undefined,
    pollIntervalMs: 0
  })
  return { batches, downloads, added, queueMedia, analyzeMedia }
}

async function scannedSession(now: () => number) {
  const sessions = new ScanSessionManager({
    now,
    fetchPage: page,
    probeItem: readyProbe,
    followDepth: 0,
    analyzeMedia: async () => videoAnalysis(),
    onUpdate: () => undefined
  })
  const started = sessions.start(PAGE_URL)
  await sessions.waitForScan(started.sessionId)
  return { sessions, session: sessions.getSession(started.sessionId) }
}

describe('video queue selection', () => {
  it('queues a resolved video through the mixed scanner batch', async () => {
    const { sessions, session } = await scannedSession(() => 1_000)
    const { batches, queueMedia } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })
    const video = session.items.find((item) => item.category === 'video')!

    expect(video.status).toBe('ready')
    expect(video.formats?.length).toBe(1)

    const result = await queue.queueSelection(
      session.sessionId,
      [video.id],
      [{ itemId: video.id, optionId: video.bestOptionId ?? undefined }]
    )
    await batches.waitForIdle()

    expect(result.queuedItemIds).toEqual([video.id])
    expect(result.batch?.items).toHaveLength(1)
    expect(result.batch?.items[0]?.kind).toBe('media')
    expect(queueMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: 'analysis_old',
        optionId: 'opt_old'
      })
    )
  })

  it('forwards the probe-resolved URL for signed-in files in a mixed batch', async () => {
    const { batches, downloads } = createBatchManager()
    const finalUrl = 'https://storage.example/presigned/a.funscript?sig=1'

    await batches.createScanMediaBatch({
      title: 'Scan: forum.example',
      files: [
        {
          url: 'https://forum.example/uploads/short-url/a.funscript',
          title: 'a.funscript',
          filename: 'a.funscript',
          resolvedUrl: finalUrl,
          requestHeaders: { cookie: '_t=session' }
        }
      ],
      videos: [
        {
          url: 'https://video.example/watch?v=1',
          title: 'Video',
          analysisId: 'analysis_old',
          optionId: 'opt_old'
        }
      ]
    })
    await batches.waitForIdle()

    // DownloadManager uses resolvedUrl to decide the Cookie scope; without it
    // a cross-host redirect could not be detected before aria2 starts.
    expect(downloads.add).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://forum.example/uploads/short-url/a.funscript',
        resolvedUrl: finalUrl,
        requestHeaders: { cookie: '_t=session' }
      })
    )
  })

  it('rejects unknown fields on mixed batch file targets', async () => {
    const { batches } = createBatchManager()
    await expect(
      batches.createScanMediaBatch({
        title: 'Scan',
        files: [{ url: 'https://forum.example/a.zip', title: 'a', extra: 1 }],
        videos: []
      } as never)
    ).rejects.toThrow(/unsupported fields/)
  })

  it('queues direct files and videos in one batch', async () => {
    const { sessions, session } = await scannedSession(() => 1_000)
    const { batches, queueMedia, downloads } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })
    const video = session.items.find((item) => item.category === 'video')!
    const archive = session.items.find((item) => item.category === 'archive')!

    const result = await queue.queueSelection(session.sessionId, [
      video.id,
      archive.id
    ])
    await batches.waitForIdle()

    expect(result.queuedItemIds).toEqual([video.id, archive.id])
    expect(result.batch?.items).toHaveLength(2)
    expect(result.batch?.items.map((item) => item.kind).sort()).toEqual([
      'download',
      'media'
    ])
    expect(downloads.add).toHaveBeenCalledTimes(1)
    expect(queueMedia).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown option IDs and extra keys before queueing', async () => {
    expect(() =>
      parseScanQueueSelectionInput({
        sessionId: 'scan_1',
        itemIds: ['item_1'],
        videoOptions: [{ itemId: 'item_1', extra: true }]
      })
    ).toThrow()
    expect(() =>
      parseScanQueueSelectionInput({
        sessionId: 'scan_1',
        itemIds: ['item_1'],
        videoOptions: [{ itemId: 'item_1', outputFormat: 'avi' }]
      })
    ).toThrow()

    const { sessions, session } = await scannedSession(() => 1_000)
    const { batches } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })
    const video = session.items.find((item) => item.category === 'video')!

    await expect(
      queue.queueSelection(session.sessionId, [video.id], [
        { itemId: video.id, optionId: 'opt_unknown' }
      ])
    ).rejects.toMatchObject({ code: 'SCAN_OPTION_INVALID' })
  })

  it('re-analyzes an expired video selection before queueing', async () => {
    let now = 1_000
    const { sessions, session } = await scannedSession(() => now)
    const { batches, queueMedia, analyzeMedia } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia },
      probeItem: readyProbe,
      now: () => now
    })
    const video = session.items.find((item) => item.category === 'video')!

    now = 3_000
    const result = await queue.queueSelection(
      session.sessionId,
      [video.id],
      [{ itemId: video.id, optionId: video.bestOptionId ?? undefined }]
    )
    await batches.waitForIdle()

    expect(analyzeMedia).toHaveBeenCalledTimes(1)
    expect(queueMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: 'analysis_fresh',
        optionId: 'opt_fresh'
      })
    )
    expect(result.queuedItemIds).toEqual([video.id])
  })

  it('keeps source and format URLs out of the renderer DTO', async () => {
    const { session } = await scannedSession(() => 1_000)
    const serialized = JSON.stringify(session)
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('format_url')
    expect(serialized).not.toContain('youtube.com/embed')
  })
})
