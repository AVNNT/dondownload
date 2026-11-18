import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}>

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

describe('duplicate check IPC', () => {
  it('normalizes the URL and routes it to the manager', async () => {
    const warning = {
      kind: 'download' as const,
      state: 'finished' as const,
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      filename: 'sample.zip',
      date: 1_800_000_000_000,
      fileExists: true
    }
    const checkDuplicate = vi.fn(async () => warning)
    const manager = { checkDuplicate } as unknown as DownloadManager
    const window = fakeWindow()
    registerIpc({
      manager,
      aria2: {} as Aria2Service,
      getWindow: () => window.window as never
    })

    const result = await handler(IPC.checkDuplicate)(
      trustedEvent(window),
      'HTTPS://Example.com:443/files/sample.zip#fragment'
    )

    expect(result).toEqual({ ok: true, value: warning })
    expect(checkDuplicate).toHaveBeenCalledWith(
      'https://example.com/files/sample.zip'
    )
  })

  it.each([42, null, '', 'not a url', 'ftp://example.com/file.zip'])(
    'rejects invalid input %s before the manager is called',
    async (input) => {
      const checkDuplicate = vi.fn()
      const manager = { checkDuplicate } as unknown as DownloadManager
      const window = fakeWindow()
      registerIpc({
        manager,
        aria2: {} as Aria2Service,
        getWindow: () => window.window as never
      })

      const result = await handler(IPC.checkDuplicate)(
        trustedEvent(window),
        input
      )

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('INVALID_INPUT')
      expect(checkDuplicate).not.toHaveBeenCalled()
    }
  )

  it('rejects an untrusted sender', async () => {
    const checkDuplicate = vi.fn()
    const manager = { checkDuplicate } as unknown as DownloadManager
    const window = fakeWindow()
    registerIpc({
      manager,
      aria2: {} as Aria2Service,
      getWindow: () => window.window as never
    })

    const result = await handler(IPC.checkDuplicate)(
      { sender: {}, senderFrame: {} },
      'https://example.com/file.zip'
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(checkDuplicate).not.toHaveBeenCalled()
  })
})
