import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { AppSnapshot, Aria2State, DownloadItem } from '../src/shared/types'
import {
  defaultDownloadSettings,
  type DownloadControls,
  type DownloadSettings
} from '../src/shared/settings'
import { ARIA2_STATUS_KEYS } from '../src/main/aria2/poll'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import { BatchManager } from '../src/main/batches/manager'
import { DownloadManager } from '../src/main/downloads/manager'
import { AppError } from '../src/main/errors'
import type { CoreHost } from '../src/main/host'
import { createTestHost } from './fakes/host'

const tempDirs: string[] = []
const managers: DownloadManager[] = []
const databases: DownloadDatabase[] = []

interface FakeCall {
  method: string
  params: unknown[]
}

interface TrackedStatus {
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
  readonly calls: FakeCall[] = []
  readonly tracked = new Map<string, TrackedStatus>()
  private nextGid = 1

  get addUriCalls(): FakeCall[] {
    return this.calls.filter((call) => call.method === 'aria2.addUri')
  }

  get methods(): string[] {
    return this.calls.map((call) => call.method)
  }

  setStatus(gid: string, status: string): void {
    const tracked = this.tracked.get(gid)
    if (tracked) tracked.status = status
  }

  /** Report the final aria2 file path, as Content-Disposition can change it. */
  setFile(gid: string, filePath: string, length = 100): void {
    const tracked = this.tracked.get(gid)
    if (!tracked) return
    tracked.totalLength = String(length)
    tracked.completedLength = String(length)
    tracked.files = [
      { path: filePath, length: String(length), completedLength: String(length) }
    ]
  }

  /** Report an aria2 failure for one GID, as aria2 does for a broken transfer. */
  fail(gid: string, errorCode: number, errorMessage: string): void {
    const tracked = this.tracked.get(gid)
    if (!tracked) return
    tracked.status = 'error'
    tracked.errorCode = String(errorCode)
    tracked.errorMessage = errorMessage
  }

  private addTracked(gid: string): TrackedStatus {
    const tracked: TrackedStatus = {
      gid,
      status: 'waiting',
      dir: '',
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      errorCode: '0',
      errorMessage: '',
      files: []
    }
    this.tracked.set(gid, tracked)
    return tracked
  }

