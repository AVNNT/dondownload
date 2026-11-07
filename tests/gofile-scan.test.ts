import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Batch } from '../src/shared/batches'
import {
  GOFILE_BROWSER_ONLY_REASON,
  GOFILE_ROW_UNRESOLVED_REASON,
  GOFILE_SHARE_PASSWORD_REASON,
  GOFILE_SHARE_PREMIUM_REASON,
  gofileCookieApplies,
  isGofileDownloadUrl,
  isGofileHostname,
  parseGofileShareUrl
} from '../src/shared/gofile'
import {
  MAX_SCAN_GOFILE_BODY_BYTES,
  SCAN_GOFILE_CHANNEL,
  parseScanGofileRequest
} from '../src/shared/scanBridge'
import { ValidationError } from '../src/shared/validation'
import { ScanQueueService, type ScanBatchPort } from '../src/main/scanner/queue'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'
import { resetNativeBridgeForTests } from '../extension/bridge'
import { runGofileScan, matchCapturedDownloads } from '../extension/gofile-scan'
import {
  isGofileCaptureArmed,
  recordGofileCapture,
  resetGofileCaptureForTests
} from '../extension/gofile-capture'

const SHARE_ID = 'AbCd1234'
const SHARE_URL = `https://gofile.io/d/${SHARE_ID}`
const TOPIC_URL = 'https://discuss.example/t/fancam-mix/9001'

function downloadUrl(id: string, name: string): string {
  return `https://store${(id.length % 5) + 1}.gofile.io/download/web/${id}/${encodeURIComponent(name)}`
}

function fileEntry(name: string, id: string, size: number | null = 1024) {
  return { name, size, url: downloadUrl(id, name) }
}

/* ------------------------------ shared policy ------------------------------ */

describe('Gofile link policy', () => {
  it('accepts only canonical public share links', () => {
    expect(parseGofileShareUrl(SHARE_URL)).toEqual({
      id: SHARE_ID,
      canonicalUrl: SHARE_URL
    })
    expect(parseGofileShareUrl(`https://www.gofile.io/d/${SHARE_ID}/`)).toEqual({
      id: SHARE_ID,
      canonicalUrl: SHARE_URL
    })
    expect(parseGofileShareUrl(`http://gofile.io/d/${SHARE_ID}`)).toBeNull()
    expect(parseGofileShareUrl(`https://gofile.io/f/${SHARE_ID}`)).toBeNull()
    expect(parseGofileShareUrl(`${SHARE_URL}?token=secret`)).toBeNull()
    expect(parseGofileShareUrl(`https://user:pw@gofile.io/d/${SHARE_ID}`)).toBeNull()
    expect(parseGofileShareUrl('https://gofile.io.evil.example/d/AbCd1234')).toBeNull()
  })

  it('accepts only HTTPS Gofile download links', () => {
    expect(isGofileDownloadUrl(downloadUrl('f1', 'a.mp4'))).toBe(true)
    expect(isGofileDownloadUrl('https://gofile.io/download/web/f1/a.mp4')).toBe(true)
    expect(isGofileDownloadUrl('https://evil.example/download/web/f1/a.mp4')).toBe(false)
    expect(isGofileDownloadUrl('https://gofile.io.evil.example/download/f1/a.mp4')).toBe(
      false
    )
    expect(isGofileDownloadUrl('http://store3.gofile.io/download/web/f1/a.mp4')).toBe(
      false
    )
    expect(isGofileDownloadUrl('https://store3.gofile.io/api/f1/a.mp4')).toBe(false)
  })

  it('scopes the one-job cookie to the Gofile family only', () => {
    expect(isGofileHostname('gofile.io')).toBe(true)
    expect(isGofileHostname('www.gofile.io')).toBe(true)
    expect(isGofileHostname('store3.gofile.io')).toBe(true)
    expect(isGofileHostname('gofile.io.evil.example')).toBe(false)

    expect(gofileCookieApplies('gofile.io', 'store3.gofile.io')).toBe(true)
    expect(gofileCookieApplies('www.gofile.io', 'gofile.io')).toBe(true)
    // A cookie captured for another site never follows a Gofile link, and a
    // Gofile cookie never leaves for another site.
    expect(gofileCookieApplies('forum.example', 'store3.gofile.io')).toBe(false)
    expect(gofileCookieApplies('gofile.io', 'forum.example')).toBe(false)
    expect(gofileCookieApplies('gofile.io', 'gofile.io.evil.example')).toBe(false)
  })
})

