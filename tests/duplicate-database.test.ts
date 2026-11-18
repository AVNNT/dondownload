import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { DownloadItem, DownloadStatus } from '../src/shared/types'
import {
  openDownloadDatabase,
  type DownloadDatabase
} from '../src/main/db/database'
import { normalizeDuplicateUrl } from '../src/shared/duplicates'

const tempDirs: string[] = []
const databases: DownloadDatabase[] = []
const rawConnections: DatabaseSync[] = []

async function makeDatabase(): Promise<{
  database: DownloadDatabase
  databasePath: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-dupdb-'))
  tempDirs.push(dir)
  const databasePath = path.join(dir, 'downloads.sqlite3')
  const database = openDownloadDatabase(databasePath)
  databases.push(database)
  return { database, databasePath }
}

function record(
  overrides: Partial<DownloadItem> = {}
): DownloadItem {
  const now = Date.UTC(2026, 1, 3, 4, 5, 6)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    gid: '0123456789abcdef',
    url: 'https://example.com/files/sample.zip',
    filename: 'sample.zip',
    dir: 'C:\\Downloads\\DonDownload',
    filePath: null,
    status: 'complete',
    totalBytes: 10,
    completedBytes: 10,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides
  }
}

afterEach(async () => {
  for (const raw of rawConnections.splice(0)) {
    try {
      raw.close()
    } catch {
      // Best effort.
    }
  }
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Best effort.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('download duplicate repository lookup', () => {
  it('finds a completed row by normalized URL', async () => {
    const { database } = await makeDatabase()
    database.save({ record: record(), explicitFilename: null })

    const found = database.findDuplicate(
      normalizeDuplicateUrl('https://example.com/files/sample.zip#again')!
    )
    expect(found).toMatchObject({
      kind: 'download',
      state: 'finished',
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      filename: 'sample.zip'
    })
  })

  it('prefers an active record over a newer completed record', async () => {
    const { database } = await makeDatabase()
    database.save({
      record: record({
        id: 'c47ac10b-58cc-4372-a567-0e02b2c3d479',
        url: 'https://example.com/files/sample.zip',
        status: 'complete',
        createdAt: Date.UTC(2026, 1, 4)
      }),
      explicitFilename: null
    })
    database.save({
      record: record({
        id: 'd47ac10b-58cc-4372-a567-0e02b2c3d479',
        url: 'https://example.com/files/sample.zip',
        status: 'paused',
        createdAt: Date.UTC(2026, 1, 3)
      }),
      explicitFilename: null
    })

    const found = database.findDuplicate(
      'https://example.com/files/sample.zip'
    )
    expect(found?.state).toBe('active')
    expect(found?.id).toBe('d47ac10b-58cc-4372-a567-0e02b2c3d479')
  })

  it.each<DownloadStatus>(['error', 'cancelled', 'interrupted'])(
    'ignores a %s row',
    async (status) => {
      const { database } = await makeDatabase()
      database.save({
        record: record({ status }),
        explicitFilename: null
      })
      expect(
        database.findDuplicate('https://example.com/files/sample.zip')
      ).toBeNull()
    }
  )

  it('does not match a different query string', async () => {
    const { database } = await makeDatabase()
    database.save({ record: record(), explicitFilename: null })
    expect(
      database.findDuplicate('https://example.com/files/sample.zip?token=2')
    ).toBeNull()
  })

  it('uses the normalized-url index instead of scanning downloads', async () => {
    const { database, databasePath } = await makeDatabase()
    database.save({ record: record(), explicitFilename: null })

    const raw = new DatabaseSync(databasePath)
    rawConnections.push(raw)
    const plan = raw
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, filename, status, file_path, created_at, completed_at
         FROM downloads
         WHERE normalized_url = ?
         ORDER BY
           CASE
             WHEN status IN ('queued', 'active', 'waiting', 'paused') THEN 0
             WHEN status = 'complete' THEN 1
             ELSE 2
           END,
           created_at DESC
         LIMIT 1`
      )
      .all('https://example.com/files/sample.zip') as Record<string, unknown>[]

    const text = JSON.stringify(plan)
    expect(text).toContain('downloads_normalized_url_idx')
    expect(text).not.toMatch(/"detail":"SCAN downloads"/)
  })

  it('backfills normalized URLs for rows written before v23', async () => {
    const { databasePath } = await makeDatabase()
    // Reopen the file as a raw v22 database to simulate an upgrade.
    const raw = new DatabaseSync(databasePath)
    rawConnections.push(raw)
    raw.exec(`
      DROP INDEX IF EXISTS downloads_normalized_url_idx;
      ALTER TABLE downloads DROP COLUMN normalized_url;
    `)
    raw.exec(`
      INSERT INTO downloads (
        id, gid, url, filename, dir, status, created_at, updated_at
      ) VALUES (
        'a47ac10b-58cc-4372-a567-0e02b2c3d479', '0123456789abcdef',
        'HTTPS://Example.com:443/files/legacy.zip#part', 'legacy.zip',
        'C:\\Downloads', 'complete', 1, 1
      );
      PRAGMA user_version = 22;
    `)
    raw.close()
    rawConnections.pop()

    const upgraded = openDownloadDatabase(databasePath)
    databases.push(upgraded)
    expect(upgraded.schemaVersion).toBe(23)
    expect(
      upgraded.findDuplicate('https://example.com/files/legacy.zip')
    ).toMatchObject({ state: 'finished', filename: 'legacy.zip' })
  })
})
