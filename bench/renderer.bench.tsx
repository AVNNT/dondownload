// @vitest-environment jsdom
/**
 * Benchmark 3 — React download table rendering.
 *
 * Runs the real DownloadTable in jsdom with a 720 px viewport (the real list is
 * virtualised at ROW_HEIGHT = 58 px), wrapped in React.Profiler so commit
 * counts and committed render durations come from React itself.
 *
 * Row re-render counts come from `rowRenderCounter`, the tiny instrumentation
 * hook in DownloadTable. It is disabled outside this benchmark.
 */
import { Profiler, act, type JSX, type ProfilerOnRenderCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { it } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import {
  DownloadTable,
  rowRenderCounter
} from '../src/renderer/src/components/DownloadTable'
import { EMPTY_SELECTION } from '../src/renderer/src/lib/selection'
import { downloadToRow, type UnifiedRow } from '../src/renderer/src/lib/unified'
import { makeDownloadEntry, stats, writePartial } from './lib/common'

const VIEWPORT_HEIGHT = 720
const ROW_COUNTS = [1_000, 5_000] as const
const UPDATED_ROWS = 50
const UPDATE_COUNT = 100

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
;(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true

const noopRow = (): void => undefined
const noopContext = (): void => undefined

function BenchTable({
  rows,
  onRender
}: {
  rows: readonly UnifiedRow[]
  onRender: ProfilerOnRenderCallback
}): JSX.Element {
  return (
    <Profiler id="download-table" onRender={onRender}>
      <DownloadTable
        rows={rows}
        selection={EMPTY_SELECTION}
        focusedKey={null}
        emptyState={null}
        onRowClick={noopRow}
        onToggleRow={noopRow}
        onFocusRow={noopRow}
        onOpenRow={noopRow}
        onShowInFolder={noopRow}
        onPauseRow={noopRow}
        onResumeRow={noopRow}
        onRetryRow={noopRow}
        onContextMenu={noopContext}
        onKeyDown={noopContext}
      />
    </Profiler>
  )
}

interface CommitRecord {
  phase: 'mount' | 'update' | 'nested-update'
  duration: number
}

async function measure(rowCount: number): Promise<{
  rows: number
  mount: {
    commits: number
    wallMs: number
    profilerMs: number
    rowRenders: number
  }
  updates: {
    updates: number
    rowsTouched: number
    commits: number
    wallMs: number
    totalRenderMs: number
    renderMsPerUpdate: ReturnType<typeof stats>
    rowRendersPerUpdate: ReturnType<typeof stats>
  }
}> {
  const items: DownloadItem[] = Array.from({ length: rowCount }, (_, index) =>
    makeDownloadEntry(index, { status: 'active', completedBytes: 0 })
  ).map((entry) => entry.record)
  let rows = items.map((item) => downloadToRow(item))

  const commits: CommitRecord[] = []
  const onRender: ProfilerOnRenderCallback = (
    _id,
    phase,
    actualDuration
  ): void => {
    commits.push({ phase, duration: actualDuration })
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  try {
    rowRenderCounter.renders = 0
    rowRenderCounter.enabled = true
    const beforeMount = commits.length

    const mountStarted = performance.now()
    await act(async () => {
      root.render(<BenchTable rows={rows} onRender={onRender} />)
    })
    const mountWallMs = performance.now() - mountStarted

    const mountCommits = commits.slice(beforeMount)
    const mount = {
      commits: mountCommits.length,
      wallMs: mountWallMs,
      profilerMs: mountCommits.reduce(
        (total, commit) => total + commit.duration,
        0
      ),
      rowRenders: rowRenderCounter.renders
    }

    const rowRendersPerUpdate: number[] = []
    const renderMsPerUpdate: number[] = []
    let updateCommits = 0
    const updateStarted = performance.now()

    for (let update = 0; update < UPDATE_COUNT; update += 1) {
      for (let index = 0; index < UPDATED_ROWS; index += 1) {
        const item = items[index]
        if (item === undefined) continue
        item.completedBytes = Math.min(
          item.totalBytes - 1,
          item.completedBytes + 2 * 1024 * 1024
        )
        item.speedBps = 2 * 1024 * 1024
        item.updatedAt = 1_760_000_000_000 + update * 1_000
      }

      rows = rows.map((row, index) => {
        const item = items[index]
        if (index >= UPDATED_ROWS || item === undefined) return row
        return downloadToRow({ ...item })
      })

      const beforeUpdate = commits.length
      rowRenderCounter.renders = 0
      await act(async () => {
        root.render(<BenchTable rows={rows} onRender={onRender} />)
      })

      const newCommits = commits.slice(beforeUpdate)
      updateCommits += newCommits.length
      rowRendersPerUpdate.push(rowRenderCounter.renders)
      renderMsPerUpdate.push(
        newCommits.reduce((total, commit) => total + commit.duration, 0)
      )
    }

    const updateWallMs = performance.now() - updateStarted

    return {
      rows: rowCount,
      mount,
      updates: {
        updates: UPDATE_COUNT,
        rowsTouched: UPDATED_ROWS,
        commits: updateCommits,
        wallMs: updateWallMs,
        totalRenderMs: renderMsPerUpdate.reduce(
          (total, value) => total + value,
          0
        ),
        renderMsPerUpdate: stats(renderMsPerUpdate),
        rowRendersPerUpdate: stats(rowRendersPerUpdate)
      }
    }
  } finally {
    rowRenderCounter.enabled = false
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
}

it('renderer: 1k and 5k rows with 100 progress updates', async () => {
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight'
  )
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT
  })

  try {
    // Warm the module graph, JIT, jsdom and the 100-update loop before the
    // measured cases. Without this the first row count pays one-time costs and
    // looks slower than the larger list.
    await measure(1_000)

    const cases = []
    for (const rowCount of ROW_COUNTS) {
      cases.push(await measure(rowCount))
    }
    writePartial('renderer', {
      id: 'renderer',
      title: 'Renderer',
      environment: 'jsdom',
      viewportHeight: VIEWPORT_HEIGHT,
      updateCount: UPDATE_COUNT,
      updatedRows: UPDATED_ROWS,
      cases
    })
  } finally {
    if (originalClientHeight === undefined) {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    } else {
      Object.defineProperty(
        HTMLElement.prototype,
        'clientHeight',
        originalClientHeight
      )
    }
  }
})
