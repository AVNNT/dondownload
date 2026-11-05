import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => undefined)
}))

vi.mock('electron', () => ({
  shell: { openExternal }
}))

import {
  GOFILE_BROWSER_REQUIRED_MESSAGE,
  BatchManager,
  describeBatchFailure,
  type BatchCollectionEnginePort,
  type BatchCollectionTarget,
  type BatchDownloadsPort,
  type BatchMediaJobsPort,
  type BatchPersistencePort,
  type BatchPixeldrainPort,
  type StoredBatchRecord
} from '../src/main/batches/manager'
import { AppError } from '../src/main/errors'
import {
  parseCollectionPreview,
  type BatchItemRecord,
  type BatchRecord,
  type CollectionEntry,
  type CollectionPreview
} from '../src/shared/batches'
import type {
  AnalyzeMediaInput,
  MediaAnalysis,
  MediaJob,
  MediaSnapshot,
  MediaToolState
} from '../src/shared/media'
import type {
  AppSnapshot,
  DownloadItem,
  SmartBatchSubmitResult
} from '../src/shared/types'

const NOW = Date.UTC(2026, 3, 1, 12, 0, 0)
const TOOL: MediaToolState = {
  status: 'ready',
  version: 'test-engine',
  message: null,
  hint: null
}

function aria2State(): AppSnapshot['aria2'] {
  return {
    status: 'ready',
    version: '1.37.0',
    binaryPath: null,
    message: null,
    hint: null
  }
}

