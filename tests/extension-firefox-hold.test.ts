import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIREFOX_HOLD_FIRST_ID,
  buildSyntheticDownloadItem,
  filenameFromUrl,
  installFirefoxDownloadHold,
  isAttachmentDisposition,
  isDownloadResponse,
  mediaTypeOf,
  nextSyntheticDownloadId,
  parseContentDispositionFilename,
  resetFirefoxDownloadHoldForTests,
  sanitizeBasename
} from '../extension/firefox-hold.js'
import {
  HANDOFF_SUGGEST_TIMEOUT_MS,
  handleCreatedDownload,
  resetHeldRequestUrlsForTests
} from '../extension/handoff.js'
import { writeCaptureSettings } from '../extension/capture-settings.js'

const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

interface FakeOptions {
  nativeResponse?: unknown
  nativeHangs?: boolean
  blockingGranted?: boolean
  hasOnDeterminingFilename?: boolean
  cookies?: Array<{ name: string; value: string }>
}

function createFake(options: FakeOptions = {}) {
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const nativeMessages: unknown[] = []
  const cancelled: number[] = []
  const erased: number[] = []
  const cookieUrls: string[] = []
  let listener: ((details: unknown) => unknown) | null = null
  let listenerOptions: unknown = null
  let listenerSpec: unknown = null
  let blockingGranted = options.blockingGranted !== false
  let activeResponse: unknown = options.nativeResponse ?? {
    ok: true,
    accepted: true,
    durable: true,
    operation: 'handoff-download',
    receipt: { downloadId: DOWNLOAD_ID, persistedAt: 1_800_000_000_000 }
  }

  function area(map: Map<string, unknown>) {
    return {
      get(key: string | string[], callback?: (value: unknown) => void) {
        const keys = Array.isArray(key) ? key : [key]
        const value: Record<string, unknown> = {}
        for (const name of keys) value[name] = map.get(name)
        if (callback) {
          callback(value)
          return undefined
        }
        return Promise.resolve(value)
      },
      set(value: Record<string, unknown>, callback?: () => void) {
        for (const [name, entry] of Object.entries(value)) map.set(name, entry)
        if (callback) callback()
        return Promise.resolve()
      },
      remove(key: string, callback?: () => void) {
        map.delete(key)
        if (callback) callback()
        return Promise.resolve()
      }
    }
  }

  const chrome: any = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(
        host: string,
        message: unknown,
        callback: (value: unknown) => void
      ) {
        nativeMessages.push({ host, message })
        if (options.nativeHangs === true) return
        callback(activeResponse)
      }
    },
    storage: {
      local: area(local),
      session: area(session)
    },
    permissions: {
      async contains(query?: { permissions?: string[] }) {
        const wanted = query && Array.isArray(query.permissions) ? query.permissions : []
        if (
          wanted.includes('webRequestBlocking') &&
          blockingGranted !== true
        ) {
          return false
        }
        return true
      }
    },
    cookies: {
      getAll(query: { url: string }, callback?: (value: unknown[]) => void) {
        cookieUrls.push(query.url)
        const value = options.cookies ?? []
        if (callback) {
          callback(value)
          return undefined
        }
        return Promise.resolve(value)
      }
    },
    downloads: {
      cancel(id: number, callback: () => void) {
        cancelled.push(id)
        callback()
      },
      erase(query: { id: number }, callback: () => void) {
        erased.push(query.id)
        callback()
      },
      search(_query: { id: number }, callback: (items: unknown[]) => void) {
        callback([])
      }
    },
    webRequest: {
      onHeadersReceived: {
        addListener(
          next: (details: unknown) => unknown,
          filter: unknown,
          spec: unknown
        ) {
          // Firefox rejects a 'blocking' listener without webRequestBlocking.
          if (blockingGranted !== true) throw new Error('webRequestBlocking missing')
          listener = next
          listenerOptions = filter
          listenerSpec = spec
        }
      }
    }
  }

  if (options.hasOnDeterminingFilename === true) {
    chrome.downloads.onDeterminingFilename = { addListener() {} }
  }

  return {
    chrome,
    nativeMessages,
    cancelled,
    erased,
    cookieUrls,
    listener: () => listener!,
    listenerInstalled: () => listener !== null,
    listenerOptions: () => listenerOptions,
    listenerSpec: () => listenerSpec,
    grantBlocking() {
      blockingGranted = true
    },
    setResponse(next: unknown) {
      activeResponse = next
    }
  }
}

