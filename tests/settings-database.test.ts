import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_SPEED_LIMIT_BPS,
  defaultDownloadSettings,
  type DownloadSettings
} from '../src/shared/settings'
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-settings-db-'))
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

const NOW = Date.UTC(2026, 10, 4, 5, 6, 7)

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
`

const V3_BATCH_ITEMS_SCHEMA = `
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

const V4_BATCH_ITEMS_SCHEMA = `
  CREATE TABLE batch_items (
    id TEXT PRIMARY KEY NOT NULL,
    batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('media', 'download')),
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'running', 'complete', 'error',
        'unavailable', 'skipped', 'cancelled', 'interrupted'
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

function project(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const selected: Record<string, unknown> = {}
    for (const column of columns) selected[column] = row[column]
    return selected
  })
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info('${table}')`).all() as {
      name: string
    }[]
  ).map((column) => column.name)
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

function userVersion(database: DatabaseSync): number {
  return (
    database.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(table)
  )
}

const DOWNLOAD_COLUMNS = [
  'id',
  'gid',
  'url',
  'filename',
  'explicit_filename',
  'dir',
  'file_path',
  'status',
  'total_bytes',
  'completed_bytes',
  'error_message',
  'attempts',
  'max_attempts',
  'created_at',
  'updated_at',
  'completed_at'
]

interface LegacyFixture {
  downloads: Record<string, unknown>[]
  media: Record<string, unknown>[]
  batches: Record<string, unknown>[]
  batchItems: Record<string, unknown>[]
}

