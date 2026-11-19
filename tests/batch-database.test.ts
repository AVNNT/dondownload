import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  BatchItemRecord,
  BatchRecord,
  BatchStatus
} from '../src/shared/batches'
import type { MediaJobRecord } from '../src/shared/media'
import type { DownloadItem } from '../src/shared/types'
import {
  DATABASE_FILENAME,
  SCHEMA_VERSION,
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'

const tempDirs: string[] = []
const openDatabases: DownloadDatabase[] = []

async function makeDatabasePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-batch-db-'))
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

const NOW = Date.UTC(2026, 2, 4, 5, 6, 7)

const V1_SCHEMA = `
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

const V2_MEDIA_SCHEMA = `
  CREATE TABLE media_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    source_url TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'audio')),
    title TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'analyzing', 'downloading', 'merging',
        'complete', 'error', 'cancelled', 'interrupted'
      )
    ),
    completed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (completed_bytes >= 0),
    total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
    error_message TEXT,
    dir TEXT NOT NULL,
    file_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX media_jobs_created_at_idx ON media_jobs (created_at DESC);
  CREATE INDEX media_jobs_status_idx ON media_jobs (status);
`

/** The exact v3 checkpoint schema from commit 1571f69. */
const V3_BATCH_SCHEMA = `
  CREATE TABLE batches (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (
      kind IN ('media-playlist', 'pixeldrain-list', 'direct-urls')
    ),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'running', 'complete', 'partial',
        'error', 'cancelled', 'interrupted'
      )
    ),
    source_url TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE INDEX batches_created_at_idx ON batches (created_at DESC);
  CREATE INDEX batches_status_idx ON batches (status);

  CREATE TABLE batch_items (
    id TEXT PRIMARY KEY NOT NULL,
    batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('media', 'download')),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'running', 'complete',
        'error', 'cancelled', 'interrupted'
      )
    ),
    child_id TEXT,
    title TEXT NOT NULL,
    label TEXT NOT NULL,
    completed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (completed_bytes >= 0),
    total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
    error_message TEXT,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (batch_id, position)
  );

  CREATE INDEX batch_items_batch_id_idx ON batch_items (batch_id, position);
  CREATE INDEX batch_items_status_idx ON batch_items (status);
`

function batchRecord(overrides: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: 'batch_0123456789abcdef',
    kind: 'media-playlist',
    title: 'Example playlist',
    status: 'queued',
    sourceUrl: 'https://example.com/playlist?list=abc',
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

function batchItem(overrides: Partial<BatchItemRecord> = {}): BatchItemRecord {
  return {
    id: 'bitem_0123456789abcdef',
    batchId: 'batch_0123456789abcdef',
    position: 0,
    kind: 'media',
    status: 'queued',
    title: 'Example media',
    label: '1080p MP4',
    childId: null,
    completedBytes: 0,
    totalBytes: 1_000,
    errorMessage: null,
    sourceUrl: 'https://example.com/watch?v=abc',
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

function downloadRecord(overrides: Partial<DownloadItem> = {}): DownloadItem {
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
    speedBps: 100,
    etaSeconds: 8,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

function mediaRecord(overrides: Partial<MediaJobRecord> = {}): MediaJobRecord {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  }
}

function rowsOf(
  database: DatabaseSync,
  table: string
): Record<string, unknown>[] {
  return (
    database.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<
      string,
      unknown
    >[]
  ).map((row) => ({ ...row }))
}

function schemaSql(database: DatabaseSync, table: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined
  return row?.sql ?? ''
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

function insertBatch(database: DatabaseSync, record: BatchRecord): void {
  database
    .prepare(
      `INSERT INTO batches (
        id, kind, title, status, source_url, error_message,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.kind,
      record.title,
      record.status,
      record.sourceUrl,
      record.errorMessage,
      record.createdAt,
      record.updatedAt,
      record.completedAt
    )
}