  readonly client = {
    call: async (method: string, params: unknown[] = []): Promise<unknown> => {
      this.calls.push({ method, params })
      const gid = typeof params[0] === 'string' ? params[0] : ''
      switch (method) {
        case 'aria2.addUri': {
          const hex = (this.nextGid++).toString(16).padStart(16, '0')
          this.addTracked(hex)
          return hex
        }
        case 'aria2.tellStatus': {
          const tracked = this.tracked.get(gid)
          if (!tracked) {
            throw new AppError('ARIA2_RPC_ERROR', 'GID is not found.')
          }
          return { ...tracked }
        }
        case 'system.multicall': {
          // One batch per poll tick; per-entry faults mirror aria2.
          const entries = Array.isArray(params[0]) ? params[0] : []
          return entries.map((entry) => {
            const sub = entry as { methodName?: string; params?: unknown[] }
            switch (sub.methodName) {
              case 'aria2.tellActive':
                return [
                  [...this.tracked.values()]
                    .filter((tracked) => tracked.status === 'active')
                    .map((tracked) => ({ ...tracked }))
                ]
              case 'aria2.tellWaiting':
                return [
                  [...this.tracked.values()]
                    .filter(
                      (tracked) =>
                        tracked.status === 'waiting' ||
                        tracked.status === 'paused'
                    )
                    .map((tracked) => ({ ...tracked }))
                ]
              case 'aria2.getGlobalStat': {
                const active = [...this.tracked.values()].filter(
                  (tracked) => tracked.status === 'active'
                ).length
                const waiting = [...this.tracked.values()].filter(
                  (tracked) =>
                    tracked.status === 'waiting' || tracked.status === 'paused'
                ).length
                return [
                  {
                    numActive: String(active),
                    numWaiting: String(waiting),
                    numStopped: '0'
                  }
                ]
              }
              case 'aria2.tellStatus': {
                const subGid =
                  typeof sub.params?.[0] === 'string' ? sub.params[0] : ''
                const tracked = this.tracked.get(subGid)
                return tracked === undefined
                  ? { code: 1, message: 'GID is not found.' }
                  : [{ ...tracked }]
              }
              default:
                return { code: 1, message: 'Unsupported method.' }
            }
          })
        }
        case 'aria2.pause': {
          const tracked = this.tracked.get(gid)
          if (!tracked) {
            throw new AppError('ARIA2_RPC_ERROR', 'GID is not found.')
          }
          tracked.status = 'paused'
          return gid
        }
        case 'aria2.unpause': {
          const tracked = this.tracked.get(gid)
          if (!tracked) {
            throw new AppError('ARIA2_RPC_ERROR', 'GID is not found.')
          }
          tracked.status = 'waiting'
          return gid
        }
        case 'aria2.forceRemove':
        case 'aria2.removeDownloadResult':
          this.tracked.delete(gid)
          return 'OK'
        default:
          throw new AppError('ARIA2_RPC_ERROR', `Unexpected method ${method}`)
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

interface Clock {
  value: number
}

interface SettingsRef {
  value: DownloadSettings
}

async function makeWorkspace(): Promise<{
  database: DownloadDatabase
  downloadDir: string
  databasePath: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-controls-'))
  tempDirs.push(dir)
  const databasePath = path.join(dir, 'downloads.sqlite3')
  const database = openDownloadDatabase(databasePath)
  databases.push(database)
  return { database, downloadDir: path.join(dir, 'downloads'), databasePath }
}

/** Local wall-clock instant on a controlled fixture date. */
function at(hour: number, minute = 0, day = 4): number {
  return new Date(2026, 10, day, hour, minute, 0, 0).getTime()
}

function settingsWithHours(
  enabled: boolean,
  start = '09:00',
  end = '10:00'
): DownloadSettings {
  return {
    ...defaultDownloadSettings(),
    allowedHours: { enabled, start, end }
  }
}

function createManager(
  database: DownloadDatabase,
  downloadDir: string,
  clock: Clock,
  settings: SettingsRef,
  updates?: AppSnapshot[],
  host?: CoreHost
): { manager: DownloadManager; aria2: FakeAria2 } {
  const aria2 = new FakeAria2()
  const manager = new DownloadManager(
    aria2.asService(),
    downloadDir,
    (snapshot) => {
      updates?.push(snapshot)
    },
    database,
    { now: () => clock.value, settings: () => settings.value, host }
  )
  managers.push(manager)
  return { manager, aria2 }
}

function controls(overrides: Partial<DownloadControls> = {}): DownloadControls {
  return {
    scheduledAt: null,
    speedLimitBps: null,
    connections: null,
    ...overrides
  }
}

function itemByUrl(manager: DownloadManager, url: string): DownloadItem {
  const item = manager.getSnapshot().downloads.find((entry) => entry.url === url)
  if (!item) throw new Error(`No download found for ${url}`)
  return item
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      manager.close()
    } catch {
      // Best effort for a failing test.
    }
  }
  databases.splice(0)
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('per-download aria2 options', () => {
  it('passes speed and connection controls to addUri and exposes them', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/limited.bin'

    await manager.add({
      url,
      controls: controls({ speedLimitBps: 3 * 1024 * 1024, connections: 5 })
    })

    expect(aria2.addUriCalls).toHaveLength(1)
    const options = aria2.addUriCalls[0]?.params[1] as Record<string, string>
    expect(options['max-download-limit']).toBe(String(3 * 1024 * 1024))
    expect(options.split).toBe('5')
    expect(options['max-connection-per-server']).toBe('5')

    const item = itemByUrl(manager, url)
    expect(item.speedLimitBps).toBe(3 * 1024 * 1024)
    expect(item.connections).toBe(5)
    expect(item.blockReason).toBeNull()

    const stored = database.loadAll()[0]
    expect(stored).toMatchObject({
      speedLimitBps: 3 * 1024 * 1024,
      connections: 5,
      scheduledAt: null
    })
  })

  it('leaves connection options to aria2 global settings when null', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    await manager.add({ url: 'https://example.com/global.bin' })
    const options = aria2.addUriCalls[0]?.params[1] as Record<string, string>
    expect(options).not.toHaveProperty('split')
    expect(options).not.toHaveProperty('max-connection-per-server')
    expect(options).not.toHaveProperty('max-download-limit')
  })
})

describe('chosen download folder', () => {
  it('downloads into a picked folder outside the default root and remembers it after a restart', async () => {
    const { database, downloadDir, databasePath } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const chosen = path.join(path.dirname(downloadDir), 'chosen folder')
    await mkdir(chosen, { recursive: true })

    const first = createManager(database, downloadDir, clock, settings)
    const url = 'https://example.com/picked.bin'
    const added = await first.manager.addToDestination(
      {
        url,
        controls: controls({ scheduledAt: at(12) })
      },
      chosen
    )
    const item = added.downloads.find((entry) => entry.url === url)
    expect(item?.status).toBe('waiting')
    expect(item?.dir).toBe(chosen)
    expect(database.loadAll()[0]?.record.dir).toBe(chosen)

    // A scheduled job was never handed to aria2. Reopening the database must
    // remember that this record may write outside the default root so Start
    // Now still works from the picked folder.
    first.manager.close()
    const reopened = openDownloadDatabase(databasePath)
    const second = createManager(reopened, downloadDir, clock, settings)
    const started = await second.manager.startNow(item?.id)
    const options = second.aria2.addUriCalls[0]?.params[1] as
      | Record<string, string>
      | undefined
    expect(options?.dir).toBe(chosen)
    expect(started.downloads.find((entry) => entry.id === item?.id)?.status).toBe(
      'queued'
    )
  })

  it('passes the picked folder to aria2 for an immediate add', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const chosen = path.join(path.dirname(downloadDir), 'elsewhere')
    await mkdir(chosen, { recursive: true })
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    await manager.addToDestination(
      { url: 'https://example.com/immediate.bin' },
      chosen
    )

    const options = aria2.addUriCalls[0]?.params[1] as Record<string, string>
    expect(options.dir).toBe(chosen)
  })

  it('refuses a relative folder instead of resolving it against the cwd', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    await expect(
      manager.addToDestination(
        { url: 'https://example.com/relative.bin' },
        'relative-folder'
      )
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FOLDER_INVALID' })
    expect(aria2.addUriCalls).toHaveLength(0)
  })
})

describe('recorded output folder trust', () => {
  function persistedRecord(
    overrides: Partial<DownloadItem> & Pick<DownloadItem, 'id' | 'dir' | 'filePath'>
  ): DownloadItem {
    const now = Date.UTC(2026, 10, 4, 9, 30)
    return {
      gid: '0123456789abcdef',
      url: 'https://example.com/files/sample.zip',
      filename: 'sample.zip',
      status: 'complete',
      totalBytes: 10,
      completedBytes: 10,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      attempts: 1,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      ...overrides
    }
  }

  it('refuses a drive-root dir that would authorise an arbitrary file', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const outside = path.join(path.dirname(downloadDir), 'outside.bin')
    await writeFile(outside, 'not part of the download')
    const id = '77777777-7777-4777-8777-777777777777'
    database.save({
      record: persistedRecord({
        id,
        dir: path.parse(outside).root,
        filePath: outside
      }),
      explicitFilename: null
    })

    const trashItem = vi.fn(async () => undefined)
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      undefined,
      createTestHost({ trashItem })
    )

    await expect(manager.deleteFile(id)).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_DOWNLOAD_DIR'
    })
    await expect(manager.openFile(id)).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_DOWNLOAD_DIR'
    })
    await expect(manager.showInFolder(id)).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_DOWNLOAD_DIR'
    })
    await expect(manager.checksumTarget(id)).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_DOWNLOAD_DIR'
    })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('falls back to the global download folder for a drive-root dir', async () => {
    const { database, downloadDir } = await makeWorkspace()
    await mkdir(downloadDir, { recursive: true })
    const inside = path.join(downloadDir, 'inside.bin')
    await writeFile(inside, 'downloaded file')
    const id = '88888888-8888-4888-8888-888888888888'
    database.save({
      record: persistedRecord({
        id,
        dir: path.parse(downloadDir).root,
        filePath: inside
      }),
      explicitFilename: null
    })

    const trashItem = vi.fn(async () => undefined)
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      undefined,
      createTestHost({ trashItem })
    )

    await manager.deleteFile(id)
    expect(trashItem).toHaveBeenCalledWith(inside)
  })

  it('allows open and show when the global download folder is a drive root', async () => {
    // A drive root is an accepted Settings default download folder: it is the
    // fallback root itself, so a file inside it can still be opened and shown.
    const { database, downloadDir } = await makeWorkspace()
    await mkdir(downloadDir, { recursive: true })
    const file = path.join(downloadDir, 'inside-global-root.bin')
    await writeFile(file, 'downloaded file')
    const driveRoot = path.parse(downloadDir).root
    const id = '99999999-9999-4999-8999-999999999999'
    database.save({
      record: persistedRecord({ id, dir: driveRoot, filePath: file }),
      explicitFilename: null
    })

    const openPath = vi.fn(async () => '')
    const showItemInFolder = vi.fn()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(
      database,
      driveRoot,
      clock,
      settings,
      undefined,
      createTestHost({ openPath, showItemInFolder })
    )

    await manager.openFile(id)
    await manager.showInFolder(id)
    expect(openPath).toHaveBeenCalledWith(file)
    expect(showItemInFolder).toHaveBeenCalledWith(file)
  })
})

