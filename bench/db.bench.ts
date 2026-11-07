/**
 * Benchmark 1 — SQLite history and progress persistence.
 *
 * Uses the real DownloadDatabase on a temporary database file, including the
 * real migrations, prepared statements and WAL settings. Nothing is mocked.
 *
 * Tick rate and persist cadence are copied from
 * `src/main/downloads/manager.ts`:
 *   POLL_INTERVAL_MS = 1_000
 *   PROGRESS_PERSIST_INTERVAL_MS = 2_500
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { it } from 'vitest'
import { openDownloadDatabase } from '../src/main/db/database'
import {
  makeDownloadEntry,
  round,
  stats,
  writePartial
} from './lib/common'

const HISTORY_ROWS = 10_000
const INSERT_BATCH = 500
const ACTIVE_DOWNLOADS = 50
const TICK_MS = 1_000
const PERSIST_INTERVAL_MS = 2_500
const SIMULATED_SECONDS = 60
const BYTES_PER_TICK = 2 * 1024 * 1024

function medianQuery(run: () => void, iterations = 5): {
  p50: number
  min: number
  iterations: number
} {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
  }
  const result = stats(samples)
  return { p50: result.p50, min: result.min, iterations }
}

it('database: 10k history, 60 s of progress ticks and common queries', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dondownload-bench-db-'))
  const database = openDownloadDatabase(path.join(directory, 'downloads.sqlite3'))

  try {
    const entries = Array.from({ length: HISTORY_ROWS }, (_, index) =>
      makeDownloadEntry(index)
    )

    // saveMany is the real flush path used by DownloadManager for progress
    // snapshots; batching every 500 rows mirrors an app-sized transaction.
    const insertStarted = performance.now()
    for (let index = 0; index < entries.length; index += INSERT_BATCH) {
      database.saveMany(entries.slice(index, index + INSERT_BATCH))
    }
    const insertMs = performance.now() - insertStarted

    const active = entries.slice(0, ACTIVE_DOWNLOADS).map((entry) => ({
      record: {
        ...entry.record,
        status: 'active' as const,
        completedBytes: 0,
        completedAt: null,
        updatedAt: entry.record.createdAt
      },
      explicitFilename: null
    }))

    let virtualElapsedMs = 0
    let nextFlushAtMs = PERSIST_INTERVAL_MS
    let flushCount = 0
    const tickSamples: number[] = []

    for (let tick = 0; tick < SIMULATED_SECONDS; tick += 1) {
      virtualElapsedMs += TICK_MS
      const tickStarted = performance.now()

      for (const entry of active) {
        const record = entry.record
        record.completedBytes = Math.min(
          record.totalBytes - 1,
          record.completedBytes + BYTES_PER_TICK
        )
        record.speedBps = BYTES_PER_TICK
        record.updatedAt = record.createdAt + virtualElapsedMs
      }

      // DownloadManager schedules a 2.5 s timer after the first dirty row and
      // flushes all dirty rows in one saveMany transaction.
      if (virtualElapsedMs >= nextFlushAtMs) {
        database.saveMany(active)
        flushCount += 1
        nextFlushAtMs += PERSIST_INTERVAL_MS
      }

      tickSamples.push(performance.now() - tickStarted)
    }

    const queries = {
      loadAll: medianQuery(() => {
        database.loadAll()
      }),
      loadSettings: medianQuery(() => {
        database.loadSettings()
      }),
      loadMediaJobs: medianQuery(() => {
        database.loadMediaJobs()
      }),
      loadBatches: medianQuery(() => {
        database.loadBatches()
      })
    }

    const tickStats = stats(tickSamples, 3)
    const result = {
      id: 'db',
      title: 'Database',
      historyRows: HISTORY_ROWS,
      insert: {
        rows: HISTORY_ROWS,
        batches: Math.ceil(HISTORY_ROWS / INSERT_BATCH),
        totalMs: round(insertMs),
        perRowMs: round(insertMs / HISTORY_ROWS, 4),
        rowsPerSecond: round(HISTORY_ROWS / (insertMs / 1_000))
      },
      progress: {
        activeDownloads: ACTIVE_DOWNLOADS,
        simulatedSeconds: SIMULATED_SECONDS,
        tickRateMs: TICK_MS,
        persistIntervalMs: PERSIST_INTERVAL_MS,
        ticks: SIMULATED_SECONDS,
        rowUpdates: ACTIVE_DOWNLOADS * SIMULATED_SECONDS,
        flushes: flushCount,
        sqliteRowWrites: flushCount * ACTIVE_DOWNLOADS,
        tickMs: tickStats
      },
      queries
    }

    writePartial('db', result)
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