/* ------------------------------ bridge contract ------------------------------ */

describe('scan-gofile bridge contract', () => {
  const valid = {
    type: SCAN_GOFILE_CHANNEL,
    shareId: SHARE_ID,
    status: 'ok',
    files: [fileEntry('Fancam 01.mp4', 'f1'), fileEntry('Fancam 01.funscript', 'f2', null)]
  }

  it('accepts a validated share with its files', () => {
    const parsed = parseScanGofileRequest(valid)
    expect(parsed.shareId).toBe(SHARE_ID)
    expect(parsed.status).toBe('ok')
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[1]?.size).toBeNull()
  })

  it('accepts a share that reported no files', () => {
    const parsed = parseScanGofileRequest({
      shareId: SHARE_ID,
      status: 'password',
      files: []
    })
    expect(parsed.status).toBe('password')
    expect(parsed.files).toEqual([])
  })

  it('keeps the rendered rows whose URL the page never exposed', () => {
    const parsed = parseScanGofileRequest({
      ...valid,
      unavailable: [{ name: 'Hidden.mp4', size: 4096 }, { name: 'NoSize.mp4' }]
    })
    expect(parsed.unavailable).toEqual([
      { name: 'Hidden.mp4', size: 4096 },
      { name: 'NoSize.mp4', size: null }
    ])
    // Duplicate names collapse and an unknown field is rejected.
    expect(
      parseScanGofileRequest({
        ...valid,
        unavailable: [
          { name: 'Hidden.mp4', size: 1 },
          { name: 'hidden.mp4', size: 2 }
        ]
      }).unavailable
    ).toEqual([{ name: 'Hidden.mp4', size: 1 }])
    expect(() =>
      parseScanGofileRequest({
        ...valid,
        unavailable: [{ name: 'Hidden.mp4', url: downloadUrl('f1', 'a.mp4') }]
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseScanGofileRequest({ ...valid, unavailable: [{ name: '' }] })
    ).toThrow(ValidationError)
    expect(() =>
      parseScanGofileRequest({ ...valid, unavailable: [{ name: 'a.mp4', size: -1 }] })
    ).toThrow(ValidationError)
  })

  it('keeps the one-shot cookie when it is a valid header', () => {
    const parsed = parseScanGofileRequest({ ...valid, cookie: 'accountToken=abc123' })
    expect(parsed.cookie).toBe('accountToken=abc123')
  })

  it('rejects a download href that is not on Gofile', () => {
    expect(() =>
      parseScanGofileRequest({
        ...valid,
        files: [{ name: 'a.mp4', size: 1, url: 'https://evil.example/download/f1/a.mp4' }]
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseScanGofileRequest({
        ...valid,
        files: [
          {
            name: 'a.mp4',
            size: 1,
            url: 'https://gofile.io.evil.example/download/f1/a.mp4'
          }
        ]
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseScanGofileRequest({
        ...valid,
        files: [{ name: 'a.mp4', size: 1, url: 'http://store3.gofile.io/download/f1/a.mp4' }]
      })
    ).toThrow(ValidationError)
  })

  it('rejects an oversize payload', () => {
    const files: Array<ReturnType<typeof fileEntry>> = []
    for (let index = 0; index < 501; index += 1) {
      files.push(fileEntry(`File ${index}.mp4`, `f${index}`))
    }
    expect(() => parseScanGofileRequest({ ...valid, files })).toThrow(ValidationError)
    // The route body limit is larger than any accepted list.
    expect(MAX_SCAN_GOFILE_BODY_BYTES).toBeGreaterThan(400 * 1024)
  })

  it('rejects unknown fields, bad ids, bad statuses and bad sizes', () => {
    expect(() => parseScanGofileRequest({ ...valid, extra: true })).toThrow(
      ValidationError
    )
    expect(() => parseScanGofileRequest({ ...valid, shareId: 'no' })).toThrow(
      ValidationError
    )
    expect(() => parseScanGofileRequest({ ...valid, status: 'maybe' })).toThrow(
      ValidationError
    )
    expect(() =>
      parseScanGofileRequest({
        ...valid,
        files: [{ name: 'a.mp4', size: -1, url: downloadUrl('f1', 'a.mp4') }]
      })
    ).toThrow(ValidationError)
    expect(() =>
      parseScanGofileRequest({
        ...valid,
        files: [{ name: '', size: 1, url: downloadUrl('f1', 'a.mp4') }]
      })
    ).toThrow(ValidationError)
  })
})

/* ------------------------------ session conversion ------------------------------ */

function topicFetcher(): ScanPageFetcher {
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
            `<p><a href="${SHARE_URL}">gofile mirror</a></p>`
        }
      ],
      stream: [1]
    }
  }
  return async (input) => {
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
    return {
      finalUrl: TOPIC_URL,
      status: 200,
      contentType: 'text/html',
      contentDisposition: null,
      body,
      bytes: body.length
    }
  }
}

function managed(): ScanSessionManager {
  return new ScanSessionManager({
    fetchPage: topicFetcher(),
    followDepth: 0,
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
}

describe('Gofile scan sessions', () => {
  it('shows a share card that only offers the browser', async () => {
    const sessions = managed()
    const started = sessions.start(TOPIC_URL)
    await sessions.waitForScan(started.sessionId)
    const session = sessions.getSession(started.sessionId)

    const share = session.items.find((item) => item.hostname === 'gofile.io')
    expect(share).toMatchObject({
      status: 'browser-only',
      kind: 'page-link',
      category: 'other',
      postNumber: 10,
      author: 'alice',
      unavailableReason: GOFILE_BROWSER_ONLY_REASON
    })
    // A browser-only card is never queueable and never carries a URL.
    expect(JSON.stringify(session)).not.toContain('gofile.io/d/')

    expect(sessions.openInBrowser(started.sessionId, share!.id)).toEqual({
      url: SHARE_URL,
      pageUrl: SHARE_URL
    })
  })

  it('merges the reported files into the session the share card belongs to', async () => {
    const sessions = managed()
    const started = sessions.start(TOPIC_URL)
    await sessions.waitForScan(started.sessionId)

    const merged = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'ok',
      files: [
        fileEntry('Fancam 01 Wonyoung.funscript', 'f2', 4096),
        fileEntry('bundle.zip', 'f3', 2048)
      ],
      cookie: 'accountToken=secret-token'
    })

    // The share card was replaced inside the same session.
    expect(merged.sessionId).toBe(started.sessionId)
    expect(merged.items.some((item) => item.hostname === 'gofile.io' && item.kind === 'page-link')).toBe(
      false
    )

    const script = merged.items.find((item) => item.category === 'script')
    expect(script).toMatchObject({
      kind: 'file',
      name: 'Fancam 01 Wonyoung.funscript',
      sizeBytes: 4096,
      status: 'ready',
      postNumber: 10,
      author: 'alice'
    })
    const archive = merged.items.find((item) => item.category === 'archive')
    expect(archive).toMatchObject({ kind: 'file', name: 'bundle.zip', postNumber: 10 })

    // The .funscript pairs with the topic video it belongs to.
    const video = merged.items.find((item) => item.category === 'video')
    const set = merged.scriptSets?.[0]
    expect(set?.postNumber).toBe(10)
    expect(set?.matchedVideoItemId).toBe(video?.id)

    // The one-job cookie never reaches the renderer DTO.
    expect(JSON.stringify(merged)).not.toContain('accountToken')
  })

  it('keeps its own session when no scan holds that share', () => {
    const sessions = managed()
    const session = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'ok',
      files: [
        fileEntry('Fancam 01.mp4', 'f1', 10),
        fileEntry('Fancam 01.funscript', 'f2', 20)
      ]
    })

    expect(session.mode).toBe('gofile')
    expect(session.status).toBe('done')
    expect(session.hostname).toBe('gofile.io')
    expect(session.items.map((item) => item.category).sort()).toEqual([
      'script',
      'video'
    ])
    expect(session.items.every((item) => item.kind === 'file')).toBe(true)
    expect(JSON.stringify(session)).not.toContain('https://')
  })

  it('keeps a rendered row without a URL as an unavailable card', () => {
    const sessions = managed()
    const session = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'ok',
      files: [fileEntry('Fancam 01.mp4', 'f1', 10)],
      unavailable: [{ name: 'Hidden.mp4', size: 2048 }]
    })

    expect(session.items).toHaveLength(2)
    const resolved = session.items.find((item) => item.name === 'Fancam 01.mp4')
    expect(resolved).toMatchObject({ kind: 'file', status: 'ready' })
    const hidden = session.items.find((item) => item.name === 'Hidden.mp4')
    expect(hidden).toMatchObject({
      status: 'unavailable',
      sizeBytes: 2048,
      unavailableReason: GOFILE_ROW_UNRESOLVED_REASON
    })
    // The share card itself is replaced by the row cards.
    expect(session.items.some((item) => item.kind === 'page-link' && item.name.startsWith('Gofile share'))).toBe(
      false
    )
  })

  it('shows only unavailable row cards when no URL was captured', () => {
    const sessions = managed()
    const session = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'ok',
      files: [],
      unavailable: [{ name: 'Hidden.mp4', size: null }]
    })

    expect(session.items).toHaveLength(1)
    expect(session.items[0]).toMatchObject({
      name: 'Hidden.mp4',
      status: 'unavailable',
      unavailableReason: GOFILE_ROW_UNRESOLVED_REASON
    })
  })

  it('shows the reason for a share that cannot be listed', () => {    const sessions = managed()
    const password = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'password',
      files: []
    })
    expect(password.items).toHaveLength(1)
    expect(password.items[0]).toMatchObject({
      status: 'unavailable',
      unavailableReason: GOFILE_SHARE_PASSWORD_REASON
    })

    const premium = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: 'Premium01',
      status: 'premium',
      files: []
    })
    expect(premium.items[0]).toMatchObject({
      status: 'unavailable',
      unavailableReason: GOFILE_SHARE_PREMIUM_REASON
    })
  })

  it('marks the existing share card when the follow-up share cannot be listed', async () => {
    const sessions = managed()
    const started = sessions.start(TOPIC_URL)
    await sessions.waitForScan(started.sessionId)

    const merged = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'password',
      files: []
    })
    const share = merged.items.find((item) => item.hostname === 'gofile.io')
    expect(share).toMatchObject({
      status: 'unavailable',
      unavailableReason: GOFILE_SHARE_PASSWORD_REASON
    })
  })
})