describe('per-host connection back-off', () => {
  it('lowers the connections for the failing host only and retries there', async () => {
    vi.useFakeTimers()
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    try {
      const slow = 'https://slow.example.com/file.bin'
      await manager.add({ url: slow })
      const item = itemByUrl(manager, slow)
      expect(item.connections).toBeNull()

      // The server refuses 16 parallel connections.
      aria2.fail(item.gid, 22, 'The response status is 429')
      await vi.advanceTimersByTimeAsync(1_000)

      const failed = itemByUrl(manager, slow)
      expect(failed.status).toBe('error')
      // An automatic retry is scheduled with the lowered count.
      expect(failed.retryAt).not.toBeNull()

      await manager.retry(item.id)
      const retryOptions = aria2.addUriCalls[1]?.params[1] as Record<
        string,
        string
      >
      expect(retryOptions.split).toBe('8')
      expect(retryOptions['max-connection-per-server']).toBe('8')

      // A new download to the same host starts from the remembered value.
      await manager.add({ url: 'https://slow.example.com/other.bin' })
      const sameHost = aria2.addUriCalls[2]?.params[1] as Record<string, string>
      expect(sameHost.split).toBe('8')

      // Another host keeps the full setting.
      await manager.add({ url: 'https://fast.example.com/file.bin' })
      const otherHost = aria2.addUriCalls[3]?.params[1] as Record<string, string>
      expect(otherHost).not.toHaveProperty('split')
      expect(otherHost).not.toHaveProperty('max-connection-per-server')
    } finally {
      manager.close()
      vi.useRealTimers()
    }
  })

  it('keeps an explicit per-download count as the back-off ceiling', async () => {
    vi.useFakeTimers()
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    try {
      const url = 'https://limited.example.com/file.bin'
      await manager.add({ url, controls: controls({ connections: 4 }) })
      const item = itemByUrl(manager, url)
      expect(
        (aria2.addUriCalls[0]?.params[1] as Record<string, string>).split
      ).toBe('4')

      // aria2 code 29: the server is temporarily overloaded.
      aria2.fail(item.gid, 29, 'Remote server is temporarily overloaded')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(itemByUrl(manager, url).retryAt).not.toBeNull()

      await manager.retry(item.id)
      const retryOptions = aria2.addUriCalls[1]?.params[1] as Record<
        string,
        string
      >
      expect(retryOptions.split).toBe('1')
      expect(retryOptions['max-connection-per-server']).toBe('1')
    } finally {
      manager.close()
      vi.useRealTimers()
    }
  })

  it('ignores failures that say nothing about connections', async () => {
    vi.useFakeTimers()
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    try {
      const url = 'https://missing.example.com/file.bin'
      await manager.add({ url })
      const item = itemByUrl(manager, url)
      aria2.fail(item.gid, 3, 'Resource not found')
      await vi.advanceTimersByTimeAsync(1_000)

      expect(itemByUrl(manager, url).status).toBe('error')
      expect(itemByUrl(manager, url).retryAt).toBeNull()

      await manager.retry(item.id)
      const retryOptions = aria2.addUriCalls[1]?.params[1] as Record<
        string,
        string
      >
      expect(retryOptions).not.toHaveProperty('split')
    } finally {
      manager.close()
      vi.useRealTimers()
    }
  })
})

describe('scheduled starts', () => {
  it('holds a future job without calling aria2 and starts it when due', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/scheduled.bin'
    const scheduledAt = at(11, 0)

    await manager.add({ url, controls: controls({ scheduledAt }) })

    expect(aria2.addUriCalls).toHaveLength(0)
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'waiting',
      blockReason: 'scheduled',
      scheduledAt
    })
    expect(database.loadAll()[0]).toMatchObject({
      scheduledAt,
      blockReason: 'scheduled'
    })

    clock.value = scheduledAt
    await manager.refreshPolicy()

    expect(aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'queued',
      blockReason: null
    })
  })

  it('treats an in-past schedule as due immediately', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(12, 0) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    await manager.add({
      url: 'https://example.com/expired.bin',
      controls: controls({ scheduledAt: at(9, 0) })
    })
    expect(aria2.addUriCalls).toHaveLength(1)
  })
})

