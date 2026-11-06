import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import { BatchManager } from '../src/main/batches/manager'
import { ScanQueueService } from '../src/main/scanner/queue'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import { ScanSessionManager } from '../src/main/scanner/session'
import { parseScanImagesRequest } from '../src/shared/scanImages'

const PAGE_URL = 'https://www.pinterest.com/ideas/autumn-outfits/9/'
const PAGE_TITLE = 'Autumn outfit ideas'
const HOST = 'i.pinimg.com'

function pin(hash: string): { url: string; fallbackUrl: string } {
  const dir = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4, 6)}`
  return {
    url: `https://${HOST}/originals/${dir}/${hash}.jpg`,
    fallbackUrl: `https://${HOST}/736x/${dir}/${hash}.jpg`
  }
}

function imageRequest(count = 3) {
  return parseScanImagesRequest({
    pageUrl: PAGE_URL,
    pageTitle: PAGE_TITLE,
    images: Array.from({ length: count }, (_value, index) => {
      const entry = pin(`aabbccddeeff${index.toString(16).padStart(4, '0')}`)
      return { url: entry.url, fallbackUrl: entry.fallbackUrl }
    })
  })
}

function downloadRecord(url: string, id: string, dir: string): DownloadItem {
  return {
    id,
    gid: id,
    url,
    filename: url.split('/').pop() ?? 'image.jpg',
    dir,
    filePath: null,
    status: 'queued',
    totalBytes: 1_000,
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
}

/** Minimal download port that records the folder each child was created in. */
function createDownloads() {
  const records: DownloadItem[] = []
  const addCalls: Array<{ url: string; filename?: string }> = []
  const scanFileCalls: Array<{ url: string; directory: string }> = []
  let counter = 0

  function create(input: unknown, directory: string): AppSnapshot {
    const record = input as { url: string; filename?: string }
    counter += 1
    const id = `child_${counter}`
    addCalls.push({ url: record.url, ...(record.filename === undefined ? {} : { filename: record.filename }) })
    records.push(downloadRecord(record.url, id, directory))
    return {
      aria2: {
        status: 'ready',
        version: '1.37.0',
        binaryPath: null,
        message: null,
        hint: null
      },
      downloads: records.map((entry) => ({ ...entry }))
    }
  }

  return {
    records,
    addCalls,
    scanFileCalls,
    add: vi.fn(async (input: unknown) => create(input, 'C:\\Downloads')),
    addScanFile: vi.fn(async (input: unknown, directory: string) => {
      scanFileCalls.push({
        url: (input as { url: string }).url,
        directory
      })
      return create(input, directory)
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
      downloads: records.map((entry) => ({ ...entry }))
    })),
    failLast(message: string): void {
      const record = records[records.length - 1]
      if (record === undefined) throw new Error('no child to fail')
      record.status = 'error'
      record.errorMessage = message
    }
  }
}