/* ------------------------------ queue path ------------------------------ */

function fakeBatches(): { port: ScanBatchPort; files: unknown[] } {
  const files: unknown[] = []
  const port: ScanBatchPort = {
    createScanBatch: async (input) => {
      files.push(...input.targets)
      return {
        id: 'batch_1',
        title: 'Scan',
        createdAt: 1,
        items: []
      } as unknown as Batch
    }
  }
  return { port, files }
}

describe('Gofile queue path', () => {
  it('attaches the one-job cookie to the exact Gofile download URL', async () => {
    const sessions = managed()
    const session = sessions.startGofile({
      type: SCAN_GOFILE_CHANNEL,
      shareId: SHARE_ID,
      status: 'ok',
      files: [fileEntry('Fancam 01.mp4', 'f1', 10)],
      cookie: 'accountToken=secret-token'
    })
    const item = session.items[0]!

    const { port, files } = fakeBatches()
    const probe = vi.fn()
    const queue = new ScanQueueService({
      sessions,
      batches: port,
      probeItem: probe
    })
    const result = await queue.queueSelection(session.sessionId, [item.id], [], [])

    expect(result.queuedItemIds).toEqual([item.id])
    // A rendered Gofile row is never re-probed.
    expect(probe).not.toHaveBeenCalled()
    expect(files).toEqual([
      {
        url: downloadUrl('f1', 'Fancam 01.mp4'),
        title: 'Fancam 01.mp4',
        filename: 'Fancam 01.mp4',
        scanItemId: item.id,
        resolvedUrl: downloadUrl('f1', 'Fancam 01.mp4'),
        requestHeaders: { cookie: 'accountToken=secret-token' }
      }
    ])
    expect(JSON.stringify(result)).not.toContain('accountToken')
  })
})