describe('allowed hours', () => {
  it('continues active downloads but pauses waiting work when the window closes', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(true) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const activeUrl = 'https://example.com/active.bin'
    const waitingUrl = 'https://example.com/waiting.bin'

    await manager.add({ url: activeUrl })
    await manager.add({ url: waitingUrl })
    const active = itemByUrl(manager, activeUrl)
    const waiting = itemByUrl(manager, waitingUrl)
    aria2.setStatus(active.gid, 'active')
    aria2.setStatus(waiting.gid, 'waiting')

    await manager.refreshPolicy()
    expect(itemByUrl(manager, activeUrl).status).toBe('active')
    expect(itemByUrl(manager, waitingUrl).status).toBe('waiting')

    clock.value = at(10, 0) // end is exclusive
    await manager.refreshPolicy()

    expect(itemByUrl(manager, activeUrl).status).toBe('active')
    expect(itemByUrl(manager, waitingUrl)).toMatchObject({
      status: 'waiting',
      blockReason: 'allowed-hours'
    })
    expect(aria2.methods.filter((method) => method === 'aria2.pause')).toEqual([
      'aria2.pause'
    ])

    const blockedUrl = 'https://example.com/blocked.bin'
    await manager.add({ url: blockedUrl })
    expect(aria2.addUriCalls).toHaveLength(2)
    expect(itemByUrl(manager, blockedUrl)).toMatchObject({
      status: 'waiting',
      blockReason: 'allowed-hours'
    })

    clock.value = at(9, 30, 5)
    await manager.refreshPolicy()

    expect(aria2.methods.filter((method) => method === 'aria2.unpause')).toHaveLength(1)
    expect(aria2.addUriCalls).toHaveLength(3)
    expect(itemByUrl(manager, blockedUrl).blockReason).toBeNull()
    expect(itemByUrl(manager, waitingUrl).blockReason).toBeNull()
  })

  it('keeps a manually paused job paused when the next window opens', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(true) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/user-paused.bin'
    await manager.add({ url })
    const item = itemByUrl(manager, url)

    await manager.pause(item.id)
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'paused',
      blockReason: null
    })

    clock.value = at(9, 30, 5)
    await manager.refreshPolicy()

    expect(itemByUrl(manager, url).status).toBe('paused')
    // Only the original add, no automatic re-add/unpause.
    expect(aria2.addUriCalls).toHaveLength(1)
    expect(aria2.methods).not.toContain('aria2.unpause')
  })
})

describe('cancelling a download', () => {
  it('stops an active transfer but keeps a retryable cancelled row and partial file', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/cancel-me.bin'

    await manager.add({ url })
    const item = itemByUrl(manager, url)
    aria2.setStatus(item.gid, 'active')
    await manager.refreshPolicy()
    expect(itemByUrl(manager, url).status).toBe('active')

    const snapshot = await manager.cancel(item.id)
    const cancelled = snapshot.downloads.find((entry) => entry.id === item.id)
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      gid: '',
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      completedAt: clock.value
    })
    // The transfer is force-removed from aria2, not merely paused.
    expect(aria2.methods).toContain('aria2.forceRemove')
    expect(aria2.methods).toContain('aria2.removeDownloadResult')
    expect(database.loadAll()[0]?.record).toMatchObject({
      status: 'cancelled',
      gid: ''
    })

    // Cancelling is not a failed attempt; Retry continues the same job.
    await manager.retry(item.id)
    const retried = itemByUrl(manager, url)
    expect(retried).toMatchObject({
      status: 'queued',
      attempts: item.attempts,
      completedAt: null
    })
    expect(aria2.addUriCalls).toHaveLength(2)
  })

  it('cancels a scheduled job that was never handed to aria2', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/never-started.bin'

    await manager.add({
      url,
      controls: controls({ scheduledAt: at(13, 0) })
    })
    const item = itemByUrl(manager, url)
    expect(item).toMatchObject({ status: 'waiting', blockReason: 'scheduled' })
    expect(aria2.addUriCalls).toHaveLength(0)

    await manager.cancel(item.id)

    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'cancelled',
      blockReason: null,
      gid: ''
    })
    expect(aria2.methods).toEqual([])
    expect(database.loadAll()[0]?.blockReason).toBeNull()

    // Its old schedule coming due must not restart a cancelled row.
    clock.value = at(13, 1)
    await manager.refreshPolicy()
    expect(aria2.addUriCalls).toHaveLength(0)

    // Retry is an explicit override: it starts the cancelled job now.
    await manager.retry(item.id)
    expect(aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(manager, url).status).toBe('queued')
  })

  it('cancels a paused job and refuses a completed one', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const pausedUrl = 'https://example.com/paused-cancel.bin'
    const doneUrl = 'https://example.com/already-done.bin'

    await manager.add({ url: pausedUrl })
    const paused = itemByUrl(manager, pausedUrl)
    await manager.pause(paused.id)
    await manager.cancel(paused.id)
    expect(itemByUrl(manager, pausedUrl).status).toBe('cancelled')

    await manager.add({ url: doneUrl })
    const done = itemByUrl(manager, doneUrl)
    aria2.setStatus(done.gid, 'complete')
    await manager.refreshPolicy()
    expect(itemByUrl(manager, doneUrl).status).toBe('complete')

    await expect(manager.cancel(done.id)).rejects.toMatchObject({
      code: 'DOWNLOAD_COMPLETE'
    })
    expect(itemByUrl(manager, doneUrl).status).toBe('complete')
  })
})

