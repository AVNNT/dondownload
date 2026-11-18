import { describe, expect, it } from 'vitest'
import type { ScanSession } from '../src/shared/scanner'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import { extractCandidates } from '../src/main/scanner/extract'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const PAGE_URL = 'https://forum.example/thread/example-346779'

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

const readyProbe: ProbeScanItemFn = async (input) => {
  const contentType = input.url.endsWith('.funscript')
    ? 'application/json'
    : input.url.endsWith('.mp4')
      ? 'video/mp4'
      : 'application/zip'
  return {
    status: 'ready',
    verified: true,
    contentType,
    contentDisposition: null,
    sizeBytes: 1024,
    finalUrl: input.url,
    classification: classifyScanCandidate({
      url: input.url,
      contentType
    }),
    reason: null
  }
}

function managed(
  fetcher: ScanPageFetcher,
  options: {
    probe?: ProbeScanItemFn
    probeCap?: number
    updates?: ScanSession[]
    ttlMs?: number
    duplicates?: (url: string) => {
      kind: 'download'
      state: 'active' | 'finished'
      id: string
      filename: string
      date: number
      fileExists: boolean
    } | null
  } = {}
): ScanSessionManager {
  return new ScanSessionManager({
    fetchPage: fetcher,
    ...(options.probe === undefined ? {} : { probeItem: options.probe }),
    ...(options.probeCap === undefined ? {} : { probeCap: options.probeCap }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.duplicates === undefined
      ? {}
      : { duplicates: options.duplicates }),
    onUpdate: (session) => options.updates?.push(session)
  })
}

