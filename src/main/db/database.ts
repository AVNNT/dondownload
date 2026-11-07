import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  isDownloadBlockReason,
  type DownloadBlockReason,
  type DownloadItem,
  type DownloadStatus
} from '@shared/types'
import {
  MEDIA_FORMAT_KINDS,
  isMediaJobStatus,
  normalizeMediaSourceUrl,
  type MediaJobRecord
} from '@shared/media'
import {
  isBatchItemKind,
  isBatchItemStatus,
  isBatchKind,
  isBatchStatus,
  normalizeBatchSourceUrl,
  type BatchItemRecord,
  type BatchMediaQuality,
  type BatchRecord
} from '@shared/batches'
import {
  DEFAULT_THEME,
  parseDownloadControls,
  parseDownloadSettings,
  type DownloadControls,
  type DownloadSettings
} from '@shared/settings'
import {
  isChecksumAlgorithm,
  isChecksumResult,
  type ChecksumResult
} from '@shared/checksum'
import {
  parseDesktopSettings,
  type DesktopSettings
} from '@shared/desktopSettings'
import {
  parseMediaToolSettings,
  type MediaToolSettings
} from '@shared/mediaTools'
import {
  parseAppUpdateSettings,
  type AppUpdateSettings
} from '@shared/appUpdate'
import { AppError } from '../errors'

/**
 * SQLite runtime note: Electron 45 ships Node 24, which includes the
 * `node:sqlite` built-in (SQLite 3.53 in Electron 45.2). Using the built-in
 * avoids a native addon, electron-rebuild, and asar unpack rules. The same
 * module is available to the Vitest process (Node 24) for hermetic tests.
 */
export const DATABASE_FILENAME = 'downloads.sqlite3'
export const SCHEMA_VERSION = 18

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
  /** Optional per-download controls; null means unscheduled/unlimited/global. */
  scheduledAt: number | null
  speedLimitBps: number | null
  connections: number | null
  /** Persistent policy hold so restart recovery never resumes a user pause. */
  blockReason: DownloadBlockReason | null
  /** One-job browser login marker; never contains the cookie itself. */
  needsLogin: boolean
}

export interface StoredBatch {
  record: BatchRecord
  items: BatchItemRecord[]
}

export interface DownloadSaveEntry {
  record: DownloadItem
  explicitFilename: string | null
  /**
   * True when this job was queued with an opt-in browser Cookie. Only this
   * boolean is persisted; the header itself stays in memory.
   */
  needsLogin?: boolean
}

interface Migration {
  version: number
  sql: string
}

/**
 * Exported for migration tests only. The Database class applies every entry up
 * to SCHEMA_VERSION in order; application code should never use this directly.
 */
