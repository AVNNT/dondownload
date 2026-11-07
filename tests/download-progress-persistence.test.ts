import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State } from '../src/shared/types'
import { defaultDownloadSettings } from '../src/shared/settings'
import type { Aria2Service } from '../src/main/aria2/service'
import { DownloadManager } from '../src/main/downloads/manager'
import {
  openDownloadDatabase,
  type DownloadDatabase,
  type DownloadSaveEntry
} from '../src/main/db/database'
import { AppError } from '../src/main/errors'

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
  readonly tracked = new Map<string, TrackedStatus>()
  private nextGid = 1

  setStatus(gid: string, status: string): void {
    const tracked = this.tracked.get(gid)
    if (tracked) tracked.status = status
  }

  setProgress(gid: string, completedLength: number): void {
    const tracked = this.tracked.get(gid)
    if (tracked) tracked.completedLength = String(completedLength)
  }

  private addTracked(gid: string): void {
    this.tracked.set(gid, {
      gid,
      status: 'waiting',
      dir: '',
      totalLength: '1000',
      completedLength: '0',
      downloadSpeed: '0',
      errorCode: '0',
      errorMessage: '',
      files: []
    })
  }

  readonly client = {
    call: async (method: string, params: unknown[] = []): Promise<unknown> => {
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
                return [{ numActive: '0', numWaiting: '0' }]
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
        case 'aria2.pause':
        case 'aria2.unpause':
        case 'aria2.forceRemove':
        case 'aria2.removeDownloadResult':
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-progress-'))
  tempDirs.push(dir)
  const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
  databases.push(database)
  return { database, downloadDir: path.join(dir, 'downloads') }
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
  vi.useRealTimers()
})

describe('progress persistence batching', () => {
  it('writes every changed active row in one transaction and skips unchanged rows', async () => {
    vi.useFakeTimers()
    const { database, downloadDir } = await makeWorkspace()
    const clock = { value: Date.UTC(2026, 10, 4, 12, 0, 0) }
    const aria2 = new FakeAria2()
    const manager = new DownloadManager(
      aria2.asService(),
      downloadDir,
      () => undefined,
      database,
      { now: () => clock.value, settings: () => defaultDownloadSettings() }
    )
    managers.push(manager)

    try {
      await manager.add({ url: 'https://example.com/one.bin' })
      await manager.add({ url: 'https://example.com/two.bin' })
      const [first, second] = manager.getSnapshot().downloads
      if (!first || !second) throw new Error('missing downloads')

      aria2.setStatus(first.gid, 'active')
      aria2.setProgress(first.gid, 100)
      aria2.setStatus(second.gid, 'active')
      aria2.setProgress(second.gid, 200)

      // First tick observes the status transition, which persists immediately.
      await manager.refreshPolicy()
      expect(manager.getSnapshot().downloads.map((item) => item.status)).toEqual([
        'active',
        'active'
      ])

      // Progress-only changes are the cheap path: they are coalesced.
      aria2.setProgress(first.gid, 110)
      aria2.setProgress(second.gid, 210)
      await manager.refreshPolicy()

      const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec')
      const saveSpy = vi.spyOn(database, 'saveMany')
      execSpy.mockClear()
      saveSpy.mockClear()

      // One flush interval: both rows changed, so all go in one transaction.
      await vi.advanceTimersByTimeAsync(2_500)
      expect(saveSpy).toHaveBeenCalledTimes(1)
      const entries = saveSpy.mock.calls[0]?.[0] as DownloadSaveEntry[]
      expect(entries).toHaveLength(2)
      const begins = execSpy.mock.calls.filter(([sql]) =>
        String(sql).startsWith('BEGIN IMMEDIATE')
      )
      expect(begins).toHaveLength(1)

      // A tick with identical progress dirties nothing and performs no write.
      saveSpy.mockClear()
      execSpy.mockClear()
      await manager.refreshPolicy()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(saveSpy).not.toHaveBeenCalled()

      // Only the row whose values changed is written.
      aria2.setProgress(first.gid, 300)
      await manager.refreshPolicy()
      saveSpy.mockClear()
      execSpy.mockClear()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(saveSpy).toHaveBeenCalledTimes(1)
      const changed = saveSpy.mock.calls[0]?.[0] as DownloadSaveEntry[]
      expect(changed).toHaveLength(1)
      expect(changed[0]?.record.id).toBe(first.id)
      expect(
        execSpy.mock.calls.filter(([sql]) =>
          String(sql).startsWith('BEGIN IMMEDIATE')
        )
      ).toHaveLength(1)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
