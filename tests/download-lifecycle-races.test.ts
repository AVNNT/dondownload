import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { AppSnapshot, Aria2State, DownloadItem } from '../src/shared/types'
import { defaultDownloadSettings } from '../src/shared/settings'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import {
  DownloadManager,
  type CookieTargetResolver
} from '../src/main/downloads/manager'
import { NEEDS_LOGIN_MESSAGE } from '../src/main/downloads/recovery'
import { AppError } from '../src/main/errors'

interface FakeCall {
  method: string
  params: unknown[]
}

interface TrackedStatus {
  gid: string
  status: string
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
  /**
   * Runs once inside the next `aria2.unpause` call, on either side of the
   * reply. It simulates a Remove that wins the race while the control action
   * is in flight.
   */
  duringNextUnpause: (() => Promise<void>) | null = null

  get addUriCalls(): FakeCall[] {
    return this.calls.filter((call) => call.method === 'aria2.addUri')
  }

  setProgress(gid: string, completedLength: number, totalLength: number): void {
    const tracked = this.tracked.get(gid)
    if (!tracked) return
    tracked.completedLength = String(completedLength)
    tracked.totalLength = String(totalLength)
  }

  private addTracked(gid: string): void {
    this.tracked.set(gid, {
      gid,
      status: 'waiting',
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      errorCode: '0',
      errorMessage: '',
      files: []
    })
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
              case 'aria2.getGlobalStat':
                return [{ numActive: '0', numWaiting: '0', numStopped: '0' }]
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
          const racing = this.duringNextUnpause
          if (racing) {
            this.duringNextUnpause = null
            await racing()
          }
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

const tempDirs: string[] = []
const managers: DownloadManager[] = []
const databases: DownloadDatabase[] = []

async function makeWorkspace(): Promise<{
  database: DownloadDatabase
  downloadDir: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-lifecycle-'))
  tempDirs.push(dir)
  const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
  databases.push(database)
  return { database, downloadDir: path.join(dir, 'downloads') }
}

interface Harness {
  manager: DownloadManager
  aria2: FakeAria2
  database: DownloadDatabase
  downloadDir: string
  updates: AppSnapshot[]
}

function createManager(
  database: DownloadDatabase,
  downloadDir: string,
  options: { resolveCookieTarget?: CookieTargetResolver } = {}
): Harness {
  const aria2 = new FakeAria2()
  const updates: AppSnapshot[] = []
  const manager = new DownloadManager(
    aria2.asService(),
    downloadDir,
    (snapshot) => updates.push(snapshot),
    database,
    {
      settings: () => defaultDownloadSettings(),
      ...(options.resolveCookieTarget === undefined
        ? {}
        : { resolveCookieTarget: options.resolveCookieTarget })
    }
  )
  managers.push(manager)
  return { manager, aria2, database, downloadDir, updates }
}

function onlyItem(manager: DownloadManager): DownloadItem {
  const items = manager.getSnapshot().downloads
  if (items.length !== 1) throw new Error(`expected one item, got ${items.length}`)
  return items[0] as DownloadItem
}

/** Seed a row directly in SQLite, as an earlier process would have persisted it. */
function seed(database: DownloadDatabase, record: DownloadItem, needsLogin: boolean): void {
  database.save({ record, explicitFilename: record.filename, needsLogin })
}

function seedRecord(overrides: Partial<DownloadItem>): DownloadItem {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0)
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gid: '',
    url: 'https://example.com/files/seeded.bin',
    filename: 'seeded.bin',
    dir: '',
    filePath: null,
    status: 'interrupted',
    totalBytes: 0,
    completedBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides
  }
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      manager.close()
    } catch {
      // Best effort cleanup.
    }
  }
  databases.splice(0)
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('lifecycle races with aria2', () => {
  const COOKIE = 'forum_session=secret'
  const cookieTarget: CookieTargetResolver = async (input) => ({
    finalUrl: input.resolvedUrl ?? input.url
  })

  it('H1: Resume does not resurrect a record removed while aria2 was being reached', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const harness = createManager(database, downloadDir)
    await harness.manager.add({ url: 'https://example.com/files/race.bin' })
    const item = onlyItem(harness.manager)
    expect(item.gid).not.toBe('')

    // Remove wins the race inside Complete: the control call returns after the
    // row is gone, exactly like a click that lands during the await.
    harness.aria2.duringNextUnpause = async () => {
      await harness.manager.remove(item.id)
    }
    await harness.manager.resume(item.id)

    expect(harness.manager.getSnapshot().downloads).toEqual([])
    expect(harness.manager.getItem(item.id)).toBeNull()
    expect(database.loadAll()).toEqual([])
  })

  it('H1: a removed record is not re-added to aria2 by Start Now', async () => {
    vi.useFakeTimers()
    try {
      const { database, downloadDir } = await makeWorkspace()
      const clock = { value: new Date(2026, 10, 4, 9, 30).getTime() }
      const aria2 = new FakeAria2()
      const updates: AppSnapshot[] = []
      const manager = new DownloadManager(
        aria2.asService(),
        downloadDir,
        (snapshot) => updates.push(snapshot),
        database,
        {
          now: () => clock.value,
          settings: () => ({
            ...defaultDownloadSettings(),
            allowedHours: { enabled: true, start: '09:00', end: '10:00' }
          })
        }
      )
      managers.push(manager)

      // Outside hours: held as waiting with no GID at all.
      clock.value = new Date(2026, 10, 4, 18, 0).getTime()
      await manager.add({ url: 'https://example.com/files/held.bin' })
      const held = onlyItem(manager)
      expect(held).toMatchObject({ status: 'waiting', gid: '' })
      clock.value = new Date(2026, 10, 4, 9, 30).getTime()

      // The directory step yields (mkdir), which is where a Remove can land
      // before the record is handed to aria2.
      const originalMkdir = fs.promises.mkdir
      const mkdirSpy = vi
        .spyOn(fs.promises, 'mkdir')
        .mockImplementation((async (
          target: Parameters<typeof originalMkdir>[0],
          options: Parameters<typeof originalMkdir>[1]
        ) => {
          await originalMkdir(target, options)
          // A second click racing the first is a no-op, not a failure.
          await manager.remove(held.id).catch(() => undefined)
        }) as typeof originalMkdir)
      try {
        await manager.startNow(held.id)
      } finally {
        mkdirSpy.mockRestore()
      }

      expect(manager.getSnapshot().downloads).toEqual([])
      expect(database.loadAll()).toEqual([])
      expect(aria2.addUriCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('H2: reconcile fails a login-only job when no live cookie is held', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const record = seedRecord({
      gid: 'bbbbbbbbbbbbbbbb',
      url: 'https://discuss.example/uploads/secret.bin',
      filename: 'secret.bin',
      dir: downloadDir,
      status: 'waiting'
    })
    seed(database, record, true)

    const harness = createManager(database, downloadDir, {
      resolveCookieTarget: cookieTarget
    })
    await harness.manager.reconcileDownloads()

    const item = onlyItem(harness.manager)
    expect(item).toMatchObject({
      status: 'error',
      gid: '',
      errorMessage: NEEDS_LOGIN_MESSAGE
    })
    expect(database.loadAll()[0]?.needsLogin).toBe(true)
  })

  it('H2: reconcile keeps a cookie job that still holds live credentials', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const harness = createManager(database, downloadDir, {
      resolveCookieTarget: cookieTarget
    })
    await harness.manager.add({
      url: 'https://discuss.example/uploads/live.bin',
      filename: 'live.bin',
      requestHeaders: { cookie: COOKIE }
    })
    const item = onlyItem(harness.manager)
    expect(item.status).toBe('queued')

    // The same aria2 process "restarts": it no longer knows the GID, but the
    // one-job cookie is still held in memory by this process.
    harness.aria2.tracked.clear()
    await harness.manager.reconcileDownloads()

    const reconciled = onlyItem(harness.manager)
    expect(reconciled.id).toBe(item.id)
    expect(reconciled.status).toBe('interrupted')
    expect(reconciled.errorMessage).not.toBe(NEEDS_LOGIN_MESSAGE)
  })

  it('H2: Retry of a login-only job is still refused without a live cookie', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const record = seedRecord({
      url: 'https://discuss.example/uploads/secret.bin',
      filename: 'secret.bin',
      dir: downloadDir,
      status: 'error'
    })
    seed(database, record, true)
    const harness = createManager(database, downloadDir, {
      resolveCookieTarget: cookieTarget
    })

    await expect(harness.manager.retry(record.id)).rejects.toMatchObject({
      code: 'HANDOFF_NEEDS_BROWSER_LOGIN'
    })
    expect(harness.aria2.addUriCalls).toHaveLength(0)
  })
})