export const MIGRATIONS: readonly Migration[] = [
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
  },
  {
    // Additive only: v1 download and v2 media rows are never rewritten.
    version: 3,
    sql: `
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
  },
  {
    // v3 is a committed checkpoint, so its batch_items CHECK cannot be widened
    // in place for databases that already ran it. Rebuild the table with the
    // SQLite safe copy-table pattern inside the migration transaction. All
    // rows, the cascade FK, the UNIQUE constraint and both indexes are kept;
    // only the status CHECK is widened to allow unavailable/skipped items.
    version: 4,
    sql: `
      CREATE TABLE batch_items_v4 (
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

      INSERT INTO batch_items_v4 (
        id, batch_id, position, kind, status, child_id, title, label,
        completed_bytes, total_bytes, error_message, source_url,
        created_at, updated_at, completed_at
      )
      SELECT
        id, batch_id, position, kind, status, child_id, title, label,
        completed_bytes, total_bytes, error_message, source_url,
        created_at, updated_at, completed_at
      FROM batch_items;

      DROP TABLE batch_items;
      ALTER TABLE batch_items_v4 RENAME TO batch_items;

      CREATE INDEX batch_items_batch_id_idx ON batch_items (batch_id, position);
      CREATE INDEX batch_items_status_idx ON batch_items (status);
    `
  },
  {
    // Additive only: existing download/media/batch rows are not rewritten.
    // New download columns default to null, which keeps every existing row
    // unscheduled and unlimited. The single settings row is created with the
    // documented defaults, which also preserves all-day/unlimited behavior.
    version: 5,
    sql: `
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
        allowed_hours_start TEXT NOT NULL DEFAULT '00:00'
          CHECK (
            allowed_hours_start GLOB '[01][0-9]:[0-5][0-9]' OR
            allowed_hours_start GLOB '2[0-3]:[0-5][0-9]'
          ),
        allowed_hours_end TEXT NOT NULL DEFAULT '00:00'
          CHECK (
            allowed_hours_end GLOB '[01][0-9]:[0-5][0-9]' OR
            allowed_hours_end GLOB '2[0-3]:[0-5][0-9]'
          ),
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO download_settings (
        id, max_concurrent_downloads, per_host_connections,
        global_speed_limit_bps, allowed_hours_enabled,
        allowed_hours_start, allowed_hours_end, updated_at
      ) VALUES (1, 3, 4, 0, 0, '00:00', '00:00', 0);
    `
  },
  {
    // Additive only: every existing download row keeps its scheduled/speed
    // values and receives null connections (global per-host setting) plus a
    // null policy hold. No table is rebuilt and no row is rewritten.
    version: 6,
    sql: `
      ALTER TABLE downloads ADD COLUMN connections INTEGER
        CHECK (connections IS NULL OR (connections >= 1 AND connections <= 16));

      ALTER TABLE downloads ADD COLUMN block_reason TEXT
        CHECK (
          block_reason IS NULL OR
          block_reason IN ('scheduled', 'allowed-hours')
      );
    `
  },
  {
    // Optional media output caps and playlist choices survive restart/retry.
    // Existing jobs and batches remain unlimited and retain best-quality behavior.
    version: 7,
    sql: `
      ALTER TABLE media_jobs ADD COLUMN max_bytes INTEGER
        CHECK (max_bytes IS NULL OR max_bytes BETWEEN 1 AND 107374182400);

      ALTER TABLE batches ADD COLUMN media_quality TEXT
        CHECK (media_quality IS NULL OR media_quality IN (
          'best', '1080p', '720p', '480p', '360p', 'audio-only'
        ));

      ALTER TABLE batches ADD COLUMN max_bytes_per_item INTEGER
        CHECK (max_bytes_per_item IS NULL OR max_bytes_per_item BETWEEN 1 AND 107374182400);
    `
  },
  {
    // Appearance is part of the existing single settings row. The additive
    // column keeps every previously stored download-control value and defaults
    // existing/new users to the original OLED-black theme.
    version: 8,
    sql: `
      ALTER TABLE download_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'oled'
        CHECK (theme IN ('oled', 'dark', 'light'));
    `
  },
  {
    // Managed media-tool preferences are separate from download settings so an
    // automatic updater check never rewrites aria2's global options. The single
    // row defaults to keeping yt-dlp up to date, with no prior check timestamp.
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS media_tool_settings (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        auto_update_ytdlp INTEGER NOT NULL DEFAULT 1
          CHECK (auto_update_ytdlp IN (0, 1)),
        last_ytdlp_check_at INTEGER
          CHECK (last_ytdlp_check_at IS NULL OR last_ytdlp_check_at >= 0),
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO media_tool_settings (
        id, auto_update_ytdlp, last_ytdlp_check_at, updated_at
      ) VALUES (1, 1, NULL, 0);
    `
  },
  {
    // Application updater preferences are also separate from download settings
    // so a background check never rewrites aria2's global options. The single
    // row defaults to automatic checks ON with no prior check timestamp.
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS app_update_settings (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        auto_check INTEGER NOT NULL DEFAULT 1
          CHECK (auto_check IN (0, 1)),
        last_check_at INTEGER
          CHECK (last_check_at IS NULL OR last_check_at >= 0),
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO app_update_settings (
        id, auto_check, last_check_at, updated_at
      ) VALUES (1, 1, NULL, 0);
    `
  },
  {
    // A media job can now be paused by the user. SQLite cannot widen a CHECK
    // constraint in place, so the table is rebuilt with the same columns and
    // rows plus `paused` in the status list. Separately, desktop-only
    // preferences get their own single row so they never rewrite aria2's
    // download settings. Defaults keep new behavior opt-in: notifications and
    // startup resume on, clipboard watching and launch-at-login off.
    version: 11,
    sql: `
      CREATE TABLE media_jobs_v11 (
        id TEXT PRIMARY KEY NOT NULL,
        source_url TEXT NOT NULL,
        analysis_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('video', 'audio')),
        title TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'queued', 'analyzing', 'downloading', 'merging', 'paused',
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
        completed_at INTEGER,
        max_bytes INTEGER
          CHECK (max_bytes IS NULL OR max_bytes BETWEEN 1 AND 107374182400)
      );

      INSERT INTO media_jobs_v11 (
        id, source_url, analysis_id, option_id, kind, title, label, status,
        completed_bytes, total_bytes, error_message, dir, file_path,
        created_at, updated_at, completed_at, max_bytes
      )
      SELECT
        id, source_url, analysis_id, option_id, kind, title, label, status,
        completed_bytes, total_bytes, error_message, dir, file_path,
        created_at, updated_at, completed_at, max_bytes
      FROM media_jobs;

      DROP TABLE media_jobs;
      ALTER TABLE media_jobs_v11 RENAME TO media_jobs;

      CREATE INDEX media_jobs_created_at_idx ON media_jobs (created_at DESC);
      CREATE INDEX media_jobs_status_idx ON media_jobs (status);

      CREATE TABLE IF NOT EXISTS desktop_settings (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        resume_interrupted_on_startup INTEGER NOT NULL DEFAULT 1
          CHECK (resume_interrupted_on_startup IN (0, 1)),
        show_notifications INTEGER NOT NULL DEFAULT 0
          CHECK (show_notifications IN (0, 1)),
        watch_clipboard INTEGER NOT NULL DEFAULT 0
          CHECK (watch_clipboard IN (0, 1)),
        launch_at_login INTEGER NOT NULL DEFAULT 0
          CHECK (launch_at_login IN (0, 1)),
        interface_size_percent INTEGER NOT NULL DEFAULT 100
          CHECK (interface_size_percent IN (90, 100, 110, 125)),
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO desktop_settings (
        id, resume_interrupted_on_startup, show_notifications,
        watch_clipboard, launch_at_login, interface_size_percent, updated_at
      ) VALUES (1, 1, 0, 0, 0, 100, 0);
    `
  },
  {
    // Additive only: a job queued with an opt-in browser Cookie records that
    // fact so a restart can ask for the browser login again instead of
    // re-downloading anonymously. The Cookie header is never stored.
    version: 12,
    sql: `
      ALTER TABLE downloads ADD COLUMN needs_login INTEGER NOT NULL DEFAULT 0
        CHECK (needs_login IN (0, 1));
    `
  },
  {
    // Additive only: the raw aria2 failure text is kept beside the
    // plain-language error message so it can be shown as technical detail.
    version: 13,
    sql: `
      ALTER TABLE downloads ADD COLUMN error_detail TEXT;
    `
  },
  {
    // One-time settings migration. The old default of 4 connections per server
    // is raised to the new default of 16, which is aria2's hard cap. Only the
    // exact old default is touched: any other stored value (including a user's
    // own 1, 2, 8 or 12) is left alone. Because this runs once per database
    // version, a user who later picks 4 again keeps it.
    version: 14,
    sql: `
      UPDATE download_settings SET per_host_connections = 16
        WHERE per_host_connections = 4;
    `
  },
  {
    // A public MEGA folder is a new batch source. SQLite cannot widen a CHECK
    // constraint in place, so the parent table is rebuilt with the same columns
    // and rows plus 'mega-folder' in the kind list. The child table, its
    // cascade and both indexes are untouched.
    version: 15,
    sql: `
      CREATE TABLE batches_v15 (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('media-playlist', 'pixeldrain-list', 'mega-folder', 'direct-urls')
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
        completed_at INTEGER,
        media_quality TEXT
          CHECK (media_quality IS NULL OR media_quality IN (
            'best', '1080p', '720p', '480p', '360p', 'audio-only'
          )),
        max_bytes_per_item INTEGER
          CHECK (max_bytes_per_item IS NULL OR max_bytes_per_item BETWEEN 1 AND 107374182400)
      );

      INSERT INTO batches_v15 (
        id, kind, title, status, source_url, error_message,
        created_at, updated_at, completed_at, media_quality, max_bytes_per_item
      )
      SELECT
        id, kind, title, status, source_url, error_message,
        created_at, updated_at, completed_at, media_quality, max_bytes_per_item
      FROM batches;

      -- batch_items declares ON DELETE CASCADE to batches and foreign_keys is
      -- on, so dropping the parent would delete every child row. Keep an exact
      -- copy, empty the child, swap the parent, then restore the children.
      CREATE TABLE batch_items_v15_backup AS SELECT * FROM batch_items;
      DELETE FROM batch_items;

      DROP TABLE batches;
      ALTER TABLE batches_v15 RENAME TO batches;

      INSERT INTO batch_items (
        id, batch_id, position, kind, status, child_id, title, label,
        completed_bytes, total_bytes, error_message, source_url,
        created_at, updated_at, completed_at
      )
      SELECT
        id, batch_id, position, kind, status, child_id, title, label,
        completed_bytes, total_bytes, error_message, source_url,
        created_at, updated_at, completed_at
      FROM batch_items_v15_backup;

      DROP TABLE batch_items_v15_backup;

      CREATE INDEX batches_created_at_idx ON batches (created_at DESC);
      CREATE INDEX batches_status_idx ON batches (status);
    `
  },
  {
    // Opt-in IDM-style sorting. The additive column defaults to off, so every
    // existing database keeps downloading straight into the chosen directory.
    version: 16,
    sql: `
      ALTER TABLE download_settings ADD COLUMN sort_downloads_by_type INTEGER
        NOT NULL DEFAULT 0 CHECK (sort_downloads_by_type IN (0, 1));
    `
  },
  {
    // History/list reads all use `ORDER BY created_at DESC, updated_at DESC`.
    // The v1 single-column index cannot satisfy the second sort key, so add
    // the composite covering index for downloads and the same shape for the
    // media/batch lists. `IF NOT EXISTS` keeps this migration self-contained
    // and safe if a database already carries an identically named index.
    version: 17,
    sql: `
      CREATE INDEX IF NOT EXISTS downloads_created_at_updated_at_idx
        ON downloads (created_at DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS media_jobs_created_at_updated_at_idx
        ON media_jobs (created_at DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS batches_created_at_updated_at_idx
        ON batches (created_at DESC, updated_at DESC);
    `
  },
  {
    // Additive only: persist the last checksum result for a download's own
    // recorded file. Existing rows keep nulls until a verification runs, and
    // the main download upsert never writes these columns, so ordinary
    // progress saves cannot clobber a stored result.
    version: 18,
    sql: `
      ALTER TABLE downloads ADD COLUMN checksum_algorithm TEXT
        CHECK (
          checksum_algorithm IS NULL OR
          checksum_algorithm IN ('md5', 'sha1', 'sha256', 'sha512')
        );

      ALTER TABLE downloads ADD COLUMN checksum_ok INTEGER
        CHECK (checksum_ok IS NULL OR checksum_ok IN (0, 1));

      ALTER TABLE downloads ADD COLUMN checksum_computed TEXT;

      ALTER TABLE downloads ADD COLUMN checksum_checked_at INTEGER
        CHECK (checksum_checked_at IS NULL OR checksum_checked_at >= 0);
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

function rowToChecksum(row: Record<string, unknown>): ChecksumResult | null {
  const algorithm = text(row, 'checksum_algorithm')
  const computed = text(row, 'checksum_computed')
  const checkedAt = nullableNumber(row, 'checksum_checked_at')
  if (!isChecksumAlgorithm(algorithm) || computed === null || checkedAt === null) {
    return null
  }
  const rawOk = nullableNumber(row, 'checksum_ok')
  const result: ChecksumResult = {
    algorithm,
    ok: rawOk === null ? null : rawOk === 1,
    computed,
    checkedAt
  }
  return isChecksumResult(result) ? result : null
}

function rowToStored(row: Record<string, unknown>): StoredDownload | null {
  const id = text(row, 'id')
  const gid = text(row, 'gid')
  const url = text(row, 'url')
  const filename = text(row, 'filename')
  const dir = text(row, 'dir')
  const rawStatus = text(row, 'status')

  // Skip rows that cannot be understood rather than crashing the app or
  // pretending they are valid. The foreign key-less table is app-owned. An
  // empty gid is valid: a scheduled/allowed-hours-blocked job is persisted
  // before aria2 has assigned it one.
  if (!id || !url || !filename || !dir || !rawStatus) return null
  if (!DOWNLOAD_STATUSES.has(rawStatus)) return null

  const attempts = Math.max(1, Math.trunc(number(row, 'attempts', 1)))
  const maxAttempts = Math.max(1, Math.trunc(number(row, 'max_attempts', 3)))
  const checksum = rowToChecksum(row)

  return {
    record: {
      id,
      gid: gid ?? '',
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
      errorDetail: text(row, 'error_detail'),
      attempts,
      maxAttempts,
      createdAt: Math.trunc(number(row, 'created_at')),
      updatedAt: Math.trunc(number(row, 'updated_at')),
      completedAt: nullableNumber(row, 'completed_at'),
      ...(checksum === null ? {} : { checksum })
    },
    explicitFilename: text(row, 'explicit_filename'),
    scheduledAt: nullableNumber(row, 'scheduled_at'),
    speedLimitBps: nullableNumber(row, 'speed_limit_bps'),
    connections: nullableNumber(row, 'connections'),
    blockReason: isDownloadBlockReason(row.block_reason)
      ? row.block_reason
      : null,
    needsLogin: number(row, 'needs_login', 0) === 1
  }
}

function rowToSettings(row: Record<string, unknown>): DownloadSettings {
  return parseDownloadSettings({
    maxConcurrentDownloads: number(row, 'max_concurrent_downloads'),
    perHostConnections: number(row, 'per_host_connections'),
    globalSpeedLimitBps: number(row, 'global_speed_limit_bps'),
    allowedHours: {
      enabled: number(row, 'allowed_hours_enabled') === 1,
      start: text(row, 'allowed_hours_start'),
      end: text(row, 'allowed_hours_end')
    },
    // The migration default covers old rows; this fallback keeps a malformed
    // row from taking the app down before the shared parser can reject it.
    theme: text(row, 'theme') ?? DEFAULT_THEME,
    sortDownloadsByType: number(row, 'sort_downloads_by_type', 0) === 1
  })
}

function rowToMediaToolSettings(
  row: Record<string, unknown>
): MediaToolSettings {
  return parseMediaToolSettings({
    autoUpdateYtdlp: number(row, 'auto_update_ytdlp', 1) === 1,
    lastYtdlpCheckAt: nullableNumber(row, 'last_ytdlp_check_at')
  })
}

function rowToAppUpdateSettings(
  row: Record<string, unknown>
): AppUpdateSettings {
  return parseAppUpdateSettings({
    autoCheck: number(row, 'auto_check', 1) === 1,
    lastCheckedAt: nullableNumber(row, 'last_check_at')
  })
}

function rowToDesktopSettings(row: Record<string, unknown>): DesktopSettings {
  return parseDesktopSettings({
    resumeInterruptedOnStartup:
      number(row, 'resume_interrupted_on_startup', 1) === 1,
    showNotifications: number(row, 'show_notifications', 0) === 1,
    watchClipboard: number(row, 'watch_clipboard', 0) === 1,
    launchAtLogin: number(row, 'launch_at_login', 0) === 1,
    interfaceSizePercent: number(row, 'interface_size_percent', 100)
  })
}

function rowToMediaRecord(row: Record<string, unknown>): MediaJobRecord | null {
  const id = text(row, 'id')
  const sourceUrl = text(row, 'source_url')
  const analysisId = text(row, 'analysis_id')
  const optionId = text(row, 'option_id')
  const rawKind = text(row, 'kind')
  const title = text(row, 'title')
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
    !title ||
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
    title,
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
    ...(nullableNumber(row, 'max_bytes') === null
      ? {}
      : { maxBytes: nullableNumber(row, 'max_bytes') }),
    createdAt: Math.trunc(number(row, 'created_at')),
    updatedAt: Math.trunc(number(row, 'updated_at')),
    completedAt: nullableNumber(row, 'completed_at')
  }
}

function rowToBatchRecord(row: Record<string, unknown>): BatchRecord | null {
  const id = text(row, 'id')
  const rawKind = text(row, 'kind')
  const title = text(row, 'title')
  const rawStatus = text(row, 'status')

  // Ignore rows the current build cannot understand instead of crashing or
  // deleting them. Batch files are never removed by the database layer.
  if (!id || !rawKind || !title || !rawStatus) return null
  if (!isBatchKind(rawKind) || !isBatchStatus(rawStatus)) return null

  return {
    id,
    kind: rawKind,
    title,
    status: rawStatus,
    sourceUrl: text(row, 'source_url'),
    ...(text(row, 'media_quality') === null
      ? {}
      : { mediaQuality: text(row, 'media_quality') as BatchMediaQuality }),
    ...(nullableNumber(row, 'max_bytes_per_item') === null
      ? {}
      : { maxBytesPerItem: nullableNumber(row, 'max_bytes_per_item') }),
    errorMessage: text(row, 'error_message'),
    createdAt: Math.trunc(number(row, 'created_at')),
    updatedAt: Math.trunc(number(row, 'updated_at')),
    completedAt: nullableNumber(row, 'completed_at')
  }
}

function rowToBatchItemRecord(
  row: Record<string, unknown>
): BatchItemRecord | null {
  const id = text(row, 'id')
  const batchId = text(row, 'batch_id')
  const rawKind = text(row, 'kind')
  const rawStatus = text(row, 'status')
  const title = text(row, 'title')
  const label = text(row, 'label')
  const position = Math.trunc(number(row, 'position', -1))

  if (!id || !batchId || !rawKind || !rawStatus || !title || !label) {
    return null
  }
  if (position < 0) return null
  if (!isBatchItemKind(rawKind) || !isBatchItemStatus(rawStatus)) return null

  return {
    id,
    batchId,
    position,
    kind: rawKind,
    status: rawStatus,
    title,
    label,
    childId: text(row, 'child_id'),
    completedBytes: Math.max(0, Math.trunc(number(row, 'completed_bytes'))),
    totalBytes:
      row.total_bytes === null || row.total_bytes === undefined
        ? null
        : Math.max(0, Math.trunc(number(row, 'total_bytes'))),
    errorMessage: text(row, 'error_message'),
    sourceUrl: text(row, 'source_url'),
    createdAt: Math.trunc(number(row, 'created_at')),
    updatedAt: Math.trunc(number(row, 'updated_at')),
    completedAt: nullableNumber(row, 'completed_at')
  }
}

export class DownloadDatabase {
  private readonly db: DatabaseSync
  private readonly upsertStatement: StatementSync
  private readonly durableRowStatement: StatementSync
  private readonly selectAllStatement: StatementSync
  private readonly deleteStatement: StatementSync
  private readonly downloadControlsStatement: StatementSync
  private readonly downloadBlockReasonStatement: StatementSync
  private readonly downloadChecksumStatement: StatementSync
  private readonly settingsSelectStatement: StatementSync
  private readonly settingsUpsertStatement: StatementSync
  private readonly mediaToolSettingsSelectStatement: StatementSync
  private readonly mediaToolSettingsUpsertStatement: StatementSync
  private readonly appUpdateSettingsSelectStatement: StatementSync
  private readonly appUpdateSettingsUpsertStatement: StatementSync
  private readonly desktopSettingsSelectStatement: StatementSync
  private readonly desktopSettingsUpsertStatement: StatementSync
  private readonly mediaUpsertStatement: StatementSync
  private readonly mediaSelectAllStatement: StatementSync
  private readonly mediaDeleteStatement: StatementSync
  private readonly batchUpsertStatement: StatementSync
  private readonly batchSelectAllStatement: StatementSync
  private readonly batchSelectOneStatement: StatementSync
  private readonly batchDeleteStatement: StatementSync
  private readonly batchItemUpsertStatement: StatementSync
  private readonly batchItemSelectAllStatement: StatementSync
  private readonly batchItemSelectByBatchStatement: StatementSync
  private readonly batchItemDeleteStatement: StatementSync
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
      // Sort/compare scratch space stays in memory; no temp files for the
      // small ORDER BY / index maintenance this database performs.
      this.db.exec('PRAGMA temp_store = MEMORY')
      this.db.exec('PRAGMA foreign_keys = ON')
      migrate(this.db)

      this.upsertStatement = this.db.prepare(`
        INSERT INTO downloads (
          id, gid, url, filename, explicit_filename, dir, file_path, status,
          total_bytes, completed_bytes, error_message, error_detail, attempts,
          max_attempts, created_at, updated_at, completed_at, needs_login
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          error_detail = excluded.error_detail,
          attempts = excluded.attempts,
          max_attempts = excluded.max_attempts,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          needs_login = excluded.needs_login
      `)
      this.selectAllStatement = this.db.prepare(`
        SELECT * FROM downloads ORDER BY created_at DESC, updated_at DESC
      `)
      this.durableRowStatement = this.db.prepare(
        'SELECT 1 AS persisted FROM downloads WHERE id = ?'
      )
      this.deleteStatement = this.db.prepare('DELETE FROM downloads WHERE id = ?')
      this.downloadControlsStatement = this.db.prepare(`
        UPDATE downloads
        SET scheduled_at = ?, speed_limit_bps = ?, connections = ?
        WHERE id = ?
      `)
      this.downloadBlockReasonStatement = this.db.prepare(`
        UPDATE downloads
        SET block_reason = ?
        WHERE id = ?
      `)
      this.downloadChecksumStatement = this.db.prepare(`
        UPDATE downloads
        SET checksum_algorithm = ?, checksum_ok = ?,
            checksum_computed = ?, checksum_checked_at = ?
        WHERE id = ?
      `)
      this.settingsSelectStatement = this.db.prepare(
        'SELECT * FROM download_settings WHERE id = 1'
      )
      this.settingsUpsertStatement = this.db.prepare(`
        INSERT INTO download_settings (
          id, max_concurrent_downloads, per_host_connections,
          global_speed_limit_bps, allowed_hours_enabled,
          allowed_hours_start, allowed_hours_end, theme,
          sort_downloads_by_type, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          max_concurrent_downloads = excluded.max_concurrent_downloads,
          per_host_connections = excluded.per_host_connections,
          global_speed_limit_bps = excluded.global_speed_limit_bps,
          allowed_hours_enabled = excluded.allowed_hours_enabled,
          allowed_hours_start = excluded.allowed_hours_start,
          allowed_hours_end = excluded.allowed_hours_end,
          theme = excluded.theme,
          sort_downloads_by_type = excluded.sort_downloads_by_type,
          updated_at = excluded.updated_at
      `)
      this.mediaToolSettingsSelectStatement = this.db.prepare(
        'SELECT * FROM media_tool_settings WHERE id = 1'
      )
      this.mediaToolSettingsUpsertStatement = this.db.prepare(`
        INSERT INTO media_tool_settings (
          id, auto_update_ytdlp, last_ytdlp_check_at, updated_at
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          auto_update_ytdlp = excluded.auto_update_ytdlp,
          last_ytdlp_check_at = excluded.last_ytdlp_check_at,
          updated_at = excluded.updated_at
      `)
      this.appUpdateSettingsSelectStatement = this.db.prepare(
        'SELECT * FROM app_update_settings WHERE id = 1'
      )
      this.appUpdateSettingsUpsertStatement = this.db.prepare(`
        INSERT INTO app_update_settings (
          id, auto_check, last_check_at, updated_at
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          auto_check = excluded.auto_check,
          last_check_at = excluded.last_check_at,
          updated_at = excluded.updated_at
      `)

      this.desktopSettingsSelectStatement = this.db.prepare(
        'SELECT * FROM desktop_settings WHERE id = 1'
      )
      this.desktopSettingsUpsertStatement = this.db.prepare(`
        INSERT INTO desktop_settings (
          id, resume_interrupted_on_startup, show_notifications,
          watch_clipboard, launch_at_login, interface_size_percent, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          resume_interrupted_on_startup =
            excluded.resume_interrupted_on_startup,
          show_notifications = excluded.show_notifications,
          watch_clipboard = excluded.watch_clipboard,
          launch_at_login = excluded.launch_at_login,
          interface_size_percent = excluded.interface_size_percent,
          updated_at = excluded.updated_at
      `)
      this.mediaUpsertStatement = this.db.prepare(`
        INSERT INTO media_jobs (
          id, source_url, analysis_id, option_id, kind, title, label, status,
          completed_bytes, total_bytes, error_message, dir, file_path,
          created_at, updated_at, completed_at, max_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          analysis_id = excluded.analysis_id,
          option_id = excluded.option_id,
          kind = excluded.kind,
          title = excluded.title,
          label = excluded.label,
          status = excluded.status,
          completed_bytes = excluded.completed_bytes,
          total_bytes = excluded.total_bytes,
          error_message = excluded.error_message,
          dir = excluded.dir,
          file_path = excluded.file_path,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          max_bytes = excluded.max_bytes
      `)
      this.mediaSelectAllStatement = this.db.prepare(`
        SELECT * FROM media_jobs ORDER BY created_at DESC, updated_at DESC
      `)
      this.mediaDeleteStatement = this.db.prepare(
        'DELETE FROM media_jobs WHERE id = ?'
      )

      this.batchUpsertStatement = this.db.prepare(`
        INSERT INTO batches (
          id, kind, title, status, source_url, error_message,
          created_at, updated_at, completed_at, media_quality, max_bytes_per_item
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          status = excluded.status,
          source_url = excluded.source_url,
          error_message = excluded.error_message,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          media_quality = excluded.media_quality,
          max_bytes_per_item = excluded.max_bytes_per_item
      `)
      this.batchSelectAllStatement = this.db.prepare(`
        SELECT * FROM batches ORDER BY created_at DESC, updated_at DESC
      `)
      this.batchSelectOneStatement = this.db.prepare(
        'SELECT * FROM batches WHERE id = ?'
      )
      this.batchDeleteStatement = this.db.prepare(
        'DELETE FROM batches WHERE id = ?'
      )

      this.batchItemUpsertStatement = this.db.prepare(`
        INSERT INTO batch_items (
          id, batch_id, position, kind, status, child_id, title, label,
          completed_bytes, total_bytes, error_message, source_url,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          batch_id = excluded.batch_id,
          position = excluded.position,
          kind = excluded.kind,
          status = excluded.status,
          child_id = excluded.child_id,
          title = excluded.title,
          label = excluded.label,
          completed_bytes = excluded.completed_bytes,
          total_bytes = excluded.total_bytes,
          error_message = excluded.error_message,
          source_url = excluded.source_url,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `)
      this.batchItemSelectAllStatement = this.db.prepare(`
        SELECT * FROM batch_items ORDER BY batch_id, position
      `)
      this.batchItemSelectByBatchStatement = this.db.prepare(`
        SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position
      `)
      this.batchItemDeleteStatement = this.db.prepare(
        'DELETE FROM batch_items WHERE batch_id = ? AND id = ?'
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

  /**
   * Strict acceptance write for the automatic browser hand-off. Unlike save(),
   * this switches WAL to FULL durability for the single row, then reads the row
   * back. Only a verified row may become a durable receipt; callers must never
   * cancel the browser's own transfer on a thrown error.
   */
  saveDurable(entry: DownloadSaveEntry): void {
    this.assertOpen()
    try {
      this.db.exec('PRAGMA synchronous = FULL')
      try {
        this.runUpsert(entry)
        const row = this.durableRowStatement.get(entry.record.id) as
          | Record<string, unknown>
          | undefined
        if (!row || row.persisted !== 1) {
          throw new Error('The download row was not readable after the write.')
        }
      } finally {
        try {
          this.db.exec('PRAGMA synchronous = NORMAL')
        } catch {
          // The connection may be unusable; the original error is more useful.
        }
      }
    } catch (error) {
      throw databaseError('Could not durably save download history', error)
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

  /**
   * Remove many download history rows in one transaction. Only the list
   * entries go; downloaded files on disk are never touched here.
   */
  deleteMany(ids: readonly string[]): void {
    if (ids.length === 0) return
    this.assertOpen()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) {
        this.deleteStatement.run(id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not remove download history', error)
    }
  }

  /** Persist optional scheduling and speed controls for one download row. */
  saveDownloadControls(id: string, controls: DownloadControls): void {
    this.assertOpen()
    try {
      const parsed = parseDownloadControls(controls)
      const result = this.downloadControlsStatement.run(
        parsed.scheduledAt,
        parsed.speedLimitBps,
        parsed.connections,
        id
      )
      if (Number(result.changes) === 0) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not update download controls: download was not found.'
        )
      }
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not update download controls', error)
    }
  }

  /**
   * Persist the policy hold for a waiting download. This is separate from the
   * user-paused status so a restart can tell the two states apart.
   */
  saveDownloadBlockReason(
    id: string,
    reason: DownloadBlockReason | null
  ): void {
    this.assertOpen()
    try {
      if (reason !== null && !isDownloadBlockReason(reason)) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not update download policy state: invalid reason.'
        )
      }
      const result = this.downloadBlockReasonStatement.run(reason, id)
      if (Number(result.changes) === 0) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not update download policy state: download was not found.'
        )
      }
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not update download policy state', error)
    }
  }

  /**
   * Persist the last checksum result for one download. Only the checksum
   * columns are touched so a concurrent progress save cannot resurrect an old
   * status. The result is validated against its algorithm's hex length.
   */
  saveDownloadChecksum(id: string, result: ChecksumResult): void {
    this.assertOpen()
    try {
      if (!isChecksumResult(result)) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not update the checksum result: invalid result.'
        )
      }
      const changes = this.downloadChecksumStatement.run(
        result.algorithm,
        result.ok === null ? null : result.ok ? 1 : 0,
        result.computed,
        result.checkedAt,
        id
      )
      if (Number(changes.changes) === 0) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not update the checksum result: download was not found.'
        )
      }
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not update the checksum result', error)
    }
  }

  loadSettings(): DownloadSettings {
    this.assertOpen()
    try {
      const row = this.settingsSelectStatement.get() as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not load download settings: the settings row is missing.'
        )
      }
      return rowToSettings(row)
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not load download settings', error)
    }
  }

  saveSettings(settings: DownloadSettings): void {
    this.assertOpen()
    try {
      const parsed = parseDownloadSettings(settings)
      this.settingsUpsertStatement.run(
        parsed.maxConcurrentDownloads,
        parsed.perHostConnections,
        parsed.globalSpeedLimitBps,
        parsed.allowedHours.enabled ? 1 : 0,
        parsed.allowedHours.start,
        parsed.allowedHours.end,
        parsed.theme,
        parsed.sortDownloadsByType ? 1 : 0,
        Date.now()
      )
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not save download settings', error)
    }
  }

  loadMediaToolSettings(): MediaToolSettings {
    this.assertOpen()
    try {
      const row = this.mediaToolSettingsSelectStatement.get() as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not load media tool settings: the settings row is missing.'
        )
      }
      return rowToMediaToolSettings(row)
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not load media tool settings', error)
    }
  }

  saveMediaToolSettings(settings: MediaToolSettings): void {
    this.assertOpen()
    try {
      const parsed = parseMediaToolSettings(settings)
      this.mediaToolSettingsUpsertStatement.run(
        parsed.autoUpdateYtdlp ? 1 : 0,
        parsed.lastYtdlpCheckAt,
        Date.now()
      )
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not save media tool settings', error)
    }
  }

  loadAppUpdateSettings(): AppUpdateSettings {
    this.assertOpen()
    try {
      const row = this.appUpdateSettingsSelectStatement.get() as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not load app update settings: the settings row is missing.'
        )
      }
      return rowToAppUpdateSettings(row)
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not load app update settings', error)
    }
  }

  saveAppUpdateSettings(settings: AppUpdateSettings): void {
    this.assertOpen()
    try {
      const parsed = parseAppUpdateSettings(settings)
      this.appUpdateSettingsUpsertStatement.run(
        parsed.autoCheck ? 1 : 0,
        parsed.lastCheckedAt,
        Date.now()
      )
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not save app update settings', error)
    }
  }

  loadDesktopSettings(): DesktopSettings {
    this.assertOpen()
    try {
      const row = this.desktopSettingsSelectStatement.get() as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not load desktop settings: the settings row is missing.'
        )
      }
      return rowToDesktopSettings(row)
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not load desktop settings', error)
    }
  }

  saveDesktopSettings(settings: DesktopSettings): void {
    this.assertOpen()
    try {
      const parsed = parseDesktopSettings(settings)
      this.desktopSettingsUpsertStatement.run(
        parsed.resumeInterruptedOnStartup ? 1 : 0,
        parsed.showNotifications ? 1 : 0,
        parsed.watchClipboard ? 1 : 0,
        parsed.launchAtLogin ? 1 : 0,
        parsed.interfaceSizePercent,
        Date.now()
      )
    } catch (error) {
      throw error instanceof AppError
        ? error
        : databaseError('Could not save desktop settings', error)
    }
  }

  loadMediaJobs(): MediaJobRecord[] {    this.assertOpen()
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

  /** Remove many media history rows in one transaction; media files are kept. */
  deleteMediaJobs(ids: readonly string[]): void {
    if (ids.length === 0) return
    this.assertOpen()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) {
        this.mediaDeleteStatement.run(id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not remove media job history', error)
    }
  }

  loadBatches(): StoredBatch[] {
    this.assertOpen()
    try {
      const batchRows = this.batchSelectAllStatement.all() as Record<
        string,
        unknown
      >[]
      const itemRows = this.batchItemSelectAllStatement.all() as Record<
        string,
        unknown
      >[]

      const itemsByBatch = new Map<string, BatchItemRecord[]>()
      for (const row of itemRows) {
        const item = rowToBatchItemRecord(row)
        if (!item) continue
        const items = itemsByBatch.get(item.batchId)
        if (items) items.push(item)
        else itemsByBatch.set(item.batchId, [item])
      }

      const stored: StoredBatch[] = []
      for (const row of batchRows) {
        const record = rowToBatchRecord(row)
        if (!record) continue
        stored.push({ record, items: itemsByBatch.get(record.id) ?? [] })
      }
      return stored
    } catch (error) {
      throw databaseError('Could not load batch history', error)
    }
  }

  loadBatch(id: string): StoredBatch | null {
    this.assertOpen()
    try {
      const row = this.batchSelectOneStatement.get(id) as
        | Record<string, unknown>
        | undefined
      if (!row) return null
      const record = rowToBatchRecord(row)
      if (!record) return null

      const rows = this.batchItemSelectByBatchStatement.all(id) as Record<
        string,
        unknown
      >[]
      const items: BatchItemRecord[] = []
      for (const itemRow of rows) {
        const item = rowToBatchItemRecord(itemRow)
        if (item) items.push(item)
      }
      return { record, items }
    } catch (error) {
      throw databaseError('Could not load batch history', error)
    }
  }

  saveBatch(record: BatchRecord): void {
    this.assertOpen()
    try {
      this.runBatchUpsert(record)
    } catch (error) {
      throw databaseError('Could not save batch history', error)
    }
  }

  /** Write a parent and all of its items atomically. */
  saveBatchWithItems(
    record: BatchRecord,
    items: readonly BatchItemRecord[]
  ): void {
    this.assertOpen()
    for (const item of items) {
      if (item.batchId !== record.id) {
        throw new AppError(
          'DATABASE_ERROR',
          'Could not save batch history: item belongs to a different batch.'
        )
      }
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.runBatchUpsert(record)
      for (const item of items) {
        this.runBatchItemUpsert(item)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not save batch history', error)
    }
  }

  /** Write item progress atomically so a batch never lands half-applied. */
  saveManyBatchItems(items: readonly BatchItemRecord[]): void {
    if (items.length === 0) return
    this.assertOpen()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of items) {
        this.runBatchItemUpsert(item)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw databaseError('Could not save batch history', error)
    }
  }

  deleteBatch(id: string): void {
    this.assertOpen()
    try {
      // batch_items is declared ON DELETE CASCADE and foreign_keys is on.
      this.batchDeleteStatement.run(id)
    } catch (error) {
      throw databaseError('Could not remove batch history', error)
    }
  }

  deleteBatchItem(batchId: string, itemId: string): void {
    this.assertOpen()
    try {
      this.batchItemDeleteStatement.run(batchId, itemId)
    } catch (error) {
      throw databaseError('Could not remove batch item history', error)
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
      record.errorDetail ?? null,
      Math.max(1, Math.trunc(record.attempts)),
      Math.max(1, Math.trunc(record.maxAttempts)),
      Math.trunc(record.createdAt),
      Math.trunc(record.updatedAt),
      record.completedAt === null ? null : Math.trunc(record.completedAt),
      entry.needsLogin === true ? 1 : 0
    )
  }

  private runMediaUpsert(record: MediaJobRecord): void {
    // Reject credentials here as a final guard even if a caller skipped the
    // shared normalizer. Fragments are removed; sourceUrl never leaves DB.
    const sourceUrl = normalizeMediaSourceUrl(record.sourceUrl)
    this.mediaUpsertStatement.run(
      record.id,
      sourceUrl,
      record.analysisId,
      record.optionId,
      record.kind,
      record.title,
      record.label,
      record.status,
      Math.max(0, Math.trunc(record.completedBytes)),
      record.totalBytes === null ? null : Math.max(0, Math.trunc(record.totalBytes)),
      record.errorMessage,
      record.dir,
      record.filePath,
      Math.trunc(record.createdAt),
      Math.trunc(record.updatedAt),
      record.completedAt === null ? null : Math.trunc(record.completedAt),
      record.maxBytes ?? null
    )
  }

  private runBatchUpsert(record: BatchRecord): void {
    // Reject credentials here as a final guard even if a caller skipped the
    // shared normalizer. Fragments are removed; sourceUrl never leaves DB.
    const sourceUrl =
      record.sourceUrl === null
        ? null
        : normalizeBatchSourceUrl(record.sourceUrl)
    this.batchUpsertStatement.run(
      record.id,
      record.kind,
      record.title,
      record.status,
      sourceUrl,
      record.errorMessage,
      Math.trunc(record.createdAt),
      Math.trunc(record.updatedAt),
      record.completedAt === null ? null : Math.trunc(record.completedAt),
      record.mediaQuality ?? null,
      record.maxBytesPerItem ?? null
    )
  }

  private runBatchItemUpsert(record: BatchItemRecord): void {
    const sourceUrl =
      record.sourceUrl === null
        ? null
        : normalizeBatchSourceUrl(record.sourceUrl)
    this.batchItemUpsertStatement.run(
      record.id,
      record.batchId,
      Math.max(0, Math.trunc(record.position)),
      record.kind,
      record.status,
      record.childId,
      record.title,
      record.label,
      Math.max(0, Math.trunc(record.completedBytes)),
      record.totalBytes === null
        ? null
        : Math.max(0, Math.trunc(record.totalBytes)),
      record.errorMessage,
      sourceUrl,
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
