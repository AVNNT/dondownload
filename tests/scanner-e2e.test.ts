import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }
  },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() }
}))

import { IPC } from '../src/shared/ipc'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import type { MediaAnalysis, MediaJob, MediaSnapshot } from '../src/shared/media'
import { isQueueableScanItem, type ScanSession } from '../src/shared/scanner'
import {
  buildScanBulkSelection,
  buildScanPreSelection
} from '../src/shared/scanSelection'
import { BatchManager } from '../src/main/batches/manager'
import { registerIpc } from '../src/main/ipc'
import { startNativeBridge, type NativeBridge } from '../src/main/nativeBridge/server'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import { ScanQueueService } from '../src/main/scanner/queue'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

/* ------------------------------------------------------------------------- *
 * Fixtures: two local Discourse topics with one video and a main + roll +
 * pitch funscript set each. The scripts intentionally use a shorter base than
 * the resolved video title so a successful post-download rename is observable.
 * ------------------------------------------------------------------------- */

interface TopicFixture {
  url: string
  topicId: number
  scriptBase: string
  videoTitle: string
  videoId: string
}

const TOPIC_A: TopicFixture = {
  url: 'https://discuss.example/t/fancam-one/1001',
  topicId: 1001,
  scriptBase: 'Fancam 01 Wonyoung',
  videoTitle: 'Fancam 01 Wonyoung 4K',
  videoId: 'AbCdEf001'
}

const TOPIC_B: TopicFixture = {
  url: 'https://discuss.example/t/fancam-two/1002',
  topicId: 1002,
  scriptBase: 'Fancam 02 Wonyoung',
  videoTitle: 'Fancam 02 Wonyoung 4K',
  videoId: 'AbCdEf002'
}

const TOPICS = [TOPIC_A, TOPIC_B]

function scriptNames(topic: TopicFixture): string[] {
  return [
    `${topic.scriptBase}.funscript`,
    `${topic.scriptBase}.roll.funscript`,
    `${topic.scriptBase}.pitch.funscript`
  ]
}

function videoUrl(topic: TopicFixture): string {
  return `https://www.youtube.com/watch?v=${topic.videoId}`
}

function cookedPost(topic: TopicFixture): string {
  const video = `<p><a href="${videoUrl(topic)}">${topic.videoTitle}</a></p>`
  const scripts = scriptNames(topic)
    .map(
      (name) =>
        `<p><a class="attachment" href="/uploads/f/${topic.topicId}/${encodeURIComponent(name)}">${name}</a></p>`
    )
    .join('')
  return video + scripts
}

function topicJson(topic: TopicFixture): string {
  return JSON.stringify({
    id: topic.topicId,
    title: `${topic.scriptBase} scripts`,
    slug: topic.url.split('/').filter(Boolean).at(-2) ?? 'topic',
    post_stream: {
      posts: [
        {
          id: topic.topicId * 10,
          post_number: 10,
          username: 'alice',
          cooked: cookedPost(topic)
        }
      ],
      stream: [topic.topicId * 10]
    }
  })
}

function topicForUrl(url: string): TopicFixture {
  const topic = TOPICS.find((candidate) => url.includes(`/${candidate.topicId}`))
  return topic ?? TOPIC_A
}

/** Network is the only thing this fetcher fakes: both pages are local data. */
const fetchPage: ScanPageFetcher = async (input) => {
  if (new URL(input.url).pathname.endsWith('.json')) {
    const body = topicJson(topicForUrl(input.url))
    return {
      finalUrl: input.url,
      status: 200,
      contentType: 'application/json',
      contentDisposition: null,
      body,
      bytes: Buffer.byteLength(body)
    }
  }
  const topic = topicForUrl(input.url)
  const body = `<html><head><meta name="generator" content="Discourse 3.2.0" /></head><body><base href="${topic.url}/" /></body></html>`
  return {
    finalUrl: topic.url,
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
      : 'application/octet-stream'
  })
  return {
    status: 'ready',
    verified: true,
    contentType: input.url.endsWith('.funscript')
      ? 'application/json'
      : 'application/octet-stream',
    contentDisposition: null,
    sizeBytes: 2048,
    finalUrl: input.url,
    classification,
    reason: null
  }
}

