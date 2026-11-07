import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showItemInFolder } = vi.hoisted(() => ({
  showItemInFolder: vi.fn()
}))

vi.mock('electron', () => ({
  shell: { showItemInFolder }
}))

// The merge-output probe is exercised on its own (media-merge-progress.test.ts);
// here only its scheduling and publication are under test.
const { readMergeProgress } = vi.hoisted(() => ({
  readMergeProgress: vi.fn(
    async (_probe: {
      dir: string
      since: number
      totalBytes?: number | null
    }): Promise<{ completedBytes: number; totalBytes: number } | null> => null
  )
}))

vi.mock('../src/main/mediaJobs/mergeProgress', () => ({
  MERGE_PROGRESS_POLL_MS: 1_000,
  readMergeProgress
}))

import type {
  MediaAnalysis,
  MediaFormatOption,
  MediaJobRecord,
  MediaJobStatus,
  MediaSnapshot,
  MediaToolState
} from '../src/shared/media'
import type { MediaBridgeTarget } from '../src/shared/mediaBridge'
import { ValidationError } from '../src/shared/validation'
import {
  MEDIA_INTERRUPTED_MESSAGE,
  MediaJobsManager,
  type MediaDownloadProgress,
  type MediaDownloadRequest,
  type MediaDownloadResult,
  type MediaEnginePort,
  type MediaJobsPersistence
} from '../src/main/mediaJobs/manager'

const VIDEO_OPTION_ID = 'option_video_0123456789'
const AUDIO_OPTION_ID = 'option_audio_0123456789'
const ANALYSIS_ID = 'analysis_0123456789abcdef'

const ACTIVE_STATUSES: readonly MediaJobStatus[] = [
  'queued',
  'analyzing',
  'downloading',
  'merging'
]

interface PendingDownload {
  request: MediaDownloadRequest
  onProgress: (progress: MediaDownloadProgress) => void
  resolve: (result: MediaDownloadResult) => void
  reject: (error: unknown) => void
}

class FakeEngine implements MediaEnginePort {
  toolState: MediaToolState = {
    status: 'ready',
    version: 'test-engine',
    message: null,
    hint: null
  }
  toolError: Error | null = null
  analysis: MediaAnalysis = analysisFixture()
  analyzeError: Error | null = null
  analyzedUrls: string[] = []
  analysisOptions: Array<{ cookie?: string } | undefined> = []
  downloads: PendingDownload[] = []
  cancelCalls: string[] = []
  pauseCalls: string[] = []
  cancelError: Error | null = null
  cancelAllCalls = 0
  cancelAllError: Error | null = null
  cancelAllPending: Promise<void> | null = null

  async getToolState(): Promise<MediaToolState> {
    if (this.toolError) throw this.toolError
    return { ...this.toolState }
  }

  async analyze(
    url: string,
    options?: { cookie?: string }
  ): Promise<MediaAnalysis> {
    this.analyzedUrls.push(url)
    this.analysisOptions.push(options)
    if (this.analyzeError) throw this.analyzeError
    return analysisFixture({
      ...this.analysis,
      options: this.analysis.options.map((option) => ({ ...option }))
    })
  }

  download(
    request: MediaDownloadRequest,
    onProgress: (progress: MediaDownloadProgress) => void
  ): Promise<MediaDownloadResult> {
    return new Promise<MediaDownloadResult>((resolve, reject) => {
      this.downloads.push({ request, onProgress, resolve, reject })
    })
  }

  cancel(jobId: string): void {
    this.cancelCalls.push(jobId)
    if (this.cancelError) throw this.cancelError
  }

  pause(jobId: string): void {
    this.pauseCalls.push(jobId)
    // Emulate the real engine: the child stops and its run rejects. The
    // manager must ignore that rejection because the row is already paused.
    const index = this.downloads.findIndex(
      (pending) => pending.request.jobId === jobId
    )
    if (index >= 0) {
      const [pending] = this.downloads.splice(index, 1)
      pending?.reject(new Error('paused by user'))
    }
  }

  async cancelAll(): Promise<void> {
    this.cancelAllCalls += 1
    if (this.cancelAllPending) await this.cancelAllPending
    if (this.cancelAllError) throw this.cancelAllError
  }

  get pending(): PendingDownload {
    const pending = this.downloads[this.downloads.length - 1]
    if (!pending) throw new Error('No pending download.')
    return pending
  }
}

class FakePersistence implements MediaJobsPersistence {
  readonly rows = new Map<string, MediaJobRecord>()
  readonly savedSingles: string[] = []
  readonly savedBatches: MediaJobRecord[][] = []
  readonly deleted: string[] = []
  readonly deletedBatches: string[][] = []
  loadFails = false
  saveFails = false

  loadMediaJobs(): MediaJobRecord[] {
    if (this.loadFails) throw new Error('load failed')
    return [...this.rows.values()].map((record) => ({ ...record }))
  }

  saveMediaJob(record: MediaJobRecord): void {
    if (this.saveFails) throw new Error('save failed')
    this.savedSingles.push(record.id)
    this.rows.set(record.id, { ...record })
  }

  saveManyMediaJobs(records: readonly MediaJobRecord[]): void {
    if (this.saveFails) throw new Error('save failed')
    this.savedBatches.push(records.map((record) => ({ ...record })))
    for (const record of records) {
      this.rows.set(record.id, { ...record })
    }
  }

  deleteMediaJob(id: string): void {
    this.deleted.push(id)
    this.rows.delete(id)
  }

  deleteMediaJobs(ids: readonly string[]): void {
    this.deletedBatches.push([...ids])
    for (const id of ids) {
      this.deleted.push(id)
      this.rows.delete(id)
    }
  }

  seed(record: MediaJobRecord): void {
    this.rows.set(record.id, { ...record })
  }
}

interface Harness {
  engine: FakeEngine
  database: FakePersistence
  manager: MediaJobsManager
  updates: MediaSnapshot[]
  mediaDir: string
}

