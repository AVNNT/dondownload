import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { DownloadItem, DownloadStatus } from '../src/shared/types'
import type { MediaJobRecord, MediaJobStatus } from '../src/shared/media'
import {
  INTERRUPTED_MESSAGE,
  decideStartupRecovery
} from '../src/main/downloads/recovery'
import {
  DATABASE_FILENAME,
  MIGRATIONS,
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

const V1_DOWNLOADS_SCHEMA = `
  CREATE TABLE downloads (
    id TEXT PRIMARY KEY NOT NULL,
    gid TEXT NOT NULL,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    explicit_filename TEXT,
    dir TEXT NOT NULL,
    file_path TEXT,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'active', 'waiting', 'paused',
        'complete', 'error', 'interrupted'
      )
    ),
    total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
    completed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (completed_bytes >= 0),
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX downloads_created_at_idx ON downloads (created_at DESC);
  CREATE INDEX downloads_status_idx ON downloads (status);
`

function mediaRecord(overrides: Partial<MediaJobRecord> = {}): MediaJobRecord {
  const now = Date.UTC(2026, 1, 3, 4, 5, 6)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    sourceUrl: 'https://example.com/watch?v=abc',
    analysisId: 'analysis_0123456789abcdef',
    optionId: 'option_video_0123456789',
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4 - H.264 + AAC',
    status: 'queued',
    completedBytes: 0,
    totalBytes: 1_000,
    errorMessage: null,
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload\\Media',
    filePath: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides
  }
}

function rowsOf(database: DatabaseSync, table: string): Record<string, unknown>[] {
  return (database.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<
    string,
    unknown
  >[]).map((row) => ({ ...row }))
}

/** Compare only the columns a prior schema had; new columns are checked apart. */
function projectRows(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {}
    for (const key of keys) projected[key] = row[key]
    return projected
  })
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

