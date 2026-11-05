import { afterEach, describe, expect, it } from 'vitest'
import { handleCreatedDownload } from '../extension/handoff.js'
import { claimHandoffDownload, finishHandoffDownload, readHandoffState, writeCaptureSettings } from '../extension/capture-settings.js'
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
}

function createFake(options: FakeOptions = {}) {
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const nativeMessages: unknown[] = []
  const cancelled: number[] = []
  const searched: number[] = []
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
    downloads: {
      search(query: { id: number }, callback: (items: unknown[]) => void) {
        searched.push(query.id)
        callback([
          {
            id: query.id,
            state: options.searchState ?? 'in_progress',
            danger: 'safe',
            url: 'https://example.com/files/report.zip',
            filename: 'C:\\Downloads\\report.zip',
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
          filename: 'report.zip'
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
    expect(automaticHandoffCandidate(fileItem({ referrer: 'https://excluded.example/page' }), ['https://excluded.example']).ok).toBe(false)
  })
})
