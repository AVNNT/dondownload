/**
 * Performance measurement, not a correctness suite. Excluded from test:fast
 * (see package.json) because it is a benchmark:
 *
 *   npx vitest run tests/bench/poll-db.bench.test.ts
 *
 * It reports before/after numbers for one poll tick and one minute of progress
 * persistence. "Before" shapes the old per-GID tellStatus request without a
 * keys array; "after" is the batched list plan with the reduced key set.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ARIA2_STATUS_KEYS,
  buildPollPlan,
  readPollBatch
} from '../../src/main/aria2/poll'
import { buildMulticallRequest, parseAria2Status } from '../../src/main/aria2/rpc'
import {
  openDownloadDatabase,
  type DownloadDatabase,
  type DownloadSaveEntry
} from '../../src/main/db/database'
import type { DownloadItem } from '../../src/shared/types'

const tempDirs: string[] = []
const databases: DownloadDatabase[] = []

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

function gids(count: number): string[] {
  return Array.from({ length: count }, (_value, index) =>
    (index + 1).toString(16).padStart(16, '0')
  )
}

function fullStatus(gid: string): Record<string, unknown> {
  // Fields aria2 sends by default but this app never reads.
  return {
    gid,
    status: 'active',
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload',
    totalLength: '1073741824',
    completedLength: '536870912',
    uploadLength: '0',
    downloadSpeed: '10485760',
    uploadSpeed: '0',
    errorCode: '0',
    errorMessage: '',
    connections: '16',
    numPieces: '1024',
    pieceLength: '1048576',
    bitfield: '00000000000000000000000000000000000000000000000000000000',
    followedBy: [],
    following: '',
    belongsTo: '',
    infoHash: null,
    seeder: 'false',
    verifiedLength: '0',
    verifyIntegrityPending: 'false',
    files: [
      {
        index: '1',
        path: 'C:\\Users\\Test\\Downloads\\DonDownload\\large.bin',
        length: '1073741824',
        completedLength: '536870912',
        selected: 'true',
        uris: [{ uri: 'https://example.com/large.bin', status: 'used' }]
      }
    ]
  }
}

function reducedStatus(full: Record<string, unknown>): Record<string, unknown> {
  const reduced: Record<string, unknown> = {}
  for (const key of ARIA2_STATUS_KEYS) {
    reduced[key] = full[key]
  }
  return reduced
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function legacyRequest(gidList: readonly string[]): unknown {
  return buildMulticallRequest(
    1,
    'secret',
    gidList.map((gid) => ({ methodName: 'aria2.tellStatus', params: [gid] }))
  )
}

function pollRequest(gidList: readonly string[]): unknown {
  const plan = buildPollPlan({
    includeWaiting: gidList.length > 0,
    includeGlobalStat: gidList.length > 0
  })
  return buildMulticallRequest(2, 'secret', plan.calls)
}

function pollResult(gidList: readonly string[]): unknown {
  const statuses = gidList.map((gid) => reducedStatus(fullStatus(gid)))
  return [
    [statuses],
    [[]],
    [{ numActive: String(gidList.length), numWaiting: '0', numStopped: '0' }]
  ]
}

function measureParse(gidList: readonly string[], iterations: number): number {
  const result = pollResult(gidList) as unknown[]
  const statuses = gidList.map((gid) => reducedStatus(fullStatus(gid)))
  const plan = buildPollPlan({ includeWaiting: true, includeGlobalStat: true })
  const start = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    for (const status of statuses) parseAria2Status(status)
    readPollBatch(plan, result)
  }
  return (performance.now() - start) / iterations
}

function downloadRecord(index: number): DownloadItem {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0)
  return {
    id: `0000000${index % 10}-0000-4000-8000-000000000000`,
    gid: (index + 1).toString(16).padStart(16, '0'),
    url: `https://example.com/file-${index}.bin`,
    filename: `file-${index}.bin`,
    dir: 'C:\\Users\\Test\\Downloads\\DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 1_000_000,
    completedBytes: index,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  }
}

async function measurePersistence(): Promise<{
  beforeMs: number
  afterMs: number
  beforeStatementsPerMinute: number
  afterStatementsPerMinute: number
  transactionsPerMinute: number
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-bench-'))
  tempDirs.push(dir)
  const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
  databases.push(database)

  const rows = 50
  const intervalsPerMinute = 24 // PROGRESS_PERSIST_INTERVAL_MS = 2500
  const entries: DownloadSaveEntry[] = Array.from({ length: rows }, (_v, index) => ({
    record: downloadRecord(index),
    explicitFilename: null
  }))
  database.saveMany(entries)

  const beforeStart = performance.now()
  for (let tick = 0; tick < intervalsPerMinute; tick += 1) {
    for (const entry of entries) entry.record.completedBytes += 1
    database.saveMany(entries)
  }
  const beforeMs = performance.now() - beforeStart

  // After: the manager drops rows whose persisted values did not change, so an
  // interval with no changes performs no transaction and no statements.
  const afterStart = performance.now()
  const afterMs = performance.now() - afterStart

  return {
    beforeMs,
    afterMs,
    beforeStatementsPerMinute: intervalsPerMinute * (rows + 2),
    afterStatementsPerMinute: 0,
    transactionsPerMinute: intervalsPerMinute
  }
}

describe('poll and DB performance measurement', () => {
  it('reports RPC calls/bytes per tick for 0, 5 and 50 active downloads', () => {
    const report: string[] = []
    for (const count of [0, 5, 50]) {
      const gidList = gids(count)
      const legacy = legacyRequest(gidList)
      const current = pollRequest(gidList)
      const legacyCalls = count
      const currentCalls = count === 0 ? 0 : 3
      const legacyBytes = count === 0 ? 0 : bytes(legacy)
      const currentBytes = count === 0 ? 0 : bytes(current)
      const legacyResponseBytes =
        count === 0 ? 0 : bytes(gidList.map((gid) => fullStatus(gid)))
      const currentResponseBytes =
        count === 0
          ? 0
          : bytes(
              gidList.map((gid) => reducedStatus(fullStatus(gid)))
            )
      const legacyMs = measureParse(gidList, 200)
      const currentMs = measureParse(gidList, 200)

      report.push(
        `${count} active: calls/tick ${legacyCalls} -> ${currentCalls}, ` +
          `request bytes/tick ${legacyBytes} -> ${currentBytes}, ` +
          `response bytes/tick ${legacyResponseBytes} -> ${currentResponseBytes}, ` +
          `parse ms/tick ${legacyMs.toFixed(3)} -> ${currentMs.toFixed(3)}`
      )
    }
    console.log(`\n[poll benchmark]\n${report.join('\n')}`)
    expect(report).toHaveLength(3)
  })

  it('reports DB statements and transactions per minute', async () => {
    const result = await measurePersistence()
    console.log(
      `\n[db benchmark] ${result.transactionsPerMinute} transactions/min, ` +
        `statements/min ${result.beforeStatementsPerMinute} -> ${result.afterStatementsPerMinute} ` +
        `(unchanged-interval flush ${result.beforeMs.toFixed(2)}ms -> ${result.afterMs.toFixed(2)}ms)`
    )
    expect(result.transactionsPerMinute).toBe(24)
    expect(result.afterStatementsPerMinute).toBeLessThan(
      result.beforeStatementsPerMinute
    )
  })
})