function insertBatchItem(
  database: DatabaseSync,
  item: BatchItemRecord
): void {
  database
    .prepare(
      `INSERT INTO batch_items (
        id, batch_id, position, kind, status, child_id, title, label,
        completed_bytes, total_bytes, error_message, source_url,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.batchId,
      item.position,
      item.kind,
      item.status,
      item.childId,
      item.title,
      item.label,
      item.completedBytes,
      item.totalBytes,
      item.errorMessage,
      item.sourceUrl,
      item.createdAt,
      item.updatedAt,
      item.completedAt
    )
}

function createV2Database(filePath: string): void {
  const raw = new DatabaseSync(filePath)
  raw.exec(V1_SCHEMA)
  raw.exec(V2_MEDIA_SCHEMA)
  raw.exec('PRAGMA user_version = 2')

  const download = downloadRecord()
  raw
    .prepare(
      `INSERT INTO downloads (
        id, gid, url, filename, explicit_filename, dir, file_path, status,
        total_bytes, completed_bytes, error_message, attempts, max_attempts,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      download.id,
      download.gid,
      download.url,
      download.filename,
      'chosen-name.zip',
      download.dir,
      download.filePath,
      download.status,
      download.totalBytes,
      download.completedBytes,
      download.errorMessage,
      download.attempts,
      download.maxAttempts,
      download.createdAt,
      download.updatedAt,
      download.completedAt
    )

  const media = mediaRecord()
  raw
    .prepare(
      `INSERT INTO media_jobs (
        id, source_url, analysis_id, option_id, kind, title, label, status,
        completed_bytes, total_bytes, error_message, dir, file_path,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      media.id,
      media.sourceUrl,
      media.analysisId,
      media.optionId,
      media.kind,
      media.title,
      media.label,
      media.status,
      media.completedBytes,
      media.totalBytes,
      media.errorMessage,
      media.dir,
      media.filePath,
      media.createdAt,
      media.updatedAt,
      media.completedAt
    )

  raw.close()
}

interface V3Fixture {
  batch: BatchRecord
  items: BatchItemRecord[]
}

/** Build a genuine v3 database with rows that the old status CHECK allows. */
function createV3Database(filePath: string): V3Fixture {
  createV2Database(filePath)

  const batch = batchRecord({ status: 'running' })
  const items: BatchItemRecord[] = [
    batchItem({
      status: 'complete',
      childId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      completedBytes: 1_000,
      completedAt: NOW
    }),
    batchItem({
      id: 'bitem_fedcba9876543210',
      position: 1,
      kind: 'download',
      status: 'error',
      title: 'Second item',
      label: 'archive.zip',
      completedBytes: 50,
      totalBytes: 200,
      errorMessage: 'The remote file was not found.',
      sourceUrl: 'https://example.com/archive.zip'
    })
  ]

  const raw = new DatabaseSync(filePath)
  raw.exec(V3_BATCH_SCHEMA)
  raw.exec('PRAGMA user_version = 3')
  insertBatch(raw, batch)
  for (const item of items) insertBatchItem(raw, item)
  raw.close()

  return { batch, items }
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

describe('batch persistence', () => {
  it('persists a parent and independent item state across close/reopen', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)

    expect(first.schemaVersion).toBe(SCHEMA_VERSION)
    first.saveBatchWithItems(
      batchRecord({ sourceUrl: 'https://example.com/playlist?list=abc#frag', mediaQuality: '720p', maxBytesPerItem: 25_000_000 }),
      [
        batchItem({
          sourceUrl: 'https://example.com/watch?v=abc#frag',
          status: 'complete',
          childId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          completedBytes: 1_000,
          completedAt: NOW
        }),
        batchItem({
          id: 'bitem_fedcba9876543210',
          position: 1,
          kind: 'download',
          status: 'error',
          title: 'Second item',
          label: 'archive.zip',
          completedBytes: 50,
          totalBytes: 200,
          errorMessage: 'The remote file was not found.',
          sourceUrl: 'https://example.com/archive.zip'
        })
      ]
    )
    close(first)

    const second = open(filePath)
    const stored = second.loadBatch('batch_0123456789abcdef')
    expect(stored).not.toBeNull()
    expect(stored?.record.sourceUrl).toBe(
      'https://example.com/playlist?list=abc'
    )
    expect(stored?.record).toMatchObject({ mediaQuality: '720p', maxBytesPerItem: 25_000_000 })
    expect(stored?.items).toHaveLength(2)
    expect(stored?.items[0]).toMatchObject({
      id: 'bitem_0123456789abcdef',
      position: 0,
      status: 'complete',
      completedBytes: 1_000,
      sourceUrl: 'https://example.com/watch?v=abc'
    })
    expect(stored?.items[1]).toMatchObject({
      id: 'bitem_fedcba9876543210',
      position: 1,
      status: 'error',
      errorMessage: 'The remote file was not found.',
      childId: null
    })
    expect(second.loadBatches()).toHaveLength(1)
    close(second)
  })

  it('rejects credential-bearing sources and keeps the parent/item batch atomic', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    expect(() =>
      database.saveBatch(
        batchRecord({
          sourceUrl: 'https://user:secret@example.com/playlist?list=abc'
        })
      )
    ).toThrow(/credentials/)
    expect(database.loadBatches()).toHaveLength(0)

    expect(() =>
      database.saveBatchWithItems(batchRecord({ sourceUrl: null }), [
        batchItem({
          sourceUrl: 'https://user:secret@example.com/watch?v=abc'
        })
      ])
    ).toThrow(/credentials/)
    expect(database.loadBatch('batch_0123456789abcdef')).toBeNull()
    close(database)
  })

  it('rolls back a parent+items write when one item violates the schema', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    expect(() =>
      database.saveBatchWithItems(batchRecord(), [
        batchItem(),
        batchItem({
          id: 'bitem_fedcba9876543210',
          position: 1,
          status: 'not-a-status' as BatchItemRecord['status']
        })
      ])
    ).toThrow()

    expect(database.loadBatches()).toHaveLength(0)
    close(database)
  })

  it('rolls back item progress when one item in the batch is invalid', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    database.saveBatchWithItems(batchRecord(), [
      batchItem(),
      batchItem({ id: 'bitem_fedcba9876543210', position: 1 })
    ])

    expect(() =>
      database.saveManyBatchItems([
        batchItem({ status: 'complete', completedBytes: 1_000 }),
        batchItem({
          id: 'bitem_fedcba9876543210',
          position: 1,
          status: 'not-a-status' as BatchItemRecord['status']
        })
      ])
    ).toThrow()

    const stored = database.loadBatch('batch_0123456789abcdef')
    expect(stored?.items[0]).toMatchObject({
      status: 'queued',
      completedBytes: 0
    })
    close(database)
  })

  it('cascades a batch delete to items but never touches download/media rows', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    database.save({ record: downloadRecord(), explicitFilename: null })
    database.saveMediaJob(mediaRecord())
    database.saveBatchWithItems(batchRecord(), [
      batchItem(),
      batchItem({ id: 'bitem_fedcba9876543210', position: 1 })
    ])

    database.deleteBatch('batch_0123456789abcdef')

    expect(database.loadBatches()).toHaveLength(0)
    expect(database.loadAll().map((entry) => entry.record.id)).toEqual([
      downloadRecord().id
    ])
    expect(database.loadMediaJobs().map((record) => record.id)).toEqual([
      mediaRecord().id
    ])
    close(database)
  })

  it('deletes only the explicitly targeted batch item', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    database.saveBatchWithItems(batchRecord(), [
      batchItem(),
      batchItem({ id: 'bitem_fedcba9876543210', position: 1 })
    ])

    database.deleteBatchItem(
      'batch_0123456789abcdef',
      'bitem_fedcba9876543210'
    )

    expect(
      database.loadBatch('batch_0123456789abcdef')?.items.map((item) => item.id)
    ).toEqual(['bitem_0123456789abcdef'])
    close(database)
  })

  it('stores no cookie, token, header, selector or path columns', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    close(database)

    const raw = new DatabaseSync(filePath)
    const columns = (table: string): string[] =>
      (
        raw.prepare(`PRAGMA table_info('${table}')`).all() as {
          name: string
        }[]
      ).map((column) => column.name)
    const batchColumns = columns('batches')
    const itemColumns = columns('batch_items')
    raw.close()

    expect(batchColumns).toEqual([
      'id',
      'kind',
      'title',
      'status',
      'source_url',
      'error_message',
      'created_at',
      'updated_at',
      'completed_at',
      'media_quality',
      'max_bytes_per_item'
    ])
    expect(itemColumns).toEqual([
      'id',
      'batch_id',
      'position',
      'kind',
      'status',
      'child_id',
      'title',
      'label',
      'completed_bytes',
      'total_bytes',
      'error_message',
      'source_url',
      'created_at',
      'updated_at',
      'completed_at'
    ])
    expect(
      [...batchColumns, ...itemColumns].filter((name) =>
        /cookie|token|header|selector|guest|file_path|dir/.test(name)
      )
    ).toEqual([])
  })
})

describe('v2 to v5 batch migration', () => {
  it('adds batch tables without changing any v2 download or media value', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    createV2Database(filePath)

    const raw = new DatabaseSync(filePath)
    const downloadsBefore = rowsOf(raw, 'downloads')
    const mediaBefore = rowsOf(raw, 'media_jobs')
    raw.close()

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.loadBatches()).toEqual([])
    expect(database.loadAll()).toHaveLength(1)
    expect(database.loadMediaJobs()).toHaveLength(1)
    database.saveBatchWithItems(batchRecord(), [
      batchItem({ status: 'unavailable', completedBytes: 0, totalBytes: null }),
      batchItem({
        id: 'bitem_skipped',
        position: 1,
        status: 'skipped',
        completedBytes: 0,
        totalBytes: null
      })
    ])
    expect(
      database
        .loadBatch('batch_0123456789abcdef')
        ?.items.map((item) => item.status)
    ).toEqual(['unavailable', 'skipped'])
    close(database)

    const verify = new DatabaseSync(filePath)
    const downloadsAfter = rowsOf(verify, 'downloads')
    expect(downloadsAfter).toHaveLength(downloadsBefore.length)
    for (const [index, row] of downloadsAfter.entries()) {
      // The v5/v6 migrations add null control columns; prior values are equal.
      expect(row).toMatchObject(downloadsBefore[index] ?? {})
      expect(row.scheduled_at).toBeNull()
      expect(row.speed_limit_bps).toBeNull()
      expect(row.connections).toBeNull()
      expect(row.block_reason).toBeNull()
    }
    expect(rowsOf(verify, 'media_jobs')[0]).toMatchObject(mediaBefore[0] ?? {})
    expect(rowsOf(verify, 'media_jobs')[0]?.max_bytes).toBeNull()
    const tables = (
      verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .all() as { name: string }[]
    ).map((table) => table.name)
    verify.close()

    expect(tables).toEqual(
      expect.arrayContaining(['batch_items', 'batches', 'downloads', 'media_jobs'])
    )
  })

  it('rolls the v3 migration back and preserves v2 data when it fails', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    createV2Database(filePath)

    const conflict = new DatabaseSync(filePath)
    // A pre-existing table with the v3 name makes CREATE TABLE batches fail.
    conflict.exec('CREATE TABLE batches (id INTEGER)')
    conflict.close()

    expect(() => openDownloadDatabase(filePath)).toThrow(/migrate/i)

    const verify = new DatabaseSync(filePath)
    expect(
      (verify.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
    ).toBe(2)
    expect(rowsOf(verify, 'downloads')).toHaveLength(1)
    expect(rowsOf(verify, 'media_jobs')).toHaveLength(1)
    const batchItems = verify
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batch_items'"
      )
      .get()
    verify.close()

    expect(batchItems).toBeUndefined()
  })
})

describe('v3 to v5 batch_items migration', () => {
  it('rebuilds a genuine prior-v3 table and preserves every row, index and cascade', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    const fixture = createV3Database(filePath)

    const beforeRaw = new DatabaseSync(filePath)
    const beforeDownloads = rowsOf(beforeRaw, 'downloads')
    const beforeMedia = rowsOf(beforeRaw, 'media_jobs')
    const beforeBatches = rowsOf(beforeRaw, 'batches')
    const beforeItems = rowsOf(beforeRaw, 'batch_items')
    const oldItemSql = schemaSql(beforeRaw, 'batch_items')
    beforeRaw.close()

    expect(oldItemSql).not.toContain("'unavailable'")
    expect(oldItemSql).not.toContain("'skipped'")

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.loadAll()).toHaveLength(1)
    expect(database.loadMediaJobs()).toHaveLength(1)
    const migrated = database.loadBatch(fixture.batch.id)
    expect(migrated?.record).toMatchObject(fixture.batch)
    expect(migrated?.record.mediaQuality).toBeUndefined()
    expect(migrated?.record.maxBytesPerItem).toBeUndefined()
    expect(migrated?.items).toEqual(fixture.items)

    database.saveManyBatchItems([
      batchItem({
        id: 'bitem_unavailable',
        position: 2,
        status: 'unavailable',
        completedBytes: 0,
        totalBytes: null
      }),
      batchItem({
        id: 'bitem_skipped',
        position: 3,
        status: 'skipped',
        completedBytes: 0,
        totalBytes: null
      })
    ])
    expect(
      database.loadBatch(fixture.batch.id)?.items.map((item) => item.status)
    ).toEqual(['complete', 'error', 'unavailable', 'skipped'])
    close(database)

    const verify = new DatabaseSync(filePath)
    expect(
      (verify.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
    ).toBe(SCHEMA_VERSION)
    const beforeTables: [string, Record<string, unknown>[]][] = [
      ['downloads', beforeDownloads],
      ['media_jobs', beforeMedia],
      ['batches', beforeBatches],
      ['batch_items', beforeItems]
    ]
    for (const [table, rows] of beforeTables) {
      const after = new Map<string, Record<string, unknown>>()
      for (const row of rowsOf(verify, table)) after.set(String(row.id), row)
      for (const row of rows) {
        // v5 adds nullable control columns to downloads only; every prior
        // column and value must still match.
        expect(after.get(String(row.id))).toMatchObject(row)
      }
    }
    for (const row of rowsOf(verify, 'downloads')) {
      expect(row.scheduled_at).toBeNull()
      expect(row.speed_limit_bps).toBeNull()
      expect(row.connections).toBeNull()
      expect(row.block_reason).toBeNull()
    }
    const itemSql = schemaSql(verify, 'batch_items')
    expect(itemSql).toContain("'unavailable'")
    expect(itemSql).toContain("'skipped'")
    expect(indexNames(verify, 'batch_items')).toEqual(
      expect.arrayContaining([
        'batch_items_batch_id_idx',
        'batch_items_status_idx'
      ])
    )
    const foreignKeys = verify
      .prepare("PRAGMA foreign_key_list('batch_items')")
      .all() as { table: string; on_delete: string }[]
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      table: 'batches',
      on_delete: 'CASCADE'
    })
    verify.close()

    const afterDelete = open(filePath)
    afterDelete.deleteBatch(fixture.batch.id)
    expect(afterDelete.loadBatches()).toHaveLength(0)
    expect(afterDelete.loadAll()).toHaveLength(1)
    expect(afterDelete.loadMediaJobs()).toHaveLength(1)
    close(afterDelete)
  })

  it('rolls back a failed v4 rebuild and preserves the v3 rows and schema', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    const fixture = createV3Database(filePath)
    const firstItemId = fixture.items[0]?.id
    if (!firstItemId) throw new Error('v3 fixture is missing its first item')

    const beforeRaw = new DatabaseSync(filePath)
    const beforeDownloads = rowsOf(beforeRaw, 'downloads')
    const beforeMedia = rowsOf(beforeRaw, 'media_jobs')
    const beforeBatches = rowsOf(beforeRaw, 'batches')
    const beforeItems = rowsOf(beforeRaw, 'batch_items')
    const oldItemSql = schemaSql(beforeRaw, 'batch_items')
    const oldIndexes = indexNames(beforeRaw, 'batch_items')
    // A dependent row makes the v4 DROP TABLE fail after the copy step, so
    // this exercises rollback after the destructive part of the rebuild.
    beforeRaw.exec(`
      CREATE TABLE batch_items_ref (
        id INTEGER PRIMARY KEY,
        item_id TEXT REFERENCES batch_items(id)
      );
    `)
    beforeRaw
      .prepare('INSERT INTO batch_items_ref (id, item_id) VALUES (?, ?)')
      .run(1, firstItemId)
    beforeRaw.close()

    expect(() => openDownloadDatabase(filePath)).toThrow(/migrate/i)

    const verify = new DatabaseSync(filePath)
    expect(
      (verify.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
    ).toBe(3)
    const beforeTables: [string, Record<string, unknown>[]][] = [
      ['downloads', beforeDownloads],
      ['media_jobs', beforeMedia],
      ['batches', beforeBatches],
      ['batch_items', beforeItems]
    ]
    for (const [table, rows] of beforeTables) {
      expect(rowsOf(verify, table)).toEqual(rows)
    }
    expect(schemaSql(verify, 'batch_items')).toBe(oldItemSql)
    expect(indexNames(verify, 'batch_items')).toEqual(oldIndexes)
    expect(
      verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batch_items_v4'"
        )
        .get()
    ).toBeUndefined()
    expect(() =>
      insertBatchItem(
        verify,
        batchItem({
          id: 'bitem_rollback_unavailable',
          position: 2,
          status: 'unavailable',
          completedBytes: 0,
          totalBytes: null
        })
      )
    ).toThrow()
    expect(() =>
      insertBatchItem(
        verify,
        batchItem({
          id: 'bitem_rollback_skipped',
          position: 3,
          status: 'skipped',
          completedBytes: 0,
          totalBytes: null
        })
      )
    ).toThrow()
    verify.close()
  })
})

describe('batch item loading at startup', () => {
  it('loads items only for unfinished batches and reads a finished batch on demand', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    database.saveBatchWithItems(
      batchRecord({ id: 'batch_running', status: 'running', completedAt: null }),
      [
        batchItem({ id: 'item_running', batchId: 'batch_running', status: 'running' })
      ]
    )
    database.saveBatchWithItems(
      batchRecord({ id: 'batch_done', status: 'complete', completedAt: NOW }),
      [
        batchItem({ id: 'item_done_1', batchId: 'batch_done', position: 0 }),
        batchItem({
          id: 'item_done_2',
          batchId: 'batch_done',
          position: 1,
          status: 'complete'
        })
      ]
    )

    const loaded = database.loadBatches()
    const byId = new Map(loaded.map((entry) => [entry.record.id, entry]))
    expect(byId.get('batch_running')?.items.map((item) => item.id)).toEqual([
      'item_running'
    ])
    // The finished batch keeps its parent row but none of its item rows.
    expect(byId.get('batch_done')?.record.status).toBe('complete')
    expect(byId.get('batch_done')?.items).toEqual([])

    expect(
      database.loadBatchItems('batch_done').map((item) => item.id)
    ).toEqual(['item_done_1', 'item_done_2'])
    // A second read is stable, and the single-batch loader still agrees.
    expect(database.loadBatchItems('batch_done')).toHaveLength(2)
    expect(
      database.loadBatch('batch_done')?.items.map((item) => item.id)
    ).toEqual(['item_done_1', 'item_done_2'])

    close(database)
  })
})

describe('batch status constraints', () => {
  it('accepts every stable batch status and rejects unknown ones', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const statuses: BatchStatus[] = [
      'queued',
      'running',
      'complete',
      'partial',
      'error',
      'cancelled',
      'interrupted'
    ]

    for (const [index, status] of statuses.entries()) {
      database.saveBatch(
        batchRecord({
          id: `batch_status_${index}`,
          status,
          completedAt: status === 'queued' || status === 'running' ? null : NOW
        })
      )
    }
    expect(database.loadBatches()).toHaveLength(statuses.length)
    expect(() =>
      database.saveBatch(
        batchRecord({
          id: 'batch_invalid',
          status: 'paused' as BatchStatus
        })
      )
    ).toThrow()
    close(database)
  })

  it('accepts unavailable and skipped item statuses and rejects unknown ones', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const statuses: BatchItemRecord['status'][] = ['unavailable', 'skipped']

    database.saveBatchWithItems(
      batchRecord(),
      statuses.map((status, index) =>
        batchItem({
          id: `bitem_status_${index}`,
          position: index,
          status,
          completedBytes: 0,
          totalBytes: null
        })
      )
    )
    expect(
      database
        .loadBatch('batch_0123456789abcdef')
        ?.items.map((item) => item.status)
    ).toEqual(statuses)
    expect(() =>
      database.saveManyBatchItems([
        batchItem({
          id: 'bitem_status_0',
          status: 'paused' as BatchItemRecord['status']
        })
      ])
    ).toThrow()
    close(database)
  })
})
