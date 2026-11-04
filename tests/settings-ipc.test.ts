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
import {
  defaultDownloadSettings,
  type DownloadSettings
} from '../src/shared/settings'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'
import type { SettingsManager } from '../src/main/settings/manager'
import { ValidationError } from '../src/shared/validation'

const SETTINGS_CHANNELS = [IPC.getSettings, IPC.updateSettings]

function settings(
  overrides: Partial<DownloadSettings> = {}
): DownloadSettings {
  return { ...defaultDownloadSettings(), ...overrides }
}

function createSettingsManager() {
  let current = defaultDownloadSettings()
  return {
    getSettings: vi.fn(() => current),
    update: vi.fn(async (input: unknown) => {
      current = input as DownloadSettings
      return current
    })
  }
}

type FakeSettingsManager = ReturnType<typeof createSettingsManager>

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
  settingsManager?: FakeSettingsManager,
  windowOverride?: FakeWindow
) {
  const fakeWindow = windowOverride ?? createWindow()
  const context = {
    manager: {} as DownloadManager,
    aria2: {} as Aria2Service,
    settings: settingsManager as unknown as SettingsManager | undefined,
    getWindow: () => fakeWindow.window as never
  }
  registerIpc(context)
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

describe('settings IPC registration', () => {
  it('adds both settings channels without replacing existing channels', () => {
    register(createSettingsManager())

    for (const channel of SETTINGS_CHANNELS) {
      expect(handlers.has(channel)).toBe(true)
    }
    expect(handlers.has(IPC.getSnapshot)).toBe(true)
    expect(handlers.has(IPC.addDownload)).toBe(true)
    expect(handlers.has(IPC.getBatchSnapshot)).toBe(true)
  })

  it('returns a safe error when the settings manager is not wired', async () => {
    const fakeWindow = register(undefined)

    for (const channel of SETTINGS_CHANNELS) {
      const result = await handler(channel)(
        trustedEvent(fakeWindow),
        defaultDownloadSettings()
      )
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('SETTINGS_UNAVAILABLE')
    }
  })
})

describe('settings IPC security and results', () => {
  it('routes trusted get and exact-key update calls to the manager', async () => {
    const settingsManager = createSettingsManager()
    const fakeWindow = register(settingsManager)
    const event = trustedEvent(fakeWindow)

    const loaded = await handler(IPC.getSettings)(event)
    expect(loaded).toEqual({
      ok: true,
      value: defaultDownloadSettings()
    })

    const next = settings({
      maxConcurrentDownloads: 8,
      perHostConnections: 6,
      globalSpeedLimitBps: 2048,
      allowedHours: { enabled: true, start: '22:00', end: '06:00' }
    })
    const updated = await handler(IPC.updateSettings)(event, next)
    expect(updated).toEqual({ ok: true, value: next })
    expect(settingsManager.update).toHaveBeenCalledWith(next)

    const reloaded = await handler(IPC.getSettings)(event)
    expect(reloaded).toEqual({ ok: true, value: next })
  })

  it('returns the manager validation failure without persisting', async () => {
    const settingsManager = createSettingsManager()
    settingsManager.update.mockRejectedValueOnce(
      new ValidationError('unsupported fields')
    )
    const fakeWindow = register(settingsManager)

    const result = await handler(IPC.updateSettings)(
      trustedEvent(fakeWindow),
      { ...defaultDownloadSettings(), extra: true }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_INPUT')
  })

  it('rejects a sender that is not the application window', async () => {
    const settingsManager = createSettingsManager()
    const fakeWindow = register(settingsManager)

    const result = await handler(IPC.updateSettings)(
      { sender: {}, senderFrame: fakeWindow.frame },
      settings({ maxConcurrentDownloads: 4 })
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(settingsManager.update).not.toHaveBeenCalled()
  })

  it('rejects a sub-frame even when it shares the top-frame URL', async () => {
    const settingsManager = createSettingsManager()
    const fakeWindow = register(settingsManager)

    const result = await handler(IPC.getSettings)({
      sender: fakeWindow.webContents,
      senderFrame: { url: fakeWindow.frame.url }
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(settingsManager.getSettings).not.toHaveBeenCalled()
  })
})
