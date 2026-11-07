import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOFF_SUGGEST_TIMEOUT_MS,
  handleCreatedDownload,
  installDownloadsListener,
  resetDownloadsListenerForTests
} from '../extension/handoff.js'
import {
  DEFAULT_CAPTURE_SETTINGS,
  normalizeCaptureSettings,
  claimHandoffDownload,
  finishHandoffDownload,
  readHandoffState,
  readNeedsLoginState,
  writeCaptureSettings
} from '../extension/capture-settings.js'
import { automaticHandoffCandidate } from '../extension/handoff-policy.js'
import { sendDurableHandoff } from '../extension/bridge.js'
import {
  forgetHandedOffDownloadsForTests,
  hasHandedOffDownload
} from '../extension/handoff-card.js'
const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

interface FakeOptions {
  settings?: Record<string, unknown>
  storageFails?: boolean
  nativeResponse?: unknown
  nativeRuntimeError?: string
  searchState?: string
  cancelFails?: boolean
  byExtensionId?: string
  cookies?: Array<{ name: string; value: string }>
  cookiesGranted?: boolean
  searchItem?: Record<string, unknown>
  scriptingFails?: boolean
}

function createFake(options: FakeOptions = {}) {
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const nativeMessages: unknown[] = []
  const cancelled: number[] = []
  const erased: number[] = []
  const searched: number[] = []
  const cookieUrls: string[] = []
  const injected: Array<{ tabId: number; args: unknown[] }> = []
  let activeResponse: unknown = options.nativeResponse ?? {
    ok: true,
    accepted: true,
    durable: true,
    operation: 'handoff-download',
    receipt: { downloadId: DOWNLOAD_ID, persistedAt: 1_800_000_000_000 }
  }
  let runtimeError = options.nativeRuntimeError ?? null

  function area(map: Map<string, unknown>, fail: boolean) {
    return {
      get(key: string | string[], callback?: (value: unknown) => void) {
        if (fail) {
          if (callback) throw new Error('storage unavailable')
          return Promise.reject(new Error('storage unavailable'))
        }
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
        if (fail) {
          if (callback) throw new Error('storage unavailable')
          return Promise.reject(new Error('storage unavailable'))
        }
        for (const [name, entry] of Object.entries(value)) map.set(name, entry)
        if (callback) callback()
        return Promise.resolve()
      },
      remove(key: string, callback?: () => void) {
        if (fail) {
          if (callback) throw new Error('storage unavailable')
          return Promise.reject(new Error('storage unavailable'))
        }
        map.delete(key)
        if (callback) callback()
        return Promise.resolve()
      }
    }
  }

  const chrome: any = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(host: string, message: unknown, callback: (value: unknown) => void) {
        nativeMessages.push({ host, message })
        if (runtimeError) chrome.runtime.lastError = { message: runtimeError }
        callback(activeResponse)
        chrome.runtime.lastError = undefined
      }
    },
    storage: {
      local: area(local, false),
      session: area(session, options.storageFails === true)
    },
    permissions: {
      async contains(query?: { permissions?: string[] }) {
        const wanted = query && Array.isArray(query.permissions) ? query.permissions : []
        if (wanted.includes('cookies')) return options.cookiesGranted !== false
        return true
      }
    },
    cookies: {
      getAll(
        query: { url: string },
        callback?: (cookies: unknown[]) => void
      ) {
        cookieUrls.push(query.url)
        const value = options.cookies ?? []
        if (typeof callback === 'function') {
          callback(value)
          return undefined
        }
        return Promise.resolve(value)
      }
    },
    tabs: {
      async query() {
        return [{ id: 5 }]
      }
    },
    scripting: {
      async executeScript(request: {
        target: { tabId: number }
        args: unknown[]
      }) {
        if (options.scriptingFails === true) {
          throw new Error('Cannot access contents of the page')
        }
        injected.push({ tabId: request.target.tabId, args: request.args })
        return []
      }
    },
    downloads: {
      search(query: { id: number }, callback: (items: unknown[]) => void) {
        searched.push(query.id)
        const base = {
          id: query.id,
          state: options.searchState ?? 'in_progress',
          danger: 'safe',
          url: 'https://example.com/files/report.zip',
          totalBytes: 4_000_000,
          mime: 'application/zip',
          filename: 'C:\\Downloads\\report.zip'
        }
        const merged: Record<string, unknown> = { ...base, ...(options.searchItem ?? {}) }
        // A search result reports the trusted final URL, so a redirect that
        // already settled keeps the same identity.
        if (typeof merged.finalUrl !== 'string') merged.finalUrl = merged.url
        callback([
          {
            ...merged,
            ...(options.byExtensionId ? { byExtensionId: options.byExtensionId } : {})
          }
        ])
      },
      cancel(id: number, callback: () => void) {
        if (options.cancelFails === true) {
          chrome.runtime.lastError = { message: 'cancel failed' }
          callback()
          chrome.runtime.lastError = undefined
          return
        }
        cancelled.push(id)
        callback()
      },
      erase(query: { id: number }, callback: () => void) {
        erased.push(query.id)
        callback()
      }
    }
  }

  return {
    chrome,
    local,
    session,
    nativeMessages,
    cancelled,
    erased,
    searched,
    cookieUrls,
    injected,
    setResponse(next: unknown) {
      activeResponse = next
    },
    setRuntimeError(next: string | null) {
      runtimeError = next
    }
  }
}