const tempDirs: string[] = []
const managers: MediaJobsManager[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-media-jobs-'))
  tempDirs.push(dir)
  return dir
}

async function createHarness(
  options: {
    engine?: FakeEngine
    database?: FakePersistence
    mediaDir?: string
    outputDirFor?: (kind: 'video' | 'audio') => string
    outputRootDir?: string
    now?: () => number
    progressPersistIntervalMs?: number
    startAllowed?: (now: number) => boolean
  } = {}
): Promise<Harness> {
  const engine = options.engine ?? new FakeEngine()
  const database = options.database ?? new FakePersistence()
  const mediaDir = options.mediaDir ?? (await makeTempDir())
  const updates: MediaSnapshot[] = []
  const manager = new MediaJobsManager({
    engine,
    mediaDir,
    outputDirFor: options.outputDirFor,
    outputRootDir: options.outputRootDir,
    database,
    onUpdate: (snapshot) => updates.push(snapshot),
    now: options.now,
    progressPersistIntervalMs: options.progressPersistIntervalMs,
    startAllowed: options.startAllowed
  })
  managers.push(manager)
  return { engine, database, manager, updates, mediaDir }
}

function formatOption(
  overrides: Partial<MediaFormatOption> = {}
): MediaFormatOption {
  return {
    kind: 'video',
    optionId: VIDEO_OPTION_ID,
    label: '1080p MP4 - H.264 + AAC',
    container: 'mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    hasAudio: true,
    requiresMerge: true,
    filesizeBytes: 1_000,
    ...overrides
  }
}

function audioOption(): MediaFormatOption {
  return formatOption({
    kind: 'audio',
    optionId: AUDIO_OPTION_ID,
    label: 'Audio only - Opus',
    container: 'opus',
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: 'opus',
    hasAudio: true,
    requiresMerge: false,
    filesizeBytes: 500
  })
}

function analysisFixture(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    analysisId: ANALYSIS_ID,
    title: 'Example media',
    durationSeconds: 120,
    options: [formatOption(), audioOption()],
    bestVideoOptionId: VIDEO_OPTION_ID,
    bestAudioOptionId: AUDIO_OPTION_ID,
    expiresAt: Date.now() + 60_000,
    ...overrides
  }
}

function recordFixture(overrides: Partial<MediaJobRecord> = {}): MediaJobRecord {
  const now = Date.UTC(2026, 2, 4, 5, 6, 7)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    sourceUrl: 'https://example.com/watch?v=abc',
    analysisId: ANALYSIS_ID,
    optionId: VIDEO_OPTION_ID,
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4 - H.264 + AAC',
    status: 'queued',
    completedBytes: 0,
    totalBytes: 1_000,
    errorMessage: null,
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload\\Media',
    filePath: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides
  }
}

function progress(
  overrides: Partial<MediaDownloadProgress> = {}
): MediaDownloadProgress {
  return {
    status: 'downloading',
    completedBytes: 0,
    totalBytes: null,
    speedBps: 0,
    filePath: null,
    ...overrides
  }
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve()
  }
}

async function queueVideo(
  harness: Harness,
  options: { force?: true } = {}
): Promise<Awaited<ReturnType<MediaJobsManager['queueMedia']>>> {
  const analysis = await harness.manager.analyzeMedia({
    url: 'https://example.com/watch?v=1'
  })
  return harness.manager.queueMedia({
    analysisId: analysis.analysisId,
    optionId: VIDEO_OPTION_ID,
    ...options
  })
}

async function completeVideo(
  harness: Harness,
  filePath: string
): Promise<Awaited<ReturnType<MediaJobsManager['queueMedia']>>> {
  const job = await queueVideo(harness)
  await flushMicrotasks()
  harness.engine.pending.resolve({ filePath, totalBytes: 1_000 })
  await flushMicrotasks()
  return job
}