describe('scan sessions', () => {
  it('extracts and deduplicates a page, then completes with verified items', async () => {
    const fetcher: ScanPageFetcher = async () =>
      page(`
        <meta property="og:video" content="https://cdn.example/clip.mp4" />
        <a class="attachment" href="/uploads/short-url/a.funscript">x.roll.funscript</a>
        <a href="/files/archive.zip">archive</a>
        <a href="/files/archive.zip?utm_source=x#frag">same archive</a>
      `)
    const updates: ScanSession[] = []
    const sessions = managed(fetcher, { updates, probe: readyProbe })

    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.status).toBe('done')
    expect(done.progress.fetchedPages).toBe(1)
    expect(done.items).toHaveLength(3)
    expect(done.items.map((item) => item.category).sort()).toEqual([
      'archive',
      'script',
      'video'
    ])
    expect(
      done.items.every((item) => item.status === 'ready' && item.verified)
    ).toBe(true)
    expect(done.counters.ready).toBe(3)
    expect(updates.some((update) => update.status === 'done')).toBe(true)
    // The public DTO never carries a URL.
    expect(JSON.stringify(done)).not.toContain('https://')
  })

  it('marks an item whose URL history already has, without leaking the URL', async () => {
    const fetcher: ScanPageFetcher = async () =>
      page('<a href="/files/archive.zip">archive</a>')
    const seen: string[] = []
    const sessions = managed(fetcher, {
      probe: readyProbe,
      duplicates: (url) => {
        seen.push(url)
        return {
          kind: 'download',
          state: 'finished',
          id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          filename: 'archive.zip',
          date: Date.UTC(2026, 2, 4),
          fileExists: true
        }
      }
    })

    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(seen.length).toBeGreaterThan(0)
    expect(done.items[0]?.alreadyDownloaded).toEqual({
      state: 'finished',
      filename: 'archive.zip',
      date: Date.UTC(2026, 2, 4)
    })
    expect(JSON.stringify(done)).not.toContain('https://')
  })

  it('reclassifies a .mp4 that actually serves HTML as a page', async () => {
    const fetcher: ScanPageFetcher = async () =>
      page('<a href="https://cdn.example/clip.mp4">watch</a>')
    const probe: ProbeScanItemFn = async (input) => ({
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
    const sessions = managed(fetcher, { probe })

    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.items[0]).toMatchObject({
      category: 'page',
      kind: 'page-link',
      status: 'found',
      verified: false
    })
    expect(done.progress.queueableItems).toBe(0)
  })

  it('enforces the 1000-item cap and reports a limited session', async () => {
    const anchors = Array.from(
      { length: 1200 },
      (_value, index) => `<a href="/files/${index}.zip">file ${index}</a>`
    ).join('')
    const fetcher: ScanPageFetcher = async () => page(anchors)
    const sessions = managed(fetcher, { probeCap: 0 })

    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.items).toHaveLength(1000)
    expect(done.status).toBe('limited')
    expect(done.progress.totalItems).toBe(1000)
    expect(done.counters.found).toBe(1000)
  })

  it('cancels an in-flight page fetch and publishes a cancelled session', async () => {
    const fetcher: ScanPageFetcher = (input) =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => {
            reject(Object.assign(new Error('cancelled'), { code: 'SCAN_CANCELLED' }))
          },
          { once: true }
        )
      })
    const sessions = managed(fetcher)
    const started = sessions.start(PAGE_URL)
    const cancelled = sessions.cancel(started.sessionId)
    await sessions.waitForScan(started.sessionId)

    expect(cancelled.status).toBe('cancelled')
    expect(sessions.getSession(started.sessionId).status).toBe('cancelled')
  })

  it('limits concurrent scans to two', async () => {
    const fetcher: ScanPageFetcher = (input) =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('cancelled'), { code: 'SCAN_CANCELLED' })),
          { once: true }
        )
      })
    const sessions = managed(fetcher)
    const first = sessions.start(PAGE_URL)
    const second = sessions.start(PAGE_URL)

    expect(() => sessions.start(PAGE_URL)).toThrow(/Two page scans/)
    sessions.cancel(first.sessionId)
    sessions.cancel(second.sessionId)
    await Promise.all([
      sessions.waitForScan(first.sessionId),
      sessions.waitForScan(second.sessionId)
    ])
  })

  it('attaches the one-job cookie only to the exact scan host', async () => {
    const seen: Array<{ url: string; cookie?: string }> = []
    const fetcher: ScanPageFetcher = async () =>
      page(`
        <a href="/uploads/a.zip">same host</a>
        <a href="https://other.example/b.zip">other host</a>
      `)
    const probe: ProbeScanItemFn = async (input) => {
      seen.push({ url: input.url, ...(input.cookie === undefined ? {} : { cookie: input.cookie }) })
      return {
        status: 'ready',
        verified: true,
        contentType: 'application/zip',
        contentDisposition: null,
        sizeBytes: 10,
        finalUrl: input.url,
        classification: classifyScanCandidate({
          url: input.url,
          contentType: 'application/zip'
        }),
        reason: null
      }
    }
    const sessions = managed(fetcher, { probe })
    const started = sessions.start(PAGE_URL, {
      origin: 'extension',
      cookie: 'auth=1'
    })
    await sessions.waitForScan(started.sessionId)
    sessions.cancel(started.sessionId)

    expect(seen).toEqual(
      expect.arrayContaining([
        { url: 'https://forum.example/uploads/a.zip', cookie: 'auth=1' },
        { url: 'https://other.example/b.zip' }
      ])
    )
  })

  it('marks a sign-in page clearly for the paste flow', async () => {
    const fetcher: ScanPageFetcher = async () => {
      throw Object.assign(new Error('login'), { code: 'SCAN_NEEDS_LOGIN' })
    }
    const sessions = managed(fetcher)
    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const done = sessions.getSession(started.sessionId)

    expect(done.signinRequired).toBe(true)
    expect(done.status).toBe('done')
    expect(done.message).toContain('Scan this page')
  })

  it('expires sessions after their TTL', async () => {
    let now = 1_000
    const sessions = new ScanSessionManager({
      now: () => now,
      ttlMs: 50,
      fetchPage: async () => page('<a href="/a.zip">a</a>'),
      probeItem: readyProbe,
      onUpdate: () => undefined
    })
    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    now += 51
    expect(() => sessions.getSession(started.sessionId)).toThrow(/Scan the page again/)
  })
})

describe('extractor purity', () => {
  it('returns the same result twice for the same input', () => {
    const html = '<a href="/a.zip">a</a><img src="/b.png" />'
    expect(extractCandidates(html, PAGE_URL)).toEqual(
      extractCandidates(html, PAGE_URL)
    )
  })
})
