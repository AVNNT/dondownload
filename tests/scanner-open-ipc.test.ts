import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>

const { handlers, openExternal } = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  openExternal: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }
  },
  shell: { showItemInFolder: vi.fn(), openExternal }
}))

import { IPC } from '../src/shared/ipc'
import {
  parseScanManualMatchInput,
  parseScanOpenInBrowserInput
} from '../src/shared/scanner'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'
import { isPublicOpenableUrl } from '../src/main/scanner/openExternal'
import type { ScanQueueService } from '../src/main/scanner/queue'
import type { ScanSessionManager } from '../src/main/scanner/session'

function createWindow() {
  const frame = { url: 'app://dondownload/index.html' }
  const webContents = { mainFrame: frame, getURL: () => frame.url }
  return { window: { isDestroyed: () => false, webContents }, frame, webContents }
}

function handler(channel: string): InvokeHandler {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`No handler registered for ${channel}.`)
  return registered
}

function trustedEvent(fakeWindow: ReturnType<typeof createWindow>): unknown {
  return { sender: fakeWindow.webContents, senderFrame: fakeWindow.frame }
}

beforeEach(() => {
  handlers.clear()
  openExternal.mockClear()
})

describe('open-in-browser contract', () => {
  it('accepts only opaque IDs and an optional strict pairing', () => {
    expect(
      parseScanOpenInBrowserInput({
        sessionId: 'scan_1',
        itemId: 'item_1'
      })
    ).toEqual({ sessionId: 'scan_1', itemId: 'item_1' })

    expect(
      parseScanOpenInBrowserInput({
        sessionId: 'scan_1',
        itemId: 'item_1',
        pairing: {
          setId: 'set:demo@1',
          scriptItemIds: ['item_2', 'item_3'],
          primaryVariant: 'hard',
          rename: true
        }
      })
    ).toMatchObject({ pairing: { setId: 'set:demo@1', primaryVariant: 'hard' } })

    expect(() =>
      parseScanOpenInBrowserInput({
        sessionId: 'scan_1',
        itemId: 'item_1',
        url: 'https://hanime1.me/watch?v=1'
      })
    ).toThrow()
    expect(() =>
      parseScanOpenInBrowserInput({
        sessionId: 'scan_1',
        itemId: 'item_1',
        pairing: {
          setId: 'set:demo@1',
          scriptItemIds: ['./escape'],
          primaryVariant: null,
          rename: true
        }
      })
    ).toThrow()
  })

  it('accepts only a null or opaque video item for a manual match', () => {
    expect(
      parseScanManualMatchInput({
        sessionId: 'scan_1',
        videoItemId: null,
        setId: 'set:demo@1',
        scriptItemIds: ['item_2'],
        primaryVariant: null,
        rename: false
      })
    ).toMatchObject({ videoItemId: null, rename: false })
    expect(() =>
      parseScanManualMatchInput({
        sessionId: 'scan_1',
        videoItemId: 'C:\\Videos\\clip.mp4',
        setId: 'set:demo@1',
        scriptItemIds: ['item_2'],
        primaryVariant: null,
        rename: true
      })
    ).toThrow()
  })

  it('rejects non-public and non-HTTP URLs before openExternal', () => {
    expect(isPublicOpenableUrl('https://hanime1.me/watch?v=1234')).toBe(true)
    expect(isPublicOpenableUrl('http://example.com/watch?v=1')).toBe(true)
    expect(isPublicOpenableUrl('http://localhost/watch?v=1')).toBe(false)
    expect(isPublicOpenableUrl('http://127.0.0.1/watch?v=1')).toBe(false)
    expect(isPublicOpenableUrl('http://192.168.1.5/watch?v=1')).toBe(false)
    expect(isPublicOpenableUrl('file:///C:/secret.mp4')).toBe(false)
    expect(isPublicOpenableUrl('javascript:alert(1)')).toBe(false)
    expect(isPublicOpenableUrl('https://user:pass@example.com/watch?v=1')).toBe(
      false
    )
  })
})

describe('open-in-browser IPC', () => {
  function register(url: string) {
    const scanner = {
      start: vi.fn(),
      cancel: vi.fn(),
      openInBrowser: vi.fn(() => ({
        url,
        pageUrl: url.split('#')[0] ?? url
      })),
      armBrowserMatch: vi.fn()
    }
    const scanQueue = { queueSelection: vi.fn() }
    const fakeWindow = createWindow()
    registerIpc({
      manager: {} as DownloadManager,
      aria2: {} as Aria2Service,
      scanner: scanner as unknown as ScanSessionManager,
      scanQueue: scanQueue as unknown as ScanQueueService,
      getWindow: () => fakeWindow.window as never
    })
    return { scanner, fakeWindow }
  }

  it('opens a validated public URL and arms the pairing', async () => {
    const { scanner, fakeWindow } = register(
      'https://hanime1.me/watch?v=1234'
    )
    const result = await handler(IPC.scanOpenInBrowser)(
      trustedEvent(fakeWindow),
      {
        sessionId: 'scan_1',
        itemId: 'item_1',
        pairing: {
          setId: 'set:demo@1',
          scriptItemIds: ['item_2'],
          primaryVariant: null,
          rename: true
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(scanner.armBrowserMatch).toHaveBeenCalledWith(
      'scan_1',
      'item_1',
      expect.objectContaining({ videoItemId: 'item_1', setId: 'set:demo@1' })
    )
    expect(openExternal).toHaveBeenCalledWith('https://hanime1.me/watch?v=1234')
  })

  it('never opens a private or non-HTTP target', async () => {
    const { scanner, fakeWindow } = register('http://127.0.0.1/watch?v=1')
    const result = await handler(IPC.scanOpenInBrowser)(
      trustedEvent(fakeWindow),
      { sessionId: 'scan_1', itemId: 'item_1' }
    )
    expect(result.ok).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
    expect(scanner.armBrowserMatch).not.toHaveBeenCalled()
  })
})
