import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The real tray host, with a stand-in Electron `Tray`/`Menu`. The point of
 * these tests is resource use: with nothing downloading the tray must own no
 * timer at all, the menu must only be built when it is about to open, and the
 * tooltip must be limited to one throttled timer while downloads are active.
 */
const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class FakeTray {
    static last: FakeTray | null = null
    readonly listeners = new Map<string, Listener[]>()
    readonly tooltips: string[] = []
    setContextMenuCalls = 0
    readonly popUps: unknown[] = []
    destroyed = false
    constructor() {
      FakeTray.last = this
    }
    on(event: string, listener: Listener): this {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      return this
    }
    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener()
    }
    setToolTip(text: string): void {
      this.tooltips.push(text)
    }
    setContextMenu(): void {
      this.setContextMenuCalls += 1
    }
    popUpContextMenu(menu: unknown): void {
      this.popUps.push(menu)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  const menu = {
    buildFromTemplate: vi.fn((template: unknown[]) => ({ template }))
  }
  return { FakeTray, menu }
})

vi.mock('electron', () => ({
  Tray: electron.FakeTray,
  Menu: electron.menu,
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false })
  }
}))

vi.mock('../src/main/assets/tray.ico?asset', () => ({ default: 'tray.ico' }))
vi.mock('../src/main/logging', () => ({ logError: vi.fn() }))

import {
  TRAY_TOOLTIP_INTERVAL_MS,
  type TrayDownloadLike
} from '../src/main/trayMenu'
import { createAppTray, type TrayActions } from '../src/main/tray'

function active(speedBps = 1_000_000): TrayDownloadLike {
  return {
    id: 'dl-1',
    filename: 'movie.mp4',
    status: 'active',
    filePath: null,
    speedBps,
    totalBytes: 100,
    completedBytes: 42,
    createdAt: 1_000,
    completedAt: null
  }
}

function createActions(
  overrides: Partial<TrayActions> = {}
): TrayActions & { downloads: { value: TrayDownloadLike[] } } {
  const downloads = { value: [] as TrayDownloadLike[] }
  const actions: TrayActions = {
    showWindow: vi.fn(),
    hideWindow: vi.fn(),
    openSettings: vi.fn(),
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    setSpeedLimitBps: vi.fn(),
    openDownload: vi.fn(),
    showDownloadInFolder: vi.fn(),
    addFromClipboard: vi.fn(),
    quit: vi.fn(),
    isWindowVisible: () => false,
    getSpeedLimitBps: () => 0,
    getDownloads: () => downloads.value,
    getMediaJobs: () => [],
    readClipboardText: () => '',
    ...overrides
  }
  return Object.assign(actions, { downloads })
}

function lastTemplate(): { label?: string; enabled?: boolean }[] {
  const built = electron.menu.buildFromTemplate.mock.calls.at(-1)?.[0]
  return (built ?? []) as { label?: string; enabled?: boolean }[]
}

beforeEach(() => {
  vi.useFakeTimers()
  electron.menu.buildFromTemplate.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tray host resource use', () => {
  it('builds nothing at startup and owns no timer while idle', () => {
    const actions = createActions()
    const tray = createAppTray(actions)
    expect(tray).not.toBeNull()
    const fake = electron.FakeTray.last!
    expect(electron.menu.buildFromTemplate).not.toHaveBeenCalled()
    // No installed menu: Windows cannot open a stale one by itself.
    expect(fake.setContextMenuCalls).toBe(0)

    tray?.onDownloadStateChanged()
    tray?.refresh()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(electron.menu.buildFromTemplate).not.toHaveBeenCalled()
    tray?.destroy()
  })

  it('runs exactly one tooltip timer while active and stops it at the end', () => {
    const actions = createActions()
    actions.downloads.value = [active()]
    const tray = createAppTray(actions)
    const fake = electron.FakeTray.last!
    tray?.onDownloadStateChanged()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(TRAY_TOOLTIP_INTERVAL_MS)
    expect(fake.tooltips).toContain('DonDownload · 1 downloading · 42%')

    // Repeated progress ticks never stack timers.
    for (let index = 0; index < 5; index += 1) {
      actions.downloads.value = [active(1_000_000 + index)]
      tray?.onDownloadStateChanged()
      expect(vi.getTimerCount()).toBe(1)
    }

    actions.downloads.value = [
      { ...active(), status: 'complete', filePath: 'C:\\movie.mp4' }
    ]
    tray?.onDownloadStateChanged()
    vi.advanceTimersByTime(TRAY_TOOLTIP_INTERVAL_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(fake.tooltips.at(-1)).toBe('DonDownload')
    tray?.destroy()
  })

  it('never builds the menu per progress tick', () => {
    const actions = createActions()
    actions.downloads.value = [active()]
    const tray = createAppTray(actions)
    for (let index = 0; index < 20; index += 1) {
      vi.advanceTimersByTime(250)
      actions.downloads.value = [active(1_000_000 + index)]
      tray?.onDownloadStateChanged()
      tray?.refresh()
    }
    expect(electron.menu.buildFromTemplate).not.toHaveBeenCalled()
    tray?.destroy()
  })

  it('builds a fresh menu when it opens, reading the clipboard just then', () => {
    const readClipboardText = vi.fn(() => 'https://example.com/a.zip')
    const actions = createActions({ readClipboardText })
    const tray = createAppTray(actions)
    const fake = electron.FakeTray.last!
    // Nothing is read until the user opens the menu.
    expect(readClipboardText).not.toHaveBeenCalled()

    fake.emit('right-click')
    expect(electron.menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(fake.popUps).toHaveLength(1)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    const add = lastTemplate().find((item) => item.label === 'Add from clipboard')
    expect(add?.enabled).toBe(true)

    // A second open reads the clipboard again and builds again.
    readClipboardText.mockReturnValue('')
    fake.emit('right-click')
    expect(electron.menu.buildFromTemplate).toHaveBeenCalledTimes(2)
    expect(
      lastTemplate().find((item) => item.label === 'Add from clipboard')?.enabled
    ).toBe(false)
    tray?.destroy()
  })

  it('a locked clipboard read only disables the item', () => {
    const actions = createActions({
      readClipboardText: () => {
        throw new Error('clipboard busy')
      }
    })
    const tray = createAppTray(actions)
    const fake = electron.FakeTray.last!
    expect(() => fake.emit('right-click')).not.toThrow()
    expect(
      lastTemplate().find((item) => item.label === 'Add from clipboard')?.enabled
    ).toBe(false)
    tray?.destroy()
  })

  it('a click restores the window and opens nothing', () => {
    const actions = createActions()
    const tray = createAppTray(actions)
    const fake = electron.FakeTray.last!
    fake.emit('click')
    fake.emit('double-click')
    expect(actions.showWindow).toHaveBeenCalledTimes(2)
    expect(fake.popUps).toHaveLength(0)
    tray?.destroy()
  })

  it('destroy stops every timer and the icon', () => {
    const actions = createActions()
    actions.downloads.value = [active()]
    const tray = createAppTray(actions)
    tray?.onDownloadStateChanged()
    expect(vi.getTimerCount()).toBe(1)
    tray?.destroy()
    expect(vi.getTimerCount()).toBe(0)
    expect(electron.FakeTray.last?.destroyed).toBe(true)
  })
})