beforeEach(() => {
  showItemInFolder.mockReset()
  readMergeProgress.mockReset()
  readMergeProgress.mockResolvedValue(null)
})

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      await manager.close()
    } catch {
      // Best effort for a failing test.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('MediaJobsManager analysis and opaque selection', () => {
  it('sorts new video and audio jobs into the configured type folders', async () => {
    const root = await makeTempDir()
    const mediaDir = path.join(root, 'Media')
    const harness = await createHarness({
      mediaDir,
      outputRootDir: root,
      outputDirFor: (kind) => path.join(root, kind === 'audio' ? 'Audio' : 'Video')
    })
    const analysis = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=1'
    })

    await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: VIDEO_OPTION_ID
    })
    await flushMicrotasks()
    await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: AUDIO_OPTION_ID
    })
    await flushMicrotasks()

    expect(harness.engine.downloads.map((entry) => entry.request.dir)).toEqual([
      path.join(root, 'Video'),
      path.join(root, 'Audio')
    ])
  })

  it('satisfies the MediaBridgeTarget interface structurally', async () => {
    const harness = await createHarness()
    const target: MediaBridgeTarget = harness.manager

    expect(target).toBe(harness.manager)
    expect(typeof target.analyzeMedia).toBe('function')
    expect(typeof target.queueMedia).toBe('function')
    expect(typeof target.getMediaStatus).toBe('function')
    expect(typeof target.cancelMedia).toBe('function')
  })

  it('keeps the cookie decision in the analysis identity and forwards it to the download', async () => {
    const harness = await createHarness()
    const analysis = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=1',
      cookie: 'session=abc'
    })
    expect(harness.engine.analysisOptions).toEqual([{ cookie: 'session=abc' }])

    await expect(
      harness.manager.queueMedia({
        analysisId: analysis.analysisId,
        optionId: VIDEO_OPTION_ID
      })
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_MISMATCH' })

    const job = await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: VIDEO_OPTION_ID,
      cookie: 'session=abc'
    })
    expect(job.status).toBe('queued')
    await flushMicrotasks()
    expect(harness.engine.pending.request.cookie).toBe('session=abc')

    // The memory-only cookie must never appear in a persisted row.
    const stored = [...harness.database.rows.values()].find(
      (record) => record.id === job.id
    )
    expect(stored).toBeDefined()
    expect(JSON.stringify(stored)).not.toContain('session=abc')
  })

  it('normalizes the page URL and returns a public job without URL, path or selector', async () => {
    const harness = await createHarness()
    const analysis = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=abc#fragment'
    })

    expect(harness.engine.analyzedUrls).toEqual([
      'https://example.com/watch?v=abc'
    ])
    expect(analysis.analysisId).toBe(ANALYSIS_ID)

    const job = await queueVideo(harness)

    expect(job.status).toBe('queued')
    expect(Object.keys(job).sort()).toEqual(
      [
        'analysisId',
        'completedAt',
        'completedBytes',
        'createdAt',
        'errorMessage',
        'id',
        'kind',
        'label',
        'optionId',
        'speedBps',
        'status',
        'title',
        'totalBytes',
        'updatedAt'
      ].sort()
    )
    expect(Object.isFrozen(job)).toBe(true)

    const snapshot = harness.manager.getMediaSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.jobs)).toBe(true)
    expect(Object.isFrozen(snapshot.tool)).toBe(true)

    const exposed = JSON.stringify({ job, snapshot })
    expect(exposed).not.toContain('example.com')
    expect(exposed).not.toContain(harness.mediaDir)
    expect(exposed).not.toContain('sourceUrl')
    expect(exposed).not.toContain('filePath')
    expect(exposed).not.toContain('"dir"')

    await flushMicrotasks()
    harness.engine.pending.resolve({
      filePath: path.join(harness.mediaDir, 'video.mp4'),
      totalBytes: 1_000
    })
    await flushMicrotasks()
  })

  it('serves display details on demand while snapshots stay clean', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)

    // The bulk job DTO and snapshot never carry a URL or path.
    const exposed = JSON.stringify({
      job,
      snapshot: harness.manager.getMediaSnapshot()
    })
    expect(exposed).not.toContain('example.com')
    expect(exposed).not.toContain('sourceUrl')
    expect(exposed).not.toContain('filePath')

    // The scoped details accessor recovers exactly the persisted data.
    expect(harness.manager.getMediaJobDetails(job.id)).toEqual({
      sourceUrl: 'https://example.com/watch?v=1',
      filePath: null
    })

    await flushMicrotasks()
    harness.engine.pending.resolve({
      filePath: path.join(harness.mediaDir, 'video.mp4'),
      totalBytes: 1_000
    })
    await flushMicrotasks()
    expect(harness.manager.getMediaJobDetails(job.id)).toEqual({
      sourceUrl: 'https://example.com/watch?v=1',
      filePath: path.join(harness.mediaDir, 'video.mp4')
    })
  })

  it('rejects credential-bearing URLs and unsupported extra fields before analysis', async () => {
    const harness = await createHarness()

    await expect(
      harness.manager.analyzeMedia({
        url: 'https://user:secret@example.com/watch?v=abc'
      })
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      harness.manager.analyzeMedia({
        url: 'https://example.com/watch?v=abc',
        cookies: 'secret'
      })
    ).rejects.toBeInstanceOf(ValidationError)
    expect(harness.engine.analyzedUrls).toHaveLength(0)
  })

  it('rejects missing, expired and mismatched analysis/option identifiers', async () => {
    let now = 1_000_000
    const engine = new FakeEngine()
    engine.analysis = analysisFixture({ expiresAt: now + 1_000 })
    const harness = await createHarness({ engine, now: () => now })

    await expect(
      harness.manager.queueMedia({
        analysisId: 'analysis_missing',
        optionId: VIDEO_OPTION_ID
      })
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_NOT_FOUND' })

    const first = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=first'
    })

    await expect(
      harness.manager.queueMedia({
        analysisId: first.analysisId,
        optionId: 'option_unknown_0123456789'
      })
    ).rejects.toMatchObject({ code: 'MEDIA_OPTION_INVALID' })

    // An incompatible container is rejected, never replaced by another one.
    await expect(
      harness.manager.queueMedia({
        analysisId: first.analysisId,
        optionId: VIDEO_OPTION_ID,
        outputFormat: 'webm'
      })
    ).rejects.toMatchObject({ code: 'MEDIA_OUTPUT_FORMAT_UNSUPPORTED' })

    // A second analysis exists, but its option is not valid for the first one.
    const otherOptionId = 'option_other_0123456789'
    engine.analysis = analysisFixture({
      analysisId: 'analysis_other_0123456789',
      options: [
        formatOption({
          optionId: otherOptionId,
          label: 'Other video'
        })
      ],
      bestVideoOptionId: otherOptionId,
      bestAudioOptionId: null,
      expiresAt: now + 1_000
    })
    await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=second'
    })
    await expect(
      harness.manager.queueMedia({
        analysisId: first.analysisId,
        optionId: otherOptionId
      })
    ).rejects.toMatchObject({ code: 'MEDIA_OPTION_INVALID' })

    now += 1_001
    await expect(
      harness.manager.queueMedia({
        analysisId: first.analysisId,
        optionId: VIDEO_OPTION_ID
      })
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_EXPIRED' })

    expect(harness.engine.downloads).toHaveLength(0)
  })
})

