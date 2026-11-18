import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>

const { handlers, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  openPath: vi.fn(async () => '')
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }
  },
  shell: { showItemInFolder: vi.fn(), openPath }
}))

import { IPC } from '../src/shared/ipc'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'

const DIAGNOSTICS_CHANNELS = [IPC.openLogFolder, IPC.copyDiagnostics] as const

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

function register(overrides: {
  openLogFolder?: () => Promise<string>
  buildDiagnostics?: () => string | Promise<string>
  window?: FakeWindow
} = {}): FakeWindow {
  const fakeWindow = overrides.window ?? createWindow()
  registerIpc({
    manager: {} as DownloadManager,
    aria2: {} as Aria2Service,
    openLogFolder: overrides.openLogFolder,
    buildDiagnostics: overrides.buildDiagnostics,
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
  return { sender: fakeWindow.webContents, senderFrame: fakeWindow.frame }
}

function untrustedEvent(fakeWindow: FakeWindow): unknown {
  return {
    sender: fakeWindow.webContents,
    senderFrame: { url: 'https://attacker.example/' }
  }
}

beforeEach(() => {
  handlers.clear()
  openPath.mockReset()
  openPath.mockResolvedValue('')
})

describe('diagnostics IPC registration', () => {
  it('registers both channels without replacing existing ones', () => {
    register()
    for (const channel of DIAGNOSTICS_CHANNELS) {
      expect(handlers.has(channel)).toBe(true)
    }
    expect(handlers.has(IPC.getSnapshot)).toBe(true)
    expect(handlers.has(IPC.scanMarkAsVideo)).toBe(true)
  })
})

describe('diagnostics IPC security', () => {
  it('rejects an untrusted sender on both channels', async () => {
    const openLogFolder = vi.fn(async () => 'C:\\Users\\Ada\\AppData\\Roaming\\dondownload\\logs')
    const buildDiagnostics = vi.fn(() => 'diagnostics')
    const fakeWindow = register({ openLogFolder, buildDiagnostics })
    const event = untrustedEvent(fakeWindow)

    for (const channel of DIAGNOSTICS_CHANNELS) {
      const result = await handler(channel)(event)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    }
    expect(openLogFolder).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
    expect(buildDiagnostics).not.toHaveBeenCalled()
  })

  it('ignores any renderer-supplied path or text argument', async () => {
    const openLogFolder = vi.fn(async () => 'C:\\logs')
    const buildDiagnostics = vi.fn(() => 'safe block')
    const fakeWindow = register({ openLogFolder, buildDiagnostics })
    const event = trustedEvent(fakeWindow)

    await handler(IPC.openLogFolder)(event, 'C:\\Users\\Ada\\Documents')
    await handler(IPC.copyDiagnostics)(event, 'https://example.com/private')

    expect(openPath).toHaveBeenCalledWith('C:\\logs')
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(buildDiagnostics).toHaveBeenCalledWith()
    expect(buildDiagnostics.mock.calls[0]).toHaveLength(0)
  })
})

describe('diagnostics IPC results', () => {
  it('opens the app-owned log folder', async () => {
    const folder = 'C:\\Users\\Ada\\AppData\\Roaming\\dondownload\\logs'
    const fakeWindow = register({ openLogFolder: async () => folder })

    const result = await handler(IPC.openLogFolder)(trustedEvent(fakeWindow))

    expect(result).toEqual({ ok: true, value: null })
    expect(openPath).toHaveBeenCalledWith(folder)
  })

  it('reports a safe error when the folder cannot be opened', async () => {
    openPath.mockResolvedValue('Access is denied.')
    const fakeWindow = register({ openLogFolder: async () => 'C:\\logs' })

    const result = await handler(IPC.openLogFolder)(trustedEvent(fakeWindow))

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('LOG_FOLDER_UNAVAILABLE')
    expect(result.error?.message).toBe('The log folder could not be opened.')
  })

  it('returns the diagnostics block as text', async () => {
    const block = 'DonDownload diagnostics\nApp version: 1.0.0'
    const fakeWindow = register({ buildDiagnostics: () => block })

    const result = await handler(IPC.copyDiagnostics)(trustedEvent(fakeWindow))
    expect(result).toEqual({ ok: true, value: block })
  })

  it('reports a safe error when diagnostics are not wired', async () => {
    const fakeWindow = register()

    for (const channel of DIAGNOSTICS_CHANNELS) {
      const result = await handler(channel)(trustedEvent(fakeWindow))
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('DIAGNOSTICS_UNAVAILABLE')
    }
  })

  it('turns a builder failure into a safe error result', async () => {
    const fakeWindow = register({
      buildDiagnostics: () => {
        throw new Error('C:\\Users\\Ada\\secret.txt could not be read')
      }
    })

    const result = await handler(IPC.copyDiagnostics)(trustedEvent(fakeWindow))

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBeDefined()
  })
})
