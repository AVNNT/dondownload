import { describe, expect, it, vi } from 'vitest'
import type { Batch } from '../src/shared/batches'
import type { SniffedMediaInput } from '../src/shared/sniffedMedia'
import type { ScanSession } from '../src/shared/scanner'
import { AppError } from '../src/main/errors'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'
import { BrowserMatchService } from '../src/main/scanner/browserMatch'

const TOPIC = 'https://discuss.example/t/topic/1'
const HANIME = 'https://hanime1.me/watch?v=1234'

function page(finalUrl: string, body: string) {
  return {
    finalUrl,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

const fetcher: ScanPageFetcher = async (input) => {
  if (input.url.endsWith('/robots.txt')) return page(input.url, '')
  if (input.url === TOPIC) {
    return page(
      TOPIC,
      `<a href="${HANIME}" rel="nofollow ugc">Hanime1 Watch Video</a>
       <a class="attachment" href="/uploads/Hanime1%20Watch%20Video.funscript">main</a>
       <a class="attachment" href="/uploads/Hanime1%20Watch%20Video.roll.funscript">roll</a>`
    )
  }
  return page(input.url, '')
}

const probe: ProbeScanItemFn = async (input) => {
  const contentType = input.url.endsWith('.funscript')
    ? 'application/json'
    : 'text/html'
  return {
    status: 'ready',
    verified: true,
    contentType,
    contentDisposition: null,
    sizeBytes: 1024,
    finalUrl: input.url,
    classification: classifyScanCandidate({ url: input.url, contentType }),
    reason: null
  }
}

interface Harness {
  sessions: ScanSessionManager
  session: ScanSession
  service: BrowserMatchService
  batches: { createBrowserMatchBatch: ReturnType<typeof vi.fn> }
}

async function harness(now: () => number): Promise<Harness> {
  const sessions = new ScanSessionManager({
    fetchPage: fetcher,
    probeItem: probe,
    analyzeMedia: async () => {
      throw new AppError('MEDIA_UNSUPPORTED_MEDIA', 'unsupported host')
    },
    now,
    onUpdate: () => undefined
  })
  const started = sessions.start(TOPIC)
  await sessions.waitForScan(started.sessionId)
  const session = sessions.getSession(started.sessionId)
  const video = session.items.find(
    (item) => item.category === 'video' && item.status === 'browser-only'
  )
  const set = session.scriptSets?.[0]
  if (!video || !set) throw new Error('fixture did not produce a browser-only pair')
  sessions.armBrowserMatch(session.sessionId, video.id, {
    videoItemId: video.id,
    setId: set.id,
    scriptItemIds: set.files.map((file) => file.id),
    primaryVariant: null,
    rename: true
  })
  const batches = { createBrowserMatchBatch: vi.fn(async () => ({} as Batch)) }
  return {
    sessions,
    session,
    batches,
    service: new BrowserMatchService({ sessions, batches })
  }
}

function sniffed(pageUrl: string): SniffedMediaInput {
  return {
    url: 'https://cdn.hanime1.me/stream/1234.mp4',
    pageUrl,
    referer: pageUrl,
    userAgent: 'Mozilla/5.0 Test',
    kind: 'file',
    title: 'Hanime1 Watch Video'
  }
}

describe('browser hand-off auto-match', () => {
  it('consumes a matching normalized page URL once and creates the batch with scripts', async () => {
    let current = 1_000
    const { batches, service, session } = await harness(() => current)
    expect(session.items.some((item) => item.status === 'browser-only')).toBe(true)

    const incoming = sniffed(`${HANIME}&utm_source=test&fbclid=x`)
    await expect(service.handleSniffed(incoming)).resolves.toBe(true)
    expect(batches.createBrowserMatchBatch).toHaveBeenCalledTimes(1)
    const input = batches.createBrowserMatchBatch.mock.calls[0]?.[0] as {
      title: string
      video: SniffedMediaInput
      scripts: Array<{ scanItemId: string; requestHeaders?: { cookie: string } }>
      pairing: { setId: string; scriptItemIds: string[] }
    }
    expect(input.title).toContain('Hanime1')
    expect(input.video.kind).toBe('file')
    expect(input.scripts).toHaveLength(2)
    expect(input.scripts.every((script) => script.requestHeaders === undefined)).toBe(true)
    expect(input.pairing.setId.startsWith('set:')).toBe(true)
    expect(input.pairing.scriptItemIds).toHaveLength(2)

    // Once consumed, the next hand-off is the normal path.
    await expect(service.handleSniffed(incoming)).resolves.toBe(false)
    expect(batches.createBrowserMatchBatch).toHaveBeenCalledTimes(1)
    current += 1
  })

  it('leaves a non-matching hand-off unchanged', async () => {
    const { batches, service } = await harness(() => 1_000)
    await expect(
      service.handleSniffed(sniffed('https://other.example/watch?v=999'))
    ).resolves.toBe(false)
    expect(batches.createBrowserMatchBatch).not.toHaveBeenCalled()
  })

  it('ignores an expired pairing', async () => {
    let current = 1_000
    const { batches, service } = await harness(() => current)
    current += 31 * 60_000
    await expect(service.handleSniffed(sniffed(HANIME))).resolves.toBe(false)
    expect(batches.createBrowserMatchBatch).not.toHaveBeenCalled()
  })

  it('exposes the waiting flag in the session DTO without a URL', async () => {
    const { session, sessions } = await harness(() => 1_000)
    const current = sessions.getSession(session.sessionId)
    const video = current.items.find(
      (item) => item.status === 'browser-only'
    )
    expect(video?.browserMatchPending).toBe(true)
    expect(JSON.stringify(current)).not.toContain('https://')
  })
})