describe('MediaJobsManager queue lifecycle', () => {
  it('holds a job while the start gate is closed and starts it on a policy pump', async () => {
    let allowed = false
    const harness = await createHarness({ startAllowed: () => allowed })
    const job = await queueVideo(harness)
    await flushMicrotasks()

    expect(harness.manager.getMediaJob(job.id).status).toBe('queued')
    expect(harness.engine.downloads).toHaveLength(0)
    expect(harness.manager.hasPendingPolicyWork()).toBe(true)

    allowed = true
    harness.manager.pumpPolicy()
    await flushMicrotasks()

    expect(harness.engine.downloads).toHaveLength(1)
    expect(harness.manager.getMediaJob(job.id).status).toBe('downloading')
    expect(harness.manager.hasPendingPolicyWork()).toBe(false)
  })

  it('moves queued -> downloading -> merging -> complete and persists internal paths only', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    expect(harness.engine.downloads).toHaveLength(1)
    expect(harness.engine.pending.request).toMatchObject({
      jobId: job.id,
      sourceUrl: 'https://example.com/watch?v=1',
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID,
      dir: harness.mediaDir
    })

    const partialPath = path.join(harness.mediaDir, 'video.part')
    const finalPath = path.join(harness.mediaDir, 'video.mp4')

    harness.engine.pending.onProgress(
      progress({
        completedBytes: 100,
        totalBytes: 1_000,
        speedBps: 50,
        filePath: partialPath
      })
    )
    let current = harness.manager.getMediaJob(job.id)
    expect(current.status).toBe('downloading')
    expect(current.completedBytes).toBe(100)
    expect(current.totalBytes).toBe(1_000)
    expect(current.speedBps).toBe(50)
    expect(harness.manager.getActiveProgress()).toEqual({
      activeCount: 1,
      sizedCount: 1,
      completedBytes: 100,
      totalBytes: 1_000
    })

    harness.engine.pending.onProgress(
      progress({
        status: 'merging',
        completedBytes: 1_000,
        totalBytes: 1_000,
        speedBps: 0,
        filePath: partialPath
      })
    )
    current = harness.manager.getMediaJob(job.id)
    expect(current.status).toBe('merging')
    expect(current.speedBps).toBe(0)
    // Merging no longer transfers, so it does not contribute to the taskbar.
    expect(harness.manager.getActiveProgress().activeCount).toBe(0)

    harness.engine.pending.resolve({
      filePath: finalPath,
      totalBytes: 1_000
    })
    await flushMicrotasks()

    current = harness.manager.getMediaJob(job.id)
    expect(current.status).toBe('complete')
    expect(current.completedBytes).toBe(1_000)
    expect(current.totalBytes).toBe(1_000)
    expect(current.speedBps).toBe(0)
    expect(current.completedAt).not.toBeNull()
    expect(current.errorMessage).toBeNull()

    const stored = harness.database.rows.get(job.id)
    expect(stored?.status).toBe('complete')
    expect(stored?.filePath).toBe(finalPath)
    expect(stored?.sourceUrl).toBe('https://example.com/watch?v=1')

    const exposed = JSON.stringify(harness.manager.getMediaSnapshot())
    expect(exposed).not.toContain(finalPath)
    expect(exposed).not.toContain('example.com')

    expect(harness.updates.length).toBeGreaterThan(0)
    expect(harness.updates[harness.updates.length - 1]?.jobs[0]?.status).toBe(
      'complete'
    )
  })

  it('coalesces repeated progress writes but persists critical transitions immediately', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({ progressPersistIntervalMs: 1_000 })
    const job = await queueVideo(harness)
    await flushMicrotasks()

    expect(harness.database.rows.get(job.id)?.status).toBe('downloading')
    const singlesBefore = harness.database.savedSingles.length
    const batchesBefore = harness.database.savedBatches.length

    harness.engine.pending.onProgress(
      progress({ completedBytes: 10, totalBytes: 100 })
    )
    harness.engine.pending.onProgress(
      progress({ completedBytes: 20, totalBytes: 100 })
    )
    harness.engine.pending.onProgress(
      progress({ completedBytes: 30, totalBytes: 100 })
    )

    // Same-status progress is dirty but not written synchronously.
    expect(harness.database.savedSingles.length).toBe(singlesBefore)
    expect(harness.database.savedBatches.length).toBe(batchesBefore)

    await vi.advanceTimersByTimeAsync(999)
    expect(harness.database.savedBatches.length).toBe(batchesBefore)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.database.savedBatches.length).toBe(batchesBefore + 1)
    expect(harness.database.rows.get(job.id)?.completedBytes).toBe(30)

    // A status transition writes at once, without waiting for the interval.
    harness.engine.pending.onProgress(
      progress({
        status: 'merging',
        completedBytes: 30,
        totalBytes: 100
      })
    )
    expect(harness.database.savedSingles.length).toBe(singlesBefore + 1)
    expect(harness.database.rows.get(job.id)?.status).toBe('merging')

    harness.engine.pending.resolve({
      filePath: path.join(harness.mediaDir, 'done.mp4'),
      totalBytes: 100
    })
    await flushMicrotasks()
    expect(harness.database.rows.get(job.id)?.status).toBe('complete')
  })

  it('coalesces progress publishes into one trailing update', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({ progressPersistIntervalMs: 1_000 })
    const job = await queueVideo(harness)
    await flushMicrotasks()
    const before = harness.updates.length

    harness.engine.pending.onProgress(
      progress({ completedBytes: 10, totalBytes: 100 })
    )
    harness.engine.pending.onProgress(
      progress({ completedBytes: 20, totalBytes: 100 })
    )
    harness.engine.pending.onProgress(
      progress({ completedBytes: 30, totalBytes: 100 })
    )

    // Same-status progress is coalesced instead of publishing on every line.
    expect(harness.updates.length).toBe(before)
    await vi.advanceTimersByTimeAsync(199)
    expect(harness.updates.length).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.updates.length).toBe(before + 1)
    expect(harness.updates[harness.updates.length - 1]?.jobs[0]?.completedBytes).toBe(
      30
    )

    // A repeated line with the same numbers is not a change at all.
    harness.engine.pending.onProgress(
      progress({ completedBytes: 30, totalBytes: 100 })
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(harness.updates.length).toBe(before + 1)

    // A status transition publishes immediately, without waiting.
    harness.engine.pending.onProgress(
      progress({ status: 'merging', completedBytes: 30, totalBytes: 100 })
    )
    expect(harness.updates.length).toBe(before + 2)
    expect(harness.updates[harness.updates.length - 1]?.jobs[0]?.status).toBe(
      'merging'
    )
    expect(harness.database.rows.get(job.id)?.status).toBe('merging')
  })

  it('turns engine failures into a sanitized error state', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.reject(
      new Error('raw failure https://example.com/secret C:\\Users\\secret\\file')
    )
    await flushMicrotasks()

    const current = harness.manager.getMediaJob(job.id)
    expect(current.status).toBe('error')
    expect(current.errorMessage).not.toContain('raw failure')
    expect(current.errorMessage).not.toContain('https://')
    expect(current.errorMessage).not.toContain('secret')
    expect(current.errorMessage).not.toContain('\\')

    const stored = harness.database.rows.get(job.id)
    expect(stored?.status).toBe('error')
    expect(stored?.errorMessage).toBe(current.errorMessage)

    const exposed = JSON.stringify(harness.manager.getMediaSnapshot())
    expect(exposed).not.toContain('raw failure')
    expect(exposed).not.toContain('example.com')
  })

  it('sanitizes analyzer failures instead of leaking engine output', async () => {
    const harness = await createHarness()
    harness.engine.analyzeError = new Error(
      'analyzer command failed for https://example.com/watch?v=secret'
    )

    let error: unknown
    try {
      await harness.manager.analyzeMedia({
        url: 'https://example.com/watch?v=secret'
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).not.toContain('example.com')
    expect(message).not.toContain('analyzer command')
    expect(message).not.toContain('secret')
  })
})

