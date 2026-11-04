import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>

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
import type { AppSnapshot } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'

const snapshot: AppSnapshot = {
  aria2: {
    status: 'ready',
    version: 'test',
    binaryPath: null,
    message: null,
    hint: null
  },
  downloads: []
}

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

function fakeWindow(): FakeWindow {
  const frame = { url: 'app://dondownload/index.html' }
  const webContents = {
    mainFrame: frame,
    getURL: () => frame.url
  }
  return {
    window: { isDestroyed: () => false, webContents },
    frame,
    webContents
  }
}

function trustedEvent(window: FakeWindow): unknown {
  return { sender: window.webContents, senderFrame: window.frame }
}

function handler(channel: string): InvokeHandler {
  const found = handlers.get(channel)
  if (!found) throw new Error(`No handler for ${channel}`)
  return found
}

beforeEach(() => {
  handlers.clear()
})

describe('download control IPC', () => {
  it('routes Start Now through the trusted manager method', async () => {
    const startNow = vi.fn(async () => snapshot)
    const manager = { startNow } as unknown as DownloadManager
    const window = fakeWindow()
    registerIpc({
      manager,
      aria2: {} as Aria2Service,
      getWindow: () => window.window as never
    })
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

    const result = await handler(IPC.startDownloadNow)(trustedEvent(window), id)

    expect(result).toEqual({ ok: true, value: snapshot })
    expect(startNow).toHaveBeenCalledWith(id)
  })

  it('rejects Start Now from an untrusted sender', async () => {
    const startNow = vi.fn(async () => snapshot)
    const manager = { startNow } as unknown as DownloadManager
    const window = fakeWindow()
    registerIpc({
      manager,
      aria2: {} as Aria2Service,
      getWindow: () => window.window as never
    })

    const result = await handler(IPC.startDownloadNow)(
      { sender: {}, senderFrame: window.frame },
      'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(startNow).not.toHaveBeenCalled()
  })
})