describe('completion notification file actions', () => {
  async function completedFile(
    manager: DownloadManager,
    aria2: FakeAria2,
    url: string,
    downloadDir: string,
    filename: string
  ): Promise<{ id: string; file: string }> {
    await manager.add({ url })
    const pending = itemByUrl(manager, url)
    await mkdir(downloadDir, { recursive: true })
    const file = path.join(downloadDir, filename)
    await writeFile(file, 'completed bytes')
    aria2.setFile(pending.gid, file)
    aria2.setStatus(pending.gid, 'complete')
    await manager.refreshPolicy()
    return { id: itemByUrl(manager, url).id, file }
  }

  it('opens and reveals exactly the path recorded for the opaque id', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const opened: string[] = []
    const revealed: string[] = []
    const host = createTestHost({
      openPath: async (target) => {
        opened.push(target)
        return ''
      },
      showItemInFolder: (target) => {
        revealed.push(target)
      }
    })
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      undefined,
      host
    )

    const { id, file } = await completedFile(
      manager,
      aria2,
      'https://example.com/notify.bin',
      downloadDir,
      'notify.bin'
    )
    expect(itemByUrl(manager, 'https://example.com/notify.bin').filePath).toBe(
      file
    )

    await manager.openFile(id)
    await manager.showInFolder(id)
    expect(opened).toEqual([file])
    expect(revealed).toEqual([file])
  })

  it('refuses an unknown id instead of opening anything', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const opened: string[] = []
    const host = createTestHost({
      openPath: async (target) => {
        opened.push(target)
        return ''
      }
    })
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      undefined,
      host
    )

    await expect(
      manager.openFile('00000000-0000-4000-8000-000000000000')
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_NOT_FOUND'
    })
    await expect(
      manager.showInFolder('00000000-0000-4000-8000-000000000000')
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_NOT_FOUND'
    })
    expect(opened).toEqual([])
  })

  it('reports FILE_MISSING when the recorded file was moved or deleted', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const opened: string[] = []
    const host = createTestHost({
      openPath: async (target) => {
        opened.push(target)
        return ''
      }
    })
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      undefined,
      host
    )

    const { id, file } = await completedFile(
      manager,
      aria2,
      'https://example.com/gone.bin',
      downloadDir,
      'gone.bin'
    )
    await rm(file)

    await expect(manager.openFile(id)).rejects.toMatchObject({
      code: 'FILE_MISSING'
    })
    await expect(manager.showInFolder(id)).rejects.toMatchObject({
      code: 'FILE_MISSING'
    })
    expect(opened).toEqual([])
  })

  it('refuses a recorded path outside the download folder', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const opened: string[] = []
    const host = createTestHost({
      openPath: async (target) => {
        opened.push(target)
        return ''
      }
    })
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      undefined,
      host
    )

    await manager.add({ url: 'https://example.com/escape.bin' })
    const pending = itemByUrl(manager, 'https://example.com/escape.bin')
    await mkdir(downloadDir, { recursive: true })
    const outside = path.join(downloadDir, '..', 'escape.bin')
    await writeFile(outside, 'outside')
    aria2.setFile(pending.gid, outside)
    aria2.setStatus(pending.gid, 'complete')
    await manager.refreshPolicy()

    const done = itemByUrl(manager, 'https://example.com/escape.bin')
    await expect(manager.openFile(done.id)).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_DOWNLOAD_DIR'
    })
    expect(opened).toEqual([])
  })
})

describe('manual pause versus schedule block', () => {
  it('keeps a paused future job paused past its schedule and resumes explicitly', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/paused-future.bin'
    await manager.add({
      url,
      controls: controls({ scheduledAt: at(11, 0) })
    })
    const item = itemByUrl(manager, url)
    expect(item.blockReason).toBe('scheduled')

    await manager.pause(item.id)
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'paused',
      blockReason: null
    })

    clock.value = at(11, 1)
    await manager.refreshPolicy()
    expect(itemByUrl(manager, url).status).toBe('paused')
    expect(aria2.addUriCalls).toHaveLength(0)

    await manager.resume(item.id)
    expect(aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(manager, url).status).toBe('queued')
  })

  it('starts a blocked job immediately with Start Now and keeps the override', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(10, 30) }
    const settings = { value: settingsWithHours(true) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/start-now.bin'
    await manager.add({
      url,
      controls: controls({ scheduledAt: at(23, 0) })
    })
    const item = itemByUrl(manager, url)
    expect(item).toMatchObject({ status: 'waiting', blockReason: 'scheduled' })
    expect(aria2.addUriCalls).toHaveLength(0)

    await manager.startNow(item.id)
    expect(aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'queued',
      blockReason: null
    })

    await manager.refreshPolicy()
    expect(aria2.methods).not.toContain('aria2.pause')
    expect(itemByUrl(manager, url).blockReason).toBeNull()
  })

  it('rejects Start Now for a completed download', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/done.bin'
    await manager.add({ url })
    const item = itemByUrl(manager, url)
    aria2.setStatus(item.gid, 'complete')
    await manager.refreshPolicy()
    expect(itemByUrl(manager, url).status).toBe('complete')

    await expect(manager.startNow(item.id)).rejects.toMatchObject({
      code: 'DOWNLOAD_COMPLETE'
    })
  })
})

describe('restart and recovery', () => {
  it('keeps scheduled work waiting across a restart and starts it after the window opens', async () => {
    const { database, downloadDir, databasePath } = await makeWorkspace()
    const clock = { value: at(10, 30) }
    const settings = { value: settingsWithHours(true) }
    const first = createManager(database, downloadDir, clock, settings)
    const url = 'https://example.com/restart.bin'
    const scheduledAt = at(11, 0)

    await first.manager.add({ url, controls: controls({ scheduledAt }) })
    expect(first.aria2.addUriCalls).toHaveLength(0)
    first.manager.close()

    // A fresh process/aria2 has no GID, but the policy hold must survive.
    const reopened = openDownloadDatabase(databasePath)
    databases.push(reopened)
    clock.value = at(10, 45)
    const second = createManager(reopened, downloadDir, clock, settings)
    await second.manager.reconcileDownloads()

    expect(itemByUrl(second.manager, url)).toMatchObject({
      status: 'waiting',
      blockReason: 'scheduled',
      scheduledAt
    })
    expect(second.aria2.addUriCalls).toHaveLength(0)

    // Schedule expires while still outside allowed hours: the specific reason
    // becomes allowed-hours, and the job still does not start.
    clock.value = at(11, 5)
    await second.manager.refreshPolicy()
    expect(itemByUrl(second.manager, url)).toMatchObject({
      status: 'waiting',
      blockReason: 'allowed-hours'
    })
    expect(second.aria2.addUriCalls).toHaveLength(0)

    clock.value = at(9, 30, 5)
    await second.manager.refreshPolicy()
    expect(second.aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(second.manager, url).blockReason).toBeNull()
  })

  it('does not resume a user-paused job after restart', async () => {
    const { database, downloadDir, databasePath } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const first = createManager(database, downloadDir, clock, settings)
    const url = 'https://example.com/restart-paused.bin'
    await first.manager.add({ url })
    await first.manager.pause(itemByUrl(first.manager, url).id)
    first.manager.close()

    const reopened = openDownloadDatabase(databasePath)
    databases.push(reopened)
    const second = createManager(reopened, downloadDir, clock, settings)
    await second.manager.reconcileDownloads()

    expect(itemByUrl(second.manager, url).status).toBe('paused')
    expect(second.aria2.addUriCalls).toHaveLength(0)
  })

  it('persists a schedule for a job added before aria2 became ready', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(database, downloadDir, clock, settings)
    const url = 'https://example.com/persist.bin'
    const scheduledAt = at(12, 0)
    await manager.add({ url, controls: controls({ scheduledAt }) })

    const stored = database.loadAll()[0]
    expect(stored).toMatchObject({
      scheduledAt,
      speedLimitBps: null,
      connections: null,
      blockReason: 'scheduled'
    })
  })
})

