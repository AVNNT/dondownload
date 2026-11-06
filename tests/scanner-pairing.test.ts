import { describe, expect, it, vi } from 'vitest'
import type { Batch } from '../src/shared/batches'
import type { MediaAnalysis } from '../src/shared/media'
import {
  parseScanQueueSelectionInput,
  parseScanSession
} from '../src/shared/scanner'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import { ScanQueueService } from '../src/main/scanner/queue'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const PAGE_URL = 'https://discuss.example/t/fancam-mix/9001'
const TOPIC_ID = 9001

interface PostFixture {
  number: number
  author: string
  videos: Array<{ id: string; title: string }>
  scripts: string[]
}

const POSTS: PostFixture[] = [
  {
    number: 10,
    author: 'alice',
    videos: [{ id: 'fancam01', title: 'Fancam 01 Wonyoung' }],
    scripts: [
      'Fancam 01 Wonyoung.funscript',
      'Fancam 01 Wonyoung.roll.funscript',
      'Fancam 01 Wonyoung.surge.funscript',
      'Fancam 01 Wonyoung.twist.funscript'
    ]
  },
  {
    number: 11,
    author: 'bob',
    videos: [{ id: 'fancam02', title: 'Fancam 02 Wonyoung' }],
    scripts: [
      'Fancam 02 Wonyoung.funscript',
      'Fancam 02 Wonyoung.hard.funscript',
      'Fancam 02 Wonyoung.hard.roll.funscript'
    ]
  },
  {
    number: 12,
    author: 'carol',
    videos: [{ id: 'fancam03', title: 'Fancam 03 Wonyoung' }],
    scripts: [
      'Fancam 03 Wonyoung.roll.funscript',
      'Fancam 03 Wonyoung.pitch.funscript'
    ]
  },
  {
    number: 13,
    author: 'dave',
    videos: [
      { id: 'fancam04', title: 'Fancam 04 Wonyoung' },
      { id: 'fancam04alt', title: 'Fancam 04 Wonyoung Full' }
    ],
    scripts: [
      'Fancam 04 Wonyoung.funscript',
      'Fancam 04 Wonyoung.roll.funscript'
    ]
  },
  {
    number: 14,
    author: 'erin',
    videos: [{ id: 'fancam05', title: 'Fancam 05 Wonyoung' }],
    scripts: []
  },
  {
    number: 16,
    author: 'frank',
    videos: [{ id: 'stagemix', title: 'Stage Mix Wonyoung' }],
    scripts: [
      'Stage Mix Wonyoung.funscript',
      'Stage Mix Wonyoung.roll.funscript'
    ]
  }
]

function videoId(prefix: string, index: number): string {
  return `AbCdEf${String(index).padStart(3, '0')}`
}

function cooked(post: PostFixture): string {
  const videos = post.videos
    .map(
      (video, index) =>
        `<p><a href="https://www.youtube.com/watch?v=${videoId(
          video.id,
          post.number * 10 + index
        )}">${video.title}</a></p>`
    )
    .join('')
  const scripts = post.scripts
    .map(
      (name, index) =>
        `<p><a class="attachment" href="/uploads/f/${post.number}-${index}/${encodeURIComponent(name)}">${name}</a></p>`
    )
    .join('')
  return videos + scripts
}

const topic = {
  id: TOPIC_ID,
  title: 'Fancam mix scripts',
  slug: 'fancam-mix',
  post_stream: {
    posts: POSTS.map((post, index) => ({
      id: 1000 + index,
      post_number: post.number,
      username: post.author,
      cooked: cooked(post)
    })),
    stream: POSTS.map((_, index) => 1000 + index)
  }
}

const fetchPage: ScanPageFetcher = async (input) => {
  if (input.url.endsWith('.json')) {
    return {
      finalUrl: input.url,
      status: 200,
      contentType: 'application/json',
      contentDisposition: null,
      body: JSON.stringify(topic),
      bytes: 1
    }
  }
  const body = `<html><head><meta name="generator" content="Discourse 3.2.0" /></head><body><base href="https://discuss.example/t/fancam-mix/" /></body></html>`
  return {
    finalUrl: PAGE_URL,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: body.length
  }
}

const readyProbe: ProbeScanItemFn = async (input) => {
  const classification = classifyScanCandidate({ url: input.url })
  return {
    status: 'ready',
    verified: true,
    contentType: 'application/octet-stream',
    contentDisposition: null,
    sizeBytes: 1024,
    finalUrl: input.url,
    classification,
    reason: null
  }
}