describe('MediaJobsManager cancellation', () => {
  it('signals the engine and stays cancelled despite late progress or completion', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.onProgress(
      progress({ completedBytes: 10, totalBytes: 100 })
    )
    const cancelled = await harness.manager.cancelMedia(job.id)

    expect(cancelled.status).toBe('cancelled')
    expect(harness.engine.cancelCalls).toEqual([job.id])
    expect(harness.database.rows.get(job.id)?.status).toBe('cancelled')

    harness.engine.pending.onProgress(
      progress({ completedBytes: 50, totalBytes: 100 })
    )
    harness.engine.pending.resolve({
      filePath: path.join(harness.mediaDir, 'ignored.mp4'),
      totalBytes: 100
    })
    await flushMicrotasks()

    expect(harness.manager.getMediaJob(job.id).status).toBe('cancelled')
    expect(harness.database.rows.get(job.id)?.status).toBe('cancelled')

    const again = await harness.manager.cancelMedia(job.id)
    expect(again.status).toBe('cancelled')
    expect(harness.engine.cancelCalls).toHaveLength(1)

    await expect(
      harness.manager.cancelMedia('99999999-9999-4999-8999-999999999999')
    ).rejects.toMatchObject({ code: 'MEDIA_JOB_NOT_FOUND' })
  })

  it('still reaches cancelled when the engine cancel signal throws', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()
    harness.engine.cancelError = new Error('engine cancel exploded')

    const cancelled = await harness.manager.cancelMedia(job.id)
    expect(cancelled.status).toBe('cancelled')
    expect(harness.database.rows.get(job.id)?.status).toBe('cancelled')
  })
})

describe('MediaJobsManager duplicate policy', () => {
  it('rejects the same active source+option unless force is true', async () => {
    const harness = await createHarness()
    const analysis = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=1'
    })
    const first = await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: VIDEO_OPTION_ID
    })
    await flushMicrotasks()

    await expect(
      harness.manager.queueMedia({
        analysisId: analysis.analysisId,
        optionId: VIDEO_OPTION_ID
      })
    ).rejects.toMatchObject({ code: 'MEDIA_DUPLICATE_JOB' })
    expect(harness.engine.downloads).toHaveLength(1)

    const forced = await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: VIDEO_OPTION_ID,
      force: true
    })
    await flushMicrotasks()
    expect(forced.id).not.toBe(first.id)
    expect(harness.engine.downloads).toHaveLength(2)

    // A different option for the same source is not a duplicate.
    await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: AUDIO_OPTION_ID
    })
    await flushMicrotasks()
    expect(harness.engine.downloads).toHaveLength(3)

    // Once the earlier jobs are terminal, a fresh non-forced queue is allowed.
    await harness.manager.cancelMedia(first.id)
    await harness.manager.cancelMedia(forced.id)
    const fresh = await harness.manager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: VIDEO_OPTION_ID
    })
    expect(fresh.id).not.toBe(first.id)
  })

  it('rejects the same source+format across fresh opaque analysis IDs unless forced', async () => {
    const engine = new FakeEngine()
    const harness = await createHarness({ engine })
    const firstAnalysis = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=1'
    })
    const first = await harness.manager.queueMedia({
      analysisId: firstAnalysis.analysisId,
      optionId: VIDEO_OPTION_ID
    })
    await flushMicrotasks()

    // A new analysis returns different opaque IDs for the same visible format.
    const secondOptionId = 'option_video_fresh_0123456789'
    engine.analysis = analysisFixture({
      analysisId: 'analysis_fresh_0123456789',
      options: [formatOption({ optionId: secondOptionId }), audioOption()],
      bestVideoOptionId: secondOptionId
    })
    const secondAnalysis = await harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=1#fresh'
    })
    expect(secondAnalysis.analysisId).not.toBe(firstAnalysis.analysisId)

    await expect(
      harness.manager.queueMedia({
        analysisId: secondAnalysis.analysisId,
        optionId: secondOptionId
      })
    ).rejects.toMatchObject({ code: 'MEDIA_DUPLICATE_JOB' })
    expect(harness.engine.downloads).toHaveLength(1)

    const forced = await harness.manager.queueMedia({
      analysisId: secondAnalysis.analysisId,
      optionId: secondOptionId,
      force: true
    })
    await flushMicrotasks()
    expect(forced.id).not.toBe(first.id)
    expect(harness.engine.downloads).toHaveLength(2)
  })
})

