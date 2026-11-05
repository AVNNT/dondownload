import type { UnifiedRow } from './unified'

export interface SelectionState {
  /** Selected row keys, always stored in current display order. */
  selected: string[]
  /** Range anchor for Shift-click and keyboard range selection. */
  anchor: string | null
}

export type SelectionMode = 'single' | 'toggle' | 'range'

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null }

function orderSelection(rows: readonly UnifiedRow[], ids: Iterable<string>): string[] {
  const wanted = new Set(ids)
  return rows.filter((row) => wanted.has(row.key)).map((row) => row.key)
}

export function selectSingle(row: UnifiedRow): SelectionState {
  return { selected: [row.key], anchor: row.key }
}

export function updateSelection(
  rows: readonly UnifiedRow[],
  current: SelectionState,
  targetKey: string,
  mode: SelectionMode,
  additiveRange = true
): SelectionState {
  const targetIndex = rows.findIndex((row) => row.key === targetKey)
  if (targetIndex < 0) return current

  if (mode === 'single') {
    return { selected: [targetKey], anchor: targetKey }
  }

  if (mode === 'toggle') {
    const selected = new Set(current.selected)
    if (selected.has(targetKey)) selected.delete(targetKey)
    else selected.add(targetKey)
    const ordered = orderSelection(rows, selected)
    return {
      selected: ordered,
      anchor: ordered.length === 0 ? null : targetKey
    }
  }

  // Shift range: from the anchor (or the target itself when there is none).
  const anchor = current.anchor ?? targetKey
  const anchorIndex = rows.findIndex((row) => row.key === anchor)
  const start = anchorIndex < 0 ? targetIndex : anchorIndex
  const from = Math.min(start, targetIndex)
  const to = Math.max(start, targetIndex)
  const range = rows.slice(from, to + 1).map((row) => row.key)

  if (!additiveRange) {
    return { selected: range, anchor }
  }
  const selected = new Set([...current.selected, ...range])
  return { selected: orderSelection(rows, selected), anchor }
}

export function selectAllRows(rows: readonly UnifiedRow[]): SelectionState {
  const selected = rows.map((row) => row.key)
  return {
    selected,
    anchor: selected[0] ?? null
  }
}

export function pruneSelection(
  rows: readonly UnifiedRow[],
  current: SelectionState
): SelectionState {
  const available = new Set(rows.map((row) => row.key))
  const selected = current.selected.filter((key) => available.has(key))
  if (
    selected.length === current.selected.length &&
    (current.anchor === null || available.has(current.anchor))
  ) {
    return current
  }
  return {
    selected,
    anchor:
      current.anchor !== null && available.has(current.anchor)
        ? current.anchor
        : (selected[0] ?? null)
  }
}

export function isSelected(current: SelectionState, key: string): boolean {
  return current.selected.includes(key)
}

export function selectedRows(
  rows: readonly UnifiedRow[],
  current: SelectionState
): UnifiedRow[] {
  const wanted = new Set(current.selected)
  return rows.filter((row) => wanted.has(row.key))
}

/**
 * Keyboard focus movement. Home/End jump to the edges; ArrowUp/ArrowDown move
 * by one row and clamp at the ends. Shift extends the range from the anchor.
 */
export function moveFocus(
  rows: readonly UnifiedRow[],
  current: SelectionState,
  focusedKey: string | null,
  delta: number,
  extend: boolean
): { focus: string | null; selection: SelectionState } {
  if (rows.length === 0) return { focus: null, selection: current }
  const currentIndex = focusedKey
    ? rows.findIndex((row) => row.key === focusedKey)
    : -1
  const start = currentIndex < 0 ? 0 : currentIndex
  const nextIndex = Math.max(0, Math.min(rows.length - 1, start + delta))
  const target = rows[nextIndex]
  if (!target) return { focus: focusedKey, selection: current }
  return {
    focus: target.key,
    selection: extend
      ? updateSelection(rows, current, target.key, 'range')
      : selectSingle(target)
  }
}

export function jumpFocus(
  rows: readonly UnifiedRow[],
  current: SelectionState,
  edge: 'start' | 'end',
  extend: boolean
): { focus: string | null; selection: SelectionState } {
  if (rows.length === 0) return { focus: null, selection: current }
  const target = edge === 'start' ? rows[0] : rows[rows.length - 1]
  if (!target) return { focus: null, selection: current }
  return {
    focus: target.key,
    selection: extend
      ? updateSelection(rows, current, target.key, 'range')
      : selectSingle(target)
  }
}