type Fake = ReturnType<typeof createFake>

async function seedSettings(fake: Fake) {
  await writeCaptureSettings(fake.chrome, {
    floatingTriggerEnabled: true,
    automaticFileHandoff: true,
    handoffNotifications: false,
    excludedOrigins: []
  })
}

function useFake(fake: Fake) {
  ;(globalThis as any).chrome = fake.chrome
  return fake.chrome
}

function responseDetails(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/files/report.zip',
    method: 'GET',
    statusCode: 200,
    tabId: 5,
    type: 'main_frame',
    responseHeaders: [
      { name: 'Content-Type', value: 'application/zip' },
      { name: 'Content-Length', value: '4000000' },
      { name: 'Content-Disposition', value: 'attachment; filename="report.zip"' }
    ],
    originUrl: 'https://example.com/page',
    ...overrides
  }
}

function nativeMessages(fake: Fake) {
  return fake.nativeMessages.map(
    (entry) => (entry as { message: Record<string, unknown> }).message
  )
}

afterEach(() => {
  delete (globalThis as any).chrome
  resetFirefoxDownloadHoldForTests()
  resetHeldRequestUrlsForTests()
  vi.useRealTimers()
})

describe('Firefox response header parsing', () => {
  it('reads quoted, unquoted and RFC 5987 file names', () => {
    expect(
      parseContentDispositionFilename('attachment; filename="report.zip"')
    ).toBe('report.zip')
    expect(
      parseContentDispositionFilename('attachment; filename=report.zip')
    ).toBe('report.zip')
    expect(
      parseContentDispositionFilename(
        "attachment; filename*=UTF-8''na%C3%AFve%20rapport.zip"
      )
    ).toBe('naïve rapport.zip')
    // The extended form wins over a plain ASCII fallback.
    expect(
      parseContentDispositionFilename(
        'attachment; filename="fallback.zip"; filename*=UTF-8\'\'r%C3%A9el.zip'
      )
    ).toBe('réel.zip')
    expect(
      parseContentDispositionFilename('attachment; filename="a \\"quoted\\".zip"')
    ).toBe('a "quoted".zip')
  })

  it('returns nothing when there is no file name', () => {
    expect(parseContentDispositionFilename('inline')).toBeNull()
    expect(parseContentDispositionFilename('attachment')).toBeNull()
    expect(parseContentDispositionFilename('attachment; filename=')).toBeNull()
    expect(parseContentDispositionFilename(null)).toBeNull()
    expect(parseContentDispositionFilename(42)).toBeNull()
  })

  it('normalizes media types and the attachment disposition', () => {
    expect(mediaTypeOf('Text/HTML; charset=utf-8')).toBe('text/html')
    expect(mediaTypeOf(undefined)).toBe('')
    expect(isAttachmentDisposition('attachment; filename=x.zip')).toBe(true)
    expect(isAttachmentDisposition('inline')).toBe(false)
    expect(isAttachmentDisposition(undefined)).toBe(false)
  })

  it('sanitizes file names and derives one from the URL path', () => {
    expect(sanitizeBasename('..\\..\\evil/../../report.zip')).toBe('report.zip')
    expect(sanitizeBasename('  a:b?c*d .zip  ')).toBe('a_b_c_d .zip')
    expect(sanitizeBasename(undefined)).toBe('')
    expect(filenameFromUrl('https://example.com/files/report.zip?x=1#y')).toBe(
      'report.zip'
    )
    expect(filenameFromUrl('https://example.com/files/na%C3%AFve.zip')).toBe(
      'naïve.zip'
    )
    expect(filenameFromUrl('https://example.com/')).toBe('')
    expect(filenameFromUrl('not a url')).toBe('')
  })
})

