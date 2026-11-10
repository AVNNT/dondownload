// @vitest-environment jsdom
/*
 * Perf benchmark for the download list. Not part of `test:fast`; run with
 * `npm run test:perf`.
 *
 * It measures two implementations with the same synthetic rows:
 *  - LegacyList: a non-virtualised, non-memoised `rows.map(...)` list, which is
 *    what the library shipped before windowing/memoisation.
 *  - DownloadTable: the real list component (windowed + memoised rows).
 *
 * For each, it renders 1,000 and 10,000 rows, applies 60 updates to 50 rows,
 * and records commits, total React render time and row component renders per
 * update. It also times filter/search/sort over 10,000 rows.
 */
import {
  Profiler,
  act,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DownloadItem } from '../../src/shared/types'
import {
  downloadToRow,
  filterRows,
  sortRows,
  statusCounts,
  type UnifiedRow
} from '../../src/renderer/src/lib/unified'
import {
  DownloadTable,
  resetRowRenderStats,
  rowRenderStats
} from '../../src/renderer/src/components/DownloadTable'
import { EMPTY_SELECTION } from '../../src/renderer/src/lib/selection'
import { formatBytes, formatEta, formatSpeed } from '../../src/shared/format'

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
;(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT_HEIGHT = 600
const UPDATES = 60
const UPDATE_SIZE = 50

interface Mounted {
  root: Root
  container: HTMLDivElement
}

const mounted: Mounted[] = []

beforeAll(() => {
  // jsdom has no layout. The list only reads clientHeight from its scroller.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return VIEWPORT_HEIGHT
    }
  })
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub
})

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()
    if (entry === undefined) continue
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

function makeDownload(index: number): DownloadItem {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0)
  return {
    id: `download-${index}`,
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
    createdAt: now - index,
    updatedAt: now - 1_000,
    completedAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 4,
    blockReason: null
  }
}

function makeRows(count: number): UnifiedRow[] {
  const rows: UnifiedRow[] = []
  for (let index = 0; index < count; index += 1) {
    rows.push(downloadToRow(makeDownload(index)))
  }
  return rows
}

function touchRows(
  rows: readonly UnifiedRow[],
  indices: readonly number[],
  tick: number
): UnifiedRow[] {
  const next = rows.slice()
  for (const index of indices) {
    const current = next[index]
    if (current === undefined) continue
    next[index] = {
      ...current,
      completedBytes: current.completedBytes + 1_000_000,
      progress: Math.min(99, current.progress + 1),
      speedBps: current.speedBps + tick,
      updatedAt: current.updatedAt + 1_000
    }
  }
  return next
}

interface ProfileStats {
  commits: number
  totalMs: number
  maxMs: number
}

function profilerFor(stats: ProfileStats) {
  return (
    _id: string,
    _phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number
  ): void => {
    stats.commits += 1
    stats.totalMs += actualDuration
    stats.maxMs = Math.max(stats.maxMs, actualDuration)
  }
}

async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  const entry = { root, container }
  mounted.push(entry)
  return entry
}

/* ------------------------------------------------------------------ legacy */

let legacyRowRenders = 0

function LegacyRow({ row }: { row: UnifiedRow }): ReactNode {
  legacyRowRenders += 1
  const percent = Math.round(row.progress)
  const sizeLabel =
    row.sizeBytes !== null ? formatBytes(row.sizeBytes) : '—'
  const speed = row.speedBps > 0 ? formatSpeed(row.speedBps) : null
  const eta = row.etaSeconds !== null ? formatEta(row.etaSeconds) : null
  return (
    <div role="row" data-legacy-row={row.key} style={{ height: 58 }}>
      <span>{row.title}</span>
      <span>{row.subtitle}</span>
      <span>{sizeLabel}</span>
      <span>
        {percent}% {speed ?? ''} {eta ?? ''}
      </span>
      <div>
        <div style={{ width: `${percent}%` }} />
      </div>
      <button type="button" onClick={() => undefined}>
        Pause
      </button>
      <button type="button" onClick={() => undefined}>
        More
      </button>
    </div>
  )
}

function LegacyList({ rows }: { rows: readonly UnifiedRow[] }): ReactNode {
  return (
    <div role="grid" aria-rowcount={rows.length}>
      {rows.map((row) => (
        <LegacyRow key={row.key} row={row} />
      ))}
    </div>
  )
}

interface LegacyControls {
  setRows: (rows: UnifiedRow[]) => void
}