function insertDownloads(database: DatabaseSync): void {
  const insert = database.prepare(`
    INSERT INTO downloads (
      id, gid, url, filename, explicit_filename, dir, file_path, status,
      total_bytes, completed_bytes, error_message, attempts, max_attempts,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const active = downloadRecord()
  insert.run(
    active.id,
    active.gid,
    active.url,
    active.filename,
    'chosen-name.zip',
    active.dir,
    active.filePath,
    active.status,
    active.totalBytes,
    active.completedBytes,
    active.errorMessage,
    active.attempts,
    active.maxAttempts,
    active.createdAt,
    active.updatedAt,
    active.completedAt
  )

  const complete = downloadRecord({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    gid: 'aaaaaaaaaaaaaaaa',
    url: 'https://example.com/files/completed.bin',
    filename: 'completed.bin',
    status: 'complete',
    totalBytes: 42,
    completedBytes: 42,
    attempts: 2,
    maxAttempts: 5,
    createdAt: Date.UTC(2001, 0, 1),
    updatedAt: Date.UTC(2001, 0, 1),
    completedAt: Date.UTC(2001, 0, 1)
  })
  insert.run(
    complete.id,
    complete.gid,
    complete.url,
    complete.filename,
    null,
    complete.dir,
    complete.filePath,
    complete.status,
    complete.totalBytes,
    complete.completedBytes,
    complete.errorMessage,
    complete.attempts,
    complete.maxAttempts,
    complete.createdAt,
    complete.updatedAt,
    complete.completedAt
  )
}

function insertMedia(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO media_jobs (
        id, source_url, analysis_id, option_id, kind, title, label, status,
        completed_bytes, total_bytes, error_message, dir, file_path,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'https://example.com/watch?v=abc',
      'analysis_0123456789abcdef',
      'option_video_0123456789',
      'video',
      'Example media',
      '1080p MP4 - H.264 + AAC',
      'complete',
      1_000,
      1_000,
      null,
      'C:\\Users\\Test\\Downloads\\DonDownload\\Media',
      'C:\\Users\\Test\\Downloads\\DonDownload\\Media\\video.mp4',
      NOW,
      NOW,
      NOW
    )
}

function insertBatch(
  database: DatabaseSync,
  version: number
): void {
  database
    .prepare(
      `INSERT INTO batches (
        id, kind, title, status, source_url, error_message,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'batch_0123456789abcdef',
      'media-playlist',
      'Example playlist',
      'partial',
      'https://example.com/playlist?list=abc',
      null,
      NOW,
      NOW,
      NOW
    )

  const insert = database.prepare(`
    INSERT INTO batch_items (
      id, batch_id, position, kind, status, child_id, title, label,
      completed_bytes, total_bytes, error_message, source_url,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insert.run(
    'bitem_complete',
    'batch_0123456789abcdef',
    0,
    'media',
    'complete',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Completed media',
    '1080p MP4',
    1_000,
    1_000,
    null,
    'https://example.com/watch?v=abc',
    NOW,
    NOW,
    NOW
  )
  insert.run(
    'bitem_error',
    'batch_0123456789abcdef',
    1,
    'download',
    'error',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'Failed archive',
    'archive.zip',
    12,
    200,
    'The remote file was not found.',
    'https://example.com/archive.zip',
    NOW,
    NOW,
    null
  )

  if (version >= 4) {
    insert.run(
      'bitem_unavailable',
      'batch_0123456789abcdef',
      2,
      'media',
      'unavailable',
      null,
      'Unavailable media',
      'Private video',
      0,
      null,
      'This entry is private.',
      'https://example.com/private',
      NOW,
      NOW,
      NOW
    )
    insert.run(
      'bitem_skipped',
      'batch_0123456789abcdef',
      3,
      'media',
      'skipped',
      null,
      'Skipped media',
      'Not selected',
      0,
      null,
      null,
      'https://example.com/skipped',
      NOW,
      NOW,
      NOW
    )
  }
}

function createLegacyDatabase(filePath: string, version: number): LegacyFixture {
  const raw = new DatabaseSync(filePath)
  raw.exec(V1_DOWNLOADS_SCHEMA)
  insertDownloads(raw)

  if (version >= 2) {
    raw.exec(V2_MEDIA_SCHEMA)
    insertMedia(raw)
  }

  if (version >= 3) {
    raw.exec(V3_BATCH_SCHEMA)
    raw.exec(version >= 4 ? V4_BATCH_ITEMS_SCHEMA : V3_BATCH_ITEMS_SCHEMA)
    insertBatch(raw, version)
  }

  raw.exec(`PRAGMA user_version = ${version}`)

  const fixture: LegacyFixture = {
    downloads: rowsOf(raw, 'downloads'),
    media: version >= 2 ? rowsOf(raw, 'media_jobs') : [],
    batches: version >= 3 ? rowsOf(raw, 'batches') : [],
    batchItems: version >= 3 ? rowsOf(raw, 'batch_items') : []
  }
  raw.close()
  return fixture
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

describe('download settings persistence', () => {
  it('creates one defaults row on a new database', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)

    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(20)
    expect(database.loadSettings()).toEqual(defaultDownloadSettings())
    close(database)

    const raw = new DatabaseSync(filePath)
    const rows = rowsOf(raw, 'download_settings')
    raw.close()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 1,
      max_concurrent_downloads: 3,
      per_host_connections: 16,
      global_speed_limit_bps: 0,
      allowed_hours_enabled: 0,
      allowed_hours_start: '00:00',
      allowed_hours_end: '00:00',
      theme: 'oled',
      sort_downloads_by_type: 0,
      history_retention_days: 30
    })
  })

  it('round-trips custom values, including an overnight window', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    const custom: DownloadSettings = {
      maxConcurrentDownloads: 16,
      perHostConnections: 12,
      globalSpeedLimitBps: 32 * 1024 * 1024,
      allowedHours: {
        enabled: true,
        start: '22:00',
        end: '06:00'
      },
      theme: 'light',
      sortDownloadsByType: true,
      historyRetentionDays: 7
    }
    first.saveSettings(custom)
    expect(first.loadSettings()).toEqual(custom)
    close(first)

    const second = open(filePath)
    expect(second.loadSettings()).toEqual(custom)
    second.saveSettings({
      ...custom,
      maxConcurrentDownloads: 1,
      perHostConnections: 1,
      globalSpeedLimitBps: MAX_SPEED_LIMIT_BPS,
      allowedHours: { enabled: true, start: '00:00', end: '00:00' },
      theme: 'dark'
    })
    expect(second.loadSettings()).toEqual({
      maxConcurrentDownloads: 1,
      perHostConnections: 1,
      globalSpeedLimitBps: MAX_SPEED_LIMIT_BPS,
      allowedHours: { enabled: true, start: '00:00', end: '00:00' },
      theme: 'dark',
      sortDownloadsByType: true,
      historyRetentionDays: 7
    })
    close(second)

    const raw = new DatabaseSync(filePath)
    expect(rowsOf(raw, 'download_settings')).toHaveLength(1)
    raw.close()
  })

  it('rejects invalid settings without changing the stored row', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const invalid: DownloadSettings[] = [
      { ...defaultDownloadSettings(), maxConcurrentDownloads: 0 },
      { ...defaultDownloadSettings(), maxConcurrentDownloads: 17 },
      { ...defaultDownloadSettings(), perHostConnections: 0 },
      { ...defaultDownloadSettings(), perHostConnections: 17 },
      { ...defaultDownloadSettings(), globalSpeedLimitBps: -1 },
      {
        ...defaultDownloadSettings(),
        globalSpeedLimitBps: MAX_SPEED_LIMIT_BPS + 1
      },
      {
        ...defaultDownloadSettings(),
        allowedHours: { enabled: true, start: '24:00', end: '06:00' }
      },
      {
        ...defaultDownloadSettings(),
        allowedHours: { enabled: true, start: '22:00', end: '6:00' }
      },
      {
        ...defaultDownloadSettings(),
        theme: 'system' as never
      },
      {
        ...defaultDownloadSettings(),
        historyRetentionDays: 14 as never
      }
    ]

    for (const settings of invalid) {
      expect(() => database.saveSettings(settings)).toThrow()
      expect(database.loadSettings()).toEqual(defaultDownloadSettings())
    }
    close(database)
  })

  it('enforces one row and every settings CHECK at the database layer', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    close(database)

    const raw = new DatabaseSync(filePath)
    expect(() =>
      raw
        .prepare(
          `INSERT INTO download_settings (
            id, max_concurrent_downloads, per_host_connections,
            global_speed_limit_bps, allowed_hours_enabled,
            allowed_hours_start, allowed_hours_end, updated_at
          ) VALUES (2, 3, 4, 0, 0, '00:00', '00:00', 0)`
        )
        .run()
    ).toThrow()

    const invalidUpdates = [
      'UPDATE download_settings SET max_concurrent_downloads = 0',
      'UPDATE download_settings SET max_concurrent_downloads = 17',
      'UPDATE download_settings SET per_host_connections = 0',
      'UPDATE download_settings SET per_host_connections = 17',
      'UPDATE download_settings SET global_speed_limit_bps = -1',
      `UPDATE download_settings SET global_speed_limit_bps = ${MAX_SPEED_LIMIT_BPS + 1}`,
      'UPDATE download_settings SET allowed_hours_enabled = 2',
      "UPDATE download_settings SET allowed_hours_start = '24:00'",
      "UPDATE download_settings SET allowed_hours_start = '9:05'",
      "UPDATE download_settings SET allowed_hours_end = '23:60'",
      "UPDATE download_settings SET theme = 'system'",
      'UPDATE download_settings SET theme = NULL',
      'UPDATE download_settings SET sort_downloads_by_type = 2',
      'UPDATE download_settings SET sort_downloads_by_type = NULL',
      'UPDATE download_settings SET history_retention_days = 14',
      'UPDATE download_settings SET history_retention_days = NULL'
    ]
    for (const sql of invalidUpdates) {
      expect(() => raw.exec(sql)).toThrow()
    }

    raw.exec(
      "UPDATE download_settings SET max_concurrent_downloads = 1, per_host_connections = 16, global_speed_limit_bps = 1073741824, allowed_hours_enabled = 1, allowed_hours_start = '23:59', allowed_hours_end = '23:59', theme = 'light', sort_downloads_by_type = 1, history_retention_days = 90"
    )
    expect(rowsOf(raw, 'download_settings')[0]).toMatchObject({
      max_concurrent_downloads: 1,
      per_host_connections: 16,
      global_speed_limit_bps: 1_073_741_824,
      allowed_hours_enabled: 1,
      allowed_hours_start: '23:59',
      allowed_hours_end: '23:59',
      theme: 'light',
      sort_downloads_by_type: 1,
      history_retention_days: 90
    })
    raw.close()
  })

  it('stores only settings fields and no URL, path or secret columns', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    close(database)

    const raw = new DatabaseSync(filePath)
    const columns = columnNames(raw, 'download_settings')
    raw.close()

    expect(columns).toEqual([
      'id',
      'max_concurrent_downloads',
      'per_host_connections',
      'global_speed_limit_bps',
      'allowed_hours_enabled',
      'allowed_hours_start',
      'allowed_hours_end',
      'updated_at',
      'theme',
      'sort_downloads_by_type',
      'history_retention_days'
    ])
    expect(columns.filter((name) => /url|path|token|secret|cookie|header/i.test(name))).toEqual(
      []
    )
  })
})

describe('per-download control persistence', () => {
  it('defaults migrated and new download rows to unscheduled and unlimited', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    database.save({ record: downloadRecord(), explicitFilename: 'chosen-name.zip' })

    const stored = database.loadAll()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      explicitFilename: 'chosen-name.zip',
      scheduledAt: null,
      speedLimitBps: null
    })
    expect(stored[0]?.record.status).toBe('active')
    close(database)
  })

  it('round-trips custom per-download controls without touching other values', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    const record = downloadRecord()
    first.save({ record, explicitFilename: 'chosen-name.zip' })
    first.saveDownloadControls(record.id, {
      scheduledAt: Date.UTC(2026, 10, 5, 1, 2, 3),
      speedLimitBps: 4 * 1024 * 1024,
      connections: 6
    })
    first.saveDownloadControls(record.id, {
      scheduledAt: null,
      speedLimitBps: null,
      connections: null
    })
    first.saveDownloadControls(record.id, {
      scheduledAt: 0,
      speedLimitBps: MAX_SPEED_LIMIT_BPS,
      connections: 16
    })
    first.saveDownloadBlockReason(record.id, 'allowed-hours')
    close(first)

    const second = open(filePath)
    const stored = second.loadAll()[0]
    expect(stored).toMatchObject({
      explicitFilename: 'chosen-name.zip',
      scheduledAt: 0,
      speedLimitBps: MAX_SPEED_LIMIT_BPS,
      connections: 16,
      blockReason: 'allowed-hours'
    })
    expect(stored?.record).toEqual({
      ...record,
      // Speed and ETA are transient and start fresh after a relaunch.
      speedBps: 0,
      etaSeconds: null,
      // The raw aria2 detail column is empty for a record without a failure.
      errorDetail: null
    })
    close(second)
  })

  it('rejects invalid per-download controls and unknown download ids', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const record = downloadRecord()
    database.save({ record, explicitFilename: null })

    for (const controls of [
      { scheduledAt: -1, speedLimitBps: null, connections: null },
      { scheduledAt: 1.5, speedLimitBps: null, connections: null },
      { scheduledAt: null, speedLimitBps: 0, connections: null },
      { scheduledAt: null, speedLimitBps: -1, connections: null },
      {
        scheduledAt: null,
        speedLimitBps: MAX_SPEED_LIMIT_BPS + 1,
        connections: null
      },
      { scheduledAt: null, speedLimitBps: null, connections: 0 },
      { scheduledAt: null, speedLimitBps: null, connections: 17 },
      { scheduledAt: null, speedLimitBps: null, connections: 1.5 }
    ]) {
      expect(() => database.saveDownloadControls(record.id, controls)).toThrow()
    }
    expect(database.loadAll()[0]).toMatchObject({
      scheduledAt: null,
      speedLimitBps: null,
      connections: null,
      blockReason: null
    })
    expect(() =>
      database.saveDownloadControls('00000000-0000-4000-8000-000000000000', {
        scheduledAt: null,
        speedLimitBps: null,
        connections: null
      })
    ).toThrow(/not found/)
    close(database)
  })

  it('enforces the per-download CHECK constraints at the database layer', async () => {
    const filePath = await makeDatabasePath()
    const database = open(filePath)
    const record = downloadRecord()
    database.save({ record, explicitFilename: null })
    close(database)

    const raw = new DatabaseSync(filePath)
    expect(columnNames(raw, 'downloads')).toEqual([
      ...DOWNLOAD_COLUMNS,
      'scheduled_at',
      'speed_limit_bps',
      'connections',
      'block_reason',
      'needs_login',
      'error_detail',
      'checksum_algorithm',
      'checksum_ok',
      'checksum_computed',
      'checksum_checked_at'
    ])
    const invalidUpdates = [
      'UPDATE downloads SET scheduled_at = -1',
      'UPDATE downloads SET scheduled_at = 9007199254740991',
      'UPDATE downloads SET speed_limit_bps = 0',
      'UPDATE downloads SET speed_limit_bps = -1',
      `UPDATE downloads SET speed_limit_bps = ${MAX_SPEED_LIMIT_BPS + 1}`,
      'UPDATE downloads SET connections = 0',
      'UPDATE downloads SET connections = 17',
      "UPDATE downloads SET block_reason = 'paused'"
    ]
    for (const sql of invalidUpdates) {
      expect(() => raw.exec(sql)).toThrow()
    }

    raw.exec(
      `UPDATE downloads SET scheduled_at = 0, speed_limit_bps = ${MAX_SPEED_LIMIT_BPS}, connections = 1, block_reason = 'scheduled'`
    )
    expect(rowsOf(raw, 'downloads')[0]).toMatchObject({
      scheduled_at: 0,
      speed_limit_bps: MAX_SPEED_LIMIT_BPS,
      connections: 1,
      block_reason: 'scheduled'
    })
    raw.close()
  })
})

describe.each([1, 2, 3, 4])('v%s to v5 migration', (version) => {
  it('preserves existing rows, statuses, indexes and foreign keys', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    const fixture = createLegacyDatabase(filePath, version)

    const beforeRaw = new DatabaseSync(filePath)
    const downloadIndexes = indexNames(beforeRaw, 'downloads')
    const mediaIndexes =
      version >= 2 ? indexNames(beforeRaw, 'media_jobs') : []
    const batchParentIndexes =
      version >= 3 ? indexNames(beforeRaw, 'batches') : []
    const batchItemIndexes =
      version >= 3 ? indexNames(beforeRaw, 'batch_items') : []
    beforeRaw.close()

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.loadSettings()).toEqual(defaultDownloadSettings())

    const downloads = database.loadAll()
    expect(downloads).toHaveLength(2)
    for (const entry of downloads) {
      expect(entry.scheduledAt).toBeNull()
      expect(entry.speedLimitBps).toBeNull()
      expect(entry.connections).toBeNull()
      expect(entry.blockReason).toBeNull()
    }
    expect(
      downloads.find((entry) => entry.record.id === 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
    ).toMatchObject({
      explicitFilename: 'chosen-name.zip',
      record: { status: 'active', completedBytes: 250 }
    })
    expect(
      downloads.find((entry) => entry.record.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    ).toMatchObject({
      explicitFilename: null,
      record: { status: 'complete', completedAt: Date.UTC(2001, 0, 1) }
    })

    if (version >= 2) {
      expect(database.loadMediaJobs()).toHaveLength(1)
      expect(database.loadMediaJobs()[0]).toMatchObject({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'complete',
        completedBytes: 1_000
      })
    } else {
      expect(database.loadMediaJobs()).toEqual([])
    }

    if (version >= 3) {
      const batches = database.loadBatches()
      expect(batches).toHaveLength(1)
      expect(batches[0]?.record).toMatchObject({
        id: 'batch_0123456789abcdef',
        status: 'partial',
        sourceUrl: 'https://example.com/playlist?list=abc'
      })
      const itemStatuses = batches[0]?.items.map((item) => item.status)
      if (version >= 4) {
        expect(itemStatuses).toEqual([
          'complete',
          'error',
          'unavailable',
          'skipped'
        ])
      } else {
        expect(itemStatuses).toEqual(['complete', 'error'])
      }
    } else {
      expect(database.loadBatches()).toEqual([])
    }
    close(database)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(rowsOf(verify, 'download_settings')).toHaveLength(1)
    expect(tableExists(verify, 'download_settings')).toBe(true)
    // v17 adds one composite history index per list table and v19 adds the
    // cleanup index; the indexes that already existed are still present.
    expect(indexNames(verify, 'downloads')).toEqual(
      [
        ...downloadIndexes,
        'downloads_created_at_updated_at_idx',
        'downloads_history_cleanup_idx'
      ].sort()
    )
    expect(project(rowsOf(verify, 'downloads'), DOWNLOAD_COLUMNS)).toEqual(
      project(fixture.downloads, DOWNLOAD_COLUMNS)
    )
    if (version >= 2) {
      expect(rowsOf(verify, 'media_jobs')).toMatchObject(fixture.media)
      expect(indexNames(verify, 'media_jobs')).toEqual(
        [
          ...mediaIndexes,
          'media_jobs_created_at_updated_at_idx',
          'media_jobs_history_cleanup_idx'
        ].sort()
      )
    }
    if (version >= 3) {
      expect(rowsOf(verify, 'batches')).toMatchObject(fixture.batches)
      expect(rowsOf(verify, 'batch_items')).toEqual(fixture.batchItems)
      expect(indexNames(verify, 'batches')).toEqual(
        [
          ...batchParentIndexes,
          'batches_created_at_updated_at_idx',
          'batches_history_cleanup_idx'
        ].sort()
      )
      expect(indexNames(verify, 'batch_items')).toEqual(batchItemIndexes)
      const foreignKeys = verify
        .prepare("PRAGMA foreign_key_list('batch_items')")
        .all() as { table: string; on_delete: string }[]
      expect(foreignKeys).toHaveLength(1)
      expect(foreignKeys[0]).toMatchObject({
        table: 'batches',
        on_delete: 'CASCADE'
      })
    }
    verify.close()
  })
})

describe('v5 to v8 migration', () => {
  it('adds connection, policy, and optional media cap columns without changing prior data', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    createLegacyDatabase(filePath, 4)

    const raw = new DatabaseSync(filePath)
    raw.exec(`
      ALTER TABLE downloads ADD COLUMN scheduled_at INTEGER
        CHECK (
          scheduled_at IS NULL OR
          (scheduled_at >= 0 AND scheduled_at <= 8640000000000000)
        );
      ALTER TABLE downloads ADD COLUMN speed_limit_bps INTEGER
        CHECK (
          speed_limit_bps IS NULL OR
          (speed_limit_bps >= 1 AND speed_limit_bps <= 1073741824)
        );
      CREATE TABLE download_settings (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        max_concurrent_downloads INTEGER NOT NULL DEFAULT 3
          CHECK (max_concurrent_downloads BETWEEN 1 AND 16),
        per_host_connections INTEGER NOT NULL DEFAULT 4
          CHECK (per_host_connections BETWEEN 1 AND 16),
        global_speed_limit_bps INTEGER NOT NULL DEFAULT 0
          CHECK (global_speed_limit_bps BETWEEN 0 AND 1073741824),
        allowed_hours_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (allowed_hours_enabled IN (0, 1)),
        allowed_hours_start TEXT NOT NULL DEFAULT '00:00',
        allowed_hours_end TEXT NOT NULL DEFAULT '00:00',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO download_settings VALUES (
        1, 7, 9, 2048, 1, '21:15', '05:45', 123
      );
      UPDATE downloads
      SET scheduled_at = 1762315200000, speed_limit_bps = 8388608
      WHERE id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      PRAGMA user_version = 5;
    `)
    const before = rowsOf(raw, 'downloads')
    raw.close()

    const database = open(filePath)
    expect(database.schemaVersion).toBe(SCHEMA_VERSION)
    expect(database.loadSettings()).toEqual({
      maxConcurrentDownloads: 7,
      perHostConnections: 9,
      globalSpeedLimitBps: 2048,
      allowedHours: { enabled: true, start: '21:15', end: '05:45' },
      theme: 'oled',
      sortDownloadsByType: false,
      historyRetentionDays: 30
    })
    const stored = database.loadAll()
    const original = stored.find(
      (entry) => entry.record.id === 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    )
    expect(original).toMatchObject({
      scheduledAt: 1762315200000,
      speedLimitBps: 8388608,
      connections: null,
      blockReason: null
    })
    close(database)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(columnNames(verify, 'downloads')).toEqual([
      ...DOWNLOAD_COLUMNS,
      'scheduled_at',
      'speed_limit_bps',
      'connections',
      'block_reason',
      'needs_login',
      'error_detail',
      'checksum_algorithm',
      'checksum_ok',
      'checksum_computed',
      'checksum_checked_at'
    ])
    expect(project(rowsOf(verify, 'downloads'), DOWNLOAD_COLUMNS)).toEqual(
      project(before, DOWNLOAD_COLUMNS)
    )
    verify.close()
  })
})

describe('v7 to v8 theme migration', () => {
  it('adds oled for existing users without changing stored download settings', async () => {
    const filePath = await makeDatabasePath()
    const seed = open(filePath)
    seed.saveSettings({
      ...defaultDownloadSettings(),
      maxConcurrentDownloads: 9,
      perHostConnections: 7,
      globalSpeedLimitBps: 4096,
      allowedHours: { enabled: true, start: '20:00', end: '04:30' },
      theme: 'light'
    })
    close(seed)

    // Simulate a database created before appearance existed.
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      ALTER TABLE download_settings DROP COLUMN theme;
      ALTER TABLE download_settings DROP COLUMN sort_downloads_by_type;
      ALTER TABLE download_settings DROP COLUMN history_retention_days;
      ALTER TABLE downloads DROP COLUMN needs_login;
      ALTER TABLE downloads DROP COLUMN error_detail;
      ALTER TABLE downloads DROP COLUMN checksum_algorithm;
      ALTER TABLE downloads DROP COLUMN checksum_ok;
      ALTER TABLE downloads DROP COLUMN checksum_computed;
      ALTER TABLE downloads DROP COLUMN checksum_checked_at;
      UPDATE download_settings
      SET max_concurrent_downloads = 9,
          per_host_connections = 7,
          global_speed_limit_bps = 4096,
          allowed_hours_enabled = 1,
          allowed_hours_start = '20:00',
          allowed_hours_end = '04:30',
          updated_at = 123;
      PRAGMA user_version = 7;
    `)
    legacy.close()

    const migrated = open(filePath)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.loadSettings()).toEqual({
      maxConcurrentDownloads: 9,
      perHostConnections: 7,
      globalSpeedLimitBps: 4096,
      allowedHours: { enabled: true, start: '20:00', end: '04:30' },
      theme: 'oled',
      sortDownloadsByType: false,
      historyRetentionDays: 30
    })
    close(migrated)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(columnNames(verify, 'download_settings')).toContain('theme')
    expect(rowsOf(verify, 'download_settings')[0]).toMatchObject({
      max_concurrent_downloads: 9,
      per_host_connections: 7,
      global_speed_limit_bps: 4096,
      allowed_hours_enabled: 1,
      allowed_hours_start: '20:00',
      allowed_hours_end: '04:30',
      theme: 'oled',
      sort_downloads_by_type: 0,
      history_retention_days: 30,
      updated_at: 123
    })
    verify.close()
  })
})