function downloadRecord(
  id: string,
  url: string,
  overrides: Partial<DownloadItem> = {}
): DownloadItem {
  return {
    id,
    gid: `gid_${id}`,
    url,
    filename: url.split('/').pop() ?? 'file.bin',
    dir: 'C:\\Downloads',
    filePath: null,
    status: 'active',
    totalBytes: 1_000,
    completedBytes: 100,
    speedBps: 10,
    etaSeconds: 90,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: NOW + Number(id.replace(/\D/g, '') || 0),
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

class FakeDownloads implements BatchDownloadsPort {
  readonly records: DownloadItem[] = []
  readonly addCalls: Array<Record<string, unknown>> = []
  readonly pauseCalls: string[] = []
  duplicateUrls = new Set<string>()
  addError: Error | null = null
  private counter = 0

  async add(input: unknown): Promise<AppSnapshot> {
    const record = input as Record<string, unknown>
    this.addCalls.push(record)
    if (this.addError) throw this.addError
    const url = String(record.url)
    if (this.duplicateUrls.has(url)) {
      throw new AppError(
        'DUPLICATE_DOWNLOAD',
        'This URL is already queued or downloading in DonDownload.'
      )
    }
    this.counter += 1
    const id = `child_${this.counter}`
    this.records.push(
      downloadRecord(id, url, {
        filename:
          typeof record.filename === 'string'
            ? record.filename
            : url.split('/').pop() ?? 'file.bin',
        createdAt: NOW + this.counter
      })
    )
    return this.getSnapshot()
  }

  async pause(id: string): Promise<AppSnapshot> {
    this.pauseCalls.push(id)
    const record = this.records.find((entry) => entry.id === id)
    if (record) record.status = 'paused'
    return this.getSnapshot()
  }

  getSnapshot(): AppSnapshot {
    return {
      aria2: aria2State(),
      downloads: this.records.map((record) => ({ ...record }))
    }
  }

  complete(id: string): void {
    const record = this.records.find((entry) => entry.id === id)
    if (!record) throw new Error(`Unknown download ${id}`)
    record.status = 'complete'
    record.completedBytes = record.totalBytes
    record.completedAt = NOW + 100
  }

  fail(id: string, message: string): void {
    const record = this.records.find((entry) => entry.id === id)
    if (!record) throw new Error(`Unknown download ${id}`)
    record.status = 'error'
    record.errorMessage = message
  }
}

function analysisFixture(
  overrides: Partial<MediaAnalysis> = {}
): MediaAnalysis {
  return {
    analysisId: 'analysis_0123456789abcdef',
    title: 'Example media',
    durationSeconds: 120,
    options: [
      {
        kind: 'video',
        optionId: 'option_video_0123456789',
        label: '1080p MP4',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: true,
        requiresMerge: false,
        filesizeBytes: 1_000
      }
    ],
    bestVideoOptionId: 'option_video_0123456789',
    bestAudioOptionId: null,
    expiresAt: NOW + 60_000,
    ...overrides
  }
}

function mediaJobFixture(
  id: string,
  overrides: Partial<MediaJob> = {}
): MediaJob {
  return {
    id,
    analysisId: 'analysis_0123456789abcdef',
    optionId: 'option_video_0123456789',
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4',
    status: 'queued',
    completedBytes: 0,
    totalBytes: 1_000,
    speedBps: 0,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

class FakeMediaJobs implements BatchMediaJobsPort {
  readonly jobs: MediaJob[] = []
  readonly analyzeCalls: AnalyzeMediaInput[] = []
  readonly queueCalls: Array<Record<string, unknown>> = []
  readonly cancelCalls: string[] = []
  analysis = analysisFixture()
  analyzeError: Error | null = null
  private counter = 0

  async analyzeMedia(input: unknown): Promise<MediaAnalysis> {
    this.analyzeCalls.push(input as AnalyzeMediaInput)
    if (this.analyzeError) throw this.analyzeError
    return {
      ...this.analysis,
      options: this.analysis.options.map((option) => ({ ...option }))
    }
  }

  async queueMedia(input: unknown): Promise<MediaJob> {
    this.queueCalls.push(input as Record<string, unknown>)
    this.counter += 1
    const job = mediaJobFixture(`media_${this.counter}`, {
      analysisId: String((input as Record<string, unknown>).analysisId),
      optionId: String((input as Record<string, unknown>).optionId)
    })
    this.jobs.push(job)
    return { ...job }
  }

  async cancelMedia(id: string): Promise<MediaJob> {
    this.cancelCalls.push(id)
    const job = this.jobs.find((entry) => entry.id === id)
    if (!job) throw new AppError('MEDIA_JOB_NOT_FOUND', 'missing')
    job.status = 'cancelled'
    return { ...job }
  }

  getMediaSnapshot(): MediaSnapshot {
    return { tool: TOOL, jobs: this.jobs.map((job) => ({ ...job })) }
  }

  complete(id: string): void {
    const job = this.jobs.find((entry) => entry.id === id)
    if (!job) throw new Error(`Unknown media job ${id}`)
    job.status = 'complete'
    job.completedBytes = job.totalBytes ?? 0
    job.completedAt = NOW + 100
  }
}

function previewFixture(
  id: string,
  entries: CollectionEntry[],
  kind: 'playlist' | 'pixeldrain-list' = 'playlist'
): CollectionPreview {
  const availableCount = entries.filter(
    (entry) => entry.availability === 'available'
  ).length
  return parseCollectionPreview({
    id,
    kind,
    title: 'Example collection',
    entryCount: entries.length,
    availableCount,
    unavailableCount: entries.length - availableCount,
    entries
  })
}

function collectionEntry(
  id: string,
  position: number,
  overrides: Partial<CollectionEntry> = {}
): CollectionEntry {
  return {
    id,
    position,
    title: `Entry ${position + 1}`,
    availability: 'available',
    errorCode: null,
    errorReason: null,
    ...overrides
  }
}

class FakeCollectionEngine implements BatchCollectionEnginePort {
  readonly analyzeCalls: string[] = []
  readonly resolveCalls: Array<{ previewId: string; entryIds: string[] }> = []
  preview: CollectionPreview = previewFixture('colprev_playlist_1', [
    collectionEntry('colentry_1', 0),
    collectionEntry('colentry_2', 1),
    collectionEntry('colentry_3', 2)
  ])
  targets = new Map<string, string>([
    ['colentry_1', 'https://media.example/watch/1'],
    ['colentry_2', 'https://media.example/watch/2'],
    ['colentry_3', 'https://media.example/watch/3']
  ])
  analyzeError: Error | null = null

  async analyzeCollection(url: string): Promise<CollectionPreview> {
    this.analyzeCalls.push(url)
    if (this.analyzeError) throw this.analyzeError
    return this.preview
  }

  async resolveCollectionEntries(
    previewId: string,
    entryIds: readonly string[]
  ): Promise<readonly BatchCollectionTarget[]> {
    this.resolveCalls.push({ previewId, entryIds: [...entryIds] })
    return entryIds.map((entryId, index) => ({
      entryId,
      url: this.targets.get(entryId) ?? `https://media.example/watch/${index}`,
      title: `Entry ${entryId}`,
      position: index
    }))
  }
}

class FakePixeldrain implements BatchPixeldrainPort {
  readonly resolveFileCalls: string[] = []
  readonly resolveListCalls: string[] = []
  listPreview: CollectionPreview = previewFixture(
    'colprev_pixeldrain_1',
    [collectionEntry('colentry_pd_1', 0), collectionEntry('colentry_pd_2', 1)],
    'pixeldrain-list'
  )

  parseLink(value: unknown) {
    const parsed = new URL(String(value))
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'pixeldrain.com' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw Object.assign(new Error('invalid pixeldrain link'), {
        code: 'PIXELDRAIN_INVALID_LINK'
      })
    }
    const match = /^\/(u|l)\/([A-Za-z0-9_-]{4,32})\/?$/.exec(parsed.pathname)
    if (!match) {
      throw Object.assign(new Error('invalid pixeldrain link'), {
        code: 'PIXELDRAIN_INVALID_LINK'
      })
    }
    const kind = match[1] === 'u' ? 'file' : 'list'
    const id = match[2] as string
    return {
      kind,
      id,
      sourceUrl: `https://pixeldrain.com/${match[1]}/${id}`
    } as const
  }

  async resolveFile(value: unknown) {
    const link = this.parseLink(value)
    if (link.kind !== 'file') {
      throw Object.assign(new Error('not a file'), {
        code: 'PIXELDRAIN_INVALID_LINK'
      })
    }
    this.resolveFileCalls.push(link.sourceUrl)
    return {
      kind: 'file' as const,
      fileId: link.id,
      name: `${link.id}.bin`,
      size: 1_000,
      mimeType: 'application/octet-stream',
      sourceUrl: link.sourceUrl,
      downloadUrl: `https://pixeldrain.com/api/file/${link.id}`
    }
  }

  async resolveList(value: unknown) {
    const link = this.parseLink(value)
    if (link.kind !== 'list') {
      throw Object.assign(new Error('not a list'), {
        code: 'PIXELDRAIN_INVALID_LINK'
      })
    }
    this.resolveListCalls.push(link.sourceUrl)
    return {
      kind: 'list' as const,
      listId: link.id,
      title: this.listPreview.title,
      sourceUrl: link.sourceUrl,
      preview: this.listPreview,
      entries: [
        {
          entryId: 'colentry_pd_1',
          position: 0,
          fileId: 'fileone',
          name: 'one.bin',
          size: 100,
          mimeType: null,
          sourceUrl: 'https://pixeldrain.com/u/fileone',
          downloadUrl: 'https://pixeldrain.com/api/file/fileone',
          availability: 'available' as const,
          errorCode: null,
          errorReason: null
        },
        {
          entryId: 'colentry_pd_2',
          position: 1,
          fileId: 'filetwo',
          name: 'two.bin',
          size: 200,
          mimeType: null,
          sourceUrl: 'https://pixeldrain.com/u/filetwo',
          downloadUrl: 'https://pixeldrain.com/api/file/filetwo',
          availability: 'available' as const,
          errorCode: null,
          errorReason: null
        }
      ]
    }
  }
}

class FakePersistence implements BatchPersistencePort {
  readonly rows = new Map<string, StoredBatchRecord>()
  readonly deleted: string[] = []
  loadCalls = 0
  loadError: Error | null = null

  loadBatches(): StoredBatchRecord[] {
    this.loadCalls += 1
    if (this.loadError) throw this.loadError
    return [...this.rows.values()].map((entry) => ({
      record: { ...entry.record },
      items: entry.items.map((item) => ({ ...item }))
    }))
  }

  saveBatch(record: BatchRecord): void {
    const existing = this.rows.get(record.id)
    this.rows.set(record.id, {
      record: { ...record },
      items: existing ? existing.items.map((item) => ({ ...item })) : []
    })
  }

  saveBatchWithItems(
    record: BatchRecord,
    items: readonly BatchItemRecord[]
  ): void {
    this.rows.set(record.id, {
      record: { ...record },
      items: items.map((item) => ({ ...item }))
    })
  }

  saveManyBatchItems(items: readonly BatchItemRecord[]): void {
    for (const item of items) {
      const entry = this.rows.get(item.batchId)
      if (!entry) throw new Error(`Unknown batch ${item.batchId}`)
      const index = entry.items.findIndex((entryItem) => entryItem.id === item.id)
      if (index >= 0) entry.items[index] = { ...item }
      else entry.items.push({ ...item })
    }
  }

  deleteBatch(id: string): void {
    this.deleted.push(id)
    this.rows.delete(id)
  }

  seed(record: BatchRecord, items: BatchItemRecord[]): void {
    this.rows.set(record.id, {
      record: { ...record },
      items: items.map((item) => ({ ...item }))
    })
  }
}

interface Harness {
  manager: BatchManager
  downloads: FakeDownloads
  media: FakeMediaJobs
  engine: FakeCollectionEngine
  pixeldrain: FakePixeldrain
  database: FakePersistence
}

function createHarness(
  options: {
    downloads?: FakeDownloads
    media?: FakeMediaJobs
    engine?: FakeCollectionEngine
    pixeldrain?: FakePixeldrain
    database?: FakePersistence
  } = {}
): Harness {
  const downloads = options.downloads ?? new FakeDownloads()
  const media = options.media ?? new FakeMediaJobs()
  const engine = options.engine ?? new FakeCollectionEngine()
  const pixeldrain = options.pixeldrain ?? new FakePixeldrain()
  const database = options.database ?? new FakePersistence()
  const manager = new BatchManager({
    downloads,
    mediaJobs: media,
    collectionEngine: engine,
    pixeldrain,
    database,
    onUpdate: () => undefined,
    now: () => NOW,
    pollIntervalMs: 0,
    progressPersistIntervalMs: 0,
    openExternal
  })
  return { manager, downloads, media, engine, pixeldrain, database }
}

function batchRecord(overrides: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'batch_seeded',
    kind: 'direct-urls',
    title: 'Seeded batch',
    status: 'running',
    sourceUrl: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

function batchItem(overrides: Partial<BatchItemRecord> = {}): BatchItemRecord {
  return {
    id: 'bitem_seeded',
    batchId: 'batch_seeded',
    position: 0,
    kind: 'download',
    status: 'queued',
    title: 'Seeded item',
    label: 'Direct download',
    childId: null,
    completedBytes: 0,
    totalBytes: null,
    errorMessage: null,
    sourceUrl: 'https://example.com/files/a.zip',
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

function publicJson(result: unknown): string {
  return JSON.stringify(result)
}

beforeEach(() => {
  openExternal.mockClear()
})

describe('batch persistence and restart recovery', () => {
  it('marks active parents/items interrupted and never auto-resumes children', async () => {
    const database = new FakePersistence()
    database.seed(batchRecord(), [
      batchItem({
        id: 'bitem_running',
        status: 'running',
        childId: 'child_old',
        completedBytes: 20
      }),
      batchItem({
        id: 'bitem_queued',
        position: 1,
        status: 'queued'
      }),
      batchItem({
        id: 'bitem_complete',
        position: 2,
        status: 'complete',
        completedBytes: 1_000,
        totalBytes: 1_000,
        completedAt: NOW,
        childId: 'child_done'
      })
    ])

    const { manager, downloads, media } = createHarness({ database })

    expect(database.loadCalls).toBe(1)
    const snapshot = manager.getBatchSnapshot()
    expect(snapshot.batches).toHaveLength(1)
    expect(snapshot.batches[0]?.status).toBe('interrupted')
    expect(snapshot.batches[0]?.items.map((item) => item.status)).toEqual([
      'interrupted',
      'interrupted',
      'complete'
    ])
    expect(snapshot.batches[0]?.items[0]?.childId).toBe('child_old')

    await manager.waitForIdle()
    expect(downloads.addCalls).toHaveLength(0)
    expect(media.analyzeCalls).toHaveLength(0)

    const persisted = database.rows.get('batch_seeded')
    expect(persisted?.record.status).toBe('interrupted')
    expect(persisted?.items.map((item) => item.status)).toEqual([
      'interrupted',
      'interrupted',
      'complete'
    ])
  })

  it('persists terminal progress and child mappings', async () => {
    const { manager, downloads, database } = createHarness()
    const result = await manager.submitSmartBatch({
      urls: ['https://example.com/files/a.zip']
    })
    const batchId = result.batch?.id
    if (!batchId) throw new Error('expected a direct batch')

    await manager.waitForIdle()
    const item = manager.getBatch(batchId).items[0]
    expect(item?.childId).toBe('child_1')

    downloads.complete('child_1')
    manager.refresh()

    const batch = manager.getBatch(batchId)
    expect(batch.status).toBe('complete')
    expect(batch.items[0]).toMatchObject({
      status: 'complete',
      childId: 'child_1',
      completedBytes: 1_000,
      totalBytes: 1_000
    })
    const persisted = database.rows.get(batchId)
    expect(persisted?.record.status).toBe('complete')
    expect(persisted?.items[0]?.status).toBe('complete')
  })
})

describe('smart submit isolation', () => {
  it('keeps unsupported, rate-limit, CAPTCHA, duplicate and generic failure text distinct', () => {
    const duplicate = describeBatchFailure(
      { code: 'DUPLICATE_DOWNLOAD' },
      'fallback'
    )
    const rateLimited = describeBatchFailure(
      { code: 'PIXELDRAIN_RATE_LIMITED' },
      'fallback'
    )
    const captcha = describeBatchFailure(
      { code: 'PIXELDRAIN_CAPTCHA_REQUIRED' },
      'fallback'
    )
    const unsupported = describeBatchFailure(
      { code: 'PIXELDRAIN_UNSUPPORTED' },
      'fallback'
    )
    const failed = describeBatchFailure(
      { message: 'The remote file was not found.' },
      'fallback'
    )

    expect(
      new Set([duplicate, rateLimited, captcha, unsupported, failed]).size
    ).toBe(5)
    expect(duplicate).toMatch(/already queued/i)
    expect(rateLimited).toMatch(/rate-limited/i)
    expect(captcha).toMatch(/CAPTCHA/i)
    expect(unsupported).toMatch(/not supported/i)
    expect(failed).toBe('The remote file was not found.')
  })

  it('isolates invalid URLs and duplicate items independently', async () => {
    const downloads = new FakeDownloads()
    downloads.duplicateUrls.add('https://example.com/files/b.zip')
    const { manager } = createHarness({ downloads })

    const result: SmartBatchSubmitResult = await manager.submitSmartBatch({
      urls: [
        'not a url',
        'https://example.com/files/a.zip',
        'https://example.com/files/b.zip'
      ]
    })

    expect(result.entries).toHaveLength(3)
    expect(result.entries[0]).toMatchObject({
      index: 0,
      outcome: 'invalid',
      code: 'INVALID_INPUT'
    })
    expect(result.entries[1]).toMatchObject({ index: 1, outcome: 'batch-item' })
    expect(result.entries[2]).toMatchObject({ index: 2, outcome: 'batch-item' })

    await manager.waitForIdle()
    const batchId = result.batch?.id
    if (!batchId) throw new Error('expected a direct batch')
    const batch = manager.getBatch(batchId)
    expect(batch.items).toHaveLength(2)
    expect(batch.items[0]).toMatchObject({ status: 'running', childId: 'child_1' })
    expect(batch.items[1]?.status).toBe('error')
    expect(batch.items[1]?.errorMessage).toBe(
      'This item is already queued or downloading.'
    )
    expect(batch.status).toBe('running')
  })

  it('keeps a Gofile share link unavailable and opens only its canonical URL', async () => {
    const { manager, downloads, database } = createHarness()
    const result = await manager.submitSmartBatch({
      urls: ['https://gofile.io/d/AbCd1234']
    })

    expect(result.entries[0]).toMatchObject({
      index: 0,
      outcome: 'unsupported',
      code: 'GOFILE_BROWSER_REQUIRED'
    })
    const batchId = result.batch?.id
    const itemId = result.entries[0]?.itemId
    if (!batchId || !itemId) throw new Error('expected a Gofile batch item')

    await manager.waitForIdle()
    expect(downloads.addCalls).toHaveLength(0)
    const batch = manager.getBatch(batchId)
    expect(batch.items[0]).toMatchObject({
      status: 'unavailable',
      errorMessage: GOFILE_BROWSER_REQUIRED_MESSAGE
    })
    expect(batch.status).toBe('partial')
    // The internal row keeps the source for the explicit browser action only.
    expect(database.rows.get(batchId)?.items[0]?.sourceUrl).toBe(
      'https://gofile.io/d/AbCd1234'
    )

    await manager.openBatchSource({ batchId, itemId })
    expect(openExternal).toHaveBeenCalledWith('https://gofile.io/d/AbCd1234')

    // Public DTOs never contain the source URL.
    expect(publicJson(manager.getBatchSnapshot())).not.toContain('gofile.io')
  })

  it('rejects non-canonical Gofile links and direct sources for browser-open', async () => {
    const { manager } = createHarness()
    const rejected = await manager.submitSmartBatch({
      urls: ['https://gofile.io/d/AbCd1234?token=secret']
    })
    expect(rejected.entries[0]).toMatchObject({
      outcome: 'unsupported',
      code: 'GOFILE_BROWSER_REQUIRED'
    })
    expect(rejected.batch).toBeNull()

    const direct = await manager.submitSmartBatch({
      urls: ['https://example.com/files/a.zip']
    })
    const batchId = direct.batch?.id
    const itemId = direct.entries[0]?.itemId
    if (!batchId || !itemId) throw new Error('expected a direct item')
    await expect(manager.openBatchSource({ batchId, itemId })).rejects.toMatchObject({
      code: 'BATCH_SOURCE_NOT_OPENABLE'
    })
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('collection previews and explicit selection', () => {
  it('never queues before an explicit selection and only queues selected entries', async () => {
    const { manager, engine, media } = createHarness()
    const preview = await manager.analyzeCollection({
      url: 'https://media.example/playlist?list=abc'
    })

    expect(preview.entries).toHaveLength(3)
    expect(engine.analyzeCalls).toEqual([
      'https://media.example/playlist?list=abc'
    ])
    expect(engine.resolveCalls).toHaveLength(0)
    expect(media.analyzeCalls).toHaveLength(0)
    expect(media.queueCalls).toHaveLength(0)
    expect(manager.getBatchSnapshot().batches).toHaveLength(0)

    const batch = await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_2']
    })

    expect(batch.kind).toBe('media-playlist')
    expect(batch.items).toHaveLength(1)
    expect(engine.resolveCalls).toEqual([
      { previewId: preview.id, entryIds: ['colentry_2'] }
    ])

    await manager.waitForIdle()
    const completed = manager.getBatch(batch.id)
    expect(media.analyzeCalls).toEqual([
      { url: 'https://media.example/watch/2' }
    ])
    expect(media.queueCalls).toHaveLength(1)
    expect(completed.items[0]).toMatchObject({
      kind: 'media',
      status: 'running',
      childId: 'media_1'
    })

    // The preview is one-shot; selecting again requires a fresh analysis.
    await expect(
      manager.createCollectionBatch({
        previewId: preview.id,
        selectedEntryIds: ['colentry_1']
      })
    ).rejects.toMatchObject({ code: 'BATCH_PREVIEW_NOT_FOUND' })
  })

  it('keeps unavailable selection items independent and skips media work', async () => {
    const engine = new FakeCollectionEngine()
    engine.preview = previewFixture('colprev_playlist_2', [
      collectionEntry('colentry_ok', 0),
      collectionEntry('colentry_bad', 1, {
        title: 'Private entry',
        availability: 'unavailable',
        errorCode: 'private',
        errorReason: 'This entry is private.'
      })
    ])
    const { manager, media } = createHarness({ engine })
    const preview = await manager.analyzeCollection({
      url: 'https://media.example/playlist?list=abc'
    })

    const batch = await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_ok', 'colentry_bad']
    })
    expect(batch.items[1]).toMatchObject({
      status: 'unavailable',
      title: 'Private entry',
      errorMessage: 'This entry is private.'
    })

    await manager.waitForIdle()
    expect(media.analyzeCalls).toHaveLength(1)
    expect(manager.getBatch(batch.id).items[1]?.status).toBe('unavailable')
  })

  it('falls back to the best verified audio option when no video exists', async () => {
    const media = new FakeMediaJobs()
    media.analysis = analysisFixture({
      options: [
        {
          kind: 'audio',
          optionId: 'option_audio_0123456789',
          label: 'Audio only',
          container: 'm4a',
          width: null,
          height: null,
          fps: null,
          videoCodec: null,
          audioCodec: 'aac',
          hasAudio: true,
          requiresMerge: false,
          filesizeBytes: 500
        }
      ],
      bestVideoOptionId: null,
      bestAudioOptionId: 'option_audio_0123456789'
    })
    const { manager, engine } = createHarness({ media })
    const preview = await manager.analyzeCollection({
      url: 'https://media.example/playlist?list=abc'
    })
    await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1']
    })
    await manager.waitForIdle()

    expect(media.queueCalls[0]).toMatchObject({
      optionId: 'option_audio_0123456789'
    })
    expect(media.analyzeCalls[0]?.url).toBe(engine.targets.get('colentry_1'))
  })

  it('reports only quality options returned by per-entry media analysis', async () => {
    const { manager, engine, media } = createHarness()
    const preview = await manager.analyzeCollection({ url: 'https://media.example/playlist?list=abc' })
    const availability = await manager.analyzeCollectionSelection({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1']
    })
    expect(availability.entries).toEqual([{
      entryId: 'colentry_1',
      title: 'Entry 1',
      qualities: [
        { quality: 'best', estimatedBytes: 1_000 },
        { quality: '1080p', estimatedBytes: 1_000 }
      ]
    }])
    expect(engine.resolveCalls).toEqual([{ previewId: preview.id, entryIds: ['colentry_1'] }])
    expect(media.queueCalls).toHaveLength(0)
  })

  it('reports the display estimate for playlist quality choices', async () => {
    const media = new FakeMediaJobs()
    media.analysis = analysisFixture({
      options: [
        {
          ...analysisFixture().options[0]!,
          estimatedBytes: 1_500,
          sizeIsEstimate: true
        }
      ]
    })
    const { manager } = createHarness({ media })
    const preview = await manager.analyzeCollection({
      url: 'https://media.example/playlist?list=abc'
    })
    const availability = await manager.analyzeCollectionSelection({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1']
    })
    expect(availability.entries[0]?.qualities).toEqual([
      { quality: 'best', estimatedBytes: 1_500, sizeIsEstimate: true },
      { quality: '1080p', estimatedBytes: 1_500, sizeIsEstimate: true }
    ])
  })

  it('skips a selected quality that is absent instead of replacing it with a higher format', async () => {
    const { manager, media } = createHarness()
    const preview = await manager.analyzeCollection({ url: 'https://media.example/playlist?list=abc' })
    const batch = await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1'],
      mediaQuality: '720p'
    })
    await manager.waitForIdle()
    expect(media.queueCalls).toHaveLength(0)
    expect(manager.getBatch(batch.id).items[0]).toMatchObject({
      status: 'skipped',
      errorMessage: expect.stringContaining('No verified 720p')
    })
  })

  it('skips known oversize options and passes a cap for unknown-size options', async () => {
    const first = createHarness()
    const preview = await first.manager.analyzeCollection({ url: 'https://media.example/playlist?list=abc' })
    const tooSmall = await first.manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1'],
      mediaQuality: '1080p',
      maxBytesPerItem: 999
    })
    await first.manager.waitForIdle()
    expect(first.media.queueCalls).toHaveLength(0)
    expect(first.manager.getBatch(tooSmall.id).items[0]?.status).toBe('skipped')

    const media = new FakeMediaJobs()
    media.analysis = analysisFixture({
      options: [{ ...analysisFixture().options[0]!, filesizeBytes: null }]
    })
    const second = createHarness({ media })
    const preview2 = await second.manager.analyzeCollection({ url: 'https://media.example/playlist?list=abc' })
    await second.manager.createCollectionBatch({
      previewId: preview2.id,
      selectedEntryIds: ['colentry_1'],
      mediaQuality: '1080p',
      maxBytesPerItem: 25_000
    })
    await second.manager.waitForIdle()
    expect(media.queueCalls[0]).toMatchObject({ maxBytes: 25_000 })
  })

  it('isolates a bad playlist entry while its sibling continues', async () => {
    const media = new FakeMediaJobs()
    const original = media.analyzeMedia.bind(media)
    let calls = 0
    media.analyzeMedia = async (input: unknown) => {
      calls += 1
      if (calls === 1) {
        throw new AppError('MEDIA_ANALYSIS_FAILED', 'The media could not be analyzed.')
      }
      return original(input)
    }
    const { manager } = createHarness({ media })
    const preview = await manager.analyzeCollection({
      url: 'https://media.example/playlist?list=abc'
    })
    const batch = await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1', 'colentry_2']
    })

    await manager.waitForIdle()
    const after = manager.getBatch(batch.id)
    expect(after.items[0]?.status).toBe('error')
    expect(after.items[1]?.status).toBe('running')
    expect(after.items[1]?.childId).not.toBeNull()
    expect(after.status).toBe('running')
  })
})