describe('MediaJobsManager analysis cache', () => {
  it('evicts analyses beyond the engine cache capacity instead of queuing an unavailable ID', async () => {
    const engine = new FakeEngine()
    const harness = await createHarness({ engine })
    const analysisIds: string[] = []
    const optionIds: string[] = []

    for (let index = 0; index < 33; index += 1) {
      const analysisId = `analysis_cache_${String(index).padStart(12, '0')}`
      const optionId = `option_cache_${String(index).padStart(12, '0')}`
      engine.analysis = analysisFixture({
        analysisId,
        options: [formatOption({ optionId, label: `Cache video ${index}` })],
        bestVideoOptionId: optionId,
        bestAudioOptionId: null
      })
      const analysis = await harness.manager.analyzeMedia({
        url: `https://example.com/watch?v=cache-${index}`
      })
      analysisIds.push(analysis.analysisId)
      optionIds.push(optionId)
    }

    await expect(
      harness.manager.queueMedia({
        analysisId: analysisIds[0] as string,
        optionId: optionIds[0] as string
      })
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_NOT_FOUND' })

    // The newest analysis remains usable, so the manager never points at an
    // ID already evicted from the engine's 32-entry cache.
    const job = await harness.manager.queueMedia({
      analysisId: analysisIds[32] as string,
      optionId: optionIds[32] as string
    })
    expect(job.status).toBe('queued')
  })
})

describe('MediaJobsManager recovery and persistence', () => {
  it('marks persisted nonterminal jobs interrupted without resuming or deleting files', async () => {
    const now = 5_000_000
    const database = new FakePersistence()
    const mediaDir = await makeTempDir()
    const partialPath = path.join(mediaDir, 'partial.mp4')

    const activeIds: string[] = []
    ACTIVE_STATUSES.forEach((status, index) => {
      const id = `1111111${index}-1111-4111-8111-11111111111${index}`
      activeIds.push(id)
      database.seed(
        recordFixture({
          id,
          status,
          dir: mediaDir,
          completedBytes: index * 10,
          totalBytes: 1_000,
          filePath: status === 'downloading' ? partialPath : null,
          createdAt: now - index,
          updatedAt: now - index
        })
      )
    })

    database.seed(
      recordFixture({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'complete',
        dir: mediaDir,
        completedBytes: 1_000,
        filePath: path.join(mediaDir, 'complete.mp4'),
        completedAt: now - 10
      })
    )
    database.seed(
      recordFixture({
        id: '33333333-3333-4333-8333-333333333333',
        status: 'error',
        dir: mediaDir,
        errorMessage: 'safe error'
      })
    )
    database.seed(
      recordFixture({
        id: '44444444-4444-4444-8444-444444444444',
        status: 'cancelled',
        dir: mediaDir
      })
    )
    database.seed(
      recordFixture({
        id: '55555555-5555-4555-8555-555555555555',
        status: 'interrupted',
        dir: mediaDir,
        errorMessage: MEDIA_INTERRUPTED_MESSAGE
      })
    )

    const engine = new FakeEngine()
    const updates: MediaSnapshot[] = []
    const manager = new MediaJobsManager({
      engine,
      mediaDir,
      database,
      onUpdate: (snapshot) => updates.push(snapshot),
      now: () => now
    })
    managers.push(manager)

    const jobs = new Map(
      manager.getMediaSnapshot().jobs.map((job) => [job.id, job])
    )
    for (const id of activeIds) {
      expect(jobs.get(id)?.status).toBe('interrupted')
      expect(jobs.get(id)?.errorMessage).toBe(MEDIA_INTERRUPTED_MESSAGE)
      expect(jobs.get(id)?.speedBps).toBe(0)
    }
    expect(jobs.get('22222222-2222-4222-8222-222222222222')?.status).toBe(
      'complete'
    )
    expect(jobs.get('33333333-3333-4333-8333-333333333333')?.status).toBe(
      'error'
    )
    expect(jobs.get('44444444-4444-4444-8444-444444444444')?.status).toBe(
      'cancelled'
    )
    expect(jobs.get('55555555-5555-4555-8555-555555555555')?.status).toBe(
      'interrupted'
    )

    // One atomic recovery batch; no deletes, no engine calls, partial path kept.
    expect(database.savedBatches).toHaveLength(1)
    expect(database.savedBatches[0]).toHaveLength(ACTIVE_STATUSES.length)
    expect(database.deleted).toHaveLength(0)
    expect(database.rows.get(activeIds[2] ?? '')?.filePath).toBe(partialPath)
    expect(engine.downloads).toHaveLength(0)
    expect(engine.analyzedUrls).toHaveLength(0)

    // A second startup sees the already-interrupted rows and writes nothing.
    const reopened = new MediaJobsManager({
      engine,
      mediaDir,
      database,
      onUpdate: () => undefined,
      now: () => now
    })
    managers.push(reopened)
    expect(database.savedBatches).toHaveLength(1)
    expect(reopened.getMediaSnapshot().jobs).toHaveLength(8)
    expect(updates.length).toBe(0)
  })

  it('skips tampered persisted URLs without deleting their rows', async () => {
    const database = new FakePersistence()
    const mediaDir = await makeTempDir()
    database.seed(
      recordFixture({
        id: '66666666-6666-4666-8666-666666666666',
        sourceUrl: 'https://user:secret@example.com/watch?v=1',
        status: 'downloading',
        dir: mediaDir
      })
    )

    const harness = await createHarness({
      database,
      mediaDir,
      engine: new FakeEngine()
    })

    expect(harness.manager.getMediaSnapshot().jobs).toHaveLength(0)
    expect(harness.database.deleted).toHaveLength(0)
    expect(harness.database.rows.size).toBe(1)
  })
})

describe('MediaJobsManager removal and show-in-folder', () => {
  it('removes only the database row and never deletes the media file', async () => {
    const harness = await createHarness()
    const filePath = path.join(harness.mediaDir, 'kept.mp4')
    await writeFile(filePath, 'media bytes')
    const job = await completeVideo(harness, filePath)

    const snapshot = await harness.manager.removeMedia(job.id)

    expect(snapshot.jobs.some((candidate) => candidate.id === job.id)).toBe(false)
    expect(harness.database.deleted).toEqual([job.id])
    expect(harness.database.rows.has(job.id)).toBe(false)
    expect(showItemInFolder).not.toHaveBeenCalled()
    await expect(access(filePath)).resolves.toBeUndefined()

    await expect(harness.manager.removeMedia(job.id)).rejects.toMatchObject({
      code: 'MEDIA_JOB_NOT_FOUND'
    })
  })

  it('shows a completed, validated file inside the media directory', async () => {
    const harness = await createHarness()
    const filePath = path.join(harness.mediaDir, 'ready.mp4')
    await writeFile(filePath, 'media bytes')
    const job = await completeVideo(harness, filePath)

    await expect(harness.manager.showMediaInFolder(job.id)).resolves.toBeNull()
    expect(showItemInFolder).toHaveBeenCalledWith(filePath)
  })

  it('rejects incomplete, outside-directory and missing files', async () => {
    const harness = await createHarness()
    const pending = await queueVideo(harness)
    await flushMicrotasks()

    await expect(
      harness.manager.showMediaInFolder(pending.id)
    ).rejects.toMatchObject({ code: 'FILE_NOT_READY' })

    const outsidePath = path.join(os.tmpdir(), 'outside-media.mp4')
    await writeFile(outsidePath, 'outside')
    try {
      harness.engine.pending.resolve({ filePath: outsidePath, totalBytes: 6 })
      await flushMicrotasks()

      await expect(
        harness.manager.showMediaInFolder(pending.id)
      ).rejects.toMatchObject({ code: 'FILE_OUTSIDE_MEDIA_DIR' })
    } finally {
      await rm(outsidePath, { force: true })
    }

    const missingPath = path.join(harness.mediaDir, 'missing.mp4')
    const missingJob = await completeVideo(harness, missingPath)
    await expect(
      harness.manager.showMediaInFolder(missingJob.id)
    ).rejects.toMatchObject({ code: 'FILE_MISSING' })
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('MediaJobsManager tool state', () => {
  it('marks active work interrupted, cancels its child and flushes before close', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    expect(harness.manager.getMediaJob(job.id).status).toBe('downloading')
    await harness.manager.close()

    expect(harness.manager.getMediaJob(job.id)).toMatchObject({
      status: 'interrupted',
      errorMessage: MEDIA_INTERRUPTED_MESSAGE,
      speedBps: 0
    })
    expect(harness.engine.cancelCalls).toEqual([job.id])
    expect(harness.engine.cancelAllCalls).toBe(1)
    expect(harness.database.rows.get(job.id)?.status).toBe('interrupted')
  })

  it('waits for engine cancellation before completing close and blocks new work', async () => {
    const harness = await createHarness()
    let releaseCancellation: () => void = () => undefined
    harness.engine.cancelAllPending = new Promise<void>((resolve) => {
      releaseCancellation = resolve
    })

    let closed = false
    const closing = harness.manager.close().then(() => {
      closed = true
    })
    await flushMicrotasks()

    expect(harness.engine.cancelAllCalls).toBe(1)
    expect(closed).toBe(false)

    releaseCancellation()
    await closing
    expect(closed).toBe(true)

    await expect(
      harness.manager.analyzeMedia({ url: 'https://example.com/watch?v=1' })
    ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' })
    expect(harness.engine.analyzedUrls).toHaveLength(0)
  })

  it('interrupts an in-flight analysis while closing', async () => {
    const engine = new FakeEngine()
    let rejectAnalyze: ((error: unknown) => void) | null = null
    engine.analyze = () =>
      new Promise<MediaAnalysis>((_resolve, reject) => {
        rejectAnalyze = reject
      })
    engine.cancelAll = async () => {
      rejectAnalyze?.(new Error('engine shutting down'))
    }
    const harness = await createHarness({ engine })

    const pending = harness.manager.analyzeMedia({
      url: 'https://example.com/watch?v=1'
    })
    await flushMicrotasks()
    await harness.manager.close()

    await expect(pending).rejects.toMatchObject({
      code: 'MEDIA_ANALYSIS_FAILED'
    })
  })

  it('publishes a parsed tool state', async () => {
    const harness = await createHarness()
    harness.engine.toolState = {
      status: 'ready',
      version: '2026.02.01',
      message: null,
      hint: null
    }

    const tool = await harness.manager.refreshToolState()
    expect(tool).toEqual(harness.engine.toolState)
    expect(harness.manager.getMediaSnapshot().tool).toEqual(tool)
    expect(harness.updates[harness.updates.length - 1]?.tool).toEqual(tool)
  })

  it('turns engine tool failures and invalid shapes into a sanitized error state', async () => {
    const harness = await createHarness()
    harness.engine.toolError = new Error(
      'tool failed at https://example.com/secret C:\\secret'
    )
    await harness.manager.refreshToolState()

    let snapshot = harness.manager.getMediaSnapshot()
    expect(snapshot.tool.status).toBe('error')
    expect(snapshot.tool.message).not.toContain('secret')
    expect(snapshot.tool.message).not.toContain('example.com')
    expect(snapshot.tool.message).not.toContain('\\')

    harness.engine.toolError = null
    harness.engine.toolState = {
      status: 'ready',
      version: null,
      message: null,
      hint: null,
      rawSelector: 'worstvideo+worstaudio'
    } as unknown as MediaToolState
    await harness.manager.refreshToolState()

    snapshot = harness.manager.getMediaSnapshot()
    expect(snapshot.tool.status).toBe('error')
    expect(JSON.stringify(snapshot)).not.toContain('worstvideo')
  })
})

describe('MediaJobsManager pause, resume and pinned retry', () => {
  it('pauses the child and keeps the exact selection for resume', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()
    const firstRequest = harness.engine.downloads[0]?.request

    const paused = await harness.manager.pauseMedia(job.id)
    expect(paused.jobs.find((entry) => entry.id === job.id)?.status).toBe(
      'paused'
    )
    expect(harness.engine.pauseCalls).toEqual([job.id])

    // The engine rejection from the stopped child must not turn the row into
    // an error while it is paused.
    await flushMicrotasks()
    expect(
      harness.manager.getMediaSnapshot().jobs.find((entry) => entry.id === job.id)
        ?.status
    ).toBe('paused')

    const resumed = await harness.manager.resumeMedia(job.id)
    expect(resumed.jobs.find((entry) => entry.id === job.id)?.status).toBe(
      'queued'
    )
    await flushMicrotasks()
    const resumedJob = harness.manager.getMediaSnapshot().jobs.find(
      (entry) => entry.id === job.id
    )
    expect(resumedJob?.status).toBe('downloading')

    const secondRequest = harness.engine.downloads.at(-1)?.request
    expect(secondRequest).toMatchObject({
      jobId: firstRequest?.jobId,
      analysisId: firstRequest?.analysisId,
      optionId: firstRequest?.optionId,
      outputFormat: firstRequest?.outputFormat
    })
  })

  it('retries a failed job with the pinned format and never re-analyzes', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()
    harness.engine.pending.reject(new Error('network failed'))
    await flushMicrotasks()
    expect(
      harness.manager.getMediaSnapshot().jobs.find((entry) => entry.id === job.id)
        ?.status
    ).toBe('error')

    const analyzedBefore = harness.engine.analyzedUrls.length
    const retried = await harness.manager.retryMedia(job.id)
    expect(retried.jobs.find((entry) => entry.id === job.id)?.status).toBe(
      'queued'
    )
    await flushMicrotasks()

    expect(harness.engine.analyzedUrls).toHaveLength(analyzedBefore)
    const retriedRequest = harness.engine.downloads.at(-1)?.request
    expect(retriedRequest).toMatchObject({
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID
    })
  })

  it('retries a user-cancelled job and rejects resuming a non-paused one', async () => {
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()
    await harness.manager.cancelMedia(job.id)
    expect(
      harness.manager.getMediaSnapshot().jobs.find((entry) => entry.id === job.id)
        ?.status
    ).toBe('cancelled')

    const retried = await harness.manager.retryMedia(job.id)
    expect(retried.jobs.find((entry) => entry.id === job.id)?.status).toBe(
      'queued'
    )
    await flushMicrotasks()

    await expect(harness.manager.resumeMedia(job.id)).rejects.toMatchObject({
      code: 'MEDIA_NOT_PAUSED'
    })
  })
})

describe('MediaJobsManager merge progress', () => {
  it('samples the merge output once a second and publishes it coalesced', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.onProgress(
      progress({ status: 'merging', completedBytes: 1_000, totalBytes: 1_000 })
    )
    expect(readMergeProgress).not.toHaveBeenCalled()

    readMergeProgress.mockResolvedValue({
      completedBytes: 410,
      totalBytes: 1_000
    })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(readMergeProgress).toHaveBeenCalledTimes(1)
    expect(readMergeProgress.mock.calls[0]?.[0]).toEqual({
      dir: harness.mediaDir,
      since: expect.any(Number),
      totalBytes: 1_000
    })

    // The sample is published through the same coalesced trailing update.
    const before = harness.updates.length
    await vi.advanceTimersByTimeAsync(200)
    expect(harness.updates.length).toBeGreaterThan(before)
    const published = harness.manager.getMediaSnapshot().jobs[0]
    expect(published?.mergeProgress).toEqual({
      completedBytes: 410,
      totalBytes: 1_000
    })

    // The next tick re-reads the growing file.
    readMergeProgress.mockResolvedValue({
      completedBytes: 820,
      totalBytes: 1_000
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readMergeProgress).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(harness.manager.getMediaSnapshot().jobs[0]?.mergeProgress).toEqual({
      completedBytes: 820,
      totalBytes: 1_000
    })
  })

  it('keeps the row indeterminate while the merge output is unmeasurable', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.onProgress(
      progress({ status: 'merging', completedBytes: 1_000, totalBytes: 1_000 })
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(200)

    expect(readMergeProgress).toHaveBeenCalledTimes(1)
    const published = harness.manager.getMediaSnapshot().jobs[0]
    expect(published?.status).toBe('merging')
    expect(published?.mergeProgress).toBeUndefined()
    expect(Object.keys(harness.manager.getMediaJob(job.id))).not.toContain(
      'mergeProgress'
    )
  })

  it('stops polling as soon as the job leaves the merging status', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.onProgress(
      progress({ status: 'merging', completedBytes: 1_000, totalBytes: 1_000 })
    )
    readMergeProgress.mockResolvedValue({
      completedBytes: 410,
      totalBytes: 1_000
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(200)
    expect(readMergeProgress).toHaveBeenCalledTimes(1)

    harness.engine.pending.resolve({
      filePath: path.join(harness.mediaDir, 'done.mp4'),
      totalBytes: 1_000
    })
    await flushMicrotasks()

    const completed = harness.manager.getMediaJob(job.id)
    expect(completed.status).toBe('complete')
    expect(completed.mergeProgress).toBeUndefined()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(readMergeProgress).toHaveBeenCalledTimes(1)
  })

  it('stops polling when the job is paused', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.onProgress(
      progress({ status: 'merging', completedBytes: 1_000, totalBytes: 1_000 })
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readMergeProgress).toHaveBeenCalledTimes(1)

    await harness.manager.pauseMedia(job.id)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(readMergeProgress).toHaveBeenCalledTimes(1)
    expect(harness.manager.getMediaJob(job.id).mergeProgress).toBeUndefined()
  })

  it('ignores a sample that arrives after the job left the merge phase', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    const job = await queueVideo(harness)
    await flushMicrotasks()

    harness.engine.pending.onProgress(
      progress({ status: 'merging', completedBytes: 1_000, totalBytes: 1_000 })
    )

    let release: (value: { completedBytes: number; totalBytes: number }) => void =
      () => undefined
    readMergeProgress.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await harness.manager.pauseMedia(job.id)
    release({ completedBytes: 410, totalBytes: 1_000 })
    await flushMicrotasks()

    expect(harness.manager.getMediaJob(job.id).mergeProgress).toBeUndefined()
  })
})