describe('v13 to v14 per-host connection migration', () => {
  /** Seed a database at the previous schema version with one stored value. */
  async function seedV13(perHostConnections: number): Promise<string> {
    const filePath = await makeDatabasePath()
    const seed = open(filePath)
    seed.saveSettings({ ...defaultDownloadSettings(), perHostConnections })
    close(seed)

    // Simulate a database created before the default changed to 16.
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      ALTER TABLE downloads DROP COLUMN checksum_algorithm;
      ALTER TABLE downloads DROP COLUMN checksum_ok;
      ALTER TABLE downloads DROP COLUMN checksum_computed;
      ALTER TABLE downloads DROP COLUMN checksum_checked_at;
      UPDATE download_settings SET per_host_connections = ${perHostConnections};
      ALTER TABLE download_settings DROP COLUMN sort_downloads_by_type;
      ALTER TABLE download_settings DROP COLUMN history_retention_days;
      PRAGMA user_version = 13;
    `)
    legacy.close()
    return filePath
  }

  it('raises the stored old default of 4 to 16', async () => {
    const filePath = await seedV13(4)
    const migrated = open(filePath)

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.loadSettings().perHostConnections).toBe(16)
    close(migrated)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(rowsOf(verify, 'download_settings')[0]).toMatchObject({
      per_host_connections: 16
    })
    verify.close()
  })

  it('keeps a 4 the user chooses after the migration ran', async () => {
    const filePath = await seedV13(4)
    const migrated = open(filePath)
    expect(migrated.loadSettings().perHostConnections).toBe(16)
    migrated.saveSettings({
      ...migrated.loadSettings(),
      perHostConnections: 4
    })
    close(migrated)

    // The migration belongs to the schema version, so it never runs twice.
    const reopened = open(filePath)
    expect(reopened.loadSettings().perHostConnections).toBe(4)
    close(reopened)
  })

  it('leaves every other stored value untouched', async () => {
    for (const value of [1, 2, 8, 12, 16]) {
      const filePath = await seedV13(value)
      const migrated = open(filePath)
      expect(migrated.loadSettings().perHostConnections).toBe(value)
      close(migrated)
    }
  })
})

describe('v14 to v15 MEGA folder migration', () => {
  const batchRecord = {
    id: 'batch_legacy',
    kind: 'pixeldrain-list' as const,
    title: 'Legacy list',
    status: 'complete' as const,
    sourceUrl: 'https://pixeldrain.com/l/abcd1234',
    mediaQuality: null,
    maxBytesPerItem: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW
  }
  const batchItems = [
    {
      id: 'bitem_legacy_1',
      batchId: 'batch_legacy',
      position: 0,
      kind: 'download' as const,
      status: 'complete' as const,
      title: 'First file',
      label: 'Pixeldrain',
      childId: 'download_1',
      completedBytes: 10,
      totalBytes: 10,
      errorMessage: null,
      sourceUrl: 'https://pixeldrain.com/u/abcd1234',
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW
    },
    {
      id: 'bitem_legacy_2',
      batchId: 'batch_legacy',
      position: 1,
      kind: 'download' as const,
      status: 'error' as const,
      title: 'Second file',
      label: 'Pixeldrain',
      childId: null,
      completedBytes: 0,
      totalBytes: null,
      errorMessage: 'The item failed.',
      sourceUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null
    }
  ]

  /** Seed a database whose schema version is still 14. */
  async function seedV14(): Promise<string> {
    const filePath = await makeDatabasePath()
    const seed = open(filePath)
    seed.saveBatchWithItems(batchRecord, batchItems)
    close(seed)

    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      ALTER TABLE downloads DROP COLUMN checksum_algorithm;
      ALTER TABLE downloads DROP COLUMN checksum_ok;
      ALTER TABLE downloads DROP COLUMN checksum_computed;
      ALTER TABLE downloads DROP COLUMN checksum_checked_at;
      ALTER TABLE download_settings DROP COLUMN sort_downloads_by_type;
      ALTER TABLE download_settings DROP COLUMN history_retention_days;
      PRAGMA user_version = 14;
    `)
    legacy.close()
    return filePath
  }

  it('keeps every batch and item row while widening the kind list', async () => {
    const filePath = await seedV14()
    const migrated = open(filePath)

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    const batches = migrated.loadBatches()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.record).toMatchObject({
      id: 'batch_legacy',
      kind: 'pixeldrain-list',
      sourceUrl: 'https://pixeldrain.com/l/abcd1234'
    })
    // The parent table is rebuilt, so the cascade must not eat the children.
    expect(batches[0]!.items).toHaveLength(2)
    expect(batches[0]!.items.map((item) => item.id).sort()).toEqual([
      'bitem_legacy_1',
      'bitem_legacy_2'
    ])

    // The new kind is accepted and the old ones still are.
    migrated.saveBatch({
      ...batchRecord,
      id: 'batch_mega',
      kind: 'mega-folder',
      title: 'MEGA folder'
    })
    expect(
      migrated.loadBatch('batch_mega')?.record.kind
    ).toBe('mega-folder')
    close(migrated)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(indexNames(verify, 'batches')).toEqual(
      expect.arrayContaining(['batches_created_at_idx', 'batches_status_idx'])
    )
    expect(tableExists(verify, 'batch_items_v15_backup')).toBe(false)
    verify.close()
  })
})

