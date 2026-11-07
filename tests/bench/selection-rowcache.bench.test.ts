/*
 * Before/after benchmark for the two renderer hot spots fixed on this branch:
 *
 *  1. Selection render path with 10,000 rows all selected. The old App code
 *     ran `pickSelectedRows(...).filter(row => selection.selected.includes(...))`
 *     plus `visibleRows.every(row => selection.selected.includes(...))` on
 *     every render — both quadratic in the selection size.
 *  2. Unified row rebuilds. The old `buildUnifiedRows` mapped every source item
 *     on every snapshot and parsed each URL twice, producing fresh row objects
 *     that defeated memoised table rows.
 *
 * Not part of `test:fast` (timing assertions); run with
 * `npx vitest run tests/bench/selection-rowcache.bench.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../../src/shared/types'
import {
  buildUnifiedRows,
  downloadToRow
} from '../../src/renderer/src/lib/unified'
import {
  areAllRowsSelected,
  rowsForSelectedKeys,
  selectAllRows,
  selectionKeys
} from '../../src/renderer/src/lib/selection'

const ROW_COUNT = 10_000
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)

function download(index: number, prefix = 'bench'): DownloadItem {
  return {
    id: `${prefix}-${index}`,
    gid: `gid-${index}`,
    url: `https://example.com/files/archive-${index}.zip`,
    filename: `archive-${index}.zip`,
    dir: 'Downloads/DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 5_000_000_000,
    completedBytes: 250_000_000 + index,
    speedBps: 1_500_000,
    etaSeconds: 42,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW - index,
    updatedAt: NOW - 1_000,
    completedAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 4,
    blockReason: null
  }
}

function measure(fn: () => void, repetitions: number): number {
  fn()
  const start = performance.now()
  for (let index = 0; index < repetitions; index += 1) fn()
  return (performance.now() - start) / repetitions
}

function hostnameOf(url: string): string {
  return new URL(url).hostname
}

describe('selection and unified row caches', () => {
  it('selection render path: 10,000 rows, all selected', () => {
    const rows = buildUnifiedRows(
      Array.from({ length: ROW_COUNT }, (_, index) => download(index, 'bench-sel')),
      []
    )
    const all = selectAllRows(rows)
    expect(all.selected).toHaveLength(ROW_COUNT)

    // ---- before: the old App render path (quadratic includes scans).
    const legacyFilterStart = performance.now()
    const legacyFiltered = rows
      .filter((row) => all.selected.includes(row.key))
      .filter((row) => all.selected.includes(row.key))
    const legacyFilterMs = performance.now() - legacyFilterStart

    const legacyAllStart = performance.now()
    const legacyAll = rows.every((row) => all.selected.includes(row.key))
    const legacyAllMs = performance.now() - legacyAllStart

    // ---- after: one memoised Set, O(1) per row.
    const keys = selectionKeys(all)
    let selectedCount = 0
    let allSelected = false
    const afterMs = measure(
      () => {
        selectedCount = rowsForSelectedKeys(rows, keys).length
        allSelected = areAllRowsSelected(rows, keys)
      },
      25
    )

    console.log(
      `[perf] selection 10,000/10,000 · before filter ${legacyFilterMs.toFixed(1)}ms ` +
        `+ every ${legacyAllMs.toFixed(1)}ms (${(legacyFilterMs + legacyAllMs).toFixed(1)}ms total) · ` +
        `after ${afterMs.toFixed(3)}ms total`
    )

    expect(legacyFiltered).toHaveLength(ROW_COUNT)
    expect(legacyAll).toBe(true)
    expect(selectedCount).toBe(ROW_COUNT)
    expect(allSelected).toBe(true)
    // Generous ceiling: the fixed path is ~1ms here; this guards regressions.
    expect(afterMs).toBeLessThan(5)
  }, 120_000)

  it('unified rows: unchanged snapshots keep the same array and row objects', () => {
    const items = Array.from({ length: ROW_COUNT }, (_, index) =>
      download(index, 'bench-rows')
    )
    const first = buildUnifiedRows(items, [])
    expect(first).toHaveLength(ROW_COUNT)

    // ---- before: a full projection on every rebuild, with two URL parses per
    // item (the audit's measured cost). Reported separately from row building
    // because the fixed `downloadToRow` parses once.
    const legacyUrlMs = measure(() => {
      for (const item of items) {
        hostnameOf(item.url)
        hostnameOf(item.url)
      }
    }, 5)

    const uncachedMs = measure(() => {
      items.map(downloadToRow)
    }, 5)

    // ---- after: identical inputs reuse every cached row and the array.
    const cachedMs = measure(() => {
      const next = buildUnifiedRows(items, [])
      if (next !== first) throw new Error('array identity was not preserved')
    }, 25)

    // A fresh IPC-style snapshot re-creates every item object with identical
    // data; rows must still be reused. Cloning is set up outside the timer so
    // this measures the renderer's build path only (IPC cloning is main-side).
    const snapshots = Array.from({ length: 10 }, () =>
      items.map((item) => ({ ...item }))
    )
    let snapshotIndex = 0
    const cloneMs = measure(() => {
      const next = buildUnifiedRows(
        snapshots[snapshotIndex % snapshots.length]!,
        []
      )
      snapshotIndex += 1
      if (next[0] !== first[0]) throw new Error('row identity was not preserved')
    }, 10)

    console.log(
      `[perf] rows 10,000 · before 2×URL parse ${legacyUrlMs.toFixed(1)}ms · ` +
        `uncached projection ${uncachedMs.toFixed(1)}ms · ` +
        `after unchanged snapshot ${cachedMs.toFixed(2)}ms · ` +
        `fresh objects, same data ${cloneMs.toFixed(2)}ms`
    )

    expect(cachedMs).toBeLessThan(uncachedMs)
  }, 120_000)
})