describe('damaged history recovery', () => {
  it('restores the last good backup when the history file is corrupt', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    first.save({ record: sample(), explicitFilename: null })
    close(first)
    // The first clean open wrote `<file>.bak`; a second open refreshes it with
    // the same healthy contents.
    const second = open(filePath)
    expect(second.openReport.status).toBe('ok')
    close(second)

    await writeFile(filePath, 'this is not a sqlite database at all', 'utf8')
    const recovered = open(filePath)

    expect(recovered.openReport.status).toBe('recovered')
    expect(recovered.openReport.corruptPath).not.toBeNull()
    expect(recovered.schemaVersion).toBe(SCHEMA_VERSION)
    // The backup held the saved row, so history did not disappear.
    expect(recovered.loadAll().map((entry) => entry.record.id)).toEqual([
      sample().id
    ])
    const names = await readdir(path.dirname(filePath))
    expect(
      names.some((name) => name.startsWith(`${DATABASE_FILENAME}.corrupt-`))
    ).toBe(true)
    // The preserved copy is the damaged bytes, not the restored file.
    const corruptName = path.basename(recovered.openReport.corruptPath as string)
    expect(await readFile(path.join(path.dirname(filePath), corruptName), 'utf8'))
      .toBe('this is not a sqlite database at all')
    close(recovered)
  })

  it('replaces an unmigratable file only when the damage is structural', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    const record = sample()
    for (let index = 0; index < 200; index += 1) {
      first.save({
        explicitFilename: null,
        record: { ...record, id: `row-${index}`, gid: `gid-${index}` }
      })
    }
    close(first)

    // Leave a database whose header parses (so it reads like an old schema)
    // but whose table B-tree pages are garbage. quick_check catches this, and
    // the damaged file is moved aside rather than debated.
    const raw = new DatabaseSync(filePath)
    raw.exec('PRAGMA journal_mode = DELETE')
    raw.exec('PRAGMA user_version = 0')
    raw.close()
    const bytes = await readFile(filePath)
    for (let offset = 8192; offset < Math.min(12288, bytes.length); offset += 1) {
      bytes[offset] = 0xff
    }
    await writeFile(filePath, bytes)

    const recovered = open(filePath)

    expect(recovered.schemaVersion).toBe(SCHEMA_VERSION)
    expect(
      recovered.openReport.status === 'recovered' ||
        recovered.openReport.status === 'recreated'
    ).toBe(true)
    expect(await readdir(path.dirname(filePath))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${DATABASE_FILENAME}\\.corrupt-`))
      ])
    )
    close(recovered)
  })

  it('starts a fresh history when the file is corrupt and no backup exists', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'garbage'.repeat(1_000), 'utf8')

    const recovered = open(filePath)

    expect(recovered.openReport.status).toBe('recreated')
    expect(recovered.openReport.corruptPath).not.toBeNull()
    expect(recovered.schemaVersion).toBe(SCHEMA_VERSION)
    expect(recovered.loadAll()).toEqual([])
    // Persistence works again in this very process.
    recovered.save({ record: sample(), explicitFilename: null })
    expect(recovered.loadAll()).toHaveLength(1)
    close(recovered)

    const reopened = open(filePath)
    expect(reopened.loadAll()).toHaveLength(1)
    close(reopened)
  })

  it('still refuses a newer schema without quarantining it', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    const raw = new DatabaseSync(filePath)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()

    expect(() => openDownloadDatabase(filePath)).toThrow(/newer version/i)
    const names = await readdir(path.dirname(filePath))
    expect(names.some((name) => name.includes('.corrupt-'))).toBe(false)
    expect((await stat(filePath)).isFile()).toBe(true)
  })

  it('reports a healthy open and refreshes the backup', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    expect(database.openReport.status).toBe('fresh')
    close(database)

    const names = await readdir(path.dirname(filePath))
    expect(names).toContain(`${DATABASE_FILENAME}.bak`)
    const reopened = open(filePath)
    expect(reopened.openReport.status).toBe('ok')
    expect(reopened.openReport.corruptPath).toBeNull()
    close(reopened)
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
      'error',
      'cancelled'
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
    expect(byFilename.get('cancelled.bin')?.status).toBe('cancelled')
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

describe('v17 to v18 checksum migration', () => {
  it('adds checksum columns in place and keeps existing downloads', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })

    const record = sample({ status: 'complete', completedAt: Date.UTC(2026, 0, 3) })
    const raw = new DatabaseSync(filePath)
    for (const migration of MIGRATIONS) {
      if (migration.version > 17) break
      raw.exec(migration.sql)
      raw.exec(`PRAGMA user_version = ${migration.version}`)
    }

    const beforeColumns = (
      raw.prepare('PRAGMA table_info(downloads)').all() as { name: string }[]
    ).map((column) => column.name)
    expect(beforeColumns).not.toContain('checksum_algorithm')

    raw
      .prepare(
        `INSERT INTO downloads (
          id, gid, url, filename, explicit_filename, dir, file_path, status,
          total_bytes, completed_bytes, error_message, attempts, max_attempts,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.gid,
        record.url,
        record.filename,
        'chosen-name.zip',
        record.dir,
        record.filePath,
        record.status,
        record.totalBytes,
        record.completedBytes,
        record.errorMessage,
        record.attempts,
        record.maxAttempts,
        record.createdAt,
        record.updatedAt,
        record.completedAt
      )
    raw.close()

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    const loaded = database.loadAll()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.record.filename).toBe(record.filename)
    expect(loaded[0]?.explicitFilename).toBe('chosen-name.zip')
    expect(loaded[0]?.record.checksum).toBeUndefined()

    const result = {
      algorithm: 'sha256' as const,
      ok: false,
      computed:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      checkedAt: Date.UTC(2026, 10, 7, 9, 30, 0)
    }
    database.saveDownloadChecksum(record.id, result)
    close(database)

    const reopened = open(filePath)
    expect(reopened.loadAll()[0]?.record.checksum).toEqual(result)
    close(reopened)
  })
})

