import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }))

import type { MenuItemConstructorOptions } from 'electron'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  TRAY_MENU_DEBOUNCE_MS,
  TRAY_NOTHING_DOWNLOADING,
  TRAY_RECENT_NAME_MAX,
  TrayMenuScheduler,
  buildRecentSubmenu,
  buildTrayMenuTemplate,
  canPauseAll,
  canResumeAll,
  clipboardUrlForMenu,
  hasActiveDownloads,
  isFinishedDownload,
  recentDownloads,
  summarizeDownloads,
  trayMenuSignature,
  trayStatusLine,
  trayTooltip,
  truncateTrayName,
  type TrayDownloadLike,
  type TrayMenuActions,
  type TrayMenuState
} from '../src/main/trayMenu'
import { defaultDownloadSettings } from '../src/shared/settings'
import type { Aria2State } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import { createTestHost } from './fakes/host'

function download(
  overrides: Partial<TrayDownloadLike> = {}
): TrayDownloadLike {
  return {
    id: 'dl-1',
    filename: 'movie.mp4',
    status: 'active',
    filePath: null,
    speedBps: 1_000_000,
    totalBytes: 100,
    completedBytes: 40,
    createdAt: 1_000,
    completedAt: null,
    ...overrides
  }
}

function actions(overrides: Partial<TrayMenuActions> = {}): TrayMenuActions {
  return {
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
    ...overrides
  }
}

function state(overrides: Partial<TrayMenuState> = {}): TrayMenuState {
  return {
    windowVisible: false,
    downloads: [],
    speedLimitBps: 0,
    clipboardUrl: null,
    ...overrides
  }
}

/** Labels of the top level, with separators written as "—". */
function topLabels(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) =>
    item.type === 'separator' ? '—' : String(item.label)
  )
}

