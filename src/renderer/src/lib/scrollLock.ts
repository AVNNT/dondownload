/**
 * Pure scroll-boundary checks for modal overlays. The renderer feeds real
 * elements into `shouldBlockWheel`; tests use plain objects with the same
 * shape so no DOM implementation is required.
 */

export interface ScrollNode {
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
  parentElement: ScrollNode | null
}

export interface ScrollOverflow {
  x: string
  y: string
}

export interface WheelDelta {
  x: number
  y: number
}

export type OverflowReader = (node: ScrollNode) => ScrollOverflow

const SCROLLABLE = new Set(['auto', 'scroll', 'overlay'])

function isScrollable(value: string): boolean {
  return SCROLLABLE.has(value.trim().toLowerCase())
}

function canScroll(node: ScrollNode, axis: 'x' | 'y', delta: number): boolean {
  const content = axis === 'y' ? node.scrollHeight : node.scrollWidth
  const view = axis === 'y' ? node.clientHeight : node.clientWidth
  const offset = axis === 'y' ? node.scrollTop : node.scrollLeft
  if (content <= view || delta === 0) return false
  return delta > 0 ? offset < content - view : offset > 0
}

/**
 * True when a wheel event must be swallowed so it cannot chain past the
 * boundary. Scrolling is allowed only when `target` or one of its ancestors
 * (up to and including `boundary`) is a scroll container with room left in the
 * direction the wheel is moving.
 */
export function shouldBlockWheel({
  target,
  boundary,
  delta,
  overflowOf
}: {
  target: ScrollNode | null
  boundary: ScrollNode
  delta: WheelDelta
  overflowOf: OverflowReader
}): boolean {
  for (let node = target; node; node = node.parentElement) {
    const overflow = overflowOf(node)
    if (
      (delta.y !== 0 &&
        isScrollable(overflow.y) &&
        canScroll(node, 'y', delta.y)) ||
      (delta.x !== 0 &&
        isScrollable(overflow.x) &&
        canScroll(node, 'x', delta.x))
    ) {
      return false
    }
    if (node === boundary) break
  }
  return true
}
