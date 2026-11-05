import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State, DownloadItem } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import { INTERRUPTED_MESSAGE } from '../src/main/downloads/recovery'
import { AppError } from '../src/main/errors'

const tempDirs: string[] = []
const managers: DownloadManager[] = []

async function makeDatabasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-manager-'))
  tempDirs.push(dir)
  return path.join(dir, 'downloads.sqlite3')
}

function open(filePath: string): DownloadDatabase {
  return openDownloadDatabase(filePath)
}

function createManager(
  database: DownloadDatabase,
  options: {
    ready?: boolean
    tracked?: Map<string, unknown>
    calls?: string[]
    failure?: Error
  } = {}
): DownloadManager {
  const ready = options.ready ?? true
  const tracked = options.tracked ?? new Map<string, unknown>()
  const calls = options.calls ?? []
  const state: Aria2State = {
    status: ready ? 'ready' : 'unavailable',
    version: ready ? 'test-aria2' : null,
    binaryPath: null,
    message: ready ? null : 'aria2 is unavailable for this test',
    hint: null
  }
  const client = {
    call: async (method: string, params: unknown[]): Promise<unknown> => {
      calls.push(method)
      if (options.failure) throw options.failure
      if (method !== 'aria2.tellStatus') {
        throw new AppError('ARIA2_RPC_ERROR', `Unexpected method ${method}`)
      }
      const found = tracked.get(String(params[0]))
      if (!found) {
        throw new AppError('ARIA2_RPC_ERROR', 'GID is not found.')
      }
      return found
    }
  }

  const aria2 = {
    getState: () => ({ ...state }),
    getReadyClient: () => (ready ? client : null),
    getClient: async () => client,
    start: async () => client,
    stop: async () => undefined,
    restart: async () => undefined
  } as unknown as Aria2Service

  const manager = new DownloadManager(
    aria2,
    'C:\\Users\\Test\\Downloads\\DonDownload',
    () => undefined,
    database
  )
  managers.push(manager)
  return manager
}

