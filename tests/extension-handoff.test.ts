import { afterEach, describe, expect, it } from 'vitest'
import { handleCreatedDownload, installDownloadsListener } from '../extension/handoff.js'
import { claimHandoffDownload, finishHandoffDownload, readHandoffState, readNeedsLoginState, writeCaptureSettings } from '../extension/capture-settings.js'
import { automaticHandoffCandidate } from '../extension/handoff-policy.js'
import { sendDurableHandoff } from '../extension/bridge.js'
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
  searchItem?: Record<string, unknown>
}

function createFake(options: FakeOptions = {}) {
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const nativeMessages: unknown[] = []
  const cancelled: number[] = []
  const searched: number[] = []
  const cookieUrls: string[] = []
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
      async contains() {
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
    downloads: {
      search(query: { id: number }, callback: (items: unknown[]) => void) {
        searched.push(query.id)
        callback([
          {
            id: query.id,
            state: options.searchState ?? 'in_progress',
            danger: 'safe',
            url: 'https://example.com/files/report.zip',
            totalBytes: 4,
            mime: 'application/zip',
            filename: 'C:\\Downloads\\report.zip',
            ...(options.byExtensionId ? { byExtensionId: options.byExtensionId } : {}),
            ...(options.searchItem ?? {})
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
      }
    }
  }

  return {
    chrome,
    local,
    session,
    nativeMessages,
    cancelled,
    searched,
    cookieUrls,
    setResponse(next: unknown) {
      activeResponse = next
    },
    setRuntimeError(next: string | null) {
      runtimeError = next
    }
  }
}

async function seedSettings(fake: ReturnType<typeof createFake>) {
  await writeCaptureSettings(fake.chrome, {
    floatingTriggerEnabled: true,
    automaticFileHandoff: true,
    handoffNotifications: false,
    excludedOrigins: []
  })
}

afterEach(() => {
  delete (globalThis as any).chrome
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
    totalBytes: 4,
    mime: 'application/zip',
    ...overrides
  }
}

describe('automatic browser hand-off is strict and conservative', () => {
  it('cancels only after a durable receipt and preserves the browser download on every uncertain path', async () => {
    // Success: exactly one session claim, one native message, one cancel.
    const success = createFake()
    await seedSettings(success)
    useFake(success)
    expect(automaticHandoffCandidate(fileItem(), []).ok).toBe(true)
    expect(await handleCreatedDownload(success.chrome, fileItem())).toBe('cancelled')
    expect(success.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: {
          type: 'handoff-download',
          url: 'https://example.com/files/report.zip',
          filename: 'report.zip',
          expectedBytes: 4,
          expectedContentType: 'application/zip'
        }
      }
    ])
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

    // Anonymous preflight failure (for example an authenticated or POST-only
    // transfer): the browser download is kept.
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
    expect(automaticHandoffCandidate(fileItem({ mime: 'video/mp4' }), []).ok).toBe(false)
    expect(automaticHandoffCandidate(fileItem({ totalBytes: -1 }), []).ok).toBe(false)
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
    changedListener!({ id: 88, totalBytes: { current: 4 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delayedSize.nativeMessages).toHaveLength(1)
    expect(delayedSize.cancelled).toEqual([88])
  })
})

describe('opt-in browser login hand-off', () => {
  it('sends no cookie or browser headers when no origin is opted in', async () => {
    const fake = createFake({ cookies: [{ name: 'auth', value: '1' }] })
    await seedSettings(fake)
    useFake(fake)
    expect(
      await handleCreatedDownload(
        fake.chrome,
        fileItem({ referrer: 'https://example.com/page' })
      )
    ).toBe('cancelled')
    const message = (fake.nativeMessages[0] as { message: Record<string, unknown> })
      .message
    expect(message).not.toHaveProperty('cookie')
    expect(message).not.toHaveProperty('referer')
    expect(message).not.toHaveProperty('userAgent')
    expect(fake.cookieUrls).toEqual([])
  })

  it('reads cookies for the exact download URL when its origin is opted in', async () => {
    const fake = createFake({ cookies: [{ name: 'auth', value: '1' }] })
    await writeCaptureSettings(fake.chrome, {
      automaticFileHandoff: true,
      handoffNotifications: false,
      cookieOptInOrigins: ['https://example.com']
    })
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
    const message = (fake.nativeMessages[0] as { message: Record<string, unknown> })
      .message
    expect(message.cookie).toBe('auth=1')
    expect(message.referer).toBe('https://example.com/page')
    expect(typeof message.userAgent).toBe('string')
    expect(fake.cancelled).toEqual([42])
  })

  it('uses a page-origin opt-in but still reads only the download host cookies', async () => {
    const fake = createFake({
      cookies: [{ name: 'cdn', value: 'yes' }],
      searchItem: {
        url: 'https://cdn.example.net/files/report.zip',
        totalBytes: 4,
        mime: 'application/zip',
        filename: 'C:\\Downloads\\report.zip'
      }
    })
    await writeCaptureSettings(fake.chrome, {
      automaticFileHandoff: true,
      handoffNotifications: false,
      cookieOptInOrigins: ['https://page.example']
    })
    useFake(fake)
    const item = fileItem({
      url: 'https://cdn.example.net/files/report.zip',
      finalUrl: 'https://cdn.example.net/files/report.zip',
      referrer: 'https://page.example/post'
    })
    expect(await handleCreatedDownload(fake.chrome, item)).toBe('cancelled')
    expect(fake.cookieUrls).toEqual([
      'https://cdn.example.net/files/report.zip'
    ])
    expect(
      (
        fake.nativeMessages[0] as { message: Record<string, unknown> }
      ).message.cookie
    ).toBe('cdn=yes')
  })

  it('records the needs-login state and keeps the browser download when not opted in', async () => {
    const fake = createFake({
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
    expect(fake.cookieUrls).toEqual([])
  })

  it('does not offer the login opt-in when the origin was already opted in', async () => {
    const fake = createFake({
      nativeResponse: {
        ok: false,
        error: {
          code: 'HANDOFF_NEEDS_LOGIN',
          message: 'This download needs your browser login.'
        }
      }
    })
    await writeCaptureSettings(fake.chrome, {
      automaticFileHandoff: true,
      handoffNotifications: false,
      cookieOptInOrigins: ['https://example.com']
    })
    useFake(fake)
    expect(
      await handleCreatedDownload(
        fake.chrome,
        fileItem({ referrer: 'https://example.com/page' })
      )
    ).toBe('left-running')
    expect(await readNeedsLoginState(fake.chrome)).toBeNull()
    expect(fake.cancelled).toEqual([])
  })
})
