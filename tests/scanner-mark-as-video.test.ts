import { describe, expect, it, vi } from 'vitest'
import type { MediaAnalysis, MediaFormatOption } from '../src/shared/media'
import { parseScanMarkAsVideoInput } from '../src/shared/scanner'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'

const PAGE_URL = 'https://forum.example/thread/one'

const lookup: PublicTargetLookup = async () => [
  { address: '93.184.216.34', family: 4 }
]

function page(body: string) {
  return {
    finalUrl: PAGE_URL,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

const htmlProbe: ProbeScanItemFn = async (input) => ({
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

function formatOption(): MediaFormatOption {
  return {
    optionId: 'opt_1080',
    kind: 'video',
    label: '1080p · MP4',
    container: 'mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'avc1',
    audioCodec: 'aac',
    hasAudio: true,
    requiresMerge: false,
    filesizeBytes: 10 * 1024 * 1024,
    estimatedBytes: null,
    sizeIsEstimate: false,
    outputFormats: ['auto', 'mp4']
  }
}

function analysis(): MediaAnalysis {
  return {
    analysisId: 'analysis_1',
    title: 'Demo video',
    thumbnailUrl: null,
    durationSeconds: 30,
    options: [formatOption()],
    bestVideoOptionId: 'opt_1080',
    bestAudioOptionId: null,
    expiresAt: 10_000
  }
}

function managed(options: {
  body: string
  analyze?: (url: string) => Promise<MediaAnalysis>
  videoCap?: number
}): ScanSessionManager {
  const fetcher: ScanPageFetcher = async () => page(options.body)
  return new ScanSessionManager({
    fetchPage: fetcher,
    probeItem: htmlProbe,
    lookup,
    analyzeMedia: options.analyze ?? (async () => analysis()),
    ...(options.videoCap === undefined ? {} : { videoCap: options.videoCap }),
    onUpdate: () => undefined
  })
}

async function scanned(
  manager: ScanSessionManager
): Promise<{ sessionId: string; itemIds: string[] }> {
  const started = manager.start(PAGE_URL)
  await manager.waitForScan(started.sessionId)
  const done = manager.getSession(started.sessionId)
  return {
    sessionId: started.sessionId,
    itemIds: done.items.map((item) => item.id)
  }
}

const TWO_LINKS = `
  <a href="/files/one.mp4">one</a>
  <a href="/files/two.mp4">two</a>
`

describe('mark as video validator', () => {
  it('accepts exactly a session ID and an item ID', () => {
    expect(
      parseScanMarkAsVideoInput({
        sessionId: 'scan_1',
        itemId: 'item_1'
      })
    ).toEqual({ sessionId: 'scan_1', itemId: 'item_1' })

    expect(() =>
      parseScanMarkAsVideoInput({
        sessionId: 'scan_1',
        itemId: 'item_1',
        url: 'https://evil.example/'
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseScanMarkAsVideoInput({ sessionId: 'scan_1' })
    ).toThrow(/missing required fields/)
    expect(() =>
      parseScanMarkAsVideoInput({ sessionId: 'bad id', itemId: 'item_1' })
    ).toThrow(/session identifier/)
  })
})

describe('mark as video', () => {
  it('converts a listed page link and resolves it into a normal video card', async () => {
    const manager = managed({ body: TWO_LINKS })
    const { sessionId, itemIds } = await scanned(manager)
    const before = manager.getSession(sessionId)
    expect(before.items[0]).toMatchObject({
      category: 'page',
      kind: 'page-link',
      status: 'found'
    })

    const after = await manager.markAsVideo(sessionId, itemIds[0]!)
    const item = after.items.find((candidate) => candidate.id === itemIds[0])

    expect(item).toMatchObject({
      category: 'video',
      kind: 'page-link',
      status: 'ready',
      verified: true,
      name: 'Demo video',
      bestOptionId: 'opt_1080'
    })
    expect(item?.formats).toHaveLength(1)
    // The renderer never receives the stored source URL.
    expect(JSON.stringify(after)).not.toContain('https://')
  })

  it('is idempotent: a second mark does not analyse again', async () => {
    const analyze = vi.fn(async () => analysis())
    const manager = managed({ body: TWO_LINKS, analyze })
    const { sessionId, itemIds } = await scanned(manager)

    await manager.markAsVideo(sessionId, itemIds[0]!)
    const second = await manager.markAsVideo(sessionId, itemIds[0]!)

    expect(analyze).toHaveBeenCalledTimes(1)
    expect(
      second.items.find((candidate) => candidate.id === itemIds[0])?.status
    ).toBe('ready')
  })

  it('rejects a non-public URL before any analysis', async () => {
    const analyze = vi.fn(async () => analysis())
    const manager = managed({
      body: '<a href="http://127.0.0.1/files/local.mp4">local</a>',
      analyze
    })
    const { sessionId, itemIds } = await scanned(manager)

    await expect(
      manager.markAsVideo(sessionId, itemIds[0]!)
    ).rejects.toMatchObject({ code: 'SCAN_TARGET_NOT_PUBLIC' })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('shares the same per-session analysis budget as a scan', async () => {
    const analyze = vi.fn(async () => analysis())
    const manager = managed({ body: TWO_LINKS, analyze, videoCap: 1 })
    const { sessionId, itemIds } = await scanned(manager)

    await manager.markAsVideo(sessionId, itemIds[0]!)
    await expect(
      manager.markAsVideo(sessionId, itemIds[1]!)
    ).rejects.toMatchObject({ code: 'SCAN_VIDEO_LIMIT' })
    expect(analyze).toHaveBeenCalledTimes(1)
  })
})