describe('lifecycle safety', () => {
  it('removes a never-submitted scheduled job without touching aria2', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/remove.bin'
    await manager.add({
      url,
      controls: controls({ scheduledAt: at(13, 0) })
    })
    const item = itemByUrl(manager, url)
    await manager.remove(item.id)

    expect(manager.getSnapshot().downloads).toHaveLength(0)
    expect(database.loadAll()).toHaveLength(0)
    clock.value = at(13, 1)
    await manager.refreshPolicy()
    expect(aria2.addUriCalls).toHaveLength(0)
  })

  it('keeps completed controls and never re-queues a completed job', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/complete.bin'
    await manager.add({
      url,
      controls: controls({ speedLimitBps: 1024, connections: 2 })
    })
    const item = itemByUrl(manager, url)
    aria2.setStatus(item.gid, 'active')
    await manager.refreshPolicy()
    aria2.setStatus(item.gid, 'complete')
    await manager.refreshPolicy()

    const completed = itemByUrl(manager, url)
    expect(completed.status).toBe('complete')
    expect(completed.speedLimitBps).toBe(1024)
    expect(completed.connections).toBe(2)
    expect(completed.blockReason).toBeNull()

    clock.value = at(13, 0)
    await manager.refreshPolicy()
    expect(aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(manager, url).status).toBe('complete')
  })
})

describe('live settings edits', () => {
  it('pauses waiting work when allowed hours become closed and unpauses when disabled', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(10, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/live-edit.bin'
    await manager.add({ url })
    const item = itemByUrl(manager, url)
    aria2.setStatus(item.gid, 'waiting')
    await manager.refreshPolicy()
    expect(itemByUrl(manager, url).status).toBe('waiting')

    settings.value = settingsWithHours(true)
    await manager.refreshPolicy()
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'waiting',
      blockReason: 'allowed-hours'
    })
    expect(aria2.methods).toContain('aria2.pause')

    settings.value = settingsWithHours(false)
    await manager.refreshPolicy()
    expect(itemByUrl(manager, url).blockReason).toBeNull()
    expect(aria2.methods).toContain('aria2.unpause')
  })

  it('does not pause an active transfer when the window closes', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(true) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/active-edit.bin'
    await manager.add({ url })
    const item = itemByUrl(manager, url)
    aria2.setStatus(item.gid, 'active')
    await manager.refreshPolicy()

    clock.value = at(10, 0)
    settings.value = settingsWithHours(true)
    await manager.refreshPolicy()

    expect(itemByUrl(manager, url).status).toBe('active')
    expect(aria2.methods).not.toContain('aria2.pause')
  })
})

describe('media policy wake port', () => {
  it('uses the download manager timer to pump pending media work', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(true) }
    const { manager } = createManager(database, downloadDir, clock, settings)
    let pending = true
    const pumpPolicy = vi.fn(() => {
      pending = false
    })

    manager.setMediaPolicyPort({
      hasPendingPolicyWork: () => pending,
      pumpPolicy
    })
    await manager.refreshPolicy()
    expect(pumpPolicy).toHaveBeenCalledTimes(1)
    expect(pumpPolicy).toHaveBeenCalledWith(clock.value)

    await manager.refreshPolicy()
    expect(pumpPolicy).toHaveBeenCalledTimes(1)
  })
})

describe('batch children', () => {
  it('applies the same allowed-hours gate to a direct batch child', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(10, 30) }
    const settings = { value: settingsWithHours(true) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const emptyMedia = {
      tool: {
        status: 'stopped' as const,
        version: null,
        message: null,
        hint: null
      },
      jobs: []
    }
    const batches = new BatchManager({
      downloads: manager,
      mediaJobs: {
        analyzeMedia: async () => {
          throw new Error('unused in this test')
        },
        queueMedia: async () => {
          throw new Error('unused in this test')
        },
        cancelMedia: async () => {
          throw new Error('unused in this test')
        },
        getMediaSnapshot: () => emptyMedia
      } as never,
      collectionEngine: {} as never,
      pixeldrain: {} as never,
      onUpdate: () => undefined,
      now: () => clock.value,
      pollIntervalMs: 0
    })
    const url = 'https://example.com/batch-child.bin'

    await batches.submitSmartBatch({ urls: [url] })
    await batches.waitForIdle()

    // The batch item uses DownloadManager.add, so the child is policy-held
    // instead of being handed to aria2 outside the window.
    expect(aria2.addUriCalls).toHaveLength(0)
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'waiting',
      blockReason: 'allowed-hours'
    })

    clock.value = at(9, 30, 5)
    await manager.refreshPolicy()
    batches.refresh()

    expect(aria2.addUriCalls).toHaveLength(1)
    expect(itemByUrl(manager, url).blockReason).toBeNull()
  })
})