function LegacyHarness({
  initial,
  controls,
  onRender
}: {
  initial: UnifiedRow[]
  controls: LegacyControls
  onRender: ReturnType<typeof profilerFor>
}): ReactNode {
  const [rows, setRows] = useState(initial)
  controls.setRows = setRows
  return (
    <Profiler id="legacy" onRender={onRender}>
      <LegacyList rows={rows} />
    </Profiler>
  )
}

async function benchmarkLegacy(itemCount: number): Promise<void> {
  const initial = makeRows(itemCount)
  const stats: ProfileStats = { commits: 0, totalMs: 0, maxMs: 0 }
  const controls: LegacyControls = { setRows: () => undefined }
  const onRender = profilerFor(stats)

  legacyRowRenders = 0
  const wallStart = performance.now()
  await mount(
    <LegacyHarness initial={initial} controls={controls} onRender={onRender} />
  )
  const initialWallMs = performance.now() - wallStart
  const initialCommittedRows = legacyRowRenders
  const initialStats = { ...stats }

  let rows = initial
  // Fifty rows spread over the whole list, so a list that re-renders
  // everything is not hidden by the changed rows being visible.
  const indices = Array.from({ length: UPDATE_SIZE }, (_, index) =>
    Math.floor((index * itemCount) / UPDATE_SIZE)
  )
  const updateStart = performance.now()
  const updateRowsRendered: number[] = []
  let updatesTotalMs = 0
  for (let tick = 0; tick < UPDATES; tick += 1) {
    rows = touchRows(rows, indices, tick)
    const before = stats.totalMs
    legacyRowRenders = 0
    await act(async () => {
      controls.setRows(rows)
    })
    updatesTotalMs += stats.totalMs - before
    updateRowsRendered.push(legacyRowRenders)
  }
  const updateWallMs = performance.now() - updateStart

  console.log(
    `[perf] legacy ${itemCount.toLocaleString()} rows · initial ` +
      `${initialWallMs.toFixed(1)}ms wall / ${initialStats.totalMs.toFixed(1)}ms render · ` +
      `${initialCommittedRows.toLocaleString()} row renders · ` +
      `${UPDATES} updates ${updateWallMs.toFixed(1)}ms wall / ${updatesTotalMs.toFixed(1)}ms render · ` +
      `${median(updateRowsRendered).toLocaleString()} row renders/update`
  )

  expect(initialStats.commits).toBe(1)
  expect(initialCommittedRows).toBe(itemCount)
}

/* -------------------------------------------------------------- virtualised */

interface TableControls {
  setRows: (rows: UnifiedRow[]) => void
}

const noop = (): void => undefined
const rowNoop = (): void => undefined

function TableHarness({
  initial,
  controls,
  onRender
}: {
  initial: UnifiedRow[]
  controls: TableControls
  onRender: ReturnType<typeof profilerFor>
}): ReactNode {
  const [rows, setRows] = useState(initial)
  controls.setRows = setRows
  return (
    <Profiler id="table" onRender={onRender}>
      <DownloadTable
        rows={rows}
        selection={EMPTY_SELECTION}
        focusedKey={null}
        emptyState={null}
        onRowClick={rowNoop}
        onToggleRow={rowNoop}
        onFocusRow={rowNoop}
        onOpenRow={rowNoop}
        onShowInFolder={rowNoop}
        onPauseRow={rowNoop}
        onResumeRow={rowNoop}
        onCancelRow={rowNoop}
        onRetryRow={rowNoop}
        onContextMenu={rowNoop}
        onKeyDown={noop}
      />
    </Profiler>
  )
}