function sample(overrides: Partial<DownloadItem> = {}): DownloadItem {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    gid: '0123456789abcdef',
    url: 'https://example.com/files/sample.zip',
    filename: 'sample.zip',
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload',
    filePath: 'C:\\Users\\Test\\Downloads\\DonDownload\\sample.zip',
    status: 'active',
    totalBytes: 1_000,
    completedBytes: 400,
    speedBps: 100,
    etaSeconds: 6,
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

describe('DownloadManager startup recovery', () => {
  it('marks a runtime-lost GID interrupted without consuming an attempt', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const record = sample({ filename: 'runtime-lost.bin', status: 'active', attempts: 2 })
    database.save({ record, explicitFilename: null })
    const manager = createManager(database)

    await manager.refreshPolicy()

    expect(manager.getSnapshot().downloads[0]).toMatchObject({
      status: 'interrupted',
      attempts: 2,
      errorMessage: INTERRUPTED_MESSAGE,
      completedBytes: record.completedBytes
    })
    expect(database.loadAll()[0]?.record.status).toBe('interrupted')
    expect(database.loadAll()[0]?.record.attempts).toBe(2)
  })

  it('preserves in-flight records when aria2 is unavailable or its status lookup fails transiently', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const record = sample({ filename: 'ambiguous.bin', status: 'active' })
    database.save({ record, explicitFilename: null })

    const unavailable = createManager(database, { ready: false })
    await unavailable.reconcileDownloads()
    expect(unavailable.getSnapshot().downloads[0]).toMatchObject({
      status: 'active',
      gid: record.gid,
      completedBytes: record.completedBytes
    })

    unavailable.close()
    const reopened = open(filePath)
    const transientFailure = createManager(reopened, {
      failure: new AppError('ARIA2_RPC_ERROR', 'Temporary RPC transport timeout.')
    })
    await transientFailure.reconcileDownloads()
    expect(transientFailure.getSnapshot().downloads[0]).toMatchObject({
      status: 'active',
      gid: record.gid,
      completedBytes: record.completedBytes
    })
    expect(reopened.loadAll()[0]?.record.status).toBe('active')
  })

  it('marks lost in-flight records interrupted, keeps paused and terminal history', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const records = [
      sample({
        id: '11111111-1111-4111-8111-111111111111',
        gid: '1111111111111111',
        filename: 'active.bin',
        status: 'active'
      }),
      sample({
        id: '22222222-2222-4222-8222-222222222222',
        gid: '2222222222222222',
        filename: 'queued.bin',
        status: 'queued'
      }),
      sample({
        id: '33333333-3333-4333-8333-333333333333',
        gid: '3333333333333333',
        filename: 'paused.bin',
        status: 'paused'
      }),
      sample({
        id: '44444444-4444-4444-8444-444444444444',
        gid: '4444444444444444',
        filename: 'complete.bin',
        status: 'complete',
        completedBytes: 1_000,
        completedAt: Date.UTC(2026, 0, 2, 4, 0, 0)
      }),
      sample({
        id: '55555555-5555-4555-8555-555555555555',
        gid: '5555555555555555',
        filename: 'error.bin',
        status: 'error',
        errorMessage: 'Network error'
      })
    ]
    for (const record of records) {
      database.save({ record, explicitFilename: null })
    }

    const manager = createManager(database)
    await manager.reconcileDownloads()

    const snapshot = new Map(
      manager.getSnapshot().downloads.map((record) => [record.filename, record])
    )
    expect(snapshot.get('active.bin')?.status).toBe('interrupted')
    expect(snapshot.get('queued.bin')?.status).toBe('interrupted')
    expect(snapshot.get('active.bin')?.errorMessage).toBe(INTERRUPTED_MESSAGE)
    expect(snapshot.get('paused.bin')?.status).toBe('paused')
    expect(snapshot.get('complete.bin')?.status).toBe('complete')
    expect(snapshot.get('error.bin')?.status).toBe('error')

    manager.close()
    const reopened = open(filePath)
    const stored = new Map(
      reopened.loadAll().map((entry) => [entry.record.filename, entry.record])
    )
    expect(stored.get('active.bin')?.status).toBe('interrupted')
    expect(stored.get('queued.bin')?.status).toBe('interrupted')
    expect(stored.get('paused.bin')?.status).toBe('paused')
    expect(stored.get('complete.bin')?.status).toBe('complete')
    expect(stored.get('error.bin')?.status).toBe('error')
    reopened.close()
  })

  it('reattaches a GID that aria2 still tracks and persists refreshed progress', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const record = sample({
      id: '66666666-6666-4666-8666-666666666666',
      gid: '6666666666666666',
      filename: 'reattach.bin',
      status: 'active',
      completedBytes: 100
    })
    database.save({ record, explicitFilename: null })

    const tracked = new Map<string, unknown>([
      [
        record.gid,
        {
          gid: record.gid,
          status: 'active',
          dir: record.dir,
          totalLength: '2000',
          completedLength: '1500',
          downloadSpeed: '250',
          errorCode: '0',
          errorMessage: '',
          files: [
            {
              path: record.filePath,
              length: '2000',
              completedLength: '1500'
            }
          ]
        }
      ]
    ])
    const manager = createManager(database, { tracked })
    await manager.reconcileDownloads()

    const reattached = manager.getSnapshot().downloads[0]
    expect(reattached?.status).toBe('active')
    expect(reattached?.totalBytes).toBe(2_000)
    expect(reattached?.completedBytes).toBe(1_500)

    manager.close()
    const reopened = open(filePath)
    const stored = reopened.loadAll()[0]?.record
    expect(stored?.status).toBe('active')
    expect(stored?.totalBytes).toBe(2_000)
    expect(stored?.completedBytes).toBe(1_500)
    reopened.close()
  })

  it('keeps a persisted paused record paused when aria2 still tracks its GID', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const record = sample({
      id: '77777777-7777-4777-8777-777777777777',
      gid: '7777777777777777',
      filename: 'paused-tracked.bin',
      status: 'paused',
      completedBytes: 400,
      speedBps: 0,
      etaSeconds: null
    })
    database.save({ record, explicitFilename: null })

    const tracked = new Map<string, unknown>([
      [
        record.gid,
        {
          gid: record.gid,
          status: 'active',
          dir: record.dir,
          totalLength: '2000',
          completedLength: '1500',
          downloadSpeed: '250',
          errorCode: '0',
          errorMessage: '',
          files: [
            {
              path: record.filePath,
              length: '2000',
              completedLength: '1500'
            }
          ]
        }
      ]
    ])
    const calls: string[] = []
    const manager = createManager(database, { tracked, calls })
    await manager.reconcileDownloads()

    const recovered = manager.getSnapshot().downloads[0]
    expect(recovered?.status).toBe('paused')
    expect(recovered?.speedBps).toBe(0)
    expect(recovered?.etaSeconds).toBeNull()
    // The tracked active status is intentionally not applied, so stale or
    // aria2-side progress is not mistaken for a resumed download.
    expect(recovered?.completedBytes).toBe(400)

    // Reconciliation only inspected status: it never unpaused, paused or
    // re-added the transfer, so no resume/network traffic was triggered.
    expect(calls).toEqual(['aria2.tellStatus'])

    manager.close()
    const reopened = open(filePath)
    const stored = reopened.loadAll()[0]?.record
    expect(stored?.status).toBe('paused')
    expect(stored?.completedBytes).toBe(400)
    reopened.close()
  })
})