function analysisFor(url: string): MediaAnalysis {
  const parsed = new URL(url)
  const id = parsed.searchParams.get('v') ?? 'unknown'
  const entry = POSTS.flatMap((post) =>
    post.videos.map((video, index) => ({
      id: videoId(video.id, post.number * 10 + index),
      title: video.title
    }))
  ).find((video) => video.id === id)
  const title = entry?.title ?? 'Unknown video'
  return {
    analysisId: `analysis_${id}`,
    title,
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

async function scanned() {
  const updates: ReturnType<ScanSessionManager['getSession']>[] = []
  const sessions = new ScanSessionManager({
    now: () => 1_000,
    fetchPage,
    probeItem: readyProbe,
    followDepth: 0,
    analyzeMedia: async (url) => analysisFor(url),
    onUpdate: (session) => updates.push(session)
  })
  const started = sessions.start(PAGE_URL)
  await sessions.waitForScan(started.sessionId)
  return { sessions, session: sessions.getSession(started.sessionId), updates }
}

function itemByName(
  session: Awaited<ReturnType<typeof scanned>>['session'],
  name: string
) {
  const item = session.items.find((candidate) => candidate.name === name)
  if (!item) throw new Error(`missing item ${name}`)
  return item
}

function setForBase(
  session: Awaited<ReturnType<typeof scanned>>['session'],
  base: string
) {
  const set = session.scriptSets?.find((candidate) => candidate.base === base)
  if (!set) throw new Error(`missing set ${base}`)
  return set
}

function fakeBatch(): Batch {
  return {
    id: 'batch_1',
    kind: 'direct-urls',
    title: 'Scan: discuss.example',
    status: 'queued',
    progress: {
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      completedBytes: 0,
      totalBytes: 0
    },
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    items: []
  }
}

describe('scan script pairing DTOs', () => {
  it('groups Discourse post scripts and matches multi-axis, variant, missing-main and ambiguous sets', async () => {
    const { session } = await scanned()
    const sets = session.scriptSets ?? []
    expect(sets).toHaveLength(5)

    const multi = setForBase(session, 'Fancam 01 Wonyoung')
    expect(multi.postNumber).toBe(10)
    expect(multi.axes).toEqual(['roll', 'surge', 'twist'])
    expect(multi.missingMain).toBe(false)
    expect(multi.ambiguous).toBe(false)
    expect(multi.matchBucket).toBe('strong')
    expect(multi.matchedVideoItemId).toBe(
      itemByName(session, 'Fancam 01 Wonyoung').id
    )
    expect(multi.files.map((file) => file.filename)).toContain(
      'Fancam 01 Wonyoung.funscript'
    )
    expect(multi.files.every((file) => file.targetName?.startsWith('Fancam 01 Wonyoung'))).toBe(
      true
    )

    const variants = setForBase(session, 'Fancam 02 Wonyoung')
    expect(variants.variants).toEqual(['hard'])
    expect(variants.matchedVideoItemId).toBe(
      itemByName(session, 'Fancam 02 Wonyoung').id
    )

    const missing = setForBase(session, 'Fancam 03 Wonyoung')
    expect(missing.missingMain).toBe(true)
    expect(missing.files.some((file) => file.isMain)).toBe(false)
    expect(missing.matchedVideoItemId).toBe(
      itemByName(session, 'Fancam 03 Wonyoung').id
    )

    const ambiguous = setForBase(session, 'Fancam 04 Wonyoung')
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.matchedVideoItemId).toBeNull()

    const mix = setForBase(session, 'Stage Mix Wonyoung')
    expect(mix.matchedVideoItemId).toBe(itemByName(session, 'Stage Mix Wonyoung').id)
  })

  it('recomputes matches progressively as videos resolve', async () => {
    const { updates, session } = await scanned()
    const withScripts = updates.filter((update) => (update.scriptSets?.length ?? 0) > 0)
    expect(withScripts.length).toBeGreaterThan(1)
    expect(
      withScripts[0]?.scriptSets?.every((set) => set.matchedVideoItemId === null)
    ).toBe(true)
    expect(
      session.scriptSets?.some((set) => set.matchedVideoItemId !== null)
    ).toBe(true)
  })

  it('keeps URLs, paths and raw scores out of the renderer DTO', async () => {
    const { session } = await scanned()
    const serialized = JSON.stringify(session)
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('youtube.com/watch')
    expect(serialized).not.toContain('uploads/f/')
    expect(serialized).not.toContain('C:\\\\')
    expect(serialized).not.toContain('"score"')
    // The strict session parser accepts the DTO round-trip.
    expect(parseScanSession(session)).toEqual(session)
  })
})

describe('scan script pairing queue validation', () => {
  it('accepts an explicit multi-axis pairing and passes it to the batch port', async () => {
    const { sessions, session } = await scanned()
    const video = itemByName(session, 'Fancam 01 Wonyoung')
    const set = setForBase(session, 'Fancam 01 Wonyoung')
    const scriptIds = set.files.map((file) => file.id)
    const captured: unknown[] = []
    const batches = {
      createScanBatch: vi.fn(async () => fakeBatch()),
      createScanMediaBatch: vi.fn(async (input: unknown) => {
        captured.push(input)
        return fakeBatch()
      })
    }
    const queue = new ScanQueueService({
      sessions,
      batches,
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })

    const result = await queue.queueSelection(
      session.sessionId,
      [video.id, ...scriptIds],
      [],
      [
        {
          videoItemId: video.id,
          setId: set.id,
          scriptItemIds: scriptIds,
          primaryVariant: null,
          rename: true
        }
      ]
    )
    expect(result.queuedItemIds).toContain(video.id)
    expect(captured).toHaveLength(1)
    const input = captured[0] as {
      files: Array<{ scanItemId: string; filename: string }>
      videos: Array<{ scanItemId: string }>
      pairings: Array<{ setId: string; scriptItemIds: string[]; rename: boolean }>
    }
    expect(input.videos[0]?.scanItemId).toBe(video.id)
    expect(input.files.map((file) => file.scanItemId).sort()).toEqual(
      [...scriptIds].sort()
    )
    expect(input.pairings[0]).toMatchObject({
      setId: set.id,
      rename: true
    })
  })

  it('rejects unknown and foreign item IDs', async () => {
    const { sessions, session } = await scanned()
    const other = await scanned()
    const video = itemByName(session, 'Fancam 01 Wonyoung')
    const foreign = itemByName(other.session, 'Fancam 01 Wonyoung')
    const queue = new ScanQueueService({
      sessions,
      batches: { createScanBatch: vi.fn(async () => fakeBatch()) },
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })

    await expect(
      queue.queueSelection(session.sessionId, ['item_unknown'], [])
    ).rejects.toMatchObject({ code: 'SCAN_ITEM_NOT_FOUND' })

    await expect(
      queue.queueSelection(session.sessionId, [foreign.id], [])
    ).rejects.toMatchObject({ code: 'SCAN_ITEM_NOT_FOUND' })

    await expect(
      queue.queueSelection(session.sessionId, [video.id], [], [
        {
          videoItemId: video.id,
          setId: 'set:unknown@1',
          scriptItemIds: [video.id],
          primaryVariant: null,
          rename: true
        }
      ])
    ).rejects.toMatchObject({ code: 'SCAN_PAIRING_INVALID' })
  })

  it('rejects scripts that do not belong to the named set', async () => {
    const { sessions, session } = await scanned()
    const video = itemByName(session, 'Fancam 01 Wonyoung')
    const set = setForBase(session, 'Fancam 01 Wonyoung')
    const other = setForBase(session, 'Fancam 02 Wonyoung')
    const otherScript = other.files[0]!
    const queue = new ScanQueueService({
      sessions,
      batches: { createScanBatch: vi.fn(async () => fakeBatch()) },
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })

    await expect(
      queue.queueSelection(
        session.sessionId,
        [video.id, ...set.files.map((file) => file.id), otherScript.id],
        [],
        [
          {
            videoItemId: video.id,
            setId: set.id,
            scriptItemIds: [...set.files.map((file) => file.id), otherScript.id],
            primaryVariant: null,
            rename: true
          }
        ]
      )
    ).rejects.toMatchObject({ code: 'SCAN_PAIRING_INVALID' })
  })

  it('rejects unsupported pairings keys and unknown primary variants', async () => {
    expect(() =>
      parseScanQueueSelectionInput({
        sessionId: 'scan_1',
        itemIds: ['item_1'],
        pairings: [
          {
            videoItemId: 'item_1',
            setId: 'set:name@1',
            scriptItemIds: ['item_1'],
            primaryVariant: null,
            rename: true,
            extra: true
          }
        ]
      })
    ).toThrow(/unsupported fields/)

    const { sessions, session } = await scanned()
    const video = itemByName(session, 'Fancam 01 Wonyoung')
    const set = setForBase(session, 'Fancam 01 Wonyoung')
    const queue = new ScanQueueService({
      sessions,
      batches: { createScanBatch: vi.fn(async () => fakeBatch()) },
      mediaJobs: { analyzeMedia: vi.fn() },
      probeItem: readyProbe,
      now: () => 1_000
    })

    await expect(
      queue.queueSelection(
        session.sessionId,
        [video.id, ...set.files.map((file) => file.id)],
        [],
        [
          {
            videoItemId: video.id,
            setId: set.id,
            scriptItemIds: set.files.map((file) => file.id),
            primaryVariant: 'hard',
            rename: true
          }
        ]
      )
    ).rejects.toMatchObject({ code: 'SCAN_PAIRING_INVALID' })
  })
})