async function benchmarkTable(itemCount: number): Promise<void> {
  const initial = makeRows(itemCount)
  const stats: ProfileStats = { commits: 0, totalMs: 0, maxMs: 0 }
  const controls: TableControls = { setRows: () => undefined }
  const onRender = profilerFor(stats)

  resetRowRenderStats()
  const wallStart = performance.now()
  const entry = await mount(
    <TableHarness initial={initial} controls={controls} onRender={onRender} />
  )
  const initialWallMs = performance.now() - wallStart
  const initialRenderedRows = rowRenderStats.renders
  const domRows = entry.container.querySelectorAll('[data-row-key]').length
  const initialStats = { ...stats }

  let rows = initial
  // Same spread as the legacy run: most changed rows are off screen.
  const indices = Array.from({ length: UPDATE_SIZE }, (_, index) =>
    Math.floor((index * itemCount) / UPDATE_SIZE)
  )
  const updateStart = performance.now()
  const updateRowsRendered: number[] = []
  let updatesTotalMs = 0
  for (let tick = 0; tick < UPDATES; tick += 1) {
    rows = touchRows(rows, indices, tick)
    const before = stats.totalMs
    resetRowRenderStats()
    await act(async () => {
      controls.setRows(rows)
    })
    updatesTotalMs += stats.totalMs - before
    updateRowsRendered.push(rowRenderStats.renders)
  }
  const updateWallMs = performance.now() - updateStart

  // Now change the rows that are actually on screen: the worst case for a
  // virtualised, memoised list (every visible row has real new data).
  const visibleIndices = Array.from({ length: domRows }, (_, index) => index)
  const visibleRowsPerUpdate: number[] = []
  for (let tick = 0; tick < UPDATES; tick += 1) {
    rows = touchRows(rows, visibleIndices, tick)
    resetRowRenderStats()
    await act(async () => {
      controls.setRows(rows)
    })
    visibleRowsPerUpdate.push(rowRenderStats.renders)
  }

  console.log(
    `[perf] virtual ${itemCount.toLocaleString()} rows · initial ` +
      `${initialWallMs.toFixed(1)}ms wall / ${initialStats.totalMs.toFixed(1)}ms render · ` +
      `${initialRenderedRows} row renders · ${domRows} rows in DOM · ` +
      `${UPDATES} spread updates ${updateWallMs.toFixed(1)}ms wall / ${updatesTotalMs.toFixed(1)}ms render · ` +
      `${median(updateRowsRendered)} row renders/update · ` +
      `${median(visibleRowsPerUpdate)} row renders/update (all visible rows changed)`
  )

  // Mount commits twice: once for the rows, once after the layout effect
  // measures the viewport height.
  expect(initialStats.commits).toBeGreaterThanOrEqual(1)
  expect(initialStats.commits).toBeLessThanOrEqual(3)
  expect(domRows).toBeLessThan(40)
  expect(initialRenderedRows).toBeLessThan(80)
}

/* ------------------------------------------------------------------- helpers */

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function averageMs(fn: () => unknown, repetitions: number): number {
  fn()
  const start = performance.now()
  for (let index = 0; index < repetitions; index += 1) fn()
  return (performance.now() - start) / repetitions
}

/* --------------------------------------------------------------------- tests */

describe('download list performance', () => {
  it(
    'legacy non-virtualised baseline: 1,000 rows',
    async () => {
      await benchmarkLegacy(1_000)
    },
    120_000
  )

  it(
    'legacy non-virtualised baseline: 10,000 rows',
    async () => {
      await benchmarkLegacy(10_000)
    },
    240_000
  )

  it(
    'virtualised list: 1,000 rows',
    async () => {
      await benchmarkTable(1_000)
    },
    120_000
  )

  it(
    'virtualised list: 10,000 rows',
    async () => {
      await benchmarkTable(10_000)
    },
    120_000
  )

  it('filter, search and sort over 10,000 rows', () => {
    const rows = makeRows(10_000)
    const oneMatch = averageMs(
      () => filterRows(rows, { category: 'all', status: 'all', query: 'archive-9999' }),
      100
    )
    const broadMatch = averageMs(
      () => filterRows(rows, { category: 'all', status: 'all', query: 'archive' }),
      100
    )
    const counted = averageMs(() => statusCounts(rows, 'all', 'archive-1'), 100)
    const sortedName = averageMs(() => sortRows(rows, 'name', 'asc'), 10)
    const sortedDate = averageMs(() => sortRows(rows, 'date', 'desc'), 10)

    console.log(
      `[perf] 10,000 rows · filter 1 match ${oneMatch.toFixed(2)}ms · ` +
        `filter all ${broadMatch.toFixed(2)}ms · status counts ${counted.toFixed(2)}ms · ` +
        `sort name ${sortedName.toFixed(2)}ms · sort date ${sortedDate.toFixed(2)}ms`
    )

    // Generous ceilings: this is a regression guard, not a benchmark score.
    expect(oneMatch).toBeLessThan(100)
    expect(broadMatch).toBeLessThan(100)
    expect(counted).toBeLessThan(100)
    expect(sortedName).toBeLessThan(500)
    expect(sortedDate).toBeLessThan(500)
    expect(filterRows(rows, { category: 'all', status: 'all', query: 'ARCHIVE-9999' })).toHaveLength(1)
  })
})
