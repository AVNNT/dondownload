import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }
  },
  shell: { showItemInFolder: vi.fn() },
  clipboard: { writeText: vi.fn() }
}))

import { IPC } from '../src/shared/ipc'
import type { ChecksumResult } from '../src/shared/checksum'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { ChecksumService } from '../src/main/checksum/service'
import { AppError } from '../src/main/errors'
import { registerIpc } from '../src/main/ipc'

const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const UNKNOWN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SHA256_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

function checksumResult(): ChecksumResult {
  return {
    algorithm: 'sha256',
    ok: true,
    computed: SHA256_ABC,
    checkedAt: Date.UTC(2026, 10, 7, 12, 0, 0)
  }
}

function createChecksumService() {
  const result = checksumResult()
  return {
    result,
    verify: vi.fn(async (_input: unknown) => result),
    compute: vi.fn(async (_input: unknown) => result),
    cancel: vi.fn((_input: unknown) => undefined)
  }
}

type FakeChecksumService = ReturnType<typeof createChecksumService>

interface FakeWindow {
  window: {
    isDestroyed: () => boolean
    webContents: {
      mainFrame: { url: string }
      getURL: () => string
    }
  }
  frame: { url: string }
  webContents: {
    mainFrame: { url: string }
    getURL: () => string
  }
}

function createWindow(): FakeWindow {
  const frame = { url: 'app://dondownload/index.html' }
  const webContents = {
    mainFrame: frame,
    getURL: () => frame.url
  }
  const window = {
    isDestroyed: () => false,
    webContents
  }
  return { window, frame, webContents }
}

function register(
  checksums: FakeChecksumService | ChecksumService,
  windowOverride?: FakeWindow
) {
  const fakeWindow = windowOverride ?? createWindow()
  registerIpc({
    manager: {} as DownloadManager,
    aria2: {} as Aria2Service,
    checksums: checksums as unknown as ChecksumService,
    getWindow: () => fakeWindow.window as never
  })
  return fakeWindow
}

function handler(channel: string): InvokeHandler {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`No handler registered for ${channel}.`)
  return registered
}

function trustedEvent(fakeWindow: FakeWindow): unknown {
  return {
    sender: fakeWindow.webContents,
    senderFrame: fakeWindow.frame
  }
}

beforeEach(() => {
  handlers.clear()
})

describe('checksum IPC registration', () => {
  it('registers every checksum channel', () => {
    register(createChecksumService())

    expect(handlers.has(IPC.verifyChecksum)).toBe(true)
    expect(handlers.has(IPC.computeChecksum)).toBe(true)
    expect(handlers.has(IPC.cancelChecksum)).toBe(true)
    expect(handlers.has(IPC.addDownload)).toBe(true)
  })

  it('routes trusted invocations to the checksum service', async () => {
    const service = createChecksumService()
    const fakeWindow = register(service)
    const event = trustedEvent(fakeWindow)

    const verified = await handler(IPC.verifyChecksum)(event, {
      downloadId: DOWNLOAD_ID,
      expectedHash: SHA256_ABC
    })
    expect(verified).toEqual({ ok: true, value: service.result })
    expect(service.verify).toHaveBeenCalledWith({
      downloadId: DOWNLOAD_ID,
      expectedHash: SHA256_ABC
    })

    const computed = await handler(IPC.computeChecksum)(event, {
      downloadId: DOWNLOAD_ID
    })
    expect(computed).toEqual({ ok: true, value: service.result })

    const cancelled = await handler(IPC.cancelChecksum)(event, {
      downloadId: DOWNLOAD_ID
    })
    expect(cancelled).toEqual({ ok: true, value: null })
    expect(service.cancel).toHaveBeenCalledWith({ downloadId: DOWNLOAD_ID })
  })

  it('rejects an untrusted sender before any hashing starts', async () => {
    const service = createChecksumService()
    const fakeWindow = register(service)

    const result = await handler(IPC.verifyChecksum)(
      {
        sender: {},
        senderFrame: fakeWindow.frame
      },
      { downloadId: DOWNLOAD_ID, expectedHash: SHA256_ABC }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(service.verify).not.toHaveBeenCalled()
  })

  it('rejects an unknown download id from a trusted sender', async () => {
    const service = new ChecksumService({
      resolveTarget: async (downloadId) => {
        if (downloadId !== DOWNLOAD_ID) {
          throw new AppError(
            'DOWNLOAD_NOT_FOUND',
            'That download no longer exists.'
          )
        }
        return {
          downloadId: DOWNLOAD_ID,
          filePath: 'unused',
          filename: 'unused.bin',
          sizeBytes: 0
        }
      },
      saveResult: vi.fn(),
      onProgress: vi.fn()
    })
    const fakeWindow = register(service)

    const result = await handler(IPC.verifyChecksum)(
      trustedEvent(fakeWindow),
      { downloadId: UNKNOWN_ID, expectedHash: SHA256_ABC }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('DOWNLOAD_NOT_FOUND')
  })

  it('reports a safe error while the checksum service is not wired', async () => {
    const fakeWindow = createWindow()
    registerIpc({
      manager: {} as DownloadManager,
      aria2: {} as Aria2Service,
      getWindow: () => fakeWindow.window as never
    })

    const result = await handler(IPC.computeChecksum)(
      trustedEvent(fakeWindow),
      { downloadId: DOWNLOAD_ID }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('CHECKSUM_UNAVAILABLE')
  })
})
