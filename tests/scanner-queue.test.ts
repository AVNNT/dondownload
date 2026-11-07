import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import {
  BatchManager,
  type BatchPixeldrainPort
} from '../src/main/batches/manager'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import { ScanQueueService } from '../src/main/scanner/queue'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import { ScanSessionManager, type ScanPageFetcher } from '../src/main/scanner/session'

const PAGE_URL = 'https://forum.example/thread/example-346779'

const page: ScanPageFetcher = async () => {
  const body = `
    <a class="attachment" href="/uploads/a.zip">a.zip</a>
    <a class="attachment" href="/uploads/b.funscript">b.funscript</a>
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
    contentType: input.url.endsWith('.funscript')
      ? 'application/json'
      : 'application/zip'
  })
  return {
    status: 'ready',
    verified: true,
    contentType: input.url.endsWith('.funscript')
      ? 'application/json'
      : 'application/zip',
    contentDisposition: null,
    sizeBytes: 2048,
    finalUrl: input.url,
    classification,
    reason: null
  }
}

function createBatchManager(
  pixeldrain: BatchPixeldrainPort = {
    parseLink: vi.fn(),
    resolveFile: vi.fn(),
    resolveList: vi.fn()
  }
) {
  const added: unknown[] = []
  const downloads = {
    add: vi.fn(async (input: unknown): Promise<AppSnapshot> => {
      added.push(input)
      const record = input as { url: string }
      const child: DownloadItem = {
        id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gid: 'gid',
        url: record.url,
        filename: 'a.zip',
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
    getItem: vi.fn(() => null),
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
  const batches = new BatchManager({
    downloads,
    mediaJobs: {
      analyzeMedia: vi.fn(),
      queueMedia: vi.fn(),
      cancelMedia: vi.fn(),
      getMediaSnapshot: vi.fn(() => ({ tool: {} as never, jobs: [] })),
      getJob: vi.fn(() => null)
    },
    collectionEngine: {
      analyzeCollection: vi.fn(),
      resolveCollectionEntries: vi.fn()
    },
    pixeldrain: {
      parseLink: vi.fn(pixeldrain.parseLink),
      resolveFile: vi.fn(pixeldrain.resolveFile),
      resolveList: vi.fn(pixeldrain.resolveList)
    },
    onUpdate: () => undefined,
    pollIntervalMs: 0
  })
  return { batches, downloads, added }
}

describe('explicit scan queue selection', () => {
  it('queues nothing during discovery and one batch only after scan:queue-selection', async () => {
    const sessions = new ScanSessionManager({
      fetchPage: page,
      probeItem: readyProbe,
      onUpdate: () => undefined
    })
    const { batches, downloads, added } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      probeItem: readyProbe
    })

    const started = sessions.start(PAGE_URL, {
      origin: 'extension',
      cookie: 'auth=1'
    })
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.items).toHaveLength(2)
    // A full discovery/probe cycle has no queue path.
    expect(downloads.add).not.toHaveBeenCalled()
    expect(added).toHaveLength(0)

    const archive = done.items.find((item) => item.category === 'archive')
    expect(archive).toBeDefined()
    const result = await queue.queueSelection(started.sessionId, [archive!.id])
    await batches.waitForIdle()

    expect(result.queuedItemIds).toEqual([archive!.id])
    expect(result.skipped).toEqual([])
    expect(result.batch?.items).toHaveLength(1)
    expect(downloads.add).toHaveBeenCalledTimes(1)
    expect(added[0]).toMatchObject({
      url: 'https://forum.example/uploads/a.zip',
      filename: 'a.zip',
      resolvedUrl: 'https://forum.example/uploads/a.zip',
      requestHeaders: { cookie: 'auth=1' }
    })
  })

  it('reuses the queue-time probe final URL for a cross-host redirect', async () => {
    const sessions = new ScanSessionManager({
      fetchPage: page,
      probeItem: readyProbe,
      onUpdate: () => undefined
    })
    const { batches, added } = createBatchManager()
    const finalUrl = 'https://storage.example/uploads/a.zip?signature=abc'
    const crossHostProbe: ProbeScanItemFn = async (input) => ({
      ...(await readyProbe(input)),
      finalUrl
    })
    const queue = new ScanQueueService({
      sessions,
      batches,
      probeItem: crossHostProbe
    })

    const started = sessions.start(PAGE_URL, {
      origin: 'extension',
      cookie: 'auth=1'
    })
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)
    const archive = done.items.find((item) => item.category === 'archive')

    await queue.queueSelection(started.sessionId, [archive!.id])
    await batches.waitForIdle()

    expect(added[0]).toMatchObject({
      url: 'https://forum.example/uploads/a.zip',
      resolvedUrl: finalUrl,
      requestHeaders: { cookie: 'auth=1' }
    })
  })

  it('attempts every topic and reports a failure without discarding the rest', async () => {
    const urls = [
      'https://forum.example/thread/topic-a',
      'https://forum.example/thread/topic-b',
      'https://forum.example/thread/topic-c'
    ]
    const fetcher: ScanPageFetcher = async (input) => {
      const name = new URL(input.url).pathname.split('/').pop() ?? 'file'
      const body = `<a class="attachment" href="/uploads/${name}.zip">${name}.zip</a>`
      return {
        finalUrl: input.url,
        status: 200,
        contentType: 'text/html',
        contentDisposition: null,
        body,
        bytes: Buffer.byteLength(body)
      }
    }
    const sessions = new ScanSessionManager({
      fetchPage: fetcher,
      probeItem: readyProbe,
      onUpdate: () => undefined
    })
    const { batches } = createBatchManager()
    const queue = new ScanQueueService({
      sessions,
      batches,
      probeItem: readyProbe
    })

    const started = sessions.startMany(urls)
    await Promise.all(
      started.map((session) => sessions.waitForScan(session.sessionId))
    )
    const first = sessions
      .getSession(started[0]!.sessionId)
      .items.find((item) => item.category === 'archive')!
    const third = sessions
      .getSession(started[2]!.sessionId)
      .items.find((item) => item.category === 'archive')!

    const result = await queue.queueSelections([
      { sessionId: started[0]!.sessionId, itemIds: [first.id] },
      { sessionId: started[1]!.sessionId, itemIds: ['item_missing'] },
      { sessionId: started[2]!.sessionId, itemIds: [third.id] }
    ])
    await batches.waitForIdle()

    expect(result.results).toHaveLength(3)
    expect(result.results[0]).toMatchObject({
      sessionId: started[0]!.sessionId,
      ok: true,
      value: { queuedItemIds: [first.id] }
    })
    expect(result.results[1]).toMatchObject({
      sessionId: started[1]!.sessionId,
      ok: false,
      error: { code: 'SCAN_ITEM_NOT_FOUND' }
    })
    expect(result.results[2]).toMatchObject({
      sessionId: started[2]!.sessionId,
      ok: true,
      value: { queuedItemIds: [third.id] }
    })
    // The failure carries only a safe message, never a source URL or path.
    expect(JSON.stringify(result.results[1])).not.toContain('https://')
    expect(JSON.stringify(result.results[1])).not.toContain('forum.example')
  })

  it('never queues a page item and reports skipped selected files', async () => {    const sessions = new ScanSessionManager({
      fetchPage: page,
      probeItem: readyProbe,
      onUpdate: () => undefined
    })
    const { batches } = createBatchManager()
    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)
    const item = done.items[0]!

    const probeThatReclassifies: ProbeScanItemFn = async (input) => ({
      status: 'found',
      verified: false,
      contentType: 'text/html',
      contentDisposition: null,
      sizeBytes: null,
      finalUrl: null,
      classification: classifyScanCandidate({
        url: input.url,
        contentType: 'text/html'
      }),
      reason: null
    })
    const skippedQueue = new ScanQueueService({
      sessions,
      batches,
      probeItem: probeThatReclassifies
    })
    await expect(
      skippedQueue.queueSelection(started.sessionId, [item.id])
    ).rejects.toMatchObject({ code: 'SCAN_NOTHING_TO_QUEUE' })
  })

  it('queues a resolved Pixeldrain file with its canonical link and real name', async () => {
    const fetcher: ScanPageFetcher = async () => {
      const body =
        '<p><a href="https://pixeldrain.com/u/Video001">download</a></p>'
      return {
        finalUrl: PAGE_URL,
        status: 200,
        contentType: 'text/html',
        contentDisposition: null,
        body,
        bytes: Buffer.byteLength(body)
      }
    }
    const sessions = new ScanSessionManager({
      fetchPage: fetcher,
      followDepth: 0,
      pixeldrain: {
        resolveFile: async () => ({
          kind: 'file',
          fileId: 'Video001',
          name: 'Fancam 01 Wonyoung.mp4',
          size: 123_456,
          mimeType: 'video/mp4',
          sourceUrl: 'https://pixeldrain.com/u/Video001',
          downloadUrl: 'https://pixeldrain.com/api/file/Video001'
        }),
        resolveList: async () => {
          throw new Error('not a list')
        }
      },
      onUpdate: () => undefined
    })
    const { batches, downloads, added } = createBatchManager({
      parseLink: (value) => {
        const id = /\/u\/([A-Za-z0-9_-]+)$/.exec(String(value))?.[1]
        if (id === undefined) throw new Error('not a pixeldrain link')
        return { kind: 'file', id, sourceUrl: `https://pixeldrain.com/u/${id}` }
      },
      resolveFile: async () => ({
        kind: 'file',
        fileId: 'Video001',
        name: 'Fancam 01 Wonyoung.mp4',
        size: 123_456,
        mimeType: 'video/mp4',
        sourceUrl: 'https://pixeldrain.com/u/Video001',
        downloadUrl: 'https://pixeldrain.com/api/file/Video001'
      }),
      resolveList: async () => {
        throw new Error('not a list')
      }
    })
    const probe = vi.fn(readyProbe)
    const queue = new ScanQueueService({ sessions, batches, probeItem: probe })

    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)
    expect(done.items).toHaveLength(1)

    const result = await queue.queueSelection(started.sessionId, [
      done.items[0]!.id
    ])
    await batches.waitForIdle()

    expect(result.queuedItemIds).toEqual([done.items[0]!.id])
    expect(result.skipped).toEqual([])
    // The page is HTML, so the generic queue-time probe must not run.
    expect(probe).not.toHaveBeenCalled()
    expect(downloads.add).toHaveBeenCalledTimes(1)
    expect(added[0]).toMatchObject({
      url: 'https://pixeldrain.com/api/file/Video001',
      filename: 'Fancam 01 Wonyoung.mp4'
    })
  })
})
