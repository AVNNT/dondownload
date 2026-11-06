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
  shell: { showItemInFolder: vi.fn() }
}))

import { IPC } from '../src/shared/ipc'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'
import type { ScanQueueService } from '../src/main/scanner/queue'
import type { ScanSessionManager } from '../src/main/scanner/session'
import type { ScanSession } from '../src/shared/scanner'
import { parseScanPageRequest } from '../src/shared/scanBridge'

const SESSION: ScanSession = {
  sessionId: 'scan_0123456789abcdef',
  status: 'scanning',
  origin: 'paste',
  hostname: 'forum.example',
  message: null,
  signinRequired: false,
  counters: { found: 0, probing: 0, ready: 0, signin: 0, unavailable: 0 },
  progress: { fetchedPages: 0, totalItems: 0, queueableItems: 0 },
  items: [],
  removedItemIds: [],
  revision: 0,
  updatedAt: 1_700_000_000_000
}

function createWindow() {
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

function register() {
  const scanner = {
    start: vi.fn((_url: unknown, _options: unknown) => SESSION),
    cancel: vi.fn((_sessionId: unknown) => SESSION)
  }
  const scanQueue = {
    queueSelection: vi.fn(async (_sessionId: unknown, _itemIds: unknown) => ({
      batch: null,
      queuedItemIds: [],
      skipped: []
    }))
  }
  const fakeWindow = createWindow()
  registerIpc({
    manager: {} as DownloadManager,
    aria2: {} as Aria2Service,
    scanner: scanner as unknown as ScanSessionManager,
    scanQueue: scanQueue as unknown as ScanQueueService,
    getWindow: () => fakeWindow.window as never
  })
  return { scanner, scanQueue, fakeWindow }
}

function handler(channel: string): InvokeHandler {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`No handler registered for ${channel}.`)
  return registered
}

function trustedEvent(fakeWindow: ReturnType<typeof createWindow>): unknown {
  return {
    sender: fakeWindow.webContents,
    senderFrame: fakeWindow.frame
  }
}

beforeEach(() => {
  handlers.clear()
})

describe('scan IPC', () => {
  it('registers the four scan channels through the trusted-sender wrapper', () => {
    register()
    expect(handlers.has(IPC.scanStart)).toBe(true)
    expect(handlers.has(IPC.scanCancel)).toBe(true)
    expect(handlers.has(IPC.scanQueueSelection)).toBe(true)
    // scan:updated is main-to-renderer only and has no invoke handler.
    expect(handlers.has(IPC.scanUpdated)).toBe(false)
  })

  it('accepts exactly a URL for start and forces the paste origin', async () => {
    const { scanner, fakeWindow } = register()
    const event = trustedEvent(fakeWindow)

    const result = await handler(IPC.scanStart)(event, {
      url: 'https://forum.example/t/topic/1'
    })
    expect(result.ok).toBe(true)
    expect(scanner.start).toHaveBeenCalledWith(
      'https://forum.example/t/topic/1',
      { origin: 'paste' }
    )

    const withCookie = await handler(IPC.scanStart)(event, {
      url: 'https://forum.example/t/topic/1',
      cookie: 'auth=1'
    })
    expect(withCookie.ok).toBe(false)
    expect(withCookie.error?.code).toBeTruthy()
    expect(scanner.start).toHaveBeenCalledTimes(1)
  })

  it('rejects extra keys and malformed opaque IDs on every scan input', async () => {
    const { scanner, scanQueue, fakeWindow } = register()
    const event = trustedEvent(fakeWindow)

    await expect(
      handler(IPC.scanStart)(event, { url: 'https://forum.example/x', extra: true })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handler(IPC.scanStart)(event, { url: 'file:///secret' })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handler(IPC.scanCancel)(event, { sessionId: 'scan_1', extra: 1 })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handler(IPC.scanCancel)(event, { sessionId: 'bad id with spaces' })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handler(IPC.scanQueueSelection)(event, {
        sessionId: SESSION.sessionId,
        itemIds: ['item_1'],
        extra: true
      })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handler(IPC.scanQueueSelection)(event, {
        sessionId: SESSION.sessionId,
        itemIds: []
      })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handler(IPC.scanQueueSelection)(event, {
        sessionId: SESSION.sessionId,
        itemIds: ['item_1', 'item_1']
      })
    ).resolves.toMatchObject({ ok: false })

    expect(scanner.cancel).not.toHaveBeenCalled()
    expect(scanQueue.queueSelection).not.toHaveBeenCalled()
  })

  it('routes a valid selection to the queue service', async () => {
    const { scanQueue, fakeWindow } = register()
    const result = await handler(IPC.scanQueueSelection)(
      trustedEvent(fakeWindow),
      { sessionId: SESSION.sessionId, itemIds: ['item_1', 'item_2'] }
    )
    expect(result.ok).toBe(true)
    expect(scanQueue.queueSelection).toHaveBeenCalledWith(SESSION.sessionId, [
      'item_1',
      'item_2'
    ])
  })
})

describe('scan-page native bridge contract', () => {
  it('accepts exactly a URL and an optional cookie', () => {
    expect(
      parseScanPageRequest({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/1',
        cookie: 'auth=1'
      })
    ).toEqual({
      type: 'scan-page',
      url: 'https://discuss.example/t/topic/1',
      cookie: 'auth=1'
    })
    expect(
      parseScanPageRequest({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/1'
      })
    ).toEqual({ type: 'scan-page', url: 'https://discuss.example/t/topic/1' })
  })

  it('rejects extra keys, wrong types, credentials and invalid cookies', () => {
    expect(() =>
      parseScanPageRequest({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/1',
        headers: {}
      })
    ).toThrow()
    expect(() =>
      parseScanPageRequest({ type: 'queue-download', url: 'https://example.com' })
    ).toThrow()
    expect(() =>
      parseScanPageRequest({
        type: 'scan-page',
        url: 'https://user:pass@discuss.example/t/topic/1'
      })
    ).toThrow()
    expect(() =>
      parseScanPageRequest({
        type: 'scan-page',
        url: 'https://discuss.example/t/topic/1',
        cookie: 'auth=1\r\nX: y'
      })
    ).toThrow()
  })
})
