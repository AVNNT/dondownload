import { describe, expect, it, vi } from 'vitest'
import {
  defaultDownloadSettings,
  type DownloadSettings
} from '../src/shared/settings'
import {
  SettingsManager,
  toAria2GlobalOptions,
  type SettingsAria2Client,
  type SettingsAria2Gateway,
  type SettingsStore
} from '../src/main/settings/manager'

function settings(
  overrides: Partial<DownloadSettings> = {}
): DownloadSettings {
  return { ...defaultDownloadSettings(), ...overrides }
}

function createStore(initial = defaultDownloadSettings()) {
  let stored = initial
  return {
    loadSettings: vi.fn(() => stored),
    saveSettings: vi.fn((next: DownloadSettings) => {
      stored = next
    }),
    get stored() {
      return stored
    }
  }
}

function createClient() {
  return {
    call: vi.fn(
      async (_method: string, _params?: unknown[]): Promise<unknown> => 'OK'
    )
  }
}

function createAria2(client: SettingsAria2Client | null) {
  return { getReadyClient: vi.fn(() => client) }
}

describe('SettingsManager', () => {
  it('loads persisted settings and returns an independent copy', () => {
    const persisted = settings({
      maxConcurrentDownloads: 7,
      perHostConnections: 12,
      globalSpeedLimitBps: 2048
    })
    const store = createStore(persisted)
    const manager = new SettingsManager({
      store: store as SettingsStore,
      aria2: null
    })

    const result = manager.getSettings()
    expect(result).toEqual(persisted)
    expect(result).not.toBe(persisted)
    expect(result.allowedHours).not.toBe(persisted.allowedHours)
    result.allowedHours.start = '08:00'
    expect(manager.getSettings().allowedHours.start).toBe('00:00')
  })

  it('uses defaults when storage is unavailable and rejects updates', async () => {
    const manager = new SettingsManager({ store: null, aria2: null })

    expect(manager.getSettings()).toEqual(defaultDownloadSettings())
    await expect(manager.update(defaultDownloadSettings())).rejects.toMatchObject(
      { code: 'SETTINGS_UNAVAILABLE' }
    )
  })

  it('falls back to defaults when the store cannot load settings', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = {
      loadSettings: vi.fn(() => {
        throw new Error('corrupt settings row')
      }),
      saveSettings: vi.fn()
    }
    const manager = new SettingsManager({ store, aria2: null })

    expect(manager.getSettings()).toEqual(defaultDownloadSettings())
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain(
      'Download settings could not be loaded'
    )
    error.mockRestore()
  })

  it('validates the complete exact-key object before persistence or aria2', async () => {
    const store = createStore()
    const client = createClient()
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway
    })

    const invalidInputs = [
      { ...defaultDownloadSettings(), extra: true },
      { ...defaultDownloadSettings(), maxConcurrentDownloads: 0 },
      {
        ...defaultDownloadSettings(),
        allowedHours: { enabled: false, start: '9:00', end: '00:00' }
      }
    ]

    for (const input of invalidInputs) {
      await expect(manager.update(input)).rejects.toBeInstanceOf(Error)
    }
    expect(store.saveSettings).not.toHaveBeenCalled()
    expect(client.call).not.toHaveBeenCalled()
    expect(manager.getSettings()).toEqual(defaultDownloadSettings())
  })

  it('persists without touching aria2 while the engine is not ready', async () => {
    const store = createStore()
    const aria2 = createAria2(null)
    const manager = new SettingsManager({
      store,
      aria2: aria2 as SettingsAria2Gateway
    })
    const next = settings({ maxConcurrentDownloads: 9 })

    await expect(manager.update(next)).resolves.toEqual(next)
    expect(store.saveSettings).toHaveBeenCalledWith(next)
    expect(aria2.getReadyClient).toHaveBeenCalled()
  })

  it('applies aria2 options before persisting when the engine is ready', async () => {
    const order: string[] = []
    const store = createStore()
    store.saveSettings.mockImplementation((next: DownloadSettings) => {
      order.push('save')
      void next
    })
    const client = {
      call: vi.fn(async () => {
        order.push('apply')
        return 'OK'
      })
    }
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway
    })
    const next = settings({
      maxConcurrentDownloads: 6,
      perHostConnections: 2,
      globalSpeedLimitBps: 1024
    })

    await expect(manager.update(next)).resolves.toEqual(next)
    expect(client.call).toHaveBeenCalledWith('aria2.changeGlobalOption', [
      {
        'max-concurrent-downloads': '6',
        'max-connection-per-server': '2',
        'max-overall-download-limit': '1024'
      }
    ])
    expect(order).toEqual(['apply', 'save'])
    expect(manager.getSettings()).toEqual(next)
  })

  it('rolls aria2 back and keeps state when a live apply fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createStore()
    const previous = store.stored
    const client = {
      call: vi
        .fn<SettingsAria2Client['call']>()
        .mockRejectedValueOnce(new Error('rejected'))
        .mockResolvedValueOnce('OK')
    }
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway
    })
    const next = settings({ maxConcurrentDownloads: 10 })

    await expect(manager.update(next)).rejects.toMatchObject({
      code: 'SETTINGS_APPLY_FAILED'
    })
    expect(store.saveSettings).not.toHaveBeenCalled()
    expect(manager.getSettings()).toEqual(previous)
    expect(client.call).toHaveBeenCalledTimes(2)
    expect(client.call.mock.calls[1]?.[1]).toEqual([
      toAria2GlobalOptions(previous)
    ])
    error.mockRestore()
  })

  it('rolls aria2 back when persistence fails after a live apply', async () => {
    const store = createStore()
    const previous = store.stored
    store.saveSettings.mockImplementation(() => {
      throw new Error('disk full')
    })
    const client = createClient()
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway
    })

    await expect(
      manager.update(settings({ maxConcurrentDownloads: 5 }))
    ).rejects.toThrow('disk full')
    expect(client.call).toHaveBeenCalledTimes(2)
    expect(client.call.mock.calls[1]?.[1]).toEqual([
      toAria2GlobalOptions(previous)
    ])
    expect(manager.getSettings()).toEqual(previous)
  })

  it('persists an appearance-only change without touching aria2', async () => {
    const store = createStore()
    const client = createClient()
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway
    })
    const next = settings({ theme: 'light' })

    await expect(manager.update(next)).resolves.toEqual(next)
    expect(store.saveSettings).toHaveBeenCalledWith(next)
    expect(client.call).not.toHaveBeenCalled()
    expect(manager.getSettings().theme).toBe('light')
  })

  it('applies the loaded snapshot before aria2 reports ready', async () => {
    const persisted = settings({
      maxConcurrentDownloads: 11,
      perHostConnections: 3,
      globalSpeedLimitBps: 4096
    })
    const client = createClient()
    const manager = new SettingsManager({
      store: createStore(persisted),
      aria2: null
    })

    await manager.applyStartup(client)

    expect(client.call).toHaveBeenCalledWith('aria2.changeGlobalOption', [
      {
        'max-concurrent-downloads': '11',
        'max-connection-per-server': '3',
        'max-overall-download-limit': '4096'
      }
    ])
  })

  it('serializes concurrent updates and merges a speed-only change with the latest row', async () => {
    const store = createStore()
    let release!: () => void
    const firstApply = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const client = {
      call: vi.fn(
        async (_method: string, _params?: unknown[]): Promise<unknown> => {
          calls.push('apply')
          if (calls.length === 1) await firstApply
          return 'OK'
        }
      )
    }
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway
    })

    const concurrency = manager.update(
      settings({ maxConcurrentDownloads: 4 })
    )
    // Built from the pre-update row if it is not merged inside the queue.
    const speed = manager.setGlobalSpeedLimit(2_500_000)
    release()
    await Promise.all([concurrency, speed])

    expect(manager.getSettings()).toMatchObject({
      maxConcurrentDownloads: 4,
      globalSpeedLimitBps: 2_500_000
    })
    expect(calls).toHaveLength(2)
    expect(client.call.mock.calls[1]?.[1]).toEqual([
      {
        'max-concurrent-downloads': '4',
        'max-connection-per-server': String(
          defaultDownloadSettings().perHostConnections
        ),
        'max-overall-download-limit': '2500000'
      }
    ])
  })

  it('notifies the policy listener only after a successful update', async () => {
    const store = createStore()
    const onChanged = vi.fn()
    const client = createClient()
    const manager = new SettingsManager({
      store,
      aria2: createAria2(client) as SettingsAria2Gateway,
      onChanged
    })
    const next = settings({
      allowedHours: { enabled: true, start: '22:00', end: '06:00' }
    })

    await manager.update(next)
    expect(onChanged).toHaveBeenCalledWith(next)

    onChanged.mockClear()
    await expect(
      manager.update({ ...next, allowedHours: { enabled: true, start: '24:00', end: '06:00' } })
    ).rejects.toThrow()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