describe('automatic retry after a transient failure', () => {
  it('waits 3 s and retries a broken connection once, resuming the partial file', async () => {
    // Fake timers: the backoff is exercised exactly, never by sleeping in real
    // time and hoping the retry lands inside a wall-clock deadline.
    vi.useFakeTimers()
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    try {
      const url = 'https://example.com/flaky.bin'

      await manager.add({ url })
      const first = itemByUrl(manager, url)
      aria2.fail(first.gid, 6, 'Connection reset by peer')

      await manager.refreshPolicy()
      const waiting = itemByUrl(manager, url)
      expect(waiting).toMatchObject({
        status: 'error',
        errorMessage: 'The connection was interrupted.',
        errorDetail: 'aria2 code 6: Connection reset by peer',
        attempts: 1
      })
      expect(waiting.retryAt).toBe(clock.value + 3_000)
      expect(aria2.addUriCalls).toHaveLength(1)

      // The scheduled retry re-adds the job once the backoff elapses.
      await vi.advanceTimersByTimeAsync(3_000)
      await vi.waitFor(() => expect(itemByUrl(manager, url).attempts).toBe(2))
      const retried = itemByUrl(manager, url)
      expect(retried).toMatchObject({
        status: 'queued',
        errorMessage: null,
        errorDetail: null,
        retryAt: null
      })
      expect(aria2.addUriCalls).toHaveLength(2)

      // A second transient failure waits the longer backoff.
      aria2.fail(retried.gid, 2, 'Timeout.')
      await manager.refreshPolicy()
      expect(itemByUrl(manager, url)).toMatchObject({
        status: 'error',
        errorMessage: 'The server stopped responding.',
        attempts: 2,
        retryAt: clock.value + 10_000
      })
    } finally {
      manager.close()
      vi.useRealTimers()
    }
  })

  it('never retries a non-transient failure automatically', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/missing.bin'

    await manager.add({ url })
    const item = itemByUrl(manager, url)
    aria2.fail(item.gid, 3, 'Resource not found')

    await manager.refreshPolicy()
    expect(itemByUrl(manager, url)).toMatchObject({
      status: 'error',
      errorMessage: "The file isn't on the server (anymore).",
      errorDetail: 'aria2 code 3: Resource not found',
      retryAt: null,
      attempts: 1
    })
    expect(aria2.addUriCalls).toHaveLength(1)
  })

  it('cancels a pending automatic retry when the download is removed', async () => {
    vi.useFakeTimers()
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    try {
      const url = 'https://example.com/removed.bin'

      await manager.add({ url })
      const item = itemByUrl(manager, url)
      aria2.fail(item.gid, 5, 'Too slow')

      await manager.refreshPolicy()
      expect(itemByUrl(manager, url).retryAt).not.toBeNull()
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      await manager.remove(item.id)

      // The retry timer is gone with the row, so nothing is left to fire and
      // the job is never handed back to aria2, however long we wait.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(manager.getSnapshot().downloads).toHaveLength(0)
      expect(aria2.addUriCalls).toHaveLength(1)
    } finally {
      manager.close()
      vi.useRealTimers()
    }
  })
})

describe('poll batching and snapshot publishing', () => {
  it('observes pending downloads with one list batch and a bounded fallback', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(database, downloadDir, clock, settings)
    const firstUrl = 'https://example.com/batch-one.bin'
    const secondUrl = 'https://example.com/batch-two.bin'
    await manager.add({ url: firstUrl })
    await manager.add({ url: secondUrl })
    const first = itemByUrl(manager, firstUrl)
    const second = itemByUrl(manager, secondUrl)
    aria2.setStatus(first.gid, 'active')
    aria2.setStatus(second.gid, 'complete')

    await manager.refreshPolicy()

    const multicalls = aria2.calls.filter(
      (call) => call.method === 'system.multicall'
    )
    // The list batch observes the active transfer. The completed GID is no
    // longer in either list, so exactly that GID gets one bounded tellStatus.
    expect(multicalls).toHaveLength(2)
    const listBatch = multicalls[0]?.params[0] as Array<{
      methodName: string
      params: unknown[]
    }>
    expect(listBatch.map((entry) => entry.methodName)).toEqual([
      'aria2.tellActive',
      'aria2.tellWaiting',
      'aria2.getGlobalStat'
    ])
    // Every status request asks only for the fields the app reads.
    expect(listBatch[0]?.params[0]).toEqual([...ARIA2_STATUS_KEYS])
    expect(listBatch[1]?.params).toEqual([0, -1, [...ARIA2_STATUS_KEYS]])
    expect(listBatch[0]?.params[0]).not.toContain('dir')
    expect(listBatch[0]?.params[0]).not.toContain('bitfield')

    const fallback = multicalls[1]?.params[0] as Array<{
      methodName: string
      params: unknown[]
    }>
    expect(fallback.map((entry) => entry.methodName)).toEqual([
      'aria2.tellStatus'
    ])
    expect(fallback[0]?.params[0]).toBe(second.gid)
    expect(fallback[0]?.params[1]).toEqual([...ARIA2_STATUS_KEYS])
    // No standalone per-GID round trip is left in the poll path.
    expect(
      aria2.methods.filter((method) => method === 'aria2.tellStatus')
    ).toEqual([])
    expect(itemByUrl(manager, firstUrl).status).toBe('active')
    expect(itemByUrl(manager, secondUrl).status).toBe('complete')
  })

  it('handles a per-entry fault without losing the rest of the batch', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(database, downloadDir, clock, settings)
    const lostUrl = 'https://example.com/lost.bin'
    const keptUrl = 'https://example.com/kept.bin'
    await manager.add({ url: lostUrl })
    await manager.add({ url: keptUrl })
    const lost = itemByUrl(manager, lostUrl)
    const kept = itemByUrl(manager, keptUrl)
    aria2.setStatus(kept.gid, 'active')
    // aria2 no longer knows this GID: the batch reports a fault for it only.
    aria2.tracked.delete(lost.gid)

    await manager.refreshPolicy()

    expect(itemByUrl(manager, lostUrl)).toMatchObject({
      status: 'interrupted',
      speedBps: 0
    })
    expect(itemByUrl(manager, keptUrl).status).toBe('active')
  })

  it('publishes only when the snapshot actually changed', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const updates: AppSnapshot[] = []
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      updates
    )
    const url = 'https://example.com/publish.bin'
    await manager.add({ url })
    const afterAdd = updates.length
    expect(afterAdd).toBeGreaterThan(0)

    // Nothing changed since the last publish: no snapshot is rebuilt or sent.
    manager.publish()
    expect(updates.length).toBe(afterAdd)

    // A record change bumps the revision, so the next plain publish sends it.
    await manager.pause(itemByUrl(manager, url).id)
    expect(updates.length).toBe(afterAdd + 1)
    expect(updates[updates.length - 1]?.downloads[0]?.status).toBe('paused')
  })
})