async function seedSettings(
  fake: ReturnType<typeof createFake>,
  notifications = false
) {
  await writeCaptureSettings(fake.chrome, {
    floatingTriggerEnabled: true,
    automaticFileHandoff: true,
    handoffNotifications: notifications,
    excludedOrigins: []
  })
}

afterEach(() => {
  delete (globalThis as any).chrome
  resetDownloadsListenerForTests()
  forgetHandedOffDownloadsForTests()
})

function useFake(fake: ReturnType<typeof createFake>) {
  ;(globalThis as any).chrome = fake.chrome
  return fake.chrome
}

function fileItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    state: 'in_progress',
    danger: 'safe',
    url: 'https://example.com/files/report.zip',
    filename: 'C:\\Downloads\\report.zip',
    totalBytes: 4_000_000,
    mime: 'application/zip',
    ...overrides
  }
}

function mediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 52,
    state: 'in_progress',
    danger: 'safe',
    url: 'https://example.com/media/clip.mp4',
    filename: 'C:\\Downloads\\clip.mp4',
    totalBytes: 25_000_000,
    mime: 'video/mp4',
    ...overrides
  }
}

function nativeMessage(fake: ReturnType<typeof createFake>, index = 0) {
  return (fake.nativeMessages[index] as { message: Record<string, unknown> }).message
}

/**
 * A browser that holds downloads in chrome.downloads.onDeterminingFilename. The
 * fake also exposes onCreated so a test can prove it was not registered.
 */
function installHeld(fake: ReturnType<typeof createFake>) {
  let heldListener: ((item: unknown, suggest: () => void) => boolean) | null = null
  let createdListener: ((item: unknown) => void) | null = null
  fake.chrome.downloads.onDeterminingFilename = {
    addListener(listener: (item: unknown, suggest: () => void) => boolean) {
      heldListener = listener
    }
  }
  fake.chrome.downloads.onCreated = {
    addListener(listener: (item: unknown) => void) {
      createdListener = listener
    }
  }
  const installed = installDownloadsListener(fake.chrome, (item, options) =>
    handleCreatedDownload(fake.chrome, item, options)
  )
  return {
    installed,
    held: () => heldListener!,
    createdRegistered: () => createdListener !== null
  }
}