function analysisFor(url: string): MediaAnalysis {
  const id = new URL(url).searchParams.get('v') ?? 'unknown'
  const topic =
    TOPICS.find((candidate) => candidate.videoId === id) ?? TOPIC_A
  return {
    analysisId: `analysis_${id}`,
    title: topic.videoTitle,
    thumbnailUrl: null,
    durationSeconds: 200,
    options: [
      {
        kind: 'video',
        optionId: `opt_${id}`,
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
    bestVideoOptionId: `opt_${id}`,
    bestAudioOptionId: null,
    expiresAt: 9_999_999
  }
}

/* ------------------------------------------------------------------------- *
 * Fakes: aria2 downloads and the yt-dlp media engine both write real files.
 * Everything else (validators, IPC handlers, queue, batch manager, rename) is
 * the production implementation.
 * ------------------------------------------------------------------------- */

function aria2State() {
  return {
    status: 'ready' as const,
    version: '1.37.0',
    binaryPath: null,
    message: null,
    hint: null
  }
}

function createDownloadPorts(downloadsDir: string) {
  let sequence = 0
  const items = new Map<string, DownloadItem>()
  const snapshot = (): AppSnapshot => ({
    aria2: aria2State(),
    downloads: [...items.values()]
  })

  const write = async (
    input: { url: string; filename?: string },
    directory: string
  ): Promise<AppSnapshot> => {
    const id = `dl_${sequence++}`
    const filename = input.filename ?? `file_${sequence}.bin`
    await fs.mkdir(directory, { recursive: true })
    const filePath = path.join(directory, filename)
    await fs.writeFile(filePath, `download:${filename}`)
    const item: DownloadItem = {
      id,
      gid: `gid_${id}`,
      url: input.url,
      filename,
      dir: directory,
      filePath,
      status: 'complete',
      totalBytes: 10,
      completedBytes: 10,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 3,
      createdAt: 1,
      updatedAt: 1,
      completedAt: 2
    }
    items.set(id, item)
    return snapshot()
  }

  return {
    items,
    add: vi.fn(async (input: unknown) =>
      write(input as { url: string; filename?: string }, downloadsDir)
    ),
    addScanFile: vi.fn(async (input: unknown, directory: string) =>
      write(input as { url: string; filename?: string }, directory)
    ),
    pause: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => snapshot()),
    getItem: (id: string) => items.get(id) ?? null,
    getFilePath: (id: string) => items.get(id)?.filePath ?? null,
    adoptRenamedFile: (id: string, filePath: string) => {
      const item = items.get(id)
      if (!item) return
      item.filePath = filePath
      item.filename = path.basename(filePath)
    }
  }
}

function createMediaPorts(mediaDir: string) {
  let sequence = 0
  const analyses = new Map<string, MediaAnalysis>()
  const jobs = new Map<string, MediaJob>()
  const finalPaths = new Map<string, string>()

  const snapshot = (): MediaSnapshot => ({
    tool: {
      status: 'ready',
      version: '2026.10.26',
      message: null,
      hint: null
    },
    jobs: [...jobs.values()]
  })

  return {
    analyses,
    analyzeMedia: vi.fn(async (input: unknown) => {
      const url = String((input as { url?: unknown }).url ?? '')
      const analysis = analysisFor(url)
      analyses.set(analysis.analysisId, analysis)
      return analysis
    }),
    queueMedia: vi.fn(async (input: unknown) => {
      const record = input as { analysisId: string; optionId: string }
      const analysis = analyses.get(record.analysisId)
      if (!analysis) throw new Error('Unknown media analysis.')
      const id = `media_${sequence++}`
      await fs.mkdir(mediaDir, { recursive: true })
      const filePath = path.join(mediaDir, `${analysis.title}.mp4`)
      await fs.writeFile(filePath, 'video')
      finalPaths.set(id, filePath)
      const job: MediaJob = {
        id,
        analysisId: record.analysisId,
        optionId: record.optionId,
        kind: 'video',
        title: analysis.title,
        label: '1080p · MP4',
        status: 'complete',
        completedBytes: 100,
        totalBytes: 100,
        speedBps: 0,
        errorMessage: null,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2
      }
      jobs.set(id, job)
      return job
    }),
    cancelMedia: vi.fn(async () => {
      throw new Error('not used')
    }),
    getMediaSnapshot: vi.fn(() => snapshot()),
    getJob: (id: string) => jobs.get(id) ?? null,
    getFilePath: (id: string) => finalPaths.get(id) ?? null
  }
}

interface World {
  root: string
  mediaDir: string
  scanner: ScanSessionManager
  queue: ScanQueueService
  batches: BatchManager
  downloads: ReturnType<typeof createDownloadPorts>
  media: ReturnType<typeof createMediaPorts>
}

const roots: string[] = []

async function tempRoot(prefix = 'dondownload-scanner-e2e-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

function createWorld(root: string): World {
  const mediaDir = path.join(root, 'Media')
  const downloads = createDownloadPorts(path.join(root, 'Downloads'))
  const media = createMediaPorts(mediaDir)
  const scanner = new ScanSessionManager({
    now: () => 1_000,
    fetchPage,
    probeItem: readyProbe,
    followDepth: 0,
    analyzeMedia: (url) => media.analyzeMedia({ url }),
    onUpdate: () => undefined
  })
  const batches = new BatchManager({
    downloads,
    mediaJobs: media,
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
    openExternal: () => undefined,
    pollIntervalMs: 0,
    scanMediaDir: mediaDir,
    scanRootDir: root
  })
  const queue = new ScanQueueService({
    sessions: scanner,
    batches,
    mediaJobs: media,
    probeItem: readyProbe,
    now: () => 1_000
  })
  return { root, mediaDir, scanner, queue, batches, downloads, media }
}

function createWindow() {
  const frame = { url: 'app://dondownload/index.html' }
  const webContents = {
    mainFrame: frame,
    getURL: () => frame.url
  }
  return {
    window: { isDestroyed: () => false, webContents },
    frame,
    webContents
  }
}

function registerWorldIpc(world: World) {
  const fakeWindow = createWindow()
  registerIpc({
    manager: {} as never,
    aria2: {} as never,
    scanner: world.scanner,
    scanQueue: world.queue,
    batches: world.batches,
    getWindow: () => fakeWindow.window as never
  })
  return fakeWindow
}

function handler(channel: string): InvokeHandler {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`No handler registered for ${channel}.`)
  return registered
}

function trustedEvent(fakeWindow: ReturnType<typeof createWindow>): unknown {
  return {
    sender: fakeWindow.webContents,
    senderFrame: fakeWindow.frame
  }
}

async function startScans(
  fakeWindow: ReturnType<typeof createWindow>,
  urls: string[]
): Promise<ScanSession[]> {
  const result = await handler(IPC.scanStartMany)(trustedEvent(fakeWindow), { urls })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error?.message)
  return result.value as ScanSession[]
}