describe('Pixeldrain integration through the adapter', () => {
  it('resolves a single file to the raw endpoint before adding it', async () => {
    const { manager, pixeldrain, downloads } = createHarness()
    const result = await manager.submitSmartBatch({
      urls: ['https://pixeldrain.com/u/AbCd1234']
    })
    expect(result.previews).toHaveLength(0)
    const batchId = result.batch?.id
    if (!batchId) throw new Error('expected a direct batch')

    await manager.waitForIdle()
    expect(pixeldrain.resolveFileCalls).toEqual([
      'https://pixeldrain.com/u/AbCd1234'
    ])
    expect(downloads.addCalls[0]).toMatchObject({
      url: 'https://pixeldrain.com/api/file/AbCd1234',
      filename: 'AbCd1234.bin'
    })
    expect(manager.getBatch(batchId).items[0]?.childId).toBe('child_1')
  })

  it('returns a Pixeldrain list as a preview and downloads only selected entries', async () => {
    const { manager, pixeldrain, downloads } = createHarness()
    const submit = await manager.submitSmartBatch({
      urls: ['https://pixeldrain.com/l/List1234']
    })

    expect(submit.batch).toBeNull()
    expect(submit.previews).toHaveLength(1)
    expect(submit.entries[0]).toMatchObject({
      outcome: 'collection-preview',
      previewId: submit.previews[0]?.id
    })
    expect(downloads.addCalls).toHaveLength(0)

    const previewId = submit.previews[0]?.id
    if (!previewId) throw new Error('expected a list preview')
    const batch = await manager.createCollectionBatch({
      previewId,
      selectedEntryIds: ['colentry_pd_2']
    })
    expect(batch.kind).toBe('pixeldrain-list')
    expect(batch.items).toHaveLength(1)

    await manager.waitForIdle()
    expect(pixeldrain.resolveFileCalls).toEqual([
      'https://pixeldrain.com/u/filetwo'
    ])
    expect(downloads.addCalls[0]).toMatchObject({
      url: 'https://pixeldrain.com/api/file/filetwo'
    })
  })
})