describe('v19 to v20 cancelled-status migration', () => {
  it('rebuilds the downloads table without losing rows and accepts cancelled', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })

    const existing = sample({ status: 'complete', completedAt: Date.UTC(2026, 0, 3) })
    const raw = new DatabaseSync(filePath)
    for (const migration of MIGRATIONS) {
      if (migration.version > 19) break
      raw.exec(migration.sql)
      raw.exec(`PRAGMA user_version = ${migration.version}`)
    }
    raw
      .prepare(
        `INSERT INTO downloads (
          id, gid, url, filename, explicit_filename, dir, file_path, status,
          total_bytes, completed_bytes, error_message, attempts, max_attempts,
          created_at, updated_at, completed_at, scheduled_at, speed_limit_bps,
          connections, block_reason, needs_login, error_detail,
          checksum_algorithm, checksum_ok, checksum_computed, checksum_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        existing.id,
        existing.gid,
        existing.url,
        existing.filename,
        'chosen-name.zip',
        existing.dir,
        existing.filePath,
        existing.status,
        existing.totalBytes,
        existing.completedBytes,
        existing.errorMessage,
        existing.attempts,
        existing.maxAttempts,
        existing.createdAt,
        existing.updatedAt,
        existing.completedAt,
        Date.UTC(2026, 0, 3, 1),
        1024,
        8,
        'scheduled',
        1,
        'aria2 code 1: test detail',
        'sha256',
        1,
        'a'.repeat(64),
        Date.UTC(2026, 0, 3, 2)
      )
    raw.close()

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.loadAll()[0]).toMatchObject({
      explicitFilename: 'chosen-name.zip',
      scheduledAt: Date.UTC(2026, 0, 3, 1),
      speedLimitBps: 1024,
      connections: 8,
      blockReason: 'scheduled',
      needsLogin: true,
      record: {
        id: existing.id,
        status: 'complete',
        errorDetail: 'aria2 code 1: test detail',
        checksum: {
          algorithm: 'sha256',
          ok: true,
          computed: 'a'.repeat(64),
          checkedAt: Date.UTC(2026, 0, 3, 2)
        }
      }
    })

    const cancelled = sample({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gid: '',
      url: 'https://example.com/files/cancelled.bin',
      filename: 'cancelled.bin',
      status: 'cancelled',
      filePath: null,
      completedAt: Date.UTC(2026, 0, 4)
    })
    database.save({ record: cancelled, explicitFilename: null })

    const stored = database.loadAll().find((entry) => entry.record.id === cancelled.id)
    expect(stored?.record.status).toBe('cancelled')
    close(database)
  })
})

describe('v1 to v5 migration preservation', () => {
  it('adds media and batch tables without changing any v1 download value', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })

    const first = sample()
    const second = sample({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gid: 'aaaaaaaaaaaaaaaa',
      url: 'https://example.com/files/completed.bin',
      filename: 'completed.bin',
      status: 'complete',
      totalBytes: 42,
      completedBytes: 42,
      errorMessage: null,
      createdAt: Date.UTC(2001, 0, 1),
      updatedAt: Date.UTC(2001, 0, 1),
      completedAt: Date.UTC(2001, 0, 1)
    })

    const raw = new DatabaseSync(filePath)
    raw.exec(V1_DOWNLOADS_SCHEMA)
    raw.exec('PRAGMA user_version = 1')
    const insert = raw.prepare(`
      INSERT INTO downloads (
        id, gid, url, filename, explicit_filename, dir, file_path, status,
        total_bytes, completed_bytes, error_message, attempts, max_attempts,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run(
      first.id,
      first.gid,
      first.url,
      first.filename,
      'chosen-name.zip',
      first.dir,
      first.filePath,
      first.status,
      first.totalBytes,
      first.completedBytes,
      first.errorMessage,
      first.attempts,
      first.maxAttempts,
      first.createdAt,
      first.updatedAt,
      first.completedAt
    )
    insert.run(
      second.id,
      second.gid,
      second.url,
      second.filename,
      null,
      second.dir,
      second.filePath,
      second.status,
      second.totalBytes,
      second.completedBytes,
      second.errorMessage,
      second.attempts,
      second.maxAttempts,
      second.createdAt,
      second.updatedAt,
      second.completedAt
    )
    const before = rowsOf(raw, 'downloads')
    raw.close()

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.loadMediaJobs()).toEqual([])
    expect(database.loadBatches()).toEqual([])
    const loaded = database.loadAll()
    expect(loaded).toHaveLength(2)
    expect(loaded.find((entry) => entry.record.id === first.id)?.record.url).toBe(
      first.url
    )
    expect(
      loaded.find((entry) => entry.record.id === second.id)?.record.completedAt
    ).toBe(second.completedAt)
    close(database)

    const verify = new DatabaseSync(filePath)
    const after = rowsOf(verify, 'downloads')
    const afterProjected = projectRows(after, Object.keys(before[0] ?? {}))
    for (const row of after) {
      expect(row.scheduled_at).toBeNull()
      expect(row.speed_limit_bps).toBeNull()
      expect(row.connections).toBeNull()
      expect(row.block_reason).toBeNull()
    }
    const mediaTable = verify
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_jobs'"
      )
      .get()
    const batchTables = (
      verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('batches', 'batch_items') ORDER BY name"
        )
        .all() as { name: string }[]
    ).map((table) => table.name)
    verify.close()

    expect(afterProjected).toEqual(before)
    expect(mediaTable).toBeDefined()
    expect(batchTables).toEqual(['batch_items', 'batches'])
  })
})

