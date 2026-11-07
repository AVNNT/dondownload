import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaJob, MediaSnapshot } from '../src/shared/media'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import { BatchManager } from '../src/main/batches/manager'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-batch-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function aria() {
  return {
    status: 'ready' as const,
    version: '1.37.0',
    binaryPath: null,
    message: null,
    hint: null
  }
}

describe('batch post-download pairing', () => {
  it('downloads paired scripts into the video folder and renames them when complete', async () => {
    const root = await tempRoot()
    const mediaDir = path.join(root, 'Media')
    await fs.mkdir(mediaDir, { recursive: true })

    let sequence = 0
    const downloads = new Map<string, DownloadItem>()
    const mediaJobs = new Map<string, MediaJob>()
    const mediaPaths = new Map<string, string>()
    const addScanDirectories: string[] = []

    const createDownload = (
      input: { url: string; filename?: string },
      directory: string
    ): DownloadItem => {
      const id = `dl_${sequence++}`
      const item: DownloadItem = {
        id,
        gid: `gid_${id}`,
        url: input.url,
        filename: input.filename ?? 'file.bin',
        dir: directory,
        filePath: null,
        status: 'queued',
        totalBytes: 10,
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
      downloads.set(id, item)
      return item
    }

    const snapshot = (): AppSnapshot => ({
      aria2: aria(),
      downloads: [...downloads.values()]
    })

    const downloadsPort = {
      add: vi.fn(async (input: unknown) => {
        createDownload(input as { url: string; filename?: string }, root)
        return snapshot()
      }),
      addScanFile: vi.fn(async (input: unknown, directory: string) => {
        addScanDirectories.push(directory)
        createDownload(input as { url: string; filename?: string }, directory)
        return snapshot()
      }),
      pause: vi.fn(async () => undefined),
      getSnapshot: vi.fn(() => snapshot()),
      getItem: (id: string) => downloads.get(id) ?? null,
      getFilePath: (id: string) => downloads.get(id)?.filePath ?? null,
      adoptRenamedFile: (id: string, filePath: string) => {
        const item = downloads.get(id)
        if (!item) return
        item.filePath = filePath
        item.filename = path.basename(filePath)
      }
    }

    const mediaSnapshot = (): MediaSnapshot => ({
      tool: {
        status: 'ready',
        version: '2026.10.26',
        message: null,
        hint: null
      },
      jobs: [...mediaJobs.values()]
    })

    const mediaPort = {
      analyzeMedia: vi.fn(async () => {
        throw new Error('not used for a pinned scanner selection')
      }),
      queueMedia: vi.fn(async (input: unknown) => {
        const record = input as { analysisId: string; optionId: string }
        const job: MediaJob = {
          id: `media_${sequence++}`,
          analysisId: record.analysisId,
          optionId: record.optionId,
          kind: 'video',
          title: 'Fancam 01 Wonyoung',
          label: '1080p · MP4',
          status: 'queued',
          completedBytes: 0,
          totalBytes: 100,
          speedBps: 0,
          errorMessage: null,
          createdAt: 1,
          updatedAt: 1,
          completedAt: null
        }
        mediaJobs.set(job.id, job)
        return job
      }),
      cancelMedia: vi.fn(async () => {
        throw new Error('not used')
      }),
      getMediaSnapshot: vi.fn(() => mediaSnapshot()),
      getJob: (id: string) => mediaJobs.get(id) ?? null,
      getFilePath: (id: string) => mediaPaths.get(id) ?? null
    }

    const batches = new BatchManager({
      downloads: downloadsPort,
      mediaJobs: mediaPort,
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
      pollIntervalMs: 0,
      scanMediaDir: mediaDir,
      scanRootDir: root
    })

    const batch = await batches.createScanMediaBatch({
      title: 'Scan: discuss.example',
      files: [
        {
          url: 'https://discuss.example/uploads/a.funscript',
          title: 'Old.funscript',
          filename: 'Old.funscript',
          scanItemId: 'item_script_main'
        },
        {
          url: 'https://discuss.example/uploads/b.funscript',
          title: 'Old.roll.funscript',
          filename: 'Old.roll.funscript',
          scanItemId: 'item_script_roll'
        }
      ],
      videos: [
        {
          url: 'https://youtube.com/watch?v=abc',
          title: 'Fancam 01 Wonyoung',
          analysisId: 'analysis_1',
          optionId: 'opt_1',
          scanItemId: 'item_video'
        }
      ],
      pairings: [
        {
          videoItemId: 'item_video',
          setId: 'set:fancam-01@10',
          scriptItemIds: ['item_script_main', 'item_script_roll'],
          primaryVariant: null,
          rename: true
        }
      ]
    })

    await batches.waitForIdle()

    // Paired scripts were queued into the video folder, not the download root.
    expect(addScanDirectories).toEqual([mediaDir, mediaDir])

    const videoFile = path.join(mediaDir, 'Fancam 01 Wonyoung.mp4')
    const mainFile = path.join(mediaDir, 'Old.funscript')
    const rollFile = path.join(mediaDir, 'Old.roll.funscript')
    await fs.writeFile(videoFile, 'video')
    await fs.writeFile(mainFile, 'main')
    await fs.writeFile(rollFile, 'roll')

    for (const download of downloads.values()) {
      download.status = 'complete'
      download.filePath = path.join(download.dir, download.filename)
      download.completedBytes = 10
      download.completedAt = 2
    }
    const videoJob = [...mediaJobs.values()][0]!
    videoJob.status = 'complete'
    videoJob.completedAt = 2
    mediaPaths.set(videoJob.id, videoFile)

    batches.refresh()
    await batches.waitForIdle()

    const finished = batches.getBatch(batch.id)
    const scriptLabels = finished.items
      .filter((item) => item.kind === 'download')
      .map((item) => item.label)
    expect(scriptLabels).toEqual([
      'Renamed to match video',
      'Renamed to match video'
    ])
    expect((await fs.readdir(mediaDir)).sort()).toEqual([
      'Fancam 01 Wonyoung.funscript',
      'Fancam 01 Wonyoung.mp4',
      'Fancam 01 Wonyoung.roll.funscript'
    ])
    expect(await fs.readFile(path.join(mediaDir, 'Fancam 01 Wonyoung.roll.funscript'), 'utf8')).toBe(
      'roll'
    )
  })
})