describe('Firefox download candidate decision', () => {
  function headers(entries: Record<string, string>) {
    return Object.entries(entries).map(([name, value]) => ({ name, value }))
  }

  it('accepts an attachment whatever its media type', () => {
    expect(
      isDownloadResponse(
        responseDetails({
          responseHeaders: headers({
            'Content-Type': 'text/html',
            'Content-Disposition': 'attachment; filename="page.html"'
          })
        })
      )
    ).toBe(true)
  })

  it('accepts the binary and archive types a browser saves', () => {
    for (const type of [
      'application/octet-stream',
      'binary/octet-stream',
      'application/force-download',
      'application/x-download',
      'application/zip',
      'application/x-7z-compressed',
      'application/x-rar-compressed',
      'application/x-msdownload',
      'application/vnd.android.package-archive',
      'application/x-iso9660-image'
    ]) {
      expect(
        isDownloadResponse(
          responseDetails({ responseHeaders: headers({ 'Content-Type': type }) })
        ),
        type
      ).toBe(true)
    }
  })

  it('ignores types Firefox displays inline', () => {
    for (const type of [
      'text/html',
      'text/plain',
      'text/css',
      'application/json',
      'application/pdf',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'image/png'
    ]) {
      expect(
        isDownloadResponse(
          responseDetails({
            responseHeaders: headers({
              'Content-Type': type,
              'Content-Disposition': 'inline'
            })
          })
        ),
        type
      ).toBe(false)
    }
  })

  it('ignores a non-2xx response and a non-GET request', () => {
    expect(isDownloadResponse(responseDetails({ statusCode: 404 }))).toBe(false)
    expect(isDownloadResponse(responseDetails({ statusCode: 500 }))).toBe(false)
    expect(isDownloadResponse(responseDetails({ method: 'POST' }))).toBe(false)
    expect(isDownloadResponse(null)).toBe(false)
  })
})

describe('synthetic download item', () => {
  it('builds the shape automaticHandoffCandidate expects', () => {
    expect(buildSyntheticDownloadItem(responseDetails(), 1_000_000_001)).toEqual({
      id: 1_000_000_001,
      url: 'https://example.com/files/report.zip',
      finalUrl: 'https://example.com/files/report.zip',
      filename: 'report.zip',
      mime: 'application/zip',
      totalBytes: 4_000_000,
      state: 'in_progress',
      danger: 'safe',
      paused: false,
      referrer: 'https://example.com/page'
    })
  })

  it('uses the RFC 5987 name, the URL path and a safe Content-Length', () => {
    const extended = buildSyntheticDownloadItem(
      responseDetails({
        url: 'https://example.com/files/download',
        responseHeaders: [
          { name: 'Content-Type', value: 'application/octet-stream' },
          {
            name: 'Content-Disposition',
            value: "attachment; filename*=UTF-8''na%C3%AFve%20rapport.zip"
          }
        ]
      }),
      1_000_000_002
    )
    expect(extended).toMatchObject({
      filename: 'naïve rapport.zip',
      mime: 'application/octet-stream',
      totalBytes: -1
    })

    const fromUrl = buildSyntheticDownloadItem(
      responseDetails({
        url: 'https://example.com/files/na%C3%AFve.zip',
        responseHeaders: [
          { name: 'Content-Type', value: 'application/zip' },
          { name: 'Content-Length', value: 'not-a-number' }
        ]
      }),
      1_000_000_003
    )
    expect(fromUrl).toMatchObject({ filename: 'naïve.zip', totalBytes: -1 })

    expect(
      buildSyntheticDownloadItem(responseDetails({ url: 'ftp://example.com/a.zip' }), 1)
    ).toBeNull()
    expect(buildSyntheticDownloadItem(responseDetails(), 0)).toBeNull()
  })

  it('starts the synthetic id counter at one billion', () => {
    resetFirefoxDownloadHoldForTests()
    expect(nextSyntheticDownloadId()).toBe(FIREFOX_HOLD_FIRST_ID)
    expect(nextSyntheticDownloadId()).toBe(FIREFOX_HOLD_FIRST_ID + 1)
  })
})

describe('installing the Firefox hold', () => {
  it('registers one blocking listener for main frames and sub frames', async () => {
    const fake = createFake()
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(true)
    expect(fake.listenerInstalled()).toBe(true)
    expect(fake.listenerOptions()).toEqual({
      urls: ['http://*/*', 'https://*/*'],
      types: ['main_frame', 'sub_frame']
    })
    expect(fake.listenerSpec()).toEqual(['blocking', 'responseHeaders'])

    // Idempotent per worker generation: a second call adds no listener.
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(true)
    expect(fake.listenerInstalled()).toBe(true)
  })

  it('does not install where onDeterminingFilename already holds the download', async () => {
    const fake = createFake({ hasOnDeterminingFilename: true })
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(false)
    expect(fake.listenerInstalled()).toBe(false)
  })

  it('waits for the optional blocking permission', async () => {
    const fake = createFake({ blockingGranted: false })
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(false)
    expect(fake.listenerInstalled()).toBe(false)

    // Granting it later (permissions.onAdded) installs the same listener.
    fake.grantBlocking()
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(true)
    expect(fake.listenerInstalled()).toBe(true)
  })

  it('does not install without the webRequest API', async () => {
    const fake = createFake()
    delete fake.chrome.webRequest
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(false)
  })
})