describe('retry re-add keeps the partial file', () => {
  it('H5: Retry disables auto-renaming and continues the existing partial', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const harness = createManager(database, downloadDir)
    await mkdir(downloadDir, { recursive: true })
    await harness.manager.add({
      url: 'https://example.com/files/partial.bin',
      filename: 'partial.bin'
    })
    const added = onlyItem(harness.manager)

    // aria2 reported 400 of 1 000 bytes and the partial is on disk.
    harness.aria2.setProgress(added.gid, 400, 1_000)
    await harness.manager.refreshPolicy()
    await writeFile(path.join(downloadDir, 'partial.bin'), Buffer.alloc(400, 1))
    await harness.manager.cancel(added.id)

    const retryCallsBefore = harness.aria2.addUriCalls.length
    await harness.manager.retry(added.id)

    // Cancel clears the progress the row reported (the bytes live in aria2's
    // control file), so the partial was a fresh restart in the same file. The
    // retry still touches exactly the reported name and nothing else.
    const readd = harness.aria2.addUriCalls[retryCallsBefore]
    expect(readd).toBeDefined()
    const options = readd?.params[1] as Record<string, string>
    expect(options.out).toBe('partial.bin')
    expect(options['auto-file-renaming']).toBe('true')
    expect(options.continue).toBe('true')
    expect(options['allow-overwrite']).toBe('false')
    // The row points at the new GID and still reports the same output name.
    const item = onlyItem(harness.manager)
    expect(item).toMatchObject({ status: 'queued', filename: 'partial.bin' })
    expect(item.gid).not.toBe(added.gid)
  })

  it('H5: keeps aria2 auto-renaming for a genuinely new download', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const harness = createManager(database, downloadDir)
    await harness.manager.add({
      url: 'https://example.com/files/new.bin',
      filename: 'new.bin'
    })
    const options = harness.aria2.addUriCalls[0]?.params[1] as Record<
      string,
      string
    >
    expect(options.out).toBe('new.bin')
    expect(options['auto-file-renaming']).toBe('true')
  })

  it('H5: never overwrites an unrelated file whose name the record reuses', async () => {
    const { database, downloadDir } = await makeWorkspace()
    await mkdir(downloadDir, { recursive: true })
    const unrelated = path.join(downloadDir, 'reused.bin')
    // A finished copy of the same name holds at least the whole file.
    await writeFile(unrelated, Buffer.alloc(2_000, 7))
    const record = seedRecord({
      filename: 'reused.bin',
      dir: downloadDir,
      status: 'error',
      totalBytes: 1_000,
      completedBytes: 400
    })
    seed(database, record, false)
    const harness = createManager(database, downloadDir)

    await harness.manager.retry(record.id)

    const options = harness.aria2.addUriCalls[0]?.params[1] as Record<
      string,
      string
    >
    expect(options.out).toBe('reused.bin')
    expect(options['allow-overwrite']).toBe('false')
    // The file is larger than the total aria2 reported, so it is a finished
    // copy, not this job's partial: never continue (and rewrite) it. The file
    // itself is left exactly as it was.
    expect(options['auto-file-renaming']).toBe('true')
    const untouched = await readFile(unrelated)
    expect(untouched.equals(Buffer.alloc(2_000, 7))).toBe(true)
  })

  it('H5: a failed job continues its own smaller partial under the same name', async () => {
    const { database, downloadDir } = await makeWorkspace()
    await mkdir(downloadDir, { recursive: true })
    await writeFile(path.join(downloadDir, 'partial.bin'), Buffer.alloc(150, 1))
    const record = seedRecord({
      filename: 'partial.bin',
      dir: downloadDir,
      status: 'error',
      totalBytes: 1_000,
      completedBytes: 400
    })
    seed(database, record, false)
    const harness = createManager(database, downloadDir)

    await harness.manager.retry(record.id)

    const options = harness.aria2.addUriCalls[0]?.params[1] as Record<
      string,
      string
    >
    expect(options.out).toBe('partial.bin')
    expect(options['auto-file-renaming']).toBe('false')
    expect(options.continue).toBe('true')
  })
})