describe('media job persistence', () => {
  it('persists only the normalized internal source URL, title, progress, lifecycle and paths', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)

    expect(() =>
      first.saveMediaJob(
        mediaRecord({
          sourceUrl: 'https://user:secret@example.com/watch?v=abc#fragment'
        })
      )
    ).toThrow(/credentials/)
    first.saveMediaJob(
      mediaRecord({ sourceUrl: 'https://example.com/watch?v=abc#fragment', maxBytes: 25_000_000 })
    )

    const stored = first.loadMediaJobs()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(
      mediaRecord({ sourceUrl: 'https://example.com/watch?v=abc', maxBytes: 25_000_000 })
    )

    first.saveMediaJob(
      mediaRecord({
        sourceUrl: 'https://example.com/watch?v=abc',
        maxBytes: 25_000_000,
        status: 'complete',
        completedBytes: 1_000,
        filePath: 'C:\\Users\\Test\\Downloads\\DonDownload\\Media\\video.mp4',
        completedAt: Date.UTC(2026, 1, 3, 4, 10, 0),
        updatedAt: Date.UTC(2026, 1, 3, 4, 10, 0)
      })
    )
    close(first)

    const second = open(filePath)
    const reopened = second.loadMediaJobs()
    expect(reopened).toHaveLength(1)
    expect(reopened[0]?.status).toBe('complete')
    expect(reopened[0]?.completedBytes).toBe(1_000)
    expect(reopened[0]?.maxBytes).toBe(25_000_000)
    expect(reopened[0]?.filePath).toBe(
      'C:\\Users\\Test\\Downloads\\DonDownload\\Media\\video.mp4'
    )
    expect(reopened[0]?.completedAt).toBe(Date.UTC(2026, 1, 3, 4, 10, 0))
    close(second)
  })

  it('removes only the explicitly deleted media job and never deletes files', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const keep = mediaRecord({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const remove = mediaRecord({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      label: 'Audio only - Opus',
      kind: 'audio',
      optionId: 'option_audio_0123456789'
    })
    database.saveMediaJob(keep)
    database.saveMediaJob(remove)

    database.deleteMediaJob(remove.id)
    expect(database.loadMediaJobs().map((record) => record.id)).toEqual([keep.id])
    close(database)
  })

  it('removes many history rows in one transaction and keeps the rest', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const keep = sample({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gid: 'aaaaaaaaaaaaaaaa',
      filename: 'keep.bin'
    })
    const first = sample()
    const second = sample({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      gid: 'bbbbbbbbbbbbbbbb',
      filename: 'gone.bin'
    })
    for (const record of [keep, first, second]) {
      database.save({ record, explicitFilename: null })
    }

    database.deleteMany([first.id, second.id, 'not-a-stored-id'])

    expect(database.loadAll().map((entry) => entry.record.id)).toEqual([keep.id])
    // An empty list is a no-op, not an empty transaction.
    database.deleteMany([])
    expect(database.loadAll()).toHaveLength(1)
    close(database)
  })

  it('removes many media job rows in one transaction and keeps the rest', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const keep = mediaRecord({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    const first = mediaRecord({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
    const second = mediaRecord({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    for (const record of [keep, first, second]) database.saveMediaJob(record)

    database.deleteMediaJobs([first.id, second.id])

    expect(database.loadMediaJobs().map((record) => record.id)).toEqual([keep.id])
    close(database)
  })

  it('rolls back a media batch when one entry violates the schema', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    expect(() =>
      database.saveManyMediaJobs([
        mediaRecord(),
        mediaRecord({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'not-a-status' as MediaJobStatus
        })
      ])
    ).toThrow()

    expect(database.loadMediaJobs()).toHaveLength(0)
    close(database)
  })

  it('stores no cookie, header, raw metadata or yt-dlp command columns', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    close(database)

    const raw = new DatabaseSync(filePath)
    const columns = (
      raw.prepare("PRAGMA table_info('media_jobs')").all() as { name: string }[]
    ).map((column) => column.name)
    raw.close()

    expect(columns).toEqual([
      'id',
      'source_url',
      'analysis_id',
      'option_id',
      'kind',
      'title',
      'label',
      'status',
      'completed_bytes',
      'total_bytes',
      'error_message',
      'dir',
      'file_path',
      'created_at',
      'updated_at',
      'completed_at',
      'max_bytes'
    ])
  })
})
