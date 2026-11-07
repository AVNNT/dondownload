import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import {
  SCHEMA_VERSION,
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'

const tempDirs: string[] = []
const databases: DownloadDatabase[] = []

async function makeDatabasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-index-'))
  tempDirs.push(dir)
  return path.join(dir, 'downloads.sqlite3')
}

function open(filePath: string): DownloadDatabase {
  const database = openDownloadDatabase(filePath)
  databases.push(database)
  return database
}

function indexNames(database: DatabaseSync, table: string): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name"
      )
      .all(table) as { name: string }[]
  ).map((index) => index.name)
}

function plan(database: DatabaseSync, sql: string): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {
    detail?: string
  }[])
    .map((row) => row.detail ?? '')
    .join('\n')
}

function sampleRecord(overrides: Partial<DownloadItem> = {}): DownloadItem {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    gid: '0123456789abcdef',
    url: 'https://example.com/files/sample.zip',
    filename: 'sample.zip',
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 1_000,
    completedBytes: 250,
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
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Best effort cleanup.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('v17 history indexes', () => {
  it('creates the composite list indexes and keeps the connection pragmas', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(19)

    // Inspect the live connection that DownloadDatabase owns.
    const raw = (database as unknown as { db: DatabaseSync }).db
    expect(indexNames(raw, 'downloads')).toContain(
      'downloads_created_at_updated_at_idx'
    )
    expect(indexNames(raw, 'media_jobs')).toContain(
      'media_jobs_created_at_updated_at_idx'
    )
    expect(indexNames(raw, 'batches')).toContain(
      'batches_created_at_updated_at_idx'
    )
    expect(indexNames(raw, 'downloads')).toContain(
      'downloads_history_cleanup_idx'
    )
    expect(indexNames(raw, 'media_jobs')).toContain(
      'media_jobs_history_cleanup_idx'
    )
    expect(indexNames(raw, 'batches')).toContain(
      'batches_history_cleanup_idx'
    )

    expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({
      journal_mode: 'wal'
    })
    expect(raw.prepare('PRAGMA synchronous').get()).toMatchObject({
      synchronous: 1
    })
    expect(raw.prepare('PRAGMA busy_timeout').get()).toMatchObject({
      timeout: 5000
    })
    expect(raw.prepare('PRAGMA temp_store').get()).toMatchObject({
      temp_store: 2
    })
  })

  it('uses the composite index for the download list query', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const raw = (database as unknown as { db: DatabaseSync }).db

    const detail = plan(
      raw,
      'SELECT * FROM downloads ORDER BY created_at DESC, updated_at DESC'
    )
    expect(detail).toContain('downloads_created_at_updated_at_idx')
  })

  it('reuses cached statements instead of preparing on every save', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare')

    try {
      database.save({ record: sampleRecord(), explicitFilename: null })
      database.saveMany([
        {
          record: sampleRecord({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            gid: 'aaaaaaaaaaaaaaaa'
          }),
          explicitFilename: null
        }
      ])
      database.loadAll()
      expect(prepareSpy).not.toHaveBeenCalled()
    } finally {
      prepareSpy.mockRestore()
    }
  })

  it('re-adds the v17 indexes and adds checksum columns when upgrading a v16 database', async () => {
    const filePath = await makeDatabasePath()
    open(filePath).close()

    const raw = new DatabaseSync(filePath)
    raw.exec('DROP INDEX downloads_created_at_updated_at_idx')
    raw.exec('DROP INDEX media_jobs_created_at_updated_at_idx')
    raw.exec('DROP INDEX batches_created_at_updated_at_idx')
    raw.exec('DROP INDEX downloads_history_cleanup_idx')
    raw.exec('DROP INDEX media_jobs_history_cleanup_idx')
    raw.exec('DROP INDEX batches_history_cleanup_idx')
    raw.exec('ALTER TABLE download_settings DROP COLUMN history_retention_days')
    raw.exec('ALTER TABLE downloads DROP COLUMN checksum_algorithm')
    raw.exec('ALTER TABLE downloads DROP COLUMN checksum_ok')
    raw.exec('ALTER TABLE downloads DROP COLUMN checksum_computed')
    raw.exec('ALTER TABLE downloads DROP COLUMN checksum_checked_at')
    raw.exec('PRAGMA user_version = 16')
    raw.close()

    const upgraded = open(filePath)
    expect(upgraded.schemaVersion).toBe(19)
    const verify = (upgraded as unknown as { db: DatabaseSync }).db
    expect(indexNames(verify, 'downloads')).toContain(
      'downloads_created_at_updated_at_idx'
    )
    expect(indexNames(verify, 'media_jobs')).toContain(
      'media_jobs_created_at_updated_at_idx'
    )
    expect(indexNames(verify, 'batches')).toContain(
      'batches_created_at_updated_at_idx'
    )
    expect(indexNames(verify, 'downloads')).toContain(
      'downloads_history_cleanup_idx'
    )
    expect(indexNames(verify, 'media_jobs')).toContain(
      'media_jobs_history_cleanup_idx'
    )
    expect(indexNames(verify, 'batches')).toContain(
      'batches_history_cleanup_idx'
    )
    const downloadColumns = (
      verify.prepare('PRAGMA table_info(downloads)').all() as { name: string }[]
    ).map((column) => column.name)
    expect(downloadColumns).toEqual(
      expect.arrayContaining([
        'checksum_algorithm',
        'checksum_ok',
        'checksum_computed',
        'checksum_checked_at'
      ])
    )
  })
})
