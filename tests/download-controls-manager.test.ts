import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State, DownloadItem } from '../src/shared/types'
import {
  defaultDownloadSettings,
  type DownloadControls,
  type DownloadSettings
} from '../src/shared/settings'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import { BatchManager } from '../src/main/batches/manager'
import { DownloadManager } from '../src/main/downloads/manager'
import { AppError } from '../src/main/errors'

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
  settings: SettingsRef
): { manager: DownloadManager; aria2: FakeAria2 } {
  const aria2 = new FakeAria2()
  const manager = new DownloadManager(
    aria2.asService(),
    downloadDir,
    () => undefined,
    database,
    { now: () => clock.value, settings: () => settings.value }
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
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
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

    // The scheduled retry re-adds the job after the backoff.
    await vi.waitFor(
      () => expect(itemByUrl(manager, url).attempts).toBe(2),
      { timeout: 5_000 }
    )
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
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: at(9, 30) }
    const settings = { value: settingsWithHours(false) }
    const { manager, aria2 } = createManager(
      database,
      downloadDir,
      clock,
      settings
    )
    const url = 'https://example.com/removed.bin'

    await manager.add({ url })
    const item = itemByUrl(manager, url)
    aria2.fail(item.gid, 5, 'Too slow')

    await manager.refreshPolicy()
    expect(itemByUrl(manager, url).retryAt).not.toBeNull()

    await manager.remove(item.id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(manager.getSnapshot().downloads).toHaveLength(0)
    expect(aria2.addUriCalls).toHaveLength(1)
  })
})