describe('cancel, retry and remove isolation', () => {
  async function twoItemBatch(): Promise<{
    harness: Harness
    batchId: string
    itemIds: string[]
  }> {
    const harness = createHarness()
    const result = await harness.manager.submitSmartBatch({
      urls: [
        'https://example.com/files/a.zip',
        'https://example.com/files/b.zip'
      ]
    })
    const batchId = result.batch?.id
    const itemIds = result.entries
      .map((entry) => entry.itemId)
      .filter((id): id is string => id !== null)
    if (!batchId || itemIds.length !== 2) throw new Error('expected two items')
    await harness.manager.waitForIdle()
    return { harness, batchId, itemIds }
  }

  it('cancels one item, the group, and retries with a new child mapping', async () => {
    const { harness, batchId, itemIds } = await twoItemBatch()
    const { manager, downloads } = harness
    const firstId = itemIds[0] as string
    const secondId = itemIds[1] as string

    await manager.cancelBatchItem({ batchId, itemId: firstId })
    expect(downloads.pauseCalls).toContain('child_1')
    expect(manager.getBatch(batchId).items[0]?.status).toBe('cancelled')
    expect(manager.getBatch(batchId).items[1]?.status).toBe('running')

    downloads.fail('child_2', 'The remote file was not found.')
    manager.refresh()
    expect(manager.getBatch(batchId).items[1]?.status).toBe('error')

    const oldChild = manager.getBatch(batchId).items[1]?.childId
    await manager.retryBatchItem({ batchId, itemId: secondId })
    await manager.waitForIdle()
    const retried = manager.getBatch(batchId).items[1]
    expect(retried?.status).toBe('running')
    expect(retried?.childId).not.toBe(oldChild)
    // Children are never deleted by a batch action.
    expect(downloads.records.some((record) => record.id === oldChild)).toBe(true)

    await manager.cancelBatch({ batchId })
    expect(manager.getBatch(batchId).status).toBe('cancelled')
    expect(downloads.pauseCalls).toContain('child_3')

    await expect(
      manager.retryBatchItem({ batchId, itemId: firstId })
    ).rejects.toMatchObject({ code: 'BATCH_ITEM_NOT_RETRYABLE' })
  })

  it('cancels a media child without deleting its records', async () => {
    const { harness } = await twoItemBatch()
    const { manager, media } = harness
    const preview = await manager.analyzeCollection({
      url: 'https://media.example/playlist?list=abc'
    })
    const batch = await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: ['colentry_1']
    })
    await manager.waitForIdle()
    const childId = manager.getBatch(batch.id).items[0]?.childId
    if (!childId) throw new Error('expected a media child')

    await manager.cancelBatch({ batchId: batch.id })
    expect(media.cancelCalls).toContain(childId)
    expect(manager.getBatch(batch.id).status).toBe('cancelled')
    expect(media.jobs.some((job) => job.id === childId)).toBe(true)
  })

  it('removes only the batch row and leaves every child record intact', async () => {
    const { harness, batchId, itemIds } = await twoItemBatch()
    const { manager, downloads, media, database } = harness

    expect(downloads.records).toHaveLength(2)
    expect(itemIds).toHaveLength(2)

    await manager.removeBatch({ batchId })

    expect(manager.getBatchSnapshot().batches).toHaveLength(0)
    expect(database.deleted).toEqual([batchId])
    expect(downloads.records).toHaveLength(2)
    expect(media.jobs).toHaveLength(0)
    expect(downloads.pauseCalls).toHaveLength(0)
  })
})
