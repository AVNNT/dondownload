import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { DownloadItem, DownloadStatus } from '../src/shared/types'
import {
  INTERRUPTED_MESSAGE,
  decideStartupRecovery
} from '../src/main/downloads/recovery'
import {
  DATABASE_FILENAME,
  SCHEMA_VERSION,
  openDownloadDatabase,
  resolveDownloadDatabasePath,
  type DownloadDatabase
} from '../src/main/db/database'

const tempDirs: string[] = []
const openDatabases: DownloadDatabase[] = []

async function makeDatabasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-db-'))
  tempDirs.push(dir)
  return path.join(dir, 'nested', DATABASE_FILENAME)
}

function open(filePath: string): DownloadDatabase {
  const database = openDownloadDatabase(filePath)
  openDatabases.push(database)
  return database
}

function close(database: DownloadDatabase): void {
  database.close()
  const index = openDatabases.indexOf(database)
  if (index >= 0) openDatabases.splice(index, 1)
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
    completedBytes: 250,
    speedBps: 100,
    etaSeconds: 8,
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
  for (const database of openDatabases.splice(0)) {
    try {
      database.close()
    } catch {
      // Best effort cleanup for a failing test.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('download database path', () => {
  it('uses a dedicated file under userData', () => {
    expect(resolveDownloadDatabasePath('C:\\Users\\Test\\AppData\\Roaming\\DonDownload')).toBe(
      path.join(
        'C:\\Users\\Test\\AppData\\Roaming\\DonDownload',
        DATABASE_FILENAME
      )
    )
  })
})

describe('download history persistence', () => {
  it('creates the database and records in a dedicated directory', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect((await stat(filePath)).isFile()).toBe(true)

    database.save({ record: sample(), explicitFilename: null })
    close(database)
  })

  it('persists progress and lifecycle fields across close/reopen', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    first.save({ record: sample(), explicitFilename: 'chosen-name.zip' })
    first.save({
      record: sample({
        status: 'complete',
        completedBytes: 1_000,
        speedBps: 0,
        etaSeconds: null,
        completedAt: Date.UTC(2026, 0, 2, 3, 10, 0),
        updatedAt: Date.UTC(2026, 0, 2, 3, 10, 0)
      }),
      explicitFilename: 'chosen-name.zip'
    })
    close(first)

    const second = open(filePath)
    const stored = second.loadAll()

    expect(stored).toHaveLength(1)
    expect(stored[0]?.record.status).toBe('complete')
    expect(stored[0]?.record.completedBytes).toBe(1_000)
    expect(stored[0]?.record.totalBytes).toBe(1_000)
    expect(stored[0]?.record.completedAt).toBe(Date.UTC(2026, 0, 2, 3, 10, 0))
    expect(stored[0]?.explicitFilename).toBe('chosen-name.zip')
    expect(stored[0]?.record.url).toBe('https://example.com/files/sample.zip')
    expect(stored[0]?.record.dir).toBe('C:\\Users\\Test\\Downloads\\DonDownload')
    expect(stored[0]?.record.filePath).toBe(
      'C:\\Users\\Test\\Downloads\\DonDownload\\sample.zip'
    )
    expect(stored[0]?.record.attempts).toBe(1)
    expect(stored[0]?.record.maxAttempts).toBe(3)
    // Transient values start fresh after a relaunch.
    expect(stored[0]?.record.speedBps).toBe(0)
    expect(stored[0]?.record.etaSeconds).toBeNull()
    close(second)
  })

  it('retains all history indefinitely, including very old records', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    const old = Date.UTC(2001, 0, 1)
    first.save({
      record: sample({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        gid: 'aaaaaaaaaaaaaaaa',
        url: 'https://example.com/very-old.bin',
        filename: 'very-old.bin',
        status: 'complete',
        totalBytes: 10,
        completedBytes: 10,
        createdAt: old,
        updatedAt: old,
        completedAt: old
      }),
      explicitFilename: null
    })
    first.save({
      record: sample({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        gid: 'bbbbbbbbbbbbbbbb',
        createdAt: Date.UTC(2026, 5, 1),
        updatedAt: Date.UTC(2026, 5, 1)
      }),
      explicitFilename: null
    })
    close(first)

    const second = open(filePath)
    const stored = second.loadAll()
    expect(stored).toHaveLength(2)
    expect(stored.some((entry) => entry.record.filename === 'very-old.bin')).toBe(true)
    close(second)
  })

  it('removes only the explicitly deleted row and never deletes files itself', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const first = sample()
    const second = sample({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gid: 'aaaaaaaaaaaaaaaa',
      filename: 'keep.bin'
    })
    database.save({ record: first, explicitFilename: null })
    database.save({ record: second, explicitFilename: null })

    database.delete(first.id)
    expect(database.loadAll().map((entry) => entry.record.id)).toEqual([second.id])
    close(database)
  })

  it('rolls back a batch when one entry violates the schema', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    expect(() =>
      database.saveMany([
        { record: sample(), explicitFilename: null },
        {
          record: sample({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            gid: 'aaaaaaaaaaaaaaaa',
            status: 'not-a-status' as DownloadStatus
          }),
          explicitFilename: null
        }
      ])
    ).toThrow()

    expect(database.loadAll()).toHaveLength(0)
    close(database)
  })

  it('persists conservative recovery transitions and leaves paused/terminal rows alone', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    const statuses: DownloadStatus[] = [
      'active',
      'queued',
      'waiting',
      'paused',
      'complete',
      'error'
    ]
    const records = statuses.map((status, index) =>
      sample({
        id: `0000000${index}-0000-4000-8000-00000000000${index}`,
        gid: String(index).repeat(16),
        filename: `${status}.bin`,
        status,
        completedAt: status === 'complete' ? Date.UTC(2026, 0, 2, 4, 0, 0) : null
      })
    )
    for (const record of records) {
      first.save({ record, explicitFilename: null })
    }

    // Simulate a new app process where aria2 has no matching GID.
    const now = Date.UTC(2026, 0, 3, 0, 0, 0)
    for (const record of records) {
      if (decideStartupRecovery(record.status, false) !== 'interrupt') continue
      record.status = 'interrupted'
      record.errorMessage = INTERRUPTED_MESSAGE
      record.updatedAt = now
      first.save({ record, explicitFilename: null })
    }
    close(first)

    const reopened = open(filePath)
    const stored = reopened.loadAll()
    const byFilename = new Map(
      stored.map((entry) => [entry.record.filename, entry.record])
    )

    expect(byFilename.get('active.bin')?.status).toBe('interrupted')
    expect(byFilename.get('queued.bin')?.status).toBe('interrupted')
    expect(byFilename.get('waiting.bin')?.status).toBe('interrupted')
    expect(byFilename.get('paused.bin')?.status).toBe('paused')
    expect(byFilename.get('complete.bin')?.status).toBe('complete')
    expect(byFilename.get('error.bin')?.status).toBe('error')
    expect(byFilename.get('active.bin')?.errorMessage).toBe(INTERRUPTED_MESSAGE)
    expect(stored).toHaveLength(statuses.length)
    close(reopened)
  })
})

describe('schema migrations', () => {
  it('migrates an empty database once and is idempotent on reopen', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })

    const raw = new DatabaseSync(filePath)
    raw.exec('CREATE TABLE unrelated (id INTEGER)')
    raw.close()

    const first = open(filePath)
    expect(first.schemaVersion).toBe(SCHEMA_VERSION)
    first.save({ record: sample(), explicitFilename: null })
    close(first)

    const second = open(filePath)
    expect(second.schemaVersion).toBe(SCHEMA_VERSION)
    expect(second.loadAll()).toHaveLength(1)
    close(second)
  })

  it('refuses a database written by a newer schema instead of corrupting it', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })

    const raw = new DatabaseSync(filePath)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()

    expect(() => openDownloadDatabase(filePath)).toThrow(/newer version/i)
  })
})