describe('bulk list removal', () => {
  it('removes many entries in one transaction and one publish, keeping files', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const updates: AppSnapshot[] = []
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings,
      updates
    )

    const urls = [
      'https://example.com/one.bin',
      'https://example.com/two.bin',
      'https://example.com/three.bin'
    ]
    for (const url of urls) await manager.add({ url })
    // A file the user already downloaded must survive the clear.
    await mkdir(downloadDir, { recursive: true })
    const keptFile = path.join(downloadDir, 'one.bin')
    await writeFile(keptFile, 'payload')

    const ids = manager.getSnapshot().downloads.map((item) => item.id)
    expect(ids).toHaveLength(3)
    const before = updates.length

    await manager.removeMany(ids)

    expect(manager.getSnapshot().downloads).toHaveLength(0)
    expect(database.loadAll()).toHaveLength(0)
    // One publish for the whole batch, not one per row.
    expect(updates.length).toBe(before + 1)
    await expect(stat(keptFile)).resolves.toMatchObject({ size: 7 })
  })

  it('skips ids the backend no longer knows instead of failing the clear', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(database, downloadDir, clock, settings)

    await manager.add({ url: 'https://example.com/keep.bin' })
    const id = itemByUrl(manager, 'https://example.com/keep.bin').id
    const unknown = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    await manager.removeMany([id, unknown])

    expect(manager.getSnapshot().downloads).toHaveLength(0)
    expect(database.loadAll()).toHaveLength(0)
  })

  it('rejects a malformed bulk payload without touching any row', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(database, downloadDir, clock, settings)

    await manager.add({ url: 'https://example.com/safe.bin' })

    await expect(manager.removeMany('not-a-list')).rejects.toThrow()
    await expect(manager.removeMany(['not-a-uuid'])).rejects.toThrow()
    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(database.loadAll()).toHaveLength(1)
  })
})

describe('sort downloads into folders by type', () => {
  it('keeps the default directory when the setting is off', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager } = createManager(database, downloadDir, clock, settings)

    await manager.add({ url: 'https://example.com/movie.mkv' })

    expect(itemByUrl(manager, 'https://example.com/movie.mkv').dir).toBe(
      downloadDir
    )
  })

  it('saves a new default-folder download in the type subfolder when on', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = {
      value: { ...defaultDownloadSettings(), sortDownloadsByType: true }
    }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    await manager.add({ url: 'https://example.com/movie.mkv' })
    await manager.add({ url: 'https://example.com/song.flac' })
    await manager.add({ url: 'https://example.com/scene.funscript' })
    await manager.add({ url: 'https://example.com/payload.bin' })

    expect(itemByUrl(manager, 'https://example.com/movie.mkv').dir).toBe(
      path.join(downloadDir, 'Video')
    )
    expect(itemByUrl(manager, 'https://example.com/song.flac').dir).toBe(
      path.join(downloadDir, 'Audio')
    )
    expect(itemByUrl(manager, 'https://example.com/scene.funscript').dir).toBe(
      path.join(downloadDir, 'Video')
    )
    expect(itemByUrl(manager, 'https://example.com/payload.bin').dir).toBe(
      downloadDir
    )

    const dirs = aria2.addUriCalls.map(
      (call) => (call.params[1] as Record<string, string>).dir
    )
    expect(dirs).toEqual([
      path.join(downloadDir, 'Video'),
      path.join(downloadDir, 'Audio'),
      path.join(downloadDir, 'Video'),
      downloadDir
    ])
  })

  it('moves a completed header-named file into its type folder', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = {
      value: { ...defaultDownloadSettings(), sortDownloadsByType: true }
    }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/download?id=42'

    await manager.add({ url })
    const pending = itemByUrl(manager, url)
    expect(pending.dir).toBe(downloadDir)

    // aria2 learns the real name only from Content-Disposition.
    await mkdir(downloadDir, { recursive: true })
    const source = path.join(downloadDir, 'clip.mkv')
    await writeFile(source, 'video')
    aria2.setFile(pending.gid, source)
    aria2.setStatus(pending.gid, 'complete')
    await manager.refreshPolicy()

    const targetDirectory = path.join(downloadDir, 'Video')
    await vi.waitFor(() => {
      expect(itemByUrl(manager, url)).toMatchObject({
        dir: targetDirectory,
        filename: 'clip.mkv',
        filePath: path.join(targetDirectory, 'clip.mkv')
      })
    })
    await expect(stat(path.join(targetDirectory, 'clip.mkv'))).resolves.toMatchObject(
      { size: 5 }
    )
    await expect(stat(source)).rejects.toThrow()
    expect(database.loadAll()[0]?.record).toMatchObject({
      dir: targetDirectory,
      filename: 'clip.mkv'
    })
  })

  it('picks the type folder from sortFilename while keeping the temporary name', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = {
      value: { ...defaultDownloadSettings(), sortDownloadsByType: true }
    }
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )

    await manager.add({
      url: 'https://mega.example/encrypted',
      filename: 'movie.mp4.megaenc',
      sortFilename: 'movie.mp4'
    })

    const item = itemByUrl(manager, 'https://mega.example/encrypted')
    expect(item.dir).toBe(path.join(downloadDir, 'Video'))
    expect(item.filename).toBe('movie.mp4.megaenc')
  })

  it('never re-sorts a download that uses an explicitly picked folder', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = {
      value: { ...defaultDownloadSettings(), sortDownloadsByType: true }
    }
    const { manager } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const customDir = path.join(downloadDir, 'My Folder')

    await manager.addScanFile(
      { url: 'https://example.com/movie.mkv' },
      customDir
    )

    const item = itemByUrl(manager, 'https://example.com/movie.mkv')
    expect(item.dir).toBe(customDir)
    expect(item.dir).not.toBe(path.join(downloadDir, 'Video'))
  })
})
