import { describe, expect, it } from 'vitest'
import type { ScanSession } from '../src/shared/scanner'
import {
  PixeldrainError,
  type PixeldrainFileResolution,
  type PixeldrainListResolution
} from '../src/main/hosts/pixeldrain'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import type { ScanPixeldrainPort } from '../src/main/scanner/pixeldrain'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const PAGE_URL = 'https://forum.example/thread/pixeldrain-1'

function page(body: string, finalUrl = PAGE_URL) {
  return {
    finalUrl,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

interface FakeFile {
  name: string
  size: number
  mimeType: string
}

interface FakeList {
  title: string
  files: Array<{ id: string } & FakeFile>
}

interface FakePortOptions {
  files?: Record<string, FakeFile | PixeldrainError>
  lists?: Record<string, FakeList | PixeldrainError>
  onCall?: (kind: 'file' | 'list', id: string) => void
}

function fileIdOf(value: unknown): string {
  const match = /\/u\/([A-Za-z0-9_-]+)\/?$/.exec(String(value))
  if (match === null) throw new Error(`not a file link: ${String(value)}`)
  return match[1]!
}

function listIdOf(value: unknown): string {
  const match = /\/l\/([A-Za-z0-9_-]+)\/?$/.exec(String(value))
  if (match === null) throw new Error(`not a list link: ${String(value)}`)
  return match[1]!
}

/** Hermetic stand-in for the public Pixeldrain adapter. No network. */
function fakePort(options: FakePortOptions = {}) {
  const calls: string[] = []
  const port: ScanPixeldrainPort = {
    resolveFile: async (value): Promise<PixeldrainFileResolution> => {
      const id = fileIdOf(value)
      calls.push(`file:${id}`)
      options.onCall?.('file', id)
      const entry = options.files?.[id]
      if (entry === undefined) throw new PixeldrainError('PIXELDRAIN_NOT_FOUND')
      if (entry instanceof PixeldrainError) throw entry
      return {
        kind: 'file',
        fileId: id,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
        sourceUrl: `https://pixeldrain.com/u/${id}`,
        downloadUrl: `https://pixeldrain.com/api/file/${id}`
      }
    },
    resolveList: async (value): Promise<PixeldrainListResolution> => {
      const id = listIdOf(value)
      calls.push(`list:${id}`)
      options.onCall?.('list', id)
      const entry = options.lists?.[id]
      if (entry === undefined) throw new PixeldrainError('PIXELDRAIN_NOT_FOUND')
      if (entry instanceof PixeldrainError) throw entry
      const entries = entry.files.map((file, position) => ({
        entryId: `entry_${position}`,
        position,
        fileId: file.id,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        sourceUrl: `https://pixeldrain.com/u/${file.id}`,
        downloadUrl: `https://pixeldrain.com/api/file/${file.id}`,
        availability: 'available' as const,
        errorCode: null,
        errorReason: null
      }))
      return {
        kind: 'list',
        listId: id,
        title: entry.title,
        sourceUrl: `https://pixeldrain.com/l/${id}`,
        preview: {
          id: 'preview_1',
          kind: 'pixeldrain-list',
          title: entry.title,
          entryCount: entries.length,
          availableCount: entries.length,
          unavailableCount: 0,
          entries: entries.map((item) => ({
            id: item.entryId,
            position: item.position,
            title: item.name,
            availability: 'available' as const,
            errorCode: null,
            errorReason: null
          }))
        },
        entries
      }
    }
  }
  return { port, calls }
}

/** A probe that records calls; it must never run for a resolved file. */
function recordingProbe() {
  const calls: string[] = []
  const probe: ProbeScanItemFn = async (input) => {
    calls.push(input.url)
    return {
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
    }
  }
  return { probe, calls }
}

function managed(
  fetcher: ScanPageFetcher,
  options: {
    pixeldrain?: ScanPixeldrainPort
    probe?: ProbeScanItemFn
    updates?: ScanSession[]
  } = {}
): ScanSessionManager {
  return new ScanSessionManager({
    fetchPage: fetcher,
    followDepth: 0,
    ...(options.pixeldrain === undefined ? {} : { pixeldrain: options.pixeldrain }),
    ...(options.probe === undefined ? {} : { probeItem: options.probe }),
    onUpdate: (session) => options.updates?.push(session)
  })
}

async function scanned(
  body: string,
  options: {
    pixeldrain?: ScanPixeldrainPort
    probe?: ProbeScanItemFn
    updates?: ScanSession[]
  } = {}
) {
  const sessions = managed(async () => page(body), options)
  const started = sessions.start(PAGE_URL)
  await sessions.waitForScan(started.sessionId)
  return { sessions, started, session: sessions.getSession(started.sessionId) }
}

describe('scan Pixeldrain resolution', () => {
  it('resolves a /u/ link to a video with its real name and size', async () => {
    const { port, calls } = fakePort({
      files: {
        Video001: {
          name: 'Fancam 01 Wonyoung.mp4',
          size: 123_456_789,
          mimeType: 'video/mp4'
        }
      }
    })
    const probe = recordingProbe()
    const { session } = await scanned(
      '<p><a href="https://pixeldrain.com/u/Video001">download</a></p>',
      { pixeldrain: port, probe: probe.probe }
    )

    expect(calls).toEqual(['file:Video001'])
    expect(session.items).toHaveLength(1)
    expect(session.items[0]).toMatchObject({
      category: 'video',
      kind: 'file',
      name: 'Fancam 01 Wonyoung.mp4',
      sizeBytes: 123_456_789,
      verified: true,
      status: 'ready'
    })
    // The resolved file is never re-probed as an HTML page.
    expect(probe.calls).toEqual([])
    // The public DTO never carries a URL.
    expect(JSON.stringify(session)).not.toContain('https://')
  })

  it('turns a /u/ .funscript into a script and pairs it with the post video', async () => {
    const TOPIC_URL = 'https://discuss.example/t/fancam-mix/9001'
    const topic = {
      id: 9001,
      title: 'Fancam mix scripts',
      slug: 'fancam-mix',
      post_stream: {
        posts: [
          {
            id: 1,
            post_number: 10,
            username: 'alice',
            cooked:
              '<p><a href="https://www.youtube.com/watch?v=abcdefghijk">Fancam 01 Wonyoung</a></p>' +
              '<p><a href="https://pixeldrain.com/u/Script01">script</a></p>'
          }
        ],
        stream: [1]
      }
    }
    const fetcher: ScanPageFetcher = async (input) => {
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
      const body =
        '<html><head><meta name="generator" content="Discourse 3.2.0" /></head><body></body></html>'
      return page(body, TOPIC_URL)
    }
    const { port } = fakePort({
      files: {
        Script01: {
          name: 'Fancam 01 Wonyoung.funscript',
          size: 4_096,
          mimeType: 'application/json'
        }
      }
    })
    const sessions = new ScanSessionManager({
      fetchPage: fetcher,
      followDepth: 0,
      pixeldrain: port,
      analyzeMedia: async () => ({
        analysisId: 'analysis_1',
        title: 'Fancam 01 Wonyoung',
        thumbnailUrl: null,
        durationSeconds: 200,
        options: [
          {
            kind: 'video',
            optionId: 'opt_1',
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
        bestVideoOptionId: 'opt_1',
        bestAudioOptionId: null,
        expiresAt: 9_999_999
      }),
      onUpdate: () => undefined
    })
    const started = sessions.start(TOPIC_URL)
    await sessions.waitForScan(started.sessionId)
    const session = sessions.getSession(started.sessionId)

    const script = session.items.find((item) => item.category === 'script')
    expect(script).toMatchObject({
      kind: 'file',
      name: 'Fancam 01 Wonyoung.funscript',
      sizeBytes: 4_096,
      status: 'ready',
      postNumber: 10,
      author: 'alice'
    })
    const video = session.items.find((item) => item.category === 'video')
    expect(video).toMatchObject({ kind: 'page-link', status: 'ready' })

    const set = session.scriptSets?.[0]
    expect(set?.matchedVideoItemId).toBe(video?.id)
    expect(set?.files[0]?.targetName).toBe('Fancam 01 Wonyoung.funscript')
  })

  it('expands a /l/ list into one item per file and keeps the post context', async () => {
    const { port, calls } = fakePort({
      lists: {
        List0001: {
          title: 'Shared assets',
          files: [
            { id: 'ListFile1', name: 'Clip One.mp4', size: 10, mimeType: 'video/mp4' },
            { id: 'ListFile2', name: 'Clip One.funscript', size: 20, mimeType: 'application/json' },
            { id: 'ListFile3', name: 'bundle.zip', size: 30, mimeType: 'application/zip' }
          ]
        }
      }
    })
    const updates: ScanSession[] = []
    const { session } = await scanned(
      '<p><a href="https://pixeldrain.com/l/List0001">list</a></p>',
      { pixeldrain: port, updates }
    )

    expect(calls).toEqual(['list:List0001'])
    expect(session.items.map((item) => item.name).sort()).toEqual([
      'Clip One.funscript',
      'Clip One.mp4',
      'bundle.zip'
    ])
    expect(session.items.map((item) => item.category).sort()).toEqual([
      'archive',
      'script',
      'video'
    ])
    expect(
      session.items.every((item) => item.status === 'ready' && item.verified)
    ).toBe(true)
    expect(session.items.every((item) => item.kind === 'file')).toBe(true)
    // The list page itself is replaced by its files.
    expect(session.items.some((item) => item.category === 'page')).toBe(false)
    expect(
      updates.some((update) => update.removedItemIds.length > 0)
    ).toBe(true)
  })

  it('collapses duplicate ids across /u/ links and list entries', async () => {
    const { port, calls } = fakePort({
      files: {
        DupFile01: {
          name: 'Duplicate.mp4',
          size: 512,
          mimeType: 'video/mp4'
        }
      },
      lists: {
        List0002: {
          title: 'Duplicates',
          files: [
            { id: 'DupFile01', name: 'Duplicate.mp4', size: 512, mimeType: 'video/mp4' },
            { id: 'DupFile02', name: 'Other.mp4', size: 256, mimeType: 'video/mp4' }
          ]
        }
      }
    })
    const { session } = await scanned(
      '<p><a href="https://pixeldrain.com/u/DupFile01">one</a></p>' +
        '<p><a href="https://pixeldrain.com/u/DupFile01/">same</a></p>' +
        '<p><a href="https://pixeldrain.com/l/List0002">list</a></p>',
      { pixeldrain: port }
    )

    expect(calls.filter((call) => call === 'file:DupFile01')).toHaveLength(1)
    expect(calls).toContain('list:List0002')
    expect(
      session.items.filter((item) => item.name === 'Duplicate.mp4')
    ).toHaveLength(1)
    expect(session.items.map((item) => item.name).sort()).toEqual([
      'Duplicate.mp4',
      'Other.mp4'
    ])
  })

  it('keeps a card visible with a reason when Pixeldrain refuses', async () => {
    const { port } = fakePort({
      files: { Rate00001: new PixeldrainError('PIXELDRAIN_RATE_LIMITED') },
      lists: { List0003: new PixeldrainError('PIXELDRAIN_CAPTCHA_REQUIRED') }
    })
    const { session } = await scanned(
      '<p><a href="https://pixeldrain.com/u/Rate00001">file</a></p>' +
        '<p><a href="https://pixeldrain.com/l/List0003">list</a></p>',
      { pixeldrain: port }
    )

    expect(session.status).toBe('done')
    const file = session.items.find((item) => item.kind === 'file')
    expect(file).toMatchObject({ status: 'unavailable', verified: false })
    expect(file?.unavailableReason).toContain('rate-limited')
    const list = session.items.find((item) => item.category === 'page')
    expect(list).toMatchObject({ status: 'unavailable' })
    expect(list?.unavailableReason).toContain('CAPTCHA')
  })

  it('stops issuing requests once the session is aborted', async () => {
    const files: Record<string, FakeFile> = {}
    for (const id of ['Abort0001', 'Abort0002', 'Abort0003', 'Abort0004']) {
      files[id] = { name: `${id}.mp4`, size: 1, mimeType: 'video/mp4' }
    }
    let cancel: (() => void) | null = null
    const { port, calls } = fakePort({
      files,
      onCall: () => cancel?.()
    })
    const sessions = managed(
      async () =>
        page(
          ['Abort0001', 'Abort0002', 'Abort0003', 'Abort0004']
            .map((id) => `<p><a href="https://pixeldrain.com/u/${id}">${id}</a></p>`)
            .join('')
        ),
      { pixeldrain: port }
    )
    const started = sessions.start(PAGE_URL)
    cancel = () => sessions.cancel(started.sessionId)
    await sessions.waitForScan(started.sessionId)

    expect(calls).toEqual(['file:Abort0001'])
    const session = sessions.getSession(started.sessionId)
    expect(session.status).toBe('cancelled')
  })
})