/** Let the whole hand-off decision settle: every step resolves on a microtask. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('automatic browser hand-off is strict and conservative', () => {
  it('cancels only after a durable receipt and preserves the browser download on every uncertain path', async () => {
    // Success: exactly one session claim, one native message, one cancel.
    const success = createFake()
    await seedSettings(success)
    useFake(success)
    expect(automaticHandoffCandidate(fileItem(), []).ok).toBe(true)
    expect(await handleCreatedDownload(success.chrome, fileItem())).toBe('cancelled')
    expect(nativeMessage(success)).toEqual({
      type: 'handoff-download',
      url: 'https://example.com/files/report.zip',
      filename: 'report.zip',
      expectedBytes: 4_000_000,
      expectedContentType: 'application/zip',
      userAgent: expect.any(String)
    })
    expect(success.cancelled).toEqual([42])
    expect(success.searched).toEqual([42])

    // A native timeout is an uncertain outcome: the bridge resolves ok:false
    // and the caller leaves the browser transfer running.
    const timedOut = createFake()
    timedOut.chrome.runtime.sendNativeMessage = () => undefined
    ;(globalThis as any).chrome = timedOut.chrome
    const timeoutResult = await sendDurableHandoff(
      'https://example.com/files/report.zip',
      undefined,
      { timeoutMs: 5 }
    )
    expect(timeoutResult).toMatchObject({
      ok: false,
      error: { code: 'HANDOFF_TIMEOUT' }
    })
    expect(timedOut.cancelled).toEqual([])

    // Duplicate recursion: an already processed ID is never handed off (or
    // cancelled) a second time, and an extension-created download is ignored.
    expect(await handleCreatedDownload(success.chrome, fileItem())).toBe(
      'duplicate-uncertain'
    )
    expect(success.nativeMessages).toHaveLength(1)
    expect(success.cancelled).toEqual([42])
    expect(
      await handleCreatedDownload(
        success.chrome,
        fileItem({ id: 43, byExtensionId: 'abcdefghijklmnop' })
      )
    ).toBe('ignored:extension-download')
    expect(success.cancelled).toEqual([42])

    // Bridge/native failure: leave the browser download running.
    const unavailable = createFake({
      nativeResponse: {
        ok: false,
        error: { code: 'APP_NOT_RUNNING', message: 'DonDownload is not running.' }
      }
    })
    await seedSettings(unavailable)
    useFake(unavailable)
    expect(await handleCreatedDownload(unavailable.chrome, fileItem())).toBe(
      'left-running'
    )
    expect(unavailable.cancelled).toEqual([])

    // Preflight failure (for example a POST-only transfer): the browser
    // download is kept.
    const preflightFailure = createFake({
      nativeResponse: {
        ok: false,
        error: {
          code: 'HANDOFF_PREFLIGHT_FAILED',
          message: 'The browser download could not be verified and was left running.'
        }
      }
    })
    await seedSettings(preflightFailure)
    useFake(preflightFailure)
    expect(
      await handleCreatedDownload(preflightFailure.chrome, fileItem({ id: 44 }))
    ).toBe('left-running')
    expect(preflightFailure.cancelled).toEqual([])

    // Malformed receipt: never cancel on a claimed-but-invalid durability.
    const malformed = createFake({
      nativeResponse: {
        ok: true,
        accepted: true,
        durable: true,
        operation: 'handoff-download',
        receipt: { downloadId: 'not-a-uuid', persistedAt: 1 }
      }
    })
    await seedSettings(malformed)
    useFake(malformed)
    expect(await handleCreatedDownload(malformed.chrome, fileItem())).toBe(
      'left-running'
    )
    expect(malformed.cancelled).toEqual([])

    // Completed race after the receipt: a possible duplicate is safer than
    // losing the file, so do not cancel.
    const completed = createFake({ searchState: 'complete' })
    await seedSettings(completed)
    useFake(completed)
    expect(await handleCreatedDownload(completed.chrome, fileItem())).toBe(
      'left-running-completed'
    )
    expect(completed.cancelled).toEqual([])

    // Storage failure means the processed/pending reservation cannot survive
    // worker suspension, so no native call is made and nothing is cancelled.
    const storageFailure = createFake({ storageFails: true })
    await writeCaptureSettings(storageFailure.chrome, {
      automaticFileHandoff: true,
      handoffNotifications: false
    })
    useFake(storageFailure)
    expect(await handleCreatedDownload(storageFailure.chrome, fileItem())).toBe(
      'not-claimed:storage-unavailable'
    )
    expect(storageFailure.nativeMessages).toEqual([])
    expect(storageFailure.cancelled).toEqual([])

    // Concurrent MV3 events must not overwrite each other's reservations.
    const concurrent = createFake()
    const claims = await Promise.all([
      claimHandoffDownload(concurrent.chrome, 70),
      claimHandoffDownload(concurrent.chrome, 71),
      claimHandoffDownload(concurrent.chrome, 70)
    ])
    expect(claims).toEqual([{ ok: true }, { ok: true }, { ok: false, reason: 'duplicate' }])
    await Promise.all([
      finishHandoffDownload(concurrent.chrome, 70),
      finishHandoffDownload(concurrent.chrome, 71)
    ])
    expect(await readHandoffState(concurrent.chrome)).toEqual({ pending: [], processed: [70, 71] })
    concurrent.chrome.storage.session.get = async () => { throw new Error('read failed') }
    expect(await claimHandoffDownload(concurrent.chrome, 72)).toEqual({ ok: false, reason: 'storage-unavailable' })
    expect(automaticHandoffCandidate(fileItem({ danger: 'uncommon' }), []).ok).toBe(false)
    expect(automaticHandoffCandidate(fileItem({ paused: true }), []).ok).toBe(false)
    // An unknown size stays in the browser unless the URL names a real file.
    expect(
      automaticHandoffCandidate(
        fileItem({
          url: 'https://example.com/download',
          filename: 'C:\\Downloads\\download',
          mime: 'application/octet-stream',
          totalBytes: -1
        }),
        []
      ).ok
    ).toBe(false)
    expect(automaticHandoffCandidate(fileItem({ referrer: 'https://excluded.example/page' }), ['https://excluded.example']).ok).toBe(false)

    // The browser may not know the total at onCreated. Wait for the exact size
    // change, then re-read the trusted DownloadItem before trying takeover.
    const delayedSize = createFake()
    await seedSettings(delayedSize)
    useFake(delayedSize)
    let createdListener: ((item: unknown) => void) | null = null
    let changedListener: ((delta: unknown) => void) | null = null
    delayedSize.chrome.downloads.onCreated = {
      addListener(listener: (item: unknown) => void) { createdListener = listener }
    }
    delayedSize.chrome.downloads.onChanged = {
      addListener(listener: (delta: unknown) => void) { changedListener = listener }
    }
    expect(installDownloadsListener(delayedSize.chrome, (item) => handleCreatedDownload(delayedSize.chrome, item))).toBe(true)
    createdListener!(fileItem({ id: 88, totalBytes: -1 }))
    expect(delayedSize.nativeMessages).toEqual([])
    changedListener!({ id: 88, totalBytes: { current: 4_000_000 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delayedSize.nativeMessages).toHaveLength(1)
    expect(delayedSize.cancelled).toEqual([88])
  })
})

describe('download-manager takeover rules', () => {
  it('hands off a direct media file of at least 1 MB', async () => {
    const fake = createFake({
      searchItem: {
        url: 'https://example.com/media/clip.mp4',
        filename: 'C:\\Downloads\\clip.mp4',
        totalBytes: 25_000_000,
        mime: 'video/mp4'
      }
    })
    await seedSettings(fake)
    useFake(fake)
    expect(automaticHandoffCandidate(mediaItem(), []).ok).toBe(true)
    expect(await handleCreatedDownload(fake.chrome, mediaItem())).toBe('cancelled')
    expect(nativeMessage(fake)).toMatchObject({
      type: 'handoff-download',
      url: 'https://example.com/media/clip.mp4',
      filename: 'clip.mp4',
      expectedBytes: 25_000_000,
      expectedContentType: 'video/mp4'
    })
    expect(fake.cancelled).toEqual([52])

    // An audio file and an extensionless media URL named by its file are the
    // same kind of ordinary browser download.
    expect(
      automaticHandoffCandidate(
        mediaItem({
          id: 53,
          url: 'https://example.com/audio/song',
          filename: 'C:\\Downloads\\song.flac',
          mime: 'audio/flac'
        }),
        []
      ).ok
    ).toBe(true)
  })

  it('never hands off an HLS/DASH manifest, a segment or an HTML page', async () => {
    const fake = createFake()
    await seedSettings(fake)
    useFake(fake)

    const manifest = mediaItem({
      id: 60,
      url: 'https://example.com/media/master.m3u8',
      filename: 'C:\\Downloads\\master.m3u8',
      mime: 'application/vnd.apple.mpegurl'
    })
    expect(automaticHandoffCandidate(manifest, [])).toEqual({
      ok: false,
      reason: 'page-or-manifest'
    })
    expect(await handleCreatedDownload(fake.chrome, manifest)).toBe(
      'ignored:page-or-manifest'
    )

    const dash = mediaItem({
      id: 61,
      url: 'https://example.com/media/manifest',
      filename: 'C:\\Downloads\\manifest.mpd',
      mime: 'application/dash+xml'
    })
    expect(await handleCreatedDownload(fake.chrome, dash)).toBe(
      'ignored:page-or-manifest'
    )

    const segment = mediaItem({
      id: 62,
      url: 'https://example.com/media/segment.m4s',
      filename: 'C:\\Downloads\\segment.m4s',
      mime: 'video/iso.segment'
    })
    expect(automaticHandoffCandidate(segment, [])).toEqual({
      ok: false,
      reason: 'segment-or-manifest'
    })

    const page = fileItem({
      id: 63,
      url: 'https://example.com/page/index.html',
      filename: 'C:\\Downloads\\index.html',
      mime: 'text/html'
    })
    expect(automaticHandoffCandidate(page, [])).toEqual({
      ok: false,
      reason: 'page-or-manifest'
    })

    const pageNamedOnly = fileItem({
      id: 64,
      url: 'https://example.com/download',
      filename: 'C:\\Downloads\\saved.html',
      mime: 'application/octet-stream'
    })
    expect(await handleCreatedDownload(fake.chrome, pageNamedOnly)).toBe(
      'ignored:page-or-manifest'
    )

    expect(fake.nativeMessages).toEqual([])
    expect(fake.cancelled).toEqual([])
  })

  it('leaves a 500 KB file and an unknown-size download in the browser', async () => {
    const fake = createFake()
    await seedSettings(fake)
    useFake(fake)

    const small = fileItem({ id: 70, totalBytes: 500_000 })
    expect(automaticHandoffCandidate(small, [])).toEqual({
      ok: false,
      reason: 'below-minimum'
    })
    expect(await handleCreatedDownload(fake.chrome, small)).toBe(
      'ignored:below-minimum'
    )

    // An unknown size is handed off only when the URL or type names a real
    // file; the desktop preflight still proves the size.
    const unknownMedia = mediaItem({ id: 71, totalBytes: -1 })
    expect(automaticHandoffCandidate(unknownMedia, []).ok).toBe(true)

    const unknownOpaque = fileItem({
      id: 72,
      url: 'https://example.com/download',
      filename: 'C:\\Downloads\\download',
      mime: 'application/octet-stream',
      totalBytes: -1
    })
    expect(automaticHandoffCandidate(unknownOpaque, [])).toEqual({
      ok: false,
      reason: 'size-unavailable'
    })
    expect(await handleCreatedDownload(fake.chrome, unknownOpaque)).toBe(
      'ignored:size-unavailable'
    )

    // Exactly 1 MB is enough; 999,999 bytes is not.
    expect(automaticHandoffCandidate(fileItem({ totalBytes: 1_000_000 }), []).ok).toBe(true)
    expect(
      automaticHandoffCandidate(fileItem({ totalBytes: 999_999 }), [])
    ).toEqual({ ok: false, reason: 'below-minimum' })

    // The user's "only files larger than" choice is honoured.
    expect(
      automaticHandoffCandidate(fileItem({ totalBytes: 2_000_000 }), [], {
        minBytes: 10_000_000
      })
    ).toEqual({ ok: false, reason: 'below-minimum' })
    expect(
      automaticHandoffCandidate(fileItem({ totalBytes: 500_000 }), [], {
        minBytes: 0
      }).ok
    ).toBe(true)

    expect(fake.nativeMessages).toEqual([])
    expect(fake.cancelled).toEqual([])
  })

  it('always hands off a .funscript whatever its size', async () => {
    // A 3 KB .funscript is far below the 1 MB minimum, but it is always wanted.
    const small = fileItem({
      id: 90,
      url: 'https://example.com/scripts/session.funscript',
      filename: 'C:\\Downloads\\session.funscript',
      mime: 'application/octet-stream',
      totalBytes: 3_000
    })
    expect(automaticHandoffCandidate(small, [])).toMatchObject({
      ok: true,
      alwaysHandoff: true,
      expectedBytes: 3_000
    })

    const fake = createFake({
      searchItem: {
        url: 'https://example.com/scripts/session.funscript',
        filename: 'C:\\Downloads\\session.funscript',
        mime: 'application/octet-stream',
        totalBytes: 3_000
      }
    })
    await seedSettings(fake)
    useFake(fake)
    expect(await handleCreatedDownload(fake.chrome, small)).toBe('cancelled')
    expect(nativeMessage(fake)).toEqual({
      type: 'handoff-download',
      url: 'https://example.com/scripts/session.funscript',
      filename: 'session.funscript',
      expectedBytes: 3_000,
      expectedContentType: 'application/octet-stream',
      userAgent: expect.any(String)
    })
    expect(fake.cancelled).toEqual([90])

    // An unknown size is no reason to wait for the browser's total.
    const unknown = fileItem({
      id: 91,
      url: 'https://example.com/scripts/unknown.funscript',
      filename: 'C:\\Downloads\\unknown.funscript',
      mime: 'application/octet-stream',
      totalBytes: -1
    })
    expect(automaticHandoffCandidate(unknown, [])).toMatchObject({
      ok: true,
      alwaysHandoff: true
    })
    const unknownFake = createFake({
      searchItem: {
        url: 'https://example.com/scripts/unknown.funscript',
        filename: 'C:\\Downloads\\unknown.funscript',
        mime: 'application/octet-stream',
        totalBytes: -1
      }
    })
    await seedSettings(unknownFake)
    useFake(unknownFake)
    expect(await handleCreatedDownload(unknownFake.chrome, unknown)).toBe(
      'cancelled'
    )
    expect(nativeMessage(unknownFake)).not.toHaveProperty('expectedBytes')

    // A Discourse short-url redirects to the real upload and the browser
    // decides the file name, so the original URL, the final URL and the file
    // name are all checked.
    const shortUrl = fileItem({
      id: 92,
      url: 'https://discuss.eroscripts.com/uploads/short-url/rZhOEUUGfIsDdGDg8tMWl9W93ng.funscript',
      finalUrl: 'https://discuss.eroscripts.com/uploads/default/original/3X/ab/cd/9f8e',
      filename: 'C:\\Downloads\\x.funscript',
      mime: 'application/octet-stream',
      totalBytes: 0
    })
    expect(automaticHandoffCandidate(shortUrl, [])).toMatchObject({
      ok: true,
      alwaysHandoff: true,
      url: 'https://discuss.eroscripts.com/uploads/default/original/3X/ab/cd/9f8e',
      filename: 'x.funscript'
    })
    // Only the original URL names the file: still a candidate.
    const shortUrlOnly = fileItem({
      id: 93,
      url: 'https://discuss.eroscripts.com/uploads/short-url/rZhOEUUGfIsDdGDg8tMWl9W93ng.funscript',
      finalUrl: 'https://discuss.eroscripts.com/uploads/default/original/3X/ab/cd/9f8e',
      filename: 'C:\\Downloads\\9f8e',
      mime: 'application/octet-stream',
      totalBytes: 0
    })
    expect(automaticHandoffCandidate(shortUrlOnly, [])).toMatchObject({
      ok: true,
      alwaysHandoff: true
    })

    // Everything else keeps the minimum: a 3 KB .txt stays in the browser.
    const text = fileItem({
      id: 94,
      url: 'https://example.com/files/notes.txt',
      filename: 'C:\\Downloads\\notes.txt',
      mime: 'text/plain',
      totalBytes: 3_000
    })
    expect(automaticHandoffCandidate(text, [])).toEqual({
      ok: false,
      reason: 'below-minimum'
    })
    expect(await handleCreatedDownload(fake.chrome, text)).toBe(
      'ignored:below-minimum'
    )

    // A .funscript that is really an HTML page is still a page.
    const page = fileItem({
      id: 95,
      url: 'https://example.com/scripts/login.funscript',
      filename: 'C:\\Downloads\\login.funscript',
      mime: 'text/html',
      totalBytes: 3_000
    })
    expect(automaticHandoffCandidate(page, [])).toEqual({
      ok: false,
      reason: 'page-or-manifest'
    })

    // The bridge must not re-reject the same file as too small.
    const bridge = createFake()
    useFake(bridge)
    const sent = await sendDurableHandoff(
      'https://example.com/scripts/small.funscript',
      'small.funscript',
      {
        expectedBytes: 3_000,
        expectedContentType: 'application/json',
        minBytes: 1_000_000
      }
    )
    expect(sent.ok).toBe(true)
    expect(nativeMessage(bridge)).toMatchObject({
      url: 'https://example.com/scripts/small.funscript',
      filename: 'small.funscript',
      expectedBytes: 3_000,
      expectedContentType: 'application/json'
    })
    const rejected = await sendDurableHandoff(
      'https://example.com/files/notes.txt',
      'notes.txt',
      { expectedBytes: 3_000, minBytes: 1_000_000 }
    )
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'HANDOFF_TOO_SMALL' }
    })

    expect(fake.cancelled).toEqual([90])
  })

  it('does not require the extension file allowlist for a browser download', async () => {
    const iso = fileItem({
      id: 80,
      url: 'https://example.com/files/disc.iso',
      filename: 'C:\\Downloads\\disc.iso',
      mime: 'application/octet-stream'
    })
    const unknownType = fileItem({
      id: 81,
      url: 'https://example.com/files/archive.xyz',
      filename: 'C:\\Downloads\\archive.xyz',
      mime: 'application/octet-stream'
    })
    for (const item of [iso, unknownType]) {
      const fake = createFake({
        searchItem: {
          url: item.url,
          filename: item.filename,
          mime: item.mime,
          totalBytes: item.totalBytes
        }
      })
      await seedSettings(fake)
      useFake(fake)
      expect(await handleCreatedDownload(fake.chrome, item)).toBe('cancelled')
      expect(fake.cancelled).toEqual([item.id])
    }
  })

  it('keeps blob:, data: and extension-created downloads out', async () => {
    expect(
      automaticHandoffCandidate(fileItem({ url: 'blob:https://example.com/1' }), [])
    ).toEqual({ ok: false, reason: 'unsupported-url' })
    expect(
      automaticHandoffCandidate(
        fileItem({ url: 'data:application/octet-stream;base64,AAAA' }),
        []
      )
    ).toEqual({ ok: false, reason: 'unsupported-url' })
    expect(
      automaticHandoffCandidate(fileItem({ byExtensionName: 'Other extension' }), [])
    ).toEqual({ ok: false, reason: 'extension-download' })
  })
})

describe('browser cookies for the automatic hand-off', () => {
  it('reads cookies for the exact download URL without any per-site opt-in', async () => {
    const fake = createFake({ cookies: [{ name: 'auth', value: '1' }] })
    await seedSettings(fake)
    useFake(fake)
    expect(
      await handleCreatedDownload(
        fake.chrome,
        fileItem({
          referrer: 'https://example.com/page',
          finalUrl: 'https://example.com/files/report.zip'
        })
      )
    ).toBe('cancelled')
    expect(fake.cookieUrls).toEqual(['https://example.com/files/report.zip'])
    const message = nativeMessage(fake)
    expect(message.cookie).toBe('auth=1')
    expect(message.referer).toBe('https://example.com/page')
    expect(typeof message.userAgent).toBe('string')
    expect(fake.cancelled).toEqual([42])

    // Nothing about the cookie is written to extension storage.
    const stored = JSON.stringify([...fake.local.entries(), ...fake.session.entries()])
    expect(stored).not.toContain('auth=1')
    expect(stored).not.toContain('auth')
  })

  it('sends no cookie when the cookies permission is not granted', async () => {
    const fake = createFake({
      cookies: [{ name: 'auth', value: '1' }],
      cookiesGranted: false
    })
    await seedSettings(fake)
    useFake(fake)
    expect(await handleCreatedDownload(fake.chrome, fileItem())).toBe('cancelled')
    expect(fake.cookieUrls).toEqual([])
    expect(nativeMessage(fake)).not.toHaveProperty('cookie')
  })

  it('records the needs-login state and keeps the browser download on a login wall', async () => {
    const fake = createFake({
      cookies: [],
      nativeResponse: {
        ok: false,
        error: {
          code: 'HANDOFF_NEEDS_LOGIN',
          message: 'This download needs your browser login.'
        }
      }
    })
    await seedSettings(fake)
    useFake(fake)
    expect(
      await handleCreatedDownload(
        fake.chrome,
        fileItem({ referrer: 'https://example.com/page' })
      )
    ).toBe('needs-login')
    expect(fake.cancelled).toEqual([])
    expect(await readNeedsLoginState(fake.chrome)).toMatchObject({
      origin: 'https://example.com',
      host: 'example.com'
    })
  })
})

describe('handoffMinBytes setting', () => {
  it('defaults to 1 MB and normalizes only the allowed values', () => {
    expect(DEFAULT_CAPTURE_SETTINGS.handoffMinBytes).toBe(1_000_000)
    expect(normalizeCaptureSettings({}).handoffMinBytes).toBe(1_000_000)
    expect(normalizeCaptureSettings({ handoffMinBytes: 0 }).handoffMinBytes).toBe(0)
    expect(
      normalizeCaptureSettings({ handoffMinBytes: 10_000_000 }).handoffMinBytes
    ).toBe(10_000_000)
    for (const value of [
      -1,
      1,
      500_000,
      2_000_000,
      Number.NaN,
      '1000000',
      null,
      undefined,
      {}
    ]) {
      expect(
        normalizeCaptureSettings({ handoffMinBytes: value }).handoffMinBytes
      ).toBe(1_000_000)
    }
  })
})

describe('in-page hand-off card', () => {
  it('shows the card with the receipt download id after a confirmed hand-off', async () => {
    const fake = createFake()
    await seedSettings(fake, true)
    useFake(fake)
    expect(await handleCreatedDownload(fake.chrome, fileItem())).toBe('cancelled')
    expect(fake.cancelled).toEqual([42])
    expect(fake.injected).toEqual([
      {
        tabId: 5,
        args: [{ downloadId: DOWNLOAD_ID, filename: 'report.zip' }]
      }
    ])
    // The service worker may now answer progress questions for this id only.
    expect(hasHandedOffDownload(DOWNLOAD_ID)).toBe(true)
  })

  it('never shows a card when hand-off notifications are off', async () => {
    const fake = createFake()
    await seedSettings(fake, false)
    useFake(fake)
    expect(await handleCreatedDownload(fake.chrome, fileItem())).toBe('cancelled')
    expect(fake.injected).toEqual([])
    expect(fake.cancelled).toEqual([42])
  })

  it('never shows a card when the hand-off failed', async () => {
    const fake = createFake({
      nativeResponse: {
        ok: false,
        error: { code: 'APP_NOT_RUNNING', message: 'DonDownload is not running.' }
      }
    })
    await seedSettings(fake, true)
    useFake(fake)
    expect(await handleCreatedDownload(fake.chrome, fileItem())).toBe(
      'left-running'
    )
    expect(fake.injected).toEqual([])
    expect(fake.cancelled).toEqual([])
    expect(hasHandedOffDownload(DOWNLOAD_ID)).toBe(false)
  })

  it('keeps the hand-off result when the card cannot be injected', async () => {
    const fake = createFake({ scriptingFails: true })
    await seedSettings(fake, true)
    useFake(fake)
    expect(await handleCreatedDownload(fake.chrome, fileItem())).toBe('cancelled')
    expect(fake.cancelled).toEqual([42])
    expect(fake.injected).toEqual([])

    // A tab query that throws is equally harmless.
    fake.chrome.tabs.query = async () => {
      throw new Error('no window')
    }
    expect(await handleCreatedDownload(fake.chrome, fileItem({ id: 43 }))).toBe(
      'cancelled'
    )
    expect(fake.cancelled).toEqual([42, 43])
  })
})

describe('downloads are intercepted before the Save As dialog', () => {
  it('hands a held download off, then cancels and erases it before releasing the browser', async () => {
    const fake = createFake()
    await seedSettings(fake)
    useFake(fake)
    const events: string[] = []
    const sendNative = fake.chrome.runtime.sendNativeMessage
    fake.chrome.runtime.sendNativeMessage = (
      host: string,
      message: unknown,
      callback: (value: unknown) => void
    ) => {
      events.push('native')
      sendNative(host, message, callback)
    }
    const cancel = fake.chrome.downloads.cancel
    fake.chrome.downloads.cancel = (id: number, callback: () => void) => {
      events.push('cancel')
      cancel(id, callback)
    }
    const erase = fake.chrome.downloads.erase
    fake.chrome.downloads.erase = (query: { id: number }, callback: () => void) => {
      events.push('erase')
      erase(query, callback)
    }

    const held = installHeld(fake)
    expect(held.installed).toBe(true)
    // onCreated is only the fallback for a browser without onDeterminingFilename.
    expect(held.createdRegistered()).toBe(false)

    const suggests: number[] = []
    expect(held.held()(fileItem(), () => {
      events.push('suggest')
      suggests.push(1)
    })).toBe(true)
    await flush()

    // The hand-off is sent first, then the browser copy is cancelled and erased,
    // and only then is the held decision released.
    expect(events).toEqual(['native', 'cancel', 'erase', 'suggest'])
    expect(fake.nativeMessages).toHaveLength(1)
    expect(fake.cancelled).toEqual([42])
    expect(fake.erased).toEqual([42])
    expect(suggests).toEqual([1])
    // A held download is not in the browser's list yet, so nothing is re-read.
    expect(fake.searched).toEqual([])
  })

  it('releases a download it will not hand off', async () => {
    const fake = createFake()
    await seedSettings(fake)
    useFake(fake)
    const held = installHeld(fake)
    const suggests: number[] = []
    expect(
      held.held()(
        fileItem({
          url: 'https://example.com/page.html',
          filename: 'C:\\Downloads\\page.html',
          mime: 'text/html'
        }),
        () => suggests.push(1)
      )
    ).toBe(true)
    await flush()
    expect(suggests).toEqual([1])
    expect(fake.nativeMessages).toEqual([])
    expect(fake.cancelled).toEqual([])
    expect(fake.erased).toEqual([])
  })

  it('releases the download when the master switch is off', async () => {
    const fake = createFake()
    await writeCaptureSettings(fake.chrome, { automaticFileHandoff: false })
    useFake(fake)
    const held = installHeld(fake)
    const suggests: number[] = []
    held.held()(fileItem(), () => suggests.push(1))
    await flush()
    expect(suggests).toEqual([1])
    expect(fake.nativeMessages).toEqual([])
    expect(fake.cancelled).toEqual([])
  })

  it('releases the download when the hand-off is not confirmed', async () => {
    const fake = createFake({
      nativeResponse: {
        ok: false,
        error: { code: 'APP_NOT_RUNNING', message: 'DonDownload is not running.' }
      }
    })
    await seedSettings(fake)
    useFake(fake)
    const held = installHeld(fake)
    const suggests: number[] = []
    held.held()(fileItem(), () => suggests.push(1))
    await flush()
    expect(suggests).toEqual([1])
    expect(fake.cancelled).toEqual([])
  })

  it('releases a held download when the decision hangs', async () => {
    const fake = createFake()
    await seedSettings(fake)
    useFake(fake)
    let heldListener: ((item: unknown, suggest: () => void) => boolean) | null = null
    fake.chrome.downloads.onDeterminingFilename = {
      addListener(listener: (item: unknown, suggest: () => void) => boolean) {
        heldListener = listener
      }
    }
    const neverSettles = () => new Promise(() => undefined)
    expect(installDownloadsListener(fake.chrome, neverSettles)).toBe(true)
    const suggests: number[] = []
    vi.useFakeTimers()
    try {
      expect(
        heldListener!(fileItem(), () => suggests.push(1))
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(HANDOFF_SUGGEST_TIMEOUT_MS - 1)
      expect(suggests).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(suggests).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never handles the same download twice', async () => {
    const fake = createFake()
    await seedSettings(fake)
    useFake(fake)
    const held = installHeld(fake)
    const suggests: number[] = []
    held.held()(fileItem(), () => suggests.push(1))
    await flush()
    expect(fake.nativeMessages).toHaveLength(1)
    // A second event for the same id is only released, never handed off again.
    expect(held.held()(fileItem(), () => suggests.push(2))).toBe(false)
    await flush()
    expect(fake.nativeMessages).toHaveLength(1)
    expect(fake.cancelled).toEqual([42])
    expect(suggests).toEqual([1, 2])
  })

  it('shows the in-page card for a held hand-off', async () => {
    const fake = createFake()
    await seedSettings(fake, true)
    useFake(fake)
    const held = installHeld(fake)
    held.held()(fileItem(), () => undefined)
    await flush()
    expect(fake.cancelled).toEqual([42])
    expect(fake.injected).toEqual([
      {
        tabId: 5,
        args: [{ downloadId: DOWNLOAD_ID, filename: 'report.zip' }]
      }
    ])
    expect(hasHandedOffDownload(DOWNLOAD_ID)).toBe(true)
  })
})