function createBatchManager(downloads: ReturnType<typeof createDownloads>) {
  return new BatchManager({
    downloads,
    mediaJobs: {
      analyzeMedia: vi.fn(),
      queueMedia: vi.fn(),
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
    pollIntervalMs: 0,
    scanRootDir: 'C:\\Downloads'
  })
}

const neverProbe: ProbeScanItemFn = async () => {
  throw new Error('an image must never be probed at queue time')
}

describe('image scan sessions', () => {
  it('fills a done session from the reported list without fetching the page', () => {
    const fetchPage = vi.fn()
    const sessions = new ScanSessionManager({
      fetchPage,
      onUpdate: () => undefined
    })

    const session = sessions.startImages(imageRequest(3))

    expect(fetchPage).not.toHaveBeenCalled()
    expect(session.mode).toBe('images')
    expect(session.status).toBe('done')
    expect(session.origin).toBe('extension')
    expect(session.title).toBe(PAGE_TITLE)
    expect(session.hostname).toBe('www.pinterest.com')
    expect(session.items).toHaveLength(3)
    const first = session.items[0]
    expect(first).toMatchObject({
      category: 'image',
      kind: 'file',
      status: 'ready',
      hostname: HOST,
      name: 'aabbccddeeff0000.jpg'
    })
    // The grid thumbnail is the small variant, not the downloaded original.
    expect(first?.thumbnailUrl).toBe(
      'https://i.pinimg.com/736x/aa/bb/cc/aabbccddeeff0000.jpg'
    )
  })

  it('keeps the internal fallback URL out of the public snapshot', () => {
    const sessions = new ScanSessionManager({ onUpdate: () => undefined })
    const session = sessions.startImages(imageRequest(1))
    const item = session.items[0] as unknown as Record<string, unknown>
    expect(item.fallbackUrl).toBeUndefined()
    expect(item.url).toBeUndefined()
    expect(item.thumbnailUrl).toContain('/736x/')
  })

  it('rejects a list whose URLs all fail normalization', () => {
    const sessions = new ScanSessionManager({ onUpdate: () => undefined })
    expect(() =>
      sessions.startImages({
        type: 'scan-images',
        pageUrl: PAGE_URL,
        pageTitle: PAGE_TITLE,
        images: [{ url: 'not a url' }]
      })
    ).toThrow()
  })
})

describe('image queue path', () => {
  it('queues one batch in a folder named after the page, without probing', async () => {
    const sessions = new ScanSessionManager({ onUpdate: () => undefined })
    const downloads = createDownloads()
    const batches = createBatchManager(downloads)
    const queue = new ScanQueueService({
      sessions,
      batches,
      probeItem: neverProbe
    })

    const session = sessions.startImages(imageRequest(3))
    const ids = session.items.map((item) => item.id)
    const result = await queue.queueSelection(session.sessionId, ids)
    await batches.waitForIdle()

    expect(result.queuedItemIds).toEqual(ids)
    expect(result.skipped).toEqual([])
    expect(result.batch?.title).toBe(`Images: ${PAGE_TITLE}`)
    expect(result.batch?.items).toHaveLength(3)
    // Every child lands in `<download root>/<page title>`.
    expect(downloads.scanFileCalls).toHaveLength(3)
    for (const call of downloads.scanFileCalls) {
      expect(call.directory).toBe('C:\\Downloads\\Autumn outfit ideas')
    }
    expect(downloads.add).not.toHaveBeenCalled()
    expect(downloads.addCalls[0]?.url).toContain('/originals/')
  })

  it('retries the 736x fallback once when the original fails', async () => {
    const sessions = new ScanSessionManager({ onUpdate: () => undefined })
    const downloads = createDownloads()
    const batches = createBatchManager(downloads)
    const queue = new ScanQueueService({
      sessions,
      batches,
      probeItem: neverProbe
    })

    const session = sessions.startImages(imageRequest(1))
    await queue.queueSelection(session.sessionId, [session.items[0]!.id])
    await batches.waitForIdle()
    expect(downloads.addCalls).toHaveLength(1)
    expect(downloads.addCalls[0]?.url).toContain('/originals/')

    downloads.failLast('HTTP 403')
    batches.refresh()
    await batches.waitForIdle()

    expect(downloads.addCalls).toHaveLength(2)
    expect(downloads.addCalls[1]?.url).toContain('/736x/')
  })
})

describe('image batch folder validation', () => {
  it('rejects a folder that could escape the download root', async () => {
    const downloads = createDownloads()
    const batches = createBatchManager(downloads)
    for (const subfolder of ['..', '../escape', 'a/b', 'C:evil', 'name.', '']) {
      await expect(
        batches.createScanBatch({
          title: 'Images: page',
          targets: [{ url: 'https://i.pinimg.com/originals/aa/bb/cc/x.jpg', title: 'x.jpg' }],
          subfolder
        })
      ).rejects.toThrow()
    }
    expect(downloads.addCalls).toHaveLength(0)
  })

  it('accepts a plain folder name and one fallback URL per target', async () => {
    const downloads = createDownloads()
    const batches = createBatchManager(downloads)
    const batch = await batches.createScanBatch({
      title: 'Images: page',
      targets: [
        {
          url: 'https://i.pinimg.com/originals/aa/bb/cc/x.jpg',
          title: 'x.jpg',
          fallbackUrl: 'https://i.pinimg.com/736x/aa/bb/cc/x.jpg'
        }
      ],
      subfolder: 'Autumn outfit ideas'
    })
    await batches.waitForIdle()
    expect(batch.items).toHaveLength(1)
    expect(downloads.scanFileCalls[0]?.directory).toBe(
      'C:\\Downloads\\Autumn outfit ideas'
    )
  })
})
