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
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'

function fakeWindow(): {
  window: {
    isDestroyed: () => boolean
    webContents: { mainFrame: { url: string }; getURL: () => string }
  }
  frame: { url: string }
  webContents: { mainFrame: { url: string }; getURL: () => string }
} {
  const frame = { url: 'app://dondownload/index.html' }
  const webContents = { mainFrame: frame, getURL: () => frame.url }
  return {
    window: { isDestroyed: () => false, webContents },
    frame,
    webContents
  }
}

function trustedEvent(window: ReturnType<typeof fakeWindow>): unknown {
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

describe('add-download IPC resolved URL trust boundary', () => {
  it('drops a renderer-supplied resolvedUrl before the manager sees it', async () => {
    const add = vi.fn(async (_input: Record<string, unknown>) => ({
      revision: 1
    }))
    const manager = { add } as unknown as DownloadManager
    const window = fakeWindow()
    registerIpc({
      manager,
      aria2: {} as Aria2Service,
      getWindow: () => window.window as never
    })

    const result = await handler(IPC.addDownload)(trustedEvent(window), {
      url: 'https://forum.example/uploads/short-url/XXXX.funscript',
      requestHeaders: { cookie: '_t=session' },
      // A signer/oracle target the page must not be able to inject.
      resolvedUrl: 'http://169.254.169.254/latest/meta-data/'
    })

    expect(result.ok).toBe(true)
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith({
      url: 'https://forum.example/uploads/short-url/XXXX.funscript',
      requestHeaders: { cookie: '_t=session' }
    })
    expect(add.mock.calls[0]![0]).not.toHaveProperty('resolvedUrl')
  })

  it('keeps an input without resolvedUrl unchanged', async () => {
    const add = vi.fn(async () => ({ revision: 1 }))
    const manager = { add } as unknown as DownloadManager
    const window = fakeWindow()
    registerIpc({
      manager,
      aria2: {} as Aria2Service,
      getWindow: () => window.window as never
    })

    await handler(IPC.addDownload)(trustedEvent(window), {
      url: 'https://example.com/app.zip'
    })

    expect(add).toHaveBeenCalledWith({ url: 'https://example.com/app.zip' })
  })
})
