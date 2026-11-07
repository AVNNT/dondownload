import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import {
  downloadToRow,
  needsRetryClock,
  type UnifiedRow
} from '../src/renderer/src/lib/unified'
import {
  EMPTY_SELECTION,
  areAllRowsSelected,
  isSelected,
  jumpFocus,
  moveFocus,
  pruneSelection,
  rowsForSelectedKeys,
  selectAllRows,
  selectSingle,
  selectedRows,
  selectionKeys,
  updateSelection
} from '../src/renderer/src/lib/selection'
import { computeWindow } from '../src/renderer/src/lib/virtualList'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)

function download(index: number, overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: `download-${index}`,
    gid: `gid-${index}`,
    url: `https://example.com/files/archive-${index}.zip`,
    filename: `archive-${index}.zip`,
    dir: 'Downloads/DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 1_000,
    completedBytes: 250,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    completedAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 4,
    blockReason: null,
    ...overrides
  }
}

function rows(count: number): UnifiedRow[] {
  return Array.from({ length: count }, (_, index) => downloadToRow(download(index)))
}

describe('selection over a virtualised list', () => {
  it('selects a shift range that spans rows outside the rendered window', () => {
    const list = rows(5_000)
    const first = updateSelection(list, EMPTY_SELECTION, list[2]!.key, 'single')
    const ranged = updateSelection(list, first, list[4_000]!.key, 'range')

    expect(ranged.selected).toHaveLength(3_999)
    expect(isSelected(ranged, list[2]!.key)).toBe(true)
    expect(isSelected(ranged, list[2_500]!.key)).toBe(true)
    expect(isSelected(ranged, list[4_000]!.key)).toBe(true)
    expect(isSelected(ranged, list[4_001]!.key)).toBe(false)
    expect(ranged.anchor).toBe(list[2]!.key)
  })

  it('keeps the selection when the rendered window moves', () => {
    const list = rows(5_000)
    const all = selectAllRows(list)
    expect(all.selected).toHaveLength(5_000)

    const window = computeWindow({
      itemCount: list.length,
      scrollTop: 4_000 * 58,
      viewportHeight: 600
    })
    const rendered = list.slice(window.start, window.end)
    expect(rendered.length).toBeLessThan(40)
    // The selection is keyed by row, not by what is rendered, so every
    // off-screen row stays selected.
    for (const row of rendered) expect(isSelected(all, row.key)).toBe(true)
    expect(isSelected(all, list[0]!.key)).toBe(true)
  })

  it('selects all rows and returns them in display order', () => {
    const list = rows(4)
    const all = selectAllRows(list)
    expect(all.selected).toEqual(list.map((row) => row.key))
    expect(selectedRows(list, all)).toEqual(list)
    expect(all.anchor).toBe(list[0]!.key)
  })

  it('memoises one key set per selection state for O(1) lookups', () => {
    const list = rows(10)
    const all = selectAllRows(list)
    const keys = selectionKeys(all)

    // Same state object => same Set, so render-path checks do not rebuild it.
    expect(selectionKeys(all)).toBe(keys)
    expect(areAllRowsSelected(list, keys)).toBe(true)
    expect(rowsForSelectedKeys(list, keys)).toEqual(list)
    expect(isSelected(all, list[7]!.key)).toBe(true)

    expect(areAllRowsSelected(list, selectionKeys(EMPTY_SELECTION))).toBe(false)
    expect(rowsForSelectedKeys(list, selectionKeys(EMPTY_SELECTION))).toEqual([])
    // Rebuilt sets with identical contents still work.
    expect(areAllRowsSelected(list, new Set(all.selected))).toBe(true)
  })

  it('toggles a single row without touching the rest', () => {
    const list = rows(3)
    const single = selectSingle(list[1]!)
    const toggled = updateSelection(list, single, list[2]!.key, 'toggle')
    expect(toggled.selected).toEqual([list[1]!.key, list[2]!.key])
    const removed = updateSelection(list, toggled, list[1]!.key, 'toggle')
    expect(removed.selected).toEqual([list[2]!.key])
  })

  it('drops rows that are no longer listed', () => {
    const list = rows(5)
    const all = selectAllRows(list)
    const pruned = pruneSelection(list.slice(0, 2), all)
    expect(pruned.selected).toEqual([list[0]!.key, list[1]!.key])
    expect(pruned.anchor).toBe(list[0]!.key)
    // Nothing changed, so the same object comes back and no re-render follows.
    expect(pruneSelection(list, all)).toBe(all)
  })

  it('moves focus by one row and extends the range with shift', () => {
    const list = rows(1_000)
    const start = selectSingle(list[0]!)
    const moved = moveFocus(list, start, list[0]!.key, 1, false)
    expect(moved.focus).toBe(list[1]!.key)
    expect(moved.selection.selected).toEqual([list[1]!.key])

    const extended = moveFocus(list, moved.selection, moved.focus, 5, true)
    expect(extended.focus).toBe(list[6]!.key)
    expect(extended.selection.selected).toHaveLength(6)
  })

  it('jumps to the end of a long list and selects it', () => {
    const list = rows(5_000)
    const jumped = jumpFocus(list, EMPTY_SELECTION, 'end', false)
    expect(jumped.focus).toBe(list[4_999]!.key)
    expect(jumped.selection.selected).toEqual([list[4_999]!.key])

    const extended = jumpFocus(list, jumped.selection, 'start', true)
    expect(extended.focus).toBe(list[0]!.key)
    expect(extended.selection.selected).toHaveLength(5_000)
  })

  it('clamps focus movement at the edges', () => {
    const list = rows(3)
    const top = moveFocus(list, EMPTY_SELECTION, list[0]!.key, -1, false)
    expect(top.focus).toBe(list[0]!.key)
    const bottom = moveFocus(list, EMPTY_SELECTION, list[2]!.key, 1, false)
    expect(bottom.focus).toBe(list[2]!.key)
  })
})

describe('row clock demand', () => {
  it('only asks for the ticking clock while a retry is pending', () => {
    expect(needsRetryClock(downloadToRow(download(0)))).toBe(false)
    expect(
      needsRetryClock(
        downloadToRow(download(1, { status: 'error', retryAt: NOW + 5_000 }))
      )
    ).toBe(true)
    expect(
      needsRetryClock(
        downloadToRow(download(2, { status: 'error', retryAt: null }))
      )
    ).toBe(false)
  })
})