describe('v15 to v16 sort-by-type migration', () => {
  it('adds the setting defaulted off and preserves stored values', async () => {
    const filePath = await makeDatabasePath()
    const seed = open(filePath)
    seed.saveSettings({
      ...defaultDownloadSettings(),
      maxConcurrentDownloads: 11,
      perHostConnections: 5,
      globalSpeedLimitBps: 4096,
      allowedHours: { enabled: true, start: '21:15', end: '05:45' },
      theme: 'dark',
      sortDownloadsByType: true
    })
    close(seed)

    // Simulate a database created before type sorting existed.
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      ALTER TABLE downloads DROP COLUMN checksum_algorithm;
      ALTER TABLE downloads DROP COLUMN checksum_ok;
      ALTER TABLE downloads DROP COLUMN checksum_computed;
      ALTER TABLE downloads DROP COLUMN checksum_checked_at;
      ALTER TABLE download_settings DROP COLUMN sort_downloads_by_type;
      ALTER TABLE download_settings DROP COLUMN history_retention_days;
      PRAGMA user_version = 15;
    `)
    legacy.close()

    const migrated = open(filePath)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.loadSettings()).toEqual({
      maxConcurrentDownloads: 11,
      perHostConnections: 5,
      globalSpeedLimitBps: 4096,
      allowedHours: { enabled: true, start: '21:15', end: '05:45' },
      theme: 'dark',
      sortDownloadsByType: false,
      historyRetentionDays: 30
    })
    close(migrated)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(columnNames(verify, 'download_settings')).toContain(
      'sort_downloads_by_type'
    )
    expect(rowsOf(verify, 'download_settings')[0]).toMatchObject({
      max_concurrent_downloads: 11,
      per_host_connections: 5,
      global_speed_limit_bps: 4096,
      allowed_hours_enabled: 1,
      allowed_hours_start: '21:15',
      allowed_hours_end: '05:45',
      theme: 'dark',
      sort_downloads_by_type: 0,
      history_retention_days: 30
    })
    verify.close()
  })

  it('round-trips the enabled flag after the migration', async () => {
    const filePath = await makeDatabasePath()
    const first = open(filePath)
    first.saveSettings({
      ...defaultDownloadSettings(),
      sortDownloadsByType: true
    })
    close(first)

    const second = open(filePath)
    expect(second.loadSettings().sortDownloadsByType).toBe(true)
    close(second)

    const raw = new DatabaseSync(filePath)
    expect(rowsOf(raw, 'download_settings')[0]).toMatchObject({
      sort_downloads_by_type: 1
    })
    raw.close()
  })
})

describe('v18 to v19 history-retention migration', () => {
  it('adds the 30-day default, keeps values and creates the cleanup indexes', async () => {
    const filePath = await makeDatabasePath()
    const seed = open(filePath)
    seed.saveSettings({
      ...defaultDownloadSettings(),
      maxConcurrentDownloads: 8,
      perHostConnections: 6,
      globalSpeedLimitBps: 8192,
      allowedHours: { enabled: true, start: '23:00', end: '07:00' },
      theme: 'light',
      sortDownloadsByType: true,
      historyRetentionDays: 90
    })
    close(seed)

    // Simulate a database created before automatic history cleanup existed.
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      DROP INDEX IF EXISTS downloads_history_cleanup_idx;
      DROP INDEX IF EXISTS media_jobs_history_cleanup_idx;
      DROP INDEX IF EXISTS batches_history_cleanup_idx;
      ALTER TABLE download_settings DROP COLUMN history_retention_days;
      PRAGMA user_version = 18;
    `)
    legacy.close()

    const migrated = open(filePath)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.loadSettings()).toEqual({
      maxConcurrentDownloads: 8,
      perHostConnections: 6,
      globalSpeedLimitBps: 8192,
      allowedHours: { enabled: true, start: '23:00', end: '07:00' },
      theme: 'light',
      sortDownloadsByType: true,
      historyRetentionDays: 30
    })
    migrated.saveSettings({
      ...migrated.loadSettings(),
      historyRetentionDays: 7
    })
    expect(migrated.loadSettings().historyRetentionDays).toBe(7)
    close(migrated)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(SCHEMA_VERSION)
    expect(columnNames(verify, 'download_settings')).toContain(
      'history_retention_days'
    )
    expect(rowsOf(verify, 'download_settings')[0]).toMatchObject({
      history_retention_days: 7
    })
    expect(indexNames(verify, 'downloads')).toContain(
      'downloads_history_cleanup_idx'
    )
    expect(indexNames(verify, 'media_jobs')).toContain(
      'media_jobs_history_cleanup_idx'
    )
    expect(indexNames(verify, 'batches')).toContain(
      'batches_history_cleanup_idx'
    )
    verify.close()
  })
})