/* ------------------------------ extension runner ------------------------------ */

interface FakeChrome {
  scripting: {
    executeScript: (input: Record<string, unknown>) => Promise<unknown>
  }
  runtime: {
    lastError: undefined
    sendNativeMessage: (
      host: string,
      message: unknown,
      callback: (value: unknown) => void
    ) => void
  }
  cookies: {
    getAll: (input: unknown, callback: (cookies: unknown[]) => void) => void
  }
  permissions: { contains: (input: unknown) => Promise<boolean> }
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>
    }
  }
}

function fakeChrome(options: {
  collected: unknown
  cookieOptIn?: boolean
  onStart?: () => void
}): { chrome: FakeChrome; native: unknown[] } {
  const native: unknown[] = []
  const chrome: FakeChrome = {
    scripting: {
      executeScript: async (input) => {
        // The collector file injection, the start call and the polling calls.
        if (Array.isArray(input.files)) return [{ result: null }]
        const source = String(input.func)
        if (source.includes('startRun')) {
          options.onStart?.()
          return [{ result: true }]
        }
        return [{ result: options.collected }]
      }
    },
    runtime: {
      lastError: undefined,
      sendNativeMessage(_host, message, callback) {
        native.push(message)
        callback({ ok: true, accepted: true })
      }
    },
    cookies: {
      getAll(_input, callback) {
        callback([{ name: 'accountToken', value: 'secret-token' }])
      }
    },
    permissions: {
      contains: () => Promise.resolve(true)
    },
    storage: {
      local: {
        get: (key: string) =>
          Promise.resolve({
            [key]: {
              cookieOptInOrigins:
                options.cookieOptIn === false ? [] : ['https://gofile.io']
            }
          })
      }
    }
  }
  return { chrome, native }
}

