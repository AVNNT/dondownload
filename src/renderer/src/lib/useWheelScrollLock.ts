import { useEffect, type RefObject } from 'react'
import {
  shouldBlockWheel,
  type OverflowReader,
  type ScrollNode
} from './scrollLock'

const readOverflow: OverflowReader = (node) => {
  const style = window.getComputedStyle(node as Element)
  return { x: style.overflowX, y: style.overflowY }
}

/**
 * Keeps wheel and touchpad scrolling inside a modal boundary. Events that no
 * inner scroll container can consume are cancelled, so the page behind the
 * overlay never moves.
 */
export function useWheelScrollLock(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const boundary = ref.current
    if (!boundary) return
    const onWheel = (event: WheelEvent): void => {
      const blocked = shouldBlockWheel({
        target: event.target instanceof Element ? (event.target as ScrollNode) : null,
        boundary,
        delta: { x: event.deltaX, y: event.deltaY },
        overflowOf: readOverflow
      })
      if (blocked) event.preventDefault()
    }
    boundary.addEventListener('wheel', onWheel, { passive: false })
    return () => boundary.removeEventListener('wheel', onWheel)
  }, [ref])
}