function menuItem(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined {
  return template.find((entry) => entry.label === label)
}

function click(item: MenuItemConstructorOptions | undefined): void {
  ;(item as { click?: () => void } | undefined)?.click?.()
}

describe('tray status line', () => {
  it('sums active transfers and their measured speed', () => {
    const downloads = [
      download({ id: 'a', speedBps: 3_000_000 }),
      download({ id: 'b', speedBps: 1_200_000 }),
      download({ id: 'c', status: 'complete', filePath: 'C:\\x\\c.mp4' })
    ]
    expect(trayStatusLine(downloads)).toBe('2 downloading · 4.01 MB/s')
    expect(summarizeDownloads(downloads)).toMatchObject({
      active: 2,
      speedBps: 4_200_000
    })
  })

  it('says nothing downloading when only queued, paused or finished rows exist', () => {
    for (const status of ['queued', 'waiting', 'paused', 'complete', 'error']) {
      expect(trayStatusLine([download({ status })])).toBe(
        TRAY_NOTHING_DOWNLOADING
      )
    }
    expect(trayStatusLine([])).toBe(TRAY_NOTHING_DOWNLOADING)
  })

  it('omits the speed while the single active transfer reports none yet', () => {
    expect(trayStatusLine([download({ speedBps: 0 })])).toBe('1 downloading')
  })
})

describe('tray tooltip', () => {
  it('is null while nothing is downloading, so no tooltip timer is needed', () => {
    expect(trayTooltip([])).toBeNull()
    expect(trayTooltip([download({ status: 'paused' })])).toBeNull()
    expect(
      hasActiveDownloads([
        download({ status: 'waiting' }),
        download({ status: 'paused' })
      ])
    ).toBe(false)
  })

  it('shows count and aggregate percent while active', () => {
    expect(
      trayTooltip([
        download({ id: 'a', totalBytes: 100, completedBytes: 42 }),
        download({ id: 'b', totalBytes: 100, completedBytes: 42 }),
        download({ id: 'done', status: 'complete', completedBytes: 0 })
      ])
    ).toBe('DonDownload · 2 downloading · 42%')
  })

  it('drops the percent when no unfinished row has a known size', () => {
    expect(trayTooltip([download({ totalBytes: 0, completedBytes: 0 })])).toBe(
      'DonDownload · 1 downloading'
    )
  })
})

describe('tray menu template (state in, template out)', () => {
  it('lays the items out in the documented order', () => {
    const template = buildTrayMenuTemplate(
      state({
        downloads: [download()],
        clipboardUrl: 'https://example.com/file.zip'
      }),
      actions()
    )
    expect(topLabels(template)).toEqual([
      '1 downloading · 977 KB/s',
      'Show DonDownload',
      'Pause all',
      '—',
      'Speed limit',
      'Recent',
      '—',
      'Add from clipboard',
      '—',
      'Settings',
      'Quit DonDownload'
    ])
    expect(template[0]).toMatchObject({ enabled: false })
  })

  it('offers Resume all once only paused rows remain', () => {
    const downloads = [
      download({ id: 'a', status: 'paused' }),
      download({ id: 'b', status: 'complete', filePath: 'C:\\x\\b.mp4' })
    ]
    const template = buildTrayMenuTemplate(state({ downloads }), actions())
    expect(canPauseAll(state({ downloads }))).toBe(false)
    expect(canResumeAll(state({ downloads }))).toBe(true)
    expect(topLabels(template)[2]).toBe('Resume all')
    expect(template[2]?.enabled).toBe(true)
  })

  it('disables the pause/resume item when nothing can move', () => {
    const template = buildTrayMenuTemplate(
      state({
        downloads: [download({ status: 'complete', filePath: 'C:\\x' })]
      }),
      actions()
    )
    expect(topLabels(template)[2]).toBe('Resume all')
    expect(template[2]?.enabled).toBe(false)
  })

  it('shows Hide DonDownload while the window is visible', () => {
    const template = buildTrayMenuTemplate(
      state({ windowVisible: true }),
      actions()
    )
    expect(topLabels(template)[1]).toBe('Hide DonDownload')
  })

  it('invokes the matching action for a click, using the checked state', () => {
    const callbacks = actions()
    const paused = buildTrayMenuTemplate(
      state({
        windowVisible: true,
        downloads: [download({ status: 'paused' })]
      }),
      callbacks
    )
    click(menuItem(paused, 'Hide DonDownload'))
    expect(callbacks.hideWindow).toHaveBeenCalledTimes(1)
    expect(callbacks.showWindow).not.toHaveBeenCalled()
    click(menuItem(paused, 'Resume all'))
    expect(callbacks.resumeAll).toHaveBeenCalledTimes(1)
    expect(callbacks.pauseAll).not.toHaveBeenCalled()

    const active = buildTrayMenuTemplate(
      state({ downloads: [download()] }),
      callbacks
    )
    click(menuItem(active, 'Pause all'))
    expect(callbacks.pauseAll).toHaveBeenCalledTimes(1)
    click(menuItem(active, 'Settings'))
    expect(callbacks.openSettings).toHaveBeenCalledTimes(1)
    click(menuItem(active, 'Quit DonDownload'))
    expect(callbacks.quit).toHaveBeenCalledTimes(1)
  })

  it('enables Add from clipboard only for the URL captured at build time', () => {
    const callbacks = actions()
    const enabled = buildTrayMenuTemplate(
      state({ clipboardUrl: 'https://example.com/a.zip' }),
      callbacks
    )
    const item = menuItem(enabled, 'Add from clipboard')
    expect(item?.enabled).toBe(true)
    click(item)
    expect(callbacks.addFromClipboard).toHaveBeenCalledWith(
      'https://example.com/a.zip'
    )

    const disabled = buildTrayMenuTemplate(state(), callbacks)
    const off = menuItem(disabled, 'Add from clipboard')
    expect(off?.enabled).toBe(false)
    click(off)
    expect(callbacks.addFromClipboard).toHaveBeenCalledTimes(1)
  })

  it('reuses the shared speed-limit presets in a radio submenu', () => {
    const callbacks = actions()
    const template = buildTrayMenuTemplate(
      state({ speedLimitBps: 2_000_000 }),
      callbacks
    )
    const items = menuItem(template, 'Speed limit')
      ?.submenu as MenuItemConstructorOptions[]
    expect(items.map((entry) => entry.label)).toEqual([
      'Unlimited',
      '512 KB/s',
      '1 MB/s',
      '2 MB/s',
      '5 MB/s',
      '10 MB/s'
    ])
    expect(
      items.filter((entry) => entry.checked).map((entry) => entry.label)
    ).toEqual(['2 MB/s'])
    click(items.find((entry) => entry.label === '5 MB/s'))
    expect(callbacks.setSpeedLimitBps).toHaveBeenCalledWith(5_000_000)
  })

  it('treats media jobs like the toolbar pause/resume-all', () => {
    expect(
      canPauseAll(state({ mediaJobs: [{ id: 'm1', status: 'downloading' }] }))
    ).toBe(true)
    expect(
      canResumeAll(state({ mediaJobs: [{ id: 'm1', status: 'paused' }] }))
    ).toBe(true)
    expect(
      canPauseAll(state({ mediaJobs: [{ id: 'm1', status: 'complete' }] }))
    ).toBe(false)
  })
})

describe('tray Recent submenu', () => {
  it('keeps the newest five finished downloads in completion order', () => {
    const downloads = Array.from({ length: 8 }, (_, index) =>
      download({
        id: `dl-${index}`,
        filename: `file-${index}.mp4`,
        status: 'complete',
        filePath: `C:\\Downloads\\file-${index}.mp4`,
        completedAt: 2_000 + index * 10
      })
    )
    downloads.push(download({ id: 'active', status: 'active' }))
    expect(recentDownloads(downloads).map((item) => item.id)).toEqual([
      'dl-7',
      'dl-6',
      'dl-5',
      'dl-4',
      'dl-3'
    ])
  })

  it('skips finished rows whose file path is missing', () => {
    const downloads = [
      download({
        id: 'ok',
        status: 'complete',
        filePath: 'C:\\a.mp4',
        completedAt: 2_000
      }),
      download({
        id: 'gone',
        status: 'complete',
        filePath: null,
        completedAt: 3_000
      }),
      download({
        id: 'empty',
        status: 'complete',
        filePath: '',
        completedAt: 4_000
      }),
      download({ id: 'active', status: 'active', completedAt: null })
    ]
    expect(downloads.filter(isFinishedDownload).map((item) => item.id)).toEqual([
      'ok'
    ])
    expect(
      buildRecentSubmenu(downloads, actions()).map((entry) =>
        entry.type === 'separator' ? '—' : entry.label
      )
    ).toEqual(['movie.mp4', '—', 'Show in folder'])
  })

  it('truncates long names and ends with Show in folder for the newest', () => {
    const callbacks = actions()
    const longName = `${'a'.repeat(60)}.mkv`
    const items = buildRecentSubmenu(
      [
        download({
          id: 'newest',
          filename: longName,
          status: 'complete',
          filePath: 'C:\\newest.mkv',
          completedAt: 5_000
        }),
        download({
          id: 'older',
          filename: 'older.bin',
          status: 'complete',
          filePath: 'C:\\older.bin',
          completedAt: 4_000
        })
      ],
      callbacks
    )
    expect(items[0]?.label).toBe(truncateTrayName(longName))
    expect(String(items[0]?.label).length).toBe(TRAY_RECENT_NAME_MAX)
    expect(String(items[0]?.label).endsWith('…')).toBe(true)
    expect(items[1]?.label).toBe('older.bin')
    expect(items[2]?.type).toBe('separator')
    expect(items[3]?.label).toBe('Show in folder')

    click(items[0])
    click(items[3])
    // Only ids cross the boundary; main resolves and re-validates the path.
    expect(callbacks.openDownload).toHaveBeenCalledWith('newest')
    expect(callbacks.showDownloadInFolder).toHaveBeenCalledWith('newest')
  })

  it('is empty when nothing has finished', () => {
    expect(buildRecentSubmenu([download()], actions())).toEqual([])
  })
})

describe('clipboard URL check', () => {
  it('accepts exactly one ordinary http(s) URL', () => {
    expect(clipboardUrlForMenu('https://example.com/file.zip')).toBe(
      'https://example.com/file.zip'
    )
    expect(clipboardUrlForMenu('  http://example.com/a?b=1  ')).toBe(
      'http://example.com/a?b=1'
    )
  })

  it('rejects everything else, so the item stays disabled', () => {
    expect(clipboardUrlForMenu('')).toBeNull()
    expect(clipboardUrlForMenu('   ')).toBeNull()
    expect(clipboardUrlForMenu('not a url')).toBeNull()
    expect(clipboardUrlForMenu('https://a.com/x https://b.com/y')).toBeNull()
    expect(clipboardUrlForMenu('file:///C:/secret.txt')).toBeNull()
    expect(clipboardUrlForMenu('javascript:alert(1)')).toBeNull()
    expect(clipboardUrlForMenu('https://user:pass@example.com/x')).toBeNull()
    expect(
      clipboardUrlForMenu(`https://example.com/${'a'.repeat(2_100)}`)
    ).toBeNull()
    expect(clipboardUrlForMenu(null)).toBeNull()
  })

  it('answers from the fresh clipboard text each time it is asked', () => {
    // The watcher's dedupe state is irrelevant: the menu asks "is there a URL
    // right now?" whenever it is built, and the same link is still offerable.
    expect(clipboardUrlForMenu('https://example.com/same.zip')).toBe(
      'https://example.com/same.zip'
    )
    expect(clipboardUrlForMenu('https://example.com/same.zip')).toBe(
      'https://example.com/same.zip'
    )
  })
})

describe('lazy rebuild and debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A scheduler wired to one mutable "now" that fake timers advance too. */
  function createScheduler(): { build: ReturnType<typeof vi.fn>; tick: (ms: number) => void } {
    let now = 0
    const build = vi.fn()
    const scheduler = new TrayMenuScheduler(
      build,
      () => now,
      TRAY_MENU_DEBOUNCE_MS
    )
    const tick = (ms: number): void => {
      now += ms
      vi.advanceTimersByTime(ms)
    }
    ;(build as unknown as { scheduler: TrayMenuScheduler }).scheduler = scheduler
    return { build, tick }
  }

  it('a menu open builds at once and leaves no timer behind', () => {
    const { build } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    scheduler.requestNow()
    expect(build).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an unchanged signature never arms a timer', () => {
    const { build, tick } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    scheduler.observe('same')
    scheduler.onStateChanged('same')
    expect(vi.getTimerCount()).toBe(0)
    tick(TRAY_MENU_DEBOUNCE_MS * 3)
    expect(build).not.toHaveBeenCalled()
  })

  it('debounces a burst of progress changes into one rebuild', () => {
    const { build, tick } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    // Nothing was built yet, so the first change is installed at once...
    scheduler.onStateChanged('progress-1')
    expect(build).toHaveBeenCalledTimes(1)
    // ...and the rest of the burst waits for the single window.
    scheduler.onStateChanged('progress-2')
    scheduler.onStateChanged('progress-3')
    scheduler.onStateChanged('progress-4')
    expect(build).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    tick(TRAY_MENU_DEBOUNCE_MS)
    expect(build).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces ticks arriving every 200 ms into one build per window', () => {
    const { build, tick } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    scheduler.requestNow()
    expect(build).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 10; index += 1) {
      tick(200)
      scheduler.onStateChanged(`progress-${index}`)
    }
    // 2 s of ticks at most one build inside the first window.
    expect(build).toHaveBeenCalledTimes(1)
    tick(TRAY_MENU_DEBOUNCE_MS)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('never builds more often than the debounce window', () => {
    const { build, tick } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    scheduler.requestNow()
    scheduler.onStateChanged('b')
    expect(build).toHaveBeenCalledTimes(1)
    tick(TRAY_MENU_DEBOUNCE_MS - 1)
    scheduler.onStateChanged('c')
    expect(build).toHaveBeenCalledTimes(1)
    tick(1)
    expect(build).toHaveBeenCalledTimes(2)
    // Still inside the same window: a third change waits again.
    scheduler.onStateChanged('d')
    tick(TRAY_MENU_DEBOUNCE_MS - 1)
    expect(build).toHaveBeenCalledTimes(2)
    tick(1)
    expect(build).toHaveBeenCalledTimes(3)
  })

  it('a menu open cancels the pending rebuild instead of stacking one', () => {
    const { build, tick } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    scheduler.requestNow()
    scheduler.onStateChanged('b')
    expect(vi.getTimerCount()).toBe(1)
    scheduler.requestNow()
    expect(build).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    tick(TRAY_MENU_DEBOUNCE_MS * 2)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('dispose clears a pending rebuild', () => {
    const { build, tick } = createScheduler()
    const scheduler = (build as unknown as { scheduler: TrayMenuScheduler })
      .scheduler
    scheduler.requestNow()
    scheduler.onStateChanged('b')
    scheduler.dispose()
    expect(vi.getTimerCount()).toBe(0)
    tick(TRAY_MENU_DEBOUNCE_MS * 2)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('ignores a pure progress tick that changes no menu text', () => {
    const earlier = [download({ completedBytes: 10, speedBps: 1_000_000 })]
    const identical = [download({ completedBytes: 11, speedBps: 1_000_000 })]
    expect(trayMenuSignature(state({ downloads: earlier }))).toBe(
      trayMenuSignature(state({ downloads: identical }))
    )
    // A visible speed change, a pause or another row are worth a rebuild.
    expect(
      trayMenuSignature(state({ downloads: [download({ speedBps: 2_000_000 })] }))
    ).not.toBe(trayMenuSignature(state({ downloads: identical })))
    const paused = [download({ completedBytes: 11, status: 'paused' })]
    expect(trayMenuSignature(state({ downloads: paused }))).not.toBe(
      trayMenuSignature(state({ downloads: identical }))
    )
    const visible = trayMenuSignature(state({ windowVisible: true }))
    expect(visible).not.toBe(trayMenuSignature(state()))
  })
})

/* ------------------------------------------------------------------------- *
 * The real manager paths behind the tray items
 * ------------------------------------------------------------------------- */

interface FakeTracked {
  gid: string
  status: string
  dir: string
  totalLength: string
  completedLength: string
  downloadSpeed: string
  errorCode: string
  errorMessage: string
  files: Array<{ path: string; length: string; completedLength: string }>
}

class FakeAria2 {
  readonly calls: Array<{ method: string; params: unknown[] }> = []
  readonly tracked = new Map<string, FakeTracked>()
  private nextGid = 1

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }

  readonly client = {
    call: async (method: string, params: unknown[] = []): Promise<unknown> => {
      this.calls.push({ method, params })
      const gid = typeof params[0] === 'string' ? params[0] : ''
      const tracked = this.tracked.get(gid)
      switch (method) {
        case 'aria2.addUri': {
          const hex = (this.nextGid++).toString(16).padStart(16, '0')
          this.tracked.set(hex, {
            gid: hex,
            status: 'active',
            dir: '',
            totalLength: '100',
            completedLength: '40',
            downloadSpeed: '1000',
            errorCode: '0',
            errorMessage: '',
            files: []
          })
          return hex
        }
        case 'aria2.pause':
          if (tracked) tracked.status = 'paused'
          return gid
        case 'aria2.unpause':
          if (tracked) tracked.status = 'active'
          return gid
        case 'aria2.tellStatus':
          return tracked
            ? { ...tracked }
            : { code: 1, message: 'GID is not found.' }
        case 'aria2.forceRemove':
        case 'aria2.removeDownloadResult':
          this.tracked.delete(gid)
          return 'OK'
        case 'system.multicall':
          return (
            params[0] as Array<{ methodName?: string; params?: unknown[] }>
          ).map((sub) => {
            switch (sub.methodName) {
              case 'aria2.tellActive':
                return [
                  [...this.tracked.values()]
                    .filter((entry) => entry.status === 'active')
                    .map((entry) => ({ ...entry }))
                ]
              case 'aria2.tellWaiting':
                return [
                  [...this.tracked.values()]
                    .filter(
                      (entry) =>
                        entry.status === 'waiting' || entry.status === 'paused'
                    )
                    .map((entry) => ({ ...entry }))
                ]
              case 'aria2.getGlobalStat':
                return [
                  {
                    numActive: String(
                      [...this.tracked.values()].filter(
                        (entry) => entry.status === 'active'
                      ).length
                    ),
                    numWaiting: String(
                      [...this.tracked.values()].filter(
                        (entry) =>
                          entry.status === 'waiting' || entry.status === 'paused'
                      ).length
                    ),
                    numStopped: '0'
                  }
                ]
              case 'aria2.tellStatus': {
                const subGid =
                  typeof sub.params?.[0] === 'string' ? sub.params[0] : ''
                const entry = this.tracked.get(subGid)
                return entry === undefined
                  ? { code: 1, message: 'GID is not found.' }
                  : [{ ...entry }]
              }
              default:
                return { code: 1, message: 'Unsupported method.' }
            }
          })
        default:
          return 'OK'
      }
    }
  }

  asService(): Aria2Service {
    const state: Aria2State = {
      status: 'ready',
      version: 'test-aria2',
      binaryPath: null,
      message: null,
      hint: null
    }
    return {
      getState: () => ({ ...state }),
      getReadyClient: () => this.client,
      getClient: async () => this.client,
      start: async () => this.client,
      stop: async () => undefined,
      restart: async () => undefined
    } as unknown as Aria2Service
  }
}

describe('tray actions use the validated manager paths', () => {
  const managers: DownloadManager[] = []
  const databases: DownloadDatabase[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    for (const manager of managers.splice(0)) {
      try {
        manager.close()
      } catch {
        // Already closed.
      }
    }
    for (const database of databases.splice(0)) {
      try {
        database.close()
      } catch {
        // Already closed.
      }
    }
    for (const directory of tempDirs.splice(0)) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function setup(): Promise<{
    manager: DownloadManager
    aria2: FakeAria2
    downloadDir: string
    showItemInFolder: ReturnType<typeof vi.fn>
    openPath: ReturnType<typeof vi.fn>
  }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-tray-'))
    tempDirs.push(dir)
    const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
    databases.push(database)
    const downloadDir = path.join(dir, 'downloads')
    await mkdir(downloadDir, { recursive: true })
    const aria2 = new FakeAria2()
    const showItemInFolder = vi.fn()
    const openPath = vi.fn(async () => '')
    const manager = new DownloadManager(
      aria2.asService(),
      downloadDir,
      () => undefined,
      database,
      {
        host: createTestHost({ showItemInFolder, openPath }),
        settings: () => defaultDownloadSettings()
      }
    )
    managers.push(manager)
    return { manager, aria2, downloadDir, showItemInFolder, openPath }
  }

  /** Let aria2 finish the single tracked transfer at a real path on disk. */
  async function finishTransfer(
    aria2: FakeAria2,
    filePath: string
  ): Promise<void> {
    await writeFile(filePath, 'payload')
    const tracked = [...aria2.tracked.values()][0]!
    tracked.status = 'complete'
    tracked.completedLength = '100'
    tracked.totalLength = '100'
    tracked.files = [{ path: filePath, length: '100', completedLength: '100' }]
  }

  it('opens a finished download by id through the validated openFile path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { manager, aria2, downloadDir, openPath } = await setup()
    await manager.add({ url: 'https://example.com/file.bin' })
    const added = manager.getSnapshot().downloads[0]!
    const finalPath = path.join(downloadDir, 'file.bin')
    await finishTransfer(aria2, finalPath)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(manager.getItem(added.id)?.status).toBe('complete')
    expect(manager.getItem(added.id)?.filePath).toBe(finalPath)

    // The Recent submenu carries ids only.
    const items = buildRecentSubmenu(manager.getSnapshot().downloads, {
      openDownload: (id) => {
        void manager.openFile(id)
      },
      showDownloadInFolder: (id) => {
        void manager.showInFolder(id)
      }
    })
    expect(
      items.map((entry) => (entry.type === 'separator' ? '—' : entry.label))
    ).toEqual(['file.bin', '—', 'Show in folder'])
    click(items[0])
    await vi.waitFor(() => expect(openPath).toHaveBeenCalledWith(finalPath))
  })

  it('reveals the newest finished download in Explorer by id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { manager, aria2, downloadDir, showItemInFolder } = await setup()
    await manager.add({ url: 'https://example.com/newest.bin' })
    const finalPath = path.join(downloadDir, 'newest.bin')
    await finishTransfer(aria2, finalPath)
    await vi.advanceTimersByTimeAsync(1_500)

    const items = buildRecentSubmenu(manager.getSnapshot().downloads, {
      openDownload: vi.fn(),
      showDownloadInFolder: (id) => {
        void manager.showInFolder(id)
      }
    })
    click(items[items.length - 1])
    await vi.waitFor(() =>
      expect(showItemInFolder).toHaveBeenCalledWith(finalPath)
    )
  })

  it('a moved file surfaces FILE_MISSING and never opens a raw path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { manager, aria2, downloadDir, openPath } = await setup()
    await manager.add({ url: 'https://example.com/gone.bin' })
    const added = manager.getSnapshot().downloads[0]!
    const finalPath = path.join(downloadDir, 'gone.bin')
    await finishTransfer(aria2, finalPath)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(manager.getItem(added.id)?.status).toBe('complete')
    await rm(finalPath)

    await expect(manager.openFile(added.id)).rejects.toMatchObject({
      code: 'FILE_MISSING'
    })
    // An id the manager never issued is refused before any path is touched.
    await expect(manager.openFile('not-a-real-id')).rejects.toBeTruthy()
    expect(openPath).not.toHaveBeenCalled()
  })
})

describe('tray pause/resume-all decisions mirror the toolbar', () => {
  it('pauses active, queued and waiting rows and resumes only paused ones', () => {
    const rows = state({
      downloads: [
        download({ id: 'a', status: 'active' }),
        download({ id: 'b', status: 'queued' }),
        download({ id: 'c', status: 'waiting' }),
        download({ id: 'd', status: 'error' }),
        download({ id: 'e', status: 'cancelled' })
      ]
    })
    expect(canPauseAll(rows)).toBe(true)
    expect(canResumeAll(rows)).toBe(false)
    for (const status of ['error', 'cancelled', 'complete']) {
      expect(canResumeAll(state({ downloads: [download({ status })] }))).toBe(
        false
      )
    }
  })
})
