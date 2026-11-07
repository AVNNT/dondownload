import type { UnifiedRow } from './unified'

export interface SelectionState {
  /** Selected row keys, always stored in current display order. */
  selected: string[]
  /** Range anchor for Shift-click and keyboard range selection. */
  anchor: string | null
}

export type SelectionMode = 'single' | 'toggle' | 'range'

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null }

/**
 * One Set per selection state object, built on first use.
 *
 * A selection state is replaced (never mutated) whenever it changes, so the
 * Set can be cached for the lifetime of the object. Every render-path lookup
 * then costs O(1) per row instead of O(selected) per `includes()` call; with
 * 10,000 rows selected the old `every(... includes ...)` scans were quadratic.
 */
const SELECTION_KEYS = new WeakMap<SelectionState, Set<string>>()

export function selectionKeys(current: SelectionState): ReadonlySet<string> {
  const cached = SELECTION_KEYS.get(current)
  if (cached !== undefined) return cached
  const keys = new Set(current.selected)
  SELECTION_KEYS.set(current, keys)
  return keys
}

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
  return selectionKeys(current).has(key)
}

/**
 * Rows that are selected, in display order. `rows` is already filtered and
 * sorted, so this preserves the visible order without re-sorting the keys.
 */
export function rowsForSelectedKeys(
  rows: readonly UnifiedRow[],
  keys: ReadonlySet<string>
): UnifiedRow[] {
  return rows.filter((row) => keys.has(row.key))
}

/** Whether every visible row is selected; O(rows) with O(1) per row. */
export function areAllRowsSelected(
  rows: readonly UnifiedRow[],
  keys: ReadonlySet<string>
): boolean {
  if (rows.length === 0) return false
  for (const row of rows) {
    if (!keys.has(row.key)) return false
  }
  return true
}

export function selectedRows(
  rows: readonly UnifiedRow[],
  current: SelectionState
): UnifiedRow[] {
  return rowsForSelectedKeys(rows, selectionKeys(current))
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
