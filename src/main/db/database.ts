import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { DownloadItem, DownloadStatus } from '@shared/types'
import {
  MEDIA_FORMAT_KINDS,
  isMediaJobStatus,
  normalizeMediaSourceUrl,
  type MediaJobRecord
} from '@shared/media'
import { AppError } from '../errors'

/**
 * SQLite runtime note: Electron 45 ships Node 24, which includes the
 * `node:sqlite` built-in (SQLite 3.53 in Electron 45.2). Using the built-in
 * avoids a native addon, electron-rebuild, and asar unpack rules. The same
 * module is available to the Vitest process (Node 24) for hermetic tests.
 */
export const DATABASE_FILENAME = 'downloads.sqlite3'
export const SCHEMA_VERSION = 2

const DOWNLOAD_STATUSES: ReadonlySet<string> = new Set<DownloadStatus>([
  'queued',
  'active',
  'waiting',
  'paused',
  'complete',
  'error',
  'interrupted'
])

export interface StoredDownload {
  record: DownloadItem
  explicitFilename: string | null
}

export interface DownloadSaveEntry {
  record: DownloadItem
  explicitFilename: string | null
}

interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
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
  },
  {
    // Additive only: v1 download rows are never rewritten by this migration.
    version: 2,
    sql: `
      CREATE TABLE media_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        source_url TEXT NOT NULL,
        analysis_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('video', 'audio')),
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
  }
]

/** The database lives in a dedicated file inside Electron's userData folder. */
export function resolveDownloadDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, DATABASE_FILENAME)
}

function databaseError(context: string, error: unknown): AppError {
  const detail = error instanceof Error ? error.message : 'unknown SQLite error'
  return new AppError('DATABASE_ERROR', `${context}: ${detail}`)
}

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | Record<string, unknown>
    | undefined
  const value = row?.user_version
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function migrate(db: DatabaseSync): void {
  const current = schemaVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new AppError(
      'DATABASE_VERSION_UNSUPPORTED',
      `Download history was created by a newer version (schema ${current}).`
    )
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      // version is a trusted integer constant from MIGRATIONS.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not migrate download history', error)
    }
  }
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

function number(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = row[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

function nullableNumber(
  row: Record<string, unknown>,
  key: string
): number | null {
  const value = row[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function rowToStored(row: Record<string, unknown>): StoredDownload | null {
  const id = text(row, 'id')
  const gid = text(row, 'gid')
  const url = text(row, 'url')
  const filename = text(row, 'filename')
  const dir = text(row, 'dir')
  const rawStatus = text(row, 'status')

  // Skip rows that cannot be understood rather than crashing the app or
  // pretending they are valid. The foreign key-less table is app-owned.
  if (!id || !gid || !url || !filename || !dir || !rawStatus) return null
  if (!DOWNLOAD_STATUSES.has(rawStatus)) return null

  const attempts = Math.max(1, Math.trunc(number(row, 'attempts', 1)))
  const maxAttempts = Math.max(1, Math.trunc(number(row, 'max_attempts', 3)))

  return {
    record: {
      id,
      gid,
      url,
      filename,
      dir,
      filePath: text(row, 'file_path'),
      status: rawStatus as DownloadStatus,
      totalBytes: Math.max(0, Math.trunc(number(row, 'total_bytes'))),
      completedBytes: Math.max(0, Math.trunc(number(row, 'completed_bytes'))),
      // Speed and ETA are transient; they start fresh after a relaunch.
      speedBps: 0,
      etaSeconds: null,
      errorMessage: text(row, 'error_message'),
      attempts,
      maxAttempts,
      createdAt: Math.trunc(number(row, 'created_at')),
      updatedAt: Math.trunc(number(row, 'updated_at')),
      completedAt: nullableNumber(row, 'completed_at')
    },
    explicitFilename: text(row, 'explicit_filename')
  }
}

function rowToMediaRecord(row: Record<string, unknown>): MediaJobRecord | null {
  const id = text(row, 'id')
  const sourceUrl = text(row, 'source_url')
  const analysisId = text(row, 'analysis_id')
  const optionId = text(row, 'option_id')
  const rawKind = text(row, 'kind')
  const label = text(row, 'label')
  const rawStatus = text(row, 'status')
  const dir = text(row, 'dir')

  // Ignore rows the current build cannot understand instead of crashing or
  // deleting them. Media files are never removed by the database layer.
  if (
    !id ||
    !sourceUrl ||
    !analysisId ||
    !optionId ||
    !rawKind ||
    !label ||
    !rawStatus ||
    !dir
  ) {
    return null
  }
  if (!(MEDIA_FORMAT_KINDS as readonly string[]).includes(rawKind)) return null
  if (!isMediaJobStatus(rawStatus)) return null

  return {
    id,
    sourceUrl,
    analysisId,
    optionId,
    kind: rawKind as MediaJobRecord['kind'],
    label,
    status: rawStatus,
    completedBytes: Math.max(0, Math.trunc(number(row, 'completed_bytes'))),
    totalBytes:
      row.total_bytes === null || row.total_bytes === undefined
        ? null
        : Math.max(0, Math.trunc(number(row, 'total_bytes'))),
    errorMessage: text(row, 'error_message'),
    dir,
    filePath: text(row, 'file_path'),
    createdAt: Math.trunc(number(row, 'created_at')),
    updatedAt: Math.trunc(number(row, 'updated_at')),
    completedAt: nullableNumber(row, 'completed_at')
  }
}

export class DownloadDatabase {
  private readonly db: DatabaseSync
  private readonly upsertStatement: StatementSync
  private readonly selectAllStatement: StatementSync
  private readonly deleteStatement: StatementSync
  private readonly mediaUpsertStatement: StatementSync
  private readonly mediaSelectAllStatement: StatementSync
  private readonly mediaDeleteStatement: StatementSync
  private closed = false

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)

    try {
      // WAL keeps small progress writes fast. synchronous=NORMAL is durable
      // across process/app crashes (the recovery scenario here) while still
      // batching fsync work inside one explicit transaction.
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA foreign_keys = ON')
      migrate(this.db)

      this.upsertStatement = this.db.prepare(`
        INSERT INTO downloads (
          id, gid, url, filename, explicit_filename, dir, file_path, status,
          total_bytes, completed_bytes, error_message, attempts, max_attempts,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          gid = excluded.gid,
          url = excluded.url,
          filename = excluded.filename,
          explicit_filename = excluded.explicit_filename,
          dir = excluded.dir,
          file_path = excluded.file_path,
          status = excluded.status,
          total_bytes = excluded.total_bytes,
          completed_bytes = excluded.completed_bytes,
          error_message = excluded.error_message,
          attempts = excluded.attempts,
          max_attempts = excluded.max_attempts,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `)
      this.selectAllStatement = this.db.prepare(`
        SELECT * FROM downloads ORDER BY created_at DESC, updated_at DESC
      `)
      this.deleteStatement = this.db.prepare('DELETE FROM downloads WHERE id = ?')

      this.mediaUpsertStatement = this.db.prepare(`
        INSERT INTO media_jobs (
          id, source_url, analysis_id, option_id, kind, label, status,
          completed_bytes, total_bytes, error_message, dir, file_path,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          analysis_id = excluded.analysis_id,
          option_id = excluded.option_id,
          kind = excluded.kind,
          label = excluded.label,
          status = excluded.status,
          completed_bytes = excluded.completed_bytes,
          total_bytes = excluded.total_bytes,
          error_message = excluded.error_message,
          dir = excluded.dir,
          file_path = excluded.file_path,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `)
      this.mediaSelectAllStatement = this.db.prepare(`
        SELECT * FROM media_jobs ORDER BY created_at DESC, updated_at DESC
      `)
      this.mediaDeleteStatement = this.db.prepare(
        'DELETE FROM media_jobs WHERE id = ?'
      )
    } catch (error) {
      try {
        this.db.close()
      } catch {
        // Ignore close failures while reporting the original problem.
      }
      throw error instanceof AppError
        ? error
        : databaseError('Could not open download history', error)
    }
  }

  get path(): string {
    return this.filePath
  }

  get schemaVersion(): number {
    return schemaVersion(this.db)
  }

  loadAll(): StoredDownload[] {
    this.assertOpen()
    try {
      const rows = this.selectAllStatement.all() as Record<string, unknown>[]
      const stored: StoredDownload[] = []
      for (const row of rows) {
        const parsed = rowToStored(row)
        if (parsed) stored.push(parsed)
      }
      return stored
    } catch (error) {
      throw databaseError('Could not load download history', error)
    }
  }

  save(entry: DownloadSaveEntry): void {
    this.assertOpen()
    try {
      this.runUpsert(entry)
    } catch (error) {
      throw databaseError('Could not save download history', error)
    }
  }

  /** Write a batch atomically so progress snapshots never land half-applied. */
  saveMany(entries: readonly DownloadSaveEntry[]): void {
    if (entries.length === 0) return
    this.assertOpen()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        this.runUpsert(entry)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not save download history', error)
    }
  }

  delete(id: string): void {
    this.assertOpen()
    try {
      this.deleteStatement.run(id)
    } catch (error) {
      throw databaseError('Could not remove download history', error)
    }
  }

  loadMediaJobs(): MediaJobRecord[] {
    this.assertOpen()
    try {
      const rows = this.mediaSelectAllStatement.all() as Record<string, unknown>[]
      const stored: MediaJobRecord[] = []
      for (const row of rows) {
        const parsed = rowToMediaRecord(row)
        if (parsed) stored.push(parsed)
      }
      return stored
    } catch (error) {
      throw databaseError('Could not load media job history', error)
    }
  }

  saveMediaJob(record: MediaJobRecord): void {
    this.assertOpen()
    try {
      this.runMediaUpsert(record)
    } catch (error) {
      throw databaseError('Could not save media job history', error)
    }
  }

  /** Write a batch atomically so media progress never lands half-applied. */
  saveManyMediaJobs(records: readonly MediaJobRecord[]): void {
    if (records.length === 0) return
    this.assertOpen()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const record of records) {
        this.runMediaUpsert(record)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not save media job history', error)
    }
  }

  deleteMediaJob(id: string): void {
    this.assertOpen()
    try {
      this.mediaDeleteStatement.run(id)
    } catch (error) {
      throw databaseError('Could not remove media job history', error)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // A checkpoint is an optimisation; the committed history is already safe.
    }
    this.db.close()
  }

  private runUpsert(entry: DownloadSaveEntry): void {
    const record = entry.record
    this.upsertStatement.run(
      record.id,
      record.gid,
      record.url,
      record.filename,
      entry.explicitFilename,
      record.dir,
      record.filePath,
      record.status,
      Math.max(0, Math.trunc(record.totalBytes)),
      Math.max(0, Math.trunc(record.completedBytes)),
      record.errorMessage,
      Math.max(1, Math.trunc(record.attempts)),
      Math.max(1, Math.trunc(record.maxAttempts)),
      Math.trunc(record.createdAt),
      Math.trunc(record.updatedAt),
      record.completedAt === null ? null : Math.trunc(record.completedAt)
    )
  }

  private runMediaUpsert(record: MediaJobRecord): void {
    // Strip credentials/fragments here as a final guard even if a caller
    // skipped the shared normalizer. The source URL never leaves this table.
    const sourceUrl = normalizeMediaSourceUrl(record.sourceUrl)
    this.mediaUpsertStatement.run(
      record.id,
      sourceUrl,
      record.analysisId,
      record.optionId,
      record.kind,
      record.label,
      record.status,
      Math.max(0, Math.trunc(record.completedBytes)),
      record.totalBytes === null ? null : Math.max(0, Math.trunc(record.totalBytes)),
      record.errorMessage,
      record.dir,
      record.filePath,
      Math.trunc(record.createdAt),
      Math.trunc(record.updatedAt),
      record.completedAt === null ? null : Math.trunc(record.completedAt)
    )
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError('DATABASE_CLOSED', 'Download history is closed.')
    }
  }
}

export function openDownloadDatabase(filePath: string): DownloadDatabase {
  return new DownloadDatabase(filePath)
}