describe('v5 migration rollback', () => {  it('rolls back added columns and settings when the migration fails', async () => {
    const filePath = await makeDatabasePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    const fixture = createLegacyDatabase(filePath, 4)

    const conflict = new DatabaseSync(filePath)
    const downloadIndexes = indexNames(conflict, 'downloads')
    const batchItemIndexes = indexNames(conflict, 'batch_items')
    conflict.exec(
      "CREATE TABLE download_settings (id INTEGER PRIMARY KEY, marker TEXT NOT NULL DEFAULT 'conflict')"
    )
    conflict.close()

    expect(() => openDownloadDatabase(filePath)).toThrow(/migrate/i)

    const verify = new DatabaseSync(filePath)
    expect(userVersion(verify)).toBe(4)
    expect(columnNames(verify, 'downloads')).toEqual(DOWNLOAD_COLUMNS)
    expect(columnNames(verify, 'downloads')).not.toContain('scheduled_at')
    expect(columnNames(verify, 'downloads')).not.toContain('speed_limit_bps')
    expect(columnNames(verify, 'downloads')).not.toContain('connections')
    expect(columnNames(verify, 'downloads')).not.toContain('block_reason')
    expect(project(rowsOf(verify, 'downloads'), DOWNLOAD_COLUMNS)).toEqual(
      project(fixture.downloads, DOWNLOAD_COLUMNS)
    )
    expect(rowsOf(verify, 'media_jobs')).toEqual(fixture.media)
    expect(rowsOf(verify, 'batches')).toEqual(fixture.batches)
    expect(rowsOf(verify, 'batch_items')).toEqual(fixture.batchItems)
    expect(rowsOf(verify, 'download_settings')).toEqual([])
    expect(indexNames(verify, 'downloads')).toEqual(downloadIndexes)
    expect(indexNames(verify, 'batch_items')).toEqual(batchItemIndexes)
    expect(columnNames(verify, 'download_settings')).toEqual(['id', 'marker'])
    expect(tableExists(verify, 'download_settings')).toBe(true)
    verify.close()
  })
})
