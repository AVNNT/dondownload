import { describe, expect, it, vi } from 'vitest'
import {
  SPEED_LIMIT_PRESETS,
  formatSpeedLimitBps,
  isSpeedLimitPreset,
  speedLimitMenuLabel,
  speedLimitPreset
} from '../src/shared/speedLimits'
import { defaultDownloadSettings, type DownloadSettings } from '../src/shared/settings'
import { buildSpeedLimitSubmenu } from '../src/main/trayMenu'
import {
  SettingsManager,
  type SettingsAria2Gateway,
  type SettingsStore
} from '../src/main/settings/manager'

function createStore(initial = defaultDownloadSettings()) {
  let stored = initial
  return {
    loadSettings: vi.fn(() => stored),
    saveSettings: vi.fn((next: DownloadSettings) => {
      stored = next
    })
  }
}

function createClient() {
  return { call: vi.fn(async () => 'OK') }
}

describe('quick speed-limit presets', () => {
  it('defines the six menu presets with stable labels and byte values', () => {
    expect(SPEED_LIMIT_PRESETS).toEqual([
      { bps: 0, label: 'Unlimited' },
      { bps: 512_000, label: '512 KB/s' },
      { bps: 1_000_000, label: '1 MB/s' },
      { bps: 2_000_000, label: '2 MB/s' },
      { bps: 5_000_000, label: '5 MB/s' },
      { bps: 10_000_000, label: '10 MB/s' }
    ])
  })

  it('formats preset, custom and unlimited values', () => {
    expect(formatSpeedLimitBps(0)).toBe('Unlimited')
    expect(formatSpeedLimitBps(1_000_000)).toBe('1 MB/s')
    expect(formatSpeedLimitBps(512_000)).toBe('512 KB/s')
    expect(formatSpeedLimitBps(1_500_000)).toBe('1.5 MB/s')
    expect(formatSpeedLimitBps(400_000)).toBe('400 KB/s')
    expect(speedLimitMenuLabel(3_000_000)).toBe('Custom (3 MB/s)')
    expect(speedLimitMenuLabel(1_000_000)).toBe('1 MB/s')
  })

  it('recognises only exact preset values', () => {
    expect(speedLimitPreset(0)?.label).toBe('Unlimited')
    expect(isSpeedLimitPreset(1_000_000)).toBe(true)
    expect(isSpeedLimitPreset(1_500_000)).toBe(false)
  })
})

describe('tray speed-limit submenu', () => {
  const checkedLabels = (
    items: ReturnType<typeof buildSpeedLimitSubmenu>
  ): string[] =>
    items
      .filter((item) => item.checked === true)
      .map((item) => String(item.label))

  it('checks Unlimited when the current limit is zero', () => {
    const items = buildSpeedLimitSubmenu(0, vi.fn())
    expect(items).toHaveLength(SPEED_LIMIT_PRESETS.length)
    expect(checkedLabels(items)).toEqual(['Unlimited'])
  })

  it('checks exactly one preset when the current limit matches it', () => {
    const items = buildSpeedLimitSubmenu(1_000_000, vi.fn())
    expect(items).toHaveLength(SPEED_LIMIT_PRESETS.length)
    expect(checkedLabels(items)).toEqual(['1 MB/s'])
  })

  it('adds a checked Custom item for any other value', () => {
    const items = buildSpeedLimitSubmenu(1_500_000, vi.fn())
    expect(items).toHaveLength(SPEED_LIMIT_PRESETS.length + 1)
    expect(checkedLabels(items)).toEqual(['Custom (1.5 MB/s)'])
    expect(items[items.length - 1]).toMatchObject({
      label: 'Custom (1.5 MB/s)',
      type: 'radio',
      checked: true,
      enabled: false
    })
  })

  it('applies a clicked preset through the settings manager', async () => {
    const onSelect = vi.fn()
    const items = buildSpeedLimitSubmenu(0, onSelect)
    const oneMegabyte = items.find(
      (item) => item.label === '1 MB/s'
    ) as { click?: () => void }
    oneMegabyte.click?.()
    expect(onSelect).toHaveBeenCalledWith(1_000_000)

    // The tray callback ends in `setGlobalSpeedLimit`, which must reuse the
    // existing validated update path (live aria2 apply, then persistence).
    const store = createStore()
    const client = createClient()
    const manager = new SettingsManager({
      store: store as SettingsStore,
      aria2: { getReadyClient: () => client } as SettingsAria2Gateway
    })
    const updated = await manager.setGlobalSpeedLimit(1_000_000)

    expect(updated.globalSpeedLimitBps).toBe(1_000_000)
    expect(store.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ globalSpeedLimitBps: 1_000_000 })
    )
    expect(client.call).toHaveBeenCalledWith('aria2.changeGlobalOption', [
      {
        'max-concurrent-downloads': String(
          defaultDownloadSettings().maxConcurrentDownloads
        ),
        'max-connection-per-server': String(
          defaultDownloadSettings().perHostConnections
        ),
        'max-overall-download-limit': '1000000'
      }
    ])
  })
})