afterEach(() => {
  resetNativeBridgeForTests()
  resetGofileCaptureForTests()
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('captured download matching', () => {
  it('matches a row by the browser file name and by the URL name', () => {
    const matched = matchCapturedDownloads(
      [
        { name: 'Fancam 01.mp4', size: 10, url: null },
        { name: 'Fancam 01.funscript', size: 20, url: null },
        { name: 'Missing.mp4', size: 30, url: null }
      ],
      [
        { url: downloadUrl('f1', 'Fancam 01.mp4'), filename: 'Fancam 01.mp4' },
        { url: downloadUrl('f2', 'Fancam 01.funscript'), filename: null }
      ]
    )

    expect(matched.files).toEqual([
      { name: 'Fancam 01.mp4', size: 10, url: downloadUrl('f1', 'Fancam 01.mp4') },
      {
        name: 'Fancam 01.funscript',
        size: 20,
        url: downloadUrl('f2', 'Fancam 01.funscript')
      }
    ])
    expect(matched.unavailable).toEqual([{ name: 'Missing.mp4', size: 30 }])
  })

  it('never reuses one captured download and drops a foreign URL', () => {
    const matched = matchCapturedDownloads(
      [
        { name: 'Same.mp4', size: null, url: null },
        { name: 'Same.mp4 (2)', size: null, url: null }
      ],
      [
        { url: 'https://evil.example/download/f1/Same.mp4', filename: 'Same.mp4' },
        { url: downloadUrl('f1', 'Same.mp4'), filename: 'Same.mp4' }
      ]
    )
    expect(matched.files).toEqual([
      { name: 'Same.mp4', size: null, url: downloadUrl('f1', 'Same.mp4') }
    ])
    expect(matched.unavailable).toEqual([{ name: 'Same.mp4 (2)', size: null }])
  })
})

describe('extension Gofile scan runner', () => {
  it('forwards the collected rows with the share id and the one-shot cookie', async () => {
    const collected = {
      shareId: SHARE_ID,
      status: 'ok',
      files: [fileEntry('Fancam 01.mp4', 'f1', 10)],
      folders: 0
    }
    const { chrome, native } = fakeChrome({ collected })
    ;(globalThis as { chrome?: unknown }).chrome = chrome

    const result = await runGofileScan(
      chrome,
      { tabId: 7, pageUrl: SHARE_URL },
      { sleep: async () => undefined }
    )

    expect(result).toMatchObject({ ok: true, shareId: SHARE_ID, fileCount: 1 })
    expect(native).toHaveLength(1)
    expect(native[0]).toMatchObject({
      type: 'scan-gofile',
      shareId: SHARE_ID,
      status: 'ok',
      cookie: 'accountToken=secret-token'
    })
  })

  it('still lists the files when the user has not allowed the cookie', async () => {
    const collected = {
      shareId: SHARE_ID,
      status: 'ok',
      files: [fileEntry('Fancam 01.mp4', 'f1', 10)],
      folders: 0
    }
    const { chrome, native } = fakeChrome({ collected, cookieOptIn: false })
    ;(globalThis as { chrome?: unknown }).chrome = chrome

    const result = await runGofileScan(
      chrome,
      { tabId: 7, pageUrl: SHARE_URL },
      { sleep: async () => undefined }
    )

    expect(result).toMatchObject({ ok: true, cookieAttached: false })
    expect(native[0]).not.toHaveProperty('cookie')
  })

  it('fills each button row from the download the click started', async () => {
    // The real page exposes no URL: the collector reports the rows with
    // `url: null` and the armed capture window supplies the URL.
    const collected = {
      shareId: SHARE_ID,
      status: 'ok',
      files: [
        { name: 'Fancam 01.mp4', size: 10, url: null },
        { name: 'Hidden.mp4', size: 20, url: null }
      ],
      folders: 0
    }
    const { chrome, native } = fakeChrome({
      collected,
      onStart: () => {
        expect(isGofileCaptureArmed()).toBe(true)
        recordGofileCapture({
          id: 11,
          url: downloadUrl('f1', 'Fancam 01.mp4'),
          finalUrl: downloadUrl('f1', 'Fancam 01.mp4'),
          filename: 'Fancam 01.mp4',
          referrer: SHARE_URL
        })
      }
    })
    ;(globalThis as { chrome?: unknown }).chrome = chrome

    const result = await runGofileScan(
      chrome,
      { tabId: 7, pageUrl: SHARE_URL },
      { sleep: async () => undefined }
    )

    expect(result).toMatchObject({ ok: true, fileCount: 1, unavailableCount: 1 })
    expect(native[0]).toMatchObject({
      type: 'scan-gofile',
      shareId: SHARE_ID,
      files: [{ name: 'Fancam 01.mp4', size: 10, url: downloadUrl('f1', 'Fancam 01.mp4') }],
      unavailable: [{ name: 'Hidden.mp4', size: 20 }]
    })
    // The window never outlives the scan.
    expect(isGofileCaptureArmed()).toBe(false)
  })

  it('refuses a page that is not a Gofile share', async () => {    const { chrome, native } = fakeChrome({ collected: null })
    ;(globalThis as { chrome?: unknown }).chrome = chrome
    const result = await runGofileScan(chrome, {
      tabId: 7,
      pageUrl: 'https://forum.example/thread/1'
    })
    expect(result).toMatchObject({ ok: false })
    expect(native).toEqual([])
  })
})
