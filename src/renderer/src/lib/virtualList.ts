/**
 * Dependency-free windowing math for the download list.
 *
 * The list uses a fixed row height, so the rendered slice is a pure function of
 * the scroll offset and the viewport height. Keeping it here (instead of inside
 * the component) makes the behaviour testable without a DOM.
 */

/** Height of one library row in px. Mirrors the `h-[58px]` row class. */
export const ROW_HEIGHT = 58

/** Extra rows rendered above and below the viewport. */
export const OVERSCAN = 6

export interface WindowMetrics {
  /** Total number of rows in the list. */
  itemCount: number
  /** Current scroll offset of the list container, in px. */
  scrollTop: number
  /** Height of the visible area of the list container, in px. */
  viewportHeight: number
  rowHeight?: number
  overscan?: number
}

export interface RowWindow {
  /** First rendered row index (inclusive). */
  start: number
  /** Last rendered row index, exclusive. */
  end: number
  /** Height of the whole list, used as the scroll spacer. */
  totalHeight: number
  /** Offset of the first rendered row inside the spacer. */
  offsetTop: number
}

function clampScrollTop(
  scrollTop: number,
  totalHeight: number,
  viewportHeight: number
): number {
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight)
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return 0
  return Math.min(scrollTop, maxScrollTop)
}

/**
 * The slice of rows to render for the current scroll position, plus the spacer
 * height that keeps the scrollbar honest.
 */
export function computeWindow({
  itemCount,
  scrollTop,
  viewportHeight,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN
}: WindowMetrics): RowWindow {
  if (itemCount <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, totalHeight: 0, offsetTop: 0 }
  }
  const totalHeight = itemCount * rowHeight
  const height = Math.max(0, viewportHeight)
  const top = clampScrollTop(scrollTop, totalHeight, height)
  const firstVisible = Math.floor(top / rowHeight)
  // One extra row covers a partially visible row at the bottom edge.
  const visibleCount = Math.ceil(height / rowHeight) + 1
  const start = Math.max(0, firstVisible - Math.max(0, overscan))
  const end = Math.min(
    itemCount,
    firstVisible + visibleCount + Math.max(0, overscan)
  )
  return { start, end, totalHeight, offsetTop: start * rowHeight }
}

/** Index of `key` in `rows`, or -1 when it is not in the list. */
export function rowIndexFor(
  rows: readonly { key: string }[],
  key: string | null
): number {
  if (key === null) return -1
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.key === key) return index
  }
  return -1
}

/** Whether row `index` is fully inside the viewport at `scrollTop`. */
export function isIndexVisible(
  index: number,
  {
    itemCount,
    scrollTop,
    viewportHeight,
    rowHeight = ROW_HEIGHT
  }: Omit<WindowMetrics, 'overscan'>
): boolean {
  if (index < 0 || index >= itemCount) return false
  const totalHeight = itemCount * rowHeight
  const top = clampScrollTop(scrollTop, totalHeight, Math.max(0, viewportHeight))
  const rowTop = index * rowHeight
  const rowBottom = rowTop + rowHeight
  return rowTop >= top && rowBottom <= top + Math.max(0, viewportHeight)
}

/**
 * The scroll offset needed to reveal row `index`, or the current offset when it
 * is already fully visible. Scrolls the minimum distance, so revealing a row
 * that is just off screen does not jump the list to the top.
 */
export function scrollTopForIndex(
  index: number,
  {
    itemCount,
    scrollTop,
    viewportHeight,
    rowHeight = ROW_HEIGHT
  }: Omit<WindowMetrics, 'overscan'>
): number {
  if (index < 0 || index >= itemCount) return scrollTop
  const totalHeight = itemCount * rowHeight
  const height = Math.max(0, viewportHeight)
  const top = clampScrollTop(scrollTop, totalHeight, height)
  const rowTop = index * rowHeight
  const rowBottom = rowTop + rowHeight
  if (rowTop < top) return clampScrollTop(rowTop, totalHeight, height)
  if (rowBottom > top + height) {
    return clampScrollTop(rowBottom - height, totalHeight, height)
  }
  return top
}