describe('holding a Firefox response until the hand-off is durable', () => {
  async function installed(fake: Fake) {
    await seedSettings(fake)
    useFake(fake)
    expect(await installFirefoxDownloadHold(fake.chrome)).toBe(true)
    return fake.listener()
  }

  it('cancels the request only after a durable receipt', async () => {
    const fake = createFake()
    const listener = await installed(fake)

    await expect(listener(responseDetails())).resolves.toEqual({ cancel: true })
    expect(nativeMessages(fake)).toEqual([
      {
        type: 'handoff-download',
        url: 'https://example.com/files/report.zip',
        filename: 'report.zip',
        expectedBytes: 4_000_000,
        expectedContentType: 'application/zip',
        referer: 'https://example.com/page',
        userAgent: expect.any(String)
      }
    ])
    // The browser never created a download, so nothing is cancelled or erased.
    expect(fake.cancelled).toEqual([])
    expect(fake.erased).toEqual([])
  })

  it('holds a top-level download Zen reports with tabId -1', async () => {
    const fake = createFake()
    const listener = await installed(fake)
    await expect(listener(responseDetails({ tabId: -1 }))).resolves.toEqual({ cancel: true })
    expect(nativeMessages(fake)).toHaveLength(1)
  })

  it('lets the browser download when the receipt is not durable', async () => {
    const fake = createFake({
      nativeResponse: {
        ok: true,
        accepted: true,
        durable: false,
        operation: 'handoff-download',
        receipt: { downloadId: DOWNLOAD_ID, persistedAt: 1_800_000_000_000 }
      }
    })
    const listener = await installed(fake)
    await expect(listener(responseDetails())).resolves.toEqual({})
  })

  it('lets the browser download when the hand-off fails', async () => {
    const fake = createFake({
      nativeResponse: {
        ok: false,
        error: { code: 'APP_NOT_RUNNING', message: 'DonDownload is not running.' }
      }
    })
    const listener = await installed(fake)
    await expect(listener(responseDetails())).resolves.toEqual({})
  })

  it('releases the response when the hand-off hangs', async () => {
    const fake = createFake({ nativeHangs: true })
    const listener = await installed(fake)
    vi.useFakeTimers()
    try {
      const pending = listener(responseDetails())
      expect(pending).toBeInstanceOf(Promise)
      await vi.advanceTimersByTimeAsync(HANDOFF_SUGGEST_TIMEOUT_MS - 1)
      let settled = false
      void (pending as Promise<unknown>).then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a non-candidate response straight through', async () => {
    const fake = createFake()
    const listener = await installed(fake)
    await expect(
      listener(
        responseDetails({
          url: 'https://example.com/page.html',
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html' },
            { name: 'Content-Disposition', value: 'inline' }
          ]
        })
      )
    ).toBeUndefined()
    await expect(listener(responseDetails({ statusCode: 404 }))).toBeUndefined()
    await expect(listener(responseDetails({ method: 'POST' }))).toBeUndefined()
    expect(nativeMessages(fake)).toEqual([])
  })

  it('ignores a later onCreated for a URL the hold already handed off', async () => {
    const fake = createFake()
    const listener = await installed(fake)
    await expect(listener(responseDetails())).resolves.toEqual({ cancel: true })
    expect(nativeMessages(fake)).toHaveLength(1)

    const created = {
      id: 42,
      state: 'in_progress',
      danger: 'safe',
      url: 'https://example.com/files/report.zip',
      finalUrl: 'https://example.com/files/report.zip',
      filename: 'C:\\Downloads\\report.zip',
      totalBytes: 4_000_000,
      mime: 'application/zip'
    }
    expect(await handleCreatedDownload(fake.chrome, created)).toBe(
      'ignored:held-request'
    )
    // Only the URL matches, not the id; a trailing redirect still matches.
    expect(
      await handleCreatedDownload(fake.chrome, {
        ...created,
        id: 43,
        url: 'https://example.com/redirected',
        finalUrl: 'https://example.com/files/report.zip'
      })
    ).toBe('ignored:held-request')
    expect(nativeMessages(fake)).toHaveLength(1)
    expect(fake.cancelled).toEqual([])
  })
})
