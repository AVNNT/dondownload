import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../../src/shared/types'
import {
  applySnapshotDelta,
  buildSnapshotDelta,
  downloadRowVersion,
  type AppSnapshotFields,
  type BuiltSnapshotDelta,
  type SnapshotApplyResult,
  type SnapshotClientState
} from '../../src/shared/snapshotDelta'

/**
 * Micro-benchmark for the snapshot pipeline. Not part of `test:fast`; run with
 *   npx vitest run tests/bench/snapshot-delta.bench.test.ts
 *
 * Models 5,000 completed history rows plus 50 active rows, where every active
 * row advances by one progress tick. "Before" serializes and ships the whole
 * snapshot. "After" ships one revisioned patch and applies it to renderer state.
 */

const HISTORY_ROWS = 5_000
const ACTIVE_ROWS = 50
const TICKS = 20
const BASE_NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

function makeRow(index: number, status: DownloadItem['status']): DownloadItem {
  const totalBytes = status === 'complete' ? 10 * 1024 * 1024 : 500 * 1024 * 1024
  return {
    id: `row-${index}`,
    gid: `gid-${index}`,
    url: `https://example.com/file-${index}.bin`,
    filename: `file-${index}.bin`,
    dir: 'C:\\Downloads',
    filePath: status === 'complete' ? `C:\\Downloads\\file-${index}.bin` : null,
    status,
    totalBytes,
    completedBytes: status === 'complete' ? totalBytes : 0,
    speedBps: status === 'active' ? 1_000_000 : 0,
    etaSeconds: status === 'active' ? 500 : null,
    errorMessage: null,
    errorDetail: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: BASE_NOW - index * 1_000,
    updatedAt: BASE_NOW,
    completedAt: status === 'complete' ? BASE_NOW - index * 1_000 : null,
    retryAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: null,
    blockReason: null
  }
}

const records: DownloadItem[] = [
  ...Array.from({ length: HISTORY_ROWS }, (_value, index) =>
    makeRow(index, 'complete')
  ),
  ...Array.from({ length: ACTIVE_ROWS }, (_value, index) =>
    makeRow(HISTORY_ROWS + index, 'active')
  )
]

const aria2 = {
  status: 'ready' as const,
  version: '1.37.0',
  binaryPath: 'C:\\tools\\aria2c.exe',
  message: null,
  hint: null
}

function buildRows(): DownloadItem[] {
  // Production rebuilds the public DTO list on every publish.
  return records.map((record) => ({ ...record }))
}

function advance(): void {
  for (const record of records) {
    if (record.status !== 'active') continue
    record.completedBytes = Math.min(
      record.totalBytes,
      record.completedBytes + 512 * 1024
    )
    record.speedBps = 1_000_000 + (record.completedBytes % 97_000)
    record.etaSeconds = Math.max(
      0,
      Math.ceil((record.totalBytes - record.completedBytes) / record.speedBps)
    )
    record.updatedAt += 1_000
  }
}

function countChangedRows(
  previous: DownloadItem[],
  next: DownloadItem[]
): number {
  let changed = 0
  const previousById = new Map(previous.map((row) => [row.id, row]))
  for (const row of next) {
    if (previousById.get(row.id) !== row) changed += 1
  }
  return changed
}

describe('snapshot delta IPC micro-benchmark', () => {
  it('reports full-snapshot vs delta bytes, build time and row identity churn', () => {
    let revision = 0
    let deltaState: SnapshotClientState<
      DownloadItem,
      AppSnapshotFields
    > | null = null
    let fullRenderer: DownloadItem[] | null = null
    let deltaRenderer: SnapshotClientState<
      DownloadItem,
      AppSnapshotFields
    > | null = null

    let fullBytes = 0
    let deltaBytes = 0
    let fullMs = 0
    let deltaMs = 0
    let fullIdentityChurn = 0
    let deltaIdentityChurn = 0

    // Warm up allocations and JSON serialization.
    buildRows()
    JSON.stringify({ aria2, downloads: buildRows() })

    for (let tick = 0; tick < TICKS; tick += 1) {
      advance()

      // Before: rebuild + serialize the entire snapshot.
      const beforeStart = performance.now()
      const rowsForFull = buildRows()
      const fullSerialized = JSON.stringify({ aria2, downloads: rowsForFull })
      fullMs += performance.now() - beforeStart
      fullBytes += Buffer.byteLength(fullSerialized, 'utf8')
      if (fullRenderer !== null) {
        fullIdentityChurn += countChangedRows(fullRenderer, rowsForFull)
      }
      fullRenderer = rowsForFull

      // After: rebuild the same public rows, but serialize only the patch.
      const afterStart = performance.now()
      const rowsForDelta = buildRows()
      revision += 1
      const built: BuiltSnapshotDelta<
        DownloadItem,
        AppSnapshotFields
      > | null = buildSnapshotDelta(
        deltaState,
        { fields: { aria2 }, rows: rowsForDelta },
        revision,
        { rowVersion: downloadRowVersion }
      )
      deltaMs += performance.now() - afterStart
      if (built === null) throw new Error('expected a delta for a progress tick')
      deltaBytes += Buffer.byteLength(JSON.stringify(built.delta), 'utf8')
      deltaState = built.state

      const result: SnapshotApplyResult<
        DownloadItem,
        AppSnapshotFields
      > = applySnapshotDelta(deltaRenderer, built.delta)
      if (result.status === 'resync') throw new Error('unexpected revision gap')
      if (result.state === null) throw new Error('missing applied state')
      if (deltaRenderer !== null) {
        deltaIdentityChurn += countChangedRows(
          deltaRenderer.rows,
          result.state.rows
        )
      }
      deltaRenderer = result.state
    }

    // A no-change tick emits nothing at all.
    const noChange = buildSnapshotDelta(
      deltaState,
      { fields: { aria2 }, rows: buildRows() },
      revision + 1,
      { rowVersion: downloadRowVersion }
    )
    const noChangeBytes =
      noChange === null ? 0 : Buffer.byteLength(JSON.stringify(noChange.delta), 'utf8')

    const average = (value: number): number =>
      Math.round((value / TICKS) * 100) / 100

    const report = {
      rows: HISTORY_ROWS + ACTIVE_ROWS,
      ticks: TICKS,
      'full bytes/tick': Math.round(fullBytes / TICKS),
      'delta bytes/tick': Math.round(deltaBytes / TICKS),
      'bytes saved/tick': Math.round((fullBytes - deltaBytes) / TICKS),
      'full ms/tick': average(fullMs),
      'delta ms/tick': average(deltaMs),
      'full row refs changed/tick': Math.round(
        fullIdentityChurn / (TICKS - 1)
      ),
      'delta row refs changed/tick': Math.round(
        deltaIdentityChurn / (TICKS - 1)
      ),
      'no-change delta bytes': noChangeBytes
    }
    console.log(`[snapshot-bench] ${JSON.stringify(report)}`)

    expect(deltaBytes).toBeLessThan(fullBytes)
    expect(deltaIdentityChurn).toBeLessThan(fullIdentityChurn)
    expect(noChangeBytes).toBe(0)
  })
})