beforeEach(() => {
  handlers.clear()
})

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

describe('Smart Link Scanner end-to-end wiring', () => {
  it('scans, pre-selects like the renderer, queues through IPC and renames multi-axis scripts next to the video', async () => {
    const root = await tempRoot()
    const world = createWorld(root)
    const fakeWindow = registerWorldIpc(world)

    const [started] = await startScans(fakeWindow, [TOPIC_A.url])
    expect(started).toBeDefined()
    await world.scanner.waitForScan(started!.sessionId)
    const session = world.scanner.getSession(started!.sessionId)
    expect(session.status).toBe('done')

    // The pure renderer helpers build exactly what the user sees ticked.
    const preSelection = buildScanPreSelection(session)
    expect(preSelection.videoCount).toBe(1)
    expect(preSelection.scriptCount).toBe(3)
    expect(preSelection.pairings).toHaveLength(1)

    // Exactly the payload preload queueScanSelection sends.
    const payload = {
      sessionId: session.sessionId,
      itemIds: preSelection.itemIds,
      videoOptions: preSelection.videoOptions,
      pairings: preSelection.pairings
    }
    const queued = await handler(IPC.scanQueueSelection)(
      trustedEvent(fakeWindow),
      payload
    )
    expect(queued.ok).toBe(true)
    if (!queued.ok) throw new Error(queued.error?.message)
    const value = queued.value as {
      batch: { id: string } | null
      queuedItemIds: string[]
      skipped: unknown[]
    }
    expect(value.batch).not.toBeNull()
    expect(value.queuedItemIds).toHaveLength(4)
    expect(value.skipped).toEqual([])

    // The fake children are already terminal; refresh reconciles them and runs
    // the real post-download rename.
    await world.batches.waitForIdle()
    world.batches.refresh()
    await world.batches.waitForIdle()

    expect(
      await fs.readFile(
        path.join(world.mediaDir, `${TOPIC_A.videoTitle}.mp4`),
        'utf8'
      )
    ).toBe('video')
    expect((await fs.readdir(world.mediaDir)).sort()).toEqual([
      `${TOPIC_A.videoTitle}.funscript`,
      `${TOPIC_A.videoTitle}.mp4`,
      `${TOPIC_A.videoTitle}.pitch.funscript`,
      `${TOPIC_A.videoTitle}.roll.funscript`
    ])
  })

  it('queues two topics in one bulk IPC call without pairing scripts across topics', async () => {
    const root = await tempRoot()
    const world = createWorld(root)
    const fakeWindow = registerWorldIpc(world)

    const started = await startScans(
      fakeWindow,
      TOPICS.map((topic) => topic.url)
    )
    expect(started).toHaveLength(2)
    for (const scan of started) {
      await world.scanner.waitForScan(scan.sessionId)
    }
    const sessions = started.map((scan) =>
      world.scanner.getSession(scan.sessionId)
    )
    const topicBySession = new Map(
      sessions.map((session, index) => [session.sessionId, TOPICS[index]!])
    )
    for (const session of sessions) expect(session.status).toBe('done')

    // The renderer's bulk helper receives every ticked item across both topics.
    const selectedItemIds = new Set(
      sessions.flatMap((session) =>
        session.items
          .filter((item) => isQueueableScanItem(item))
          .map((item) => item.id)
      )
    )
    const selections = buildScanBulkSelection(sessions, { selectedItemIds })
    expect(selections).toHaveLength(2)
    for (const selection of selections) {
      expect(selection.itemIds).toHaveLength(4)
      expect(selection.pairings).toHaveLength(1)
    }

    // Exactly the payload preload queueScanSelections sends.
    const queued = await handler(IPC.scanQueueSelections)(
      trustedEvent(fakeWindow),
      { selections }
    )
    expect(queued.ok).toBe(true)
    if (!queued.ok) throw new Error(queued.error?.message)
    const result = queued.value as {
      results: Array<{
        sessionId: string
        ok: boolean
        value?: { batch: { id: string } | null }
        error?: { message: string }
      }>
    }
    expect(result.results).toHaveLength(2)
    for (const outcome of result.results) expect(outcome.ok).toBe(true)

    await world.batches.waitForIdle()
    world.batches.refresh()
    await world.batches.waitForIdle()

    // Two parent batches, each containing only its own topic's video/scripts.
    const snapshot = world.batches.getBatchSnapshot()
    expect(snapshot.batches).toHaveLength(2)
    for (const outcome of result.results) {
      const expected = topicBySession.get(outcome.sessionId)
      expect(expected).toBeDefined()
      const batch = world.batches.getBatch(outcome.value?.batch?.id)
      const titles = batch.items.map((item) => item.title)
      expect(titles).toHaveLength(4)
      expect(titles.every((title) => title.startsWith(expected!.scriptBase))).toBe(
        true
      )
      const other = TOPICS.find((topic) => topic !== expected)
      expect(titles.some((title) => title.startsWith(other!.scriptBase))).toBe(
        false
      )
    }

    expect((await fs.readdir(world.mediaDir)).sort()).toEqual(
      TOPICS.flatMap((topic) => [
        `${topic.videoTitle}.funscript`,
        `${topic.videoTitle}.mp4`,
        `${topic.videoTitle}.pitch.funscript`,
        `${topic.videoTitle}.roll.funscript`
      ]).sort()
    )
  })

  it('accepts the native host body on /scan-page and queues a third request instead of rejecting it', async () => {
    const root = await tempRoot('dondownload-scan-bridge-')
    let bridge: NativeBridge | null = null
    const seen: ScanSession[] = []
    // Two active scans stay unresolved so the third must wait for a slot.
    const scanner = new ScanSessionManager({
      fetchPage: () => new Promise(() => undefined),
      onUpdate: () => undefined
    })
    try {
      bridge = await startNativeBridge({
        manager: { add: vi.fn(async () => ({ accepted: true })) },
        userDataPath: root,
        logger: () => undefined,
        scanner: {
          start: (url, options) => scanner.start(url, options),
          startMany: (urls, options) => scanner.startMany(urls, options)
        },
        onScanRequested: (session) => seen.push(session)
      })

      const state = JSON.parse(
        await fs.readFile(bridge.statePath, 'utf8')
      ) as { token: string }
      const post = async (url: string): Promise<{ status: number; body: unknown }> => {
        // Exactly what native/NativeHost.cs forwards: url + optional cookie,
        // and no `type` field.
        const response = await fetch(`http://127.0.0.1:${bridge!.port}/scan-page`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${state.token}`
          },
          body: JSON.stringify({ url, cookie: '_t=session' })
        })
        return { status: response.status, body: await response.json() }
      }

      const first = await post(TOPIC_A.url)
      const second = await post(TOPIC_B.url)
      const third = await post('https://discuss.example/t/fancam-three/1003')

      expect(first.status).toBe(200)
      expect(first.body).toEqual({
        ok: true,
        accepted: true,
        operation: 'scan-page'
      })
      expect(second.status).toBe(200)
      expect(third.status).toBe(200)
      expect(seen).toHaveLength(3)
      expect(seen[0]?.status).toBe('scanning')
      // The third session is real and queued, not an error.
      expect(seen[2]?.message).toMatch(/waiting/i)
      expect(scanner.getSession(seen[2]!.sessionId).message).toMatch(/waiting/i)
    } finally {
      await bridge?.close()
      scanner.close()
    }
  })

  it('still rejects an unknown key in the queue payload through the real IPC handler', async () => {
    const scanQueue = {
      queueSelection: vi.fn(),
      queueSelections: vi.fn()
    }
    const fakeWindow = createWindow()
    registerIpc({
      manager: {} as never,
      aria2: {} as never,
      scanner: { start: vi.fn(), startMany: vi.fn() } as never,
      scanQueue: scanQueue as never,
      getWindow: () => fakeWindow.window as never
    })

    const result = await handler(IPC.scanQueueSelection)(
      trustedEvent(fakeWindow),
      {
        sessionId: 'scan_0123456789abcdef',
        itemIds: ['item_1'],
        pairings: [],
        unexpected: true
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBeTruthy()
    expect(scanQueue.queueSelection).not.toHaveBeenCalled()
  })
})
