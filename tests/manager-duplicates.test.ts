import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State, DownloadItem, DownloadStatus } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import { AppError } from '../src/main/errors'

const tempDirs: string[] = []
const managers: DownloadManager[] = []

interface AddCall {
  url: string
  options: Record<string, string>
}

async function makeWorkspace(): Promise<{
  database: DownloadDatabase
  downloadDir: string
  databasePath: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-duplicates-'))
  tempDirs.push(dir)
  const databasePath = path.join(dir, 'downloads.sqlite3')
  return {
    database: openDownloadDatabase(databasePath),
    downloadDir: path.join(dir, 'downloads'),
    databasePath
  }
}

function createManager(
  database: DownloadDatabase,
  downloadDir: string,
  options: { addDelayMs?: number } = {}
): { manager: DownloadManager; calls: AddCall[] } {
  const calls: AddCall[] = []
  let nextGid = 0
  const state: Aria2State = {
    status: 'ready',
    version: 'test-aria2',
    binaryPath: null,
    message: null,
    hint: null
  }

  const client = {
    call: async (method: string, params: unknown[]): Promise<unknown> => {
      if (method !== 'aria2.addUri') {
        throw new AppError('ARIA2_RPC_ERROR', `Unexpected method ${method}`)
      }
      const urls = params[0] as string[]
      calls.push({
        url: urls[0] ?? '',
        options: (params[1] as Record<string, string>) ?? {}
      })
      if (options.addDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.addDelayMs))
      }
      nextGid += 1
      return nextGid.toString(16).padStart(16, '0')
    }
  }

  const aria2 = {
    getState: () => ({ ...state }),
    getReadyClient: () => client,
    getClient: async () => client,
    start: async () => client,
    stop: async () => undefined,
    restart: async () => undefined
  } as unknown as Aria2Service

  const manager = new DownloadManager(
    aria2,
    downloadDir,
    () => undefined,
    database
  )
  managers.push(manager)
  return { manager, calls }
}

function storedRecord(
  overrides: Partial<DownloadItem> = {}
): DownloadItem {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    gid: '0123456789abcdef',
    url: 'https://example.com/files/sample.zip',
    filename: 'sample.zip',
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload',
    filePath: null,
    status: 'complete',
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
      // Best effort for a failing test.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('DownloadManager duplicate policy', () => {
  it('rejects an exact normalized duplicate without a new aria2 GID or history row', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir)

    await manager.add({
      url: 'https://example.com/files/sample.zip#first-fragment'
    })
    await expect(
      manager.add({ url: '  https://example.com/files/sample.zip#second  ' })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_DOWNLOAD'
    })

    expect(calls).toHaveLength(1)
    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(database.loadAll()).toHaveLength(1)
  })

  it.each<DownloadStatus>(['queued', 'active', 'waiting', 'paused'])(
    'treats a prior %s record as an unfinished duplicate',
    async (status) => {
      const { database, downloadDir } = await makeWorkspace()
      database.save({
        record: storedRecord({
          url: 'https://example.com/files/blocked.zip',
          status
        }),
        explicitFilename: null
      })
      const { manager, calls } = createManager(database, downloadDir)

      await expect(
        manager.add({ url: 'https://example.com/files/blocked.zip' })
      ).rejects.toMatchObject({ code: 'DUPLICATE_DOWNLOAD' })

      expect(calls).toHaveLength(0)
      expect(manager.getSnapshot().downloads).toHaveLength(1)
      expect(database.loadAll()).toHaveLength(1)
    }
  )

  it('force creates a new job for the same URL', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir)
    const url = 'https://example.com/files/force.zip'

    await manager.add({ url })
    await manager.add({ url, force: true })

    const downloads = manager.getSnapshot().downloads
    expect(downloads).toHaveLength(2)
    expect(new Set(downloads.map((download) => download.id)).size).toBe(2)
    expect(new Set(downloads.map((download) => download.gid)).size).toBe(2)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.url)).toEqual([url, url])
    expect(database.loadAll()).toHaveLength(2)
  })

  it('accepts a different exact URL', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir)

    await manager.add({ url: 'https://example.com/files/sample.zip' })
    await manager.add({ url: 'https://example.com/files/sample.zip?v=2' })

    expect(calls).toHaveLength(2)
    expect(manager.getSnapshot().downloads).toHaveLength(2)
  })

  it.each<DownloadStatus>(['complete', 'error', 'cancelled', 'interrupted'])(
    'does not let a prior %s record block a new job',
    async (status) => {
      const { database, downloadDir } = await makeWorkspace()
      database.save({
        record: storedRecord({
          url: 'https://example.com/files/terminal.zip',
          status
        }),
        explicitFilename: null
      })
      const { manager, calls } = createManager(database, downloadDir)

      await manager.add({ url: 'https://example.com/files/terminal.zip' })

      expect(calls).toHaveLength(1)
      expect(manager.getSnapshot().downloads).toHaveLength(2)
      expect(database.loadAll()).toHaveLength(2)
    }
  )

  it('never lets concurrent identical adds create two jobs', async () => {
    const { database, downloadDir } = await makeWorkspace()
    const { manager, calls } = createManager(database, downloadDir, {
      addDelayMs: 25
    })
    const url = 'https://example.com/files/concurrent.zip'

    const results = await Promise.allSettled([
      manager.add({ url }),
      manager.add({ url })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toBeDefined()
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toMatchObject({ code: 'DUPLICATE_DOWNLOAD' })
    }

    expect(calls).toHaveLength(1)
    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(database.loadAll()).toHaveLength(1)
  })
})
