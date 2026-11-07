import { describe, expect, it } from 'vitest'
import {
  OVERSCAN,
  ROW_HEIGHT,
  computeWindow,
  isIndexVisible,
  rowIndexFor,
  scrollTopForIndex
} from '../src/renderer/src/lib/virtualList'

const VIEWPORT = 600

function windowFor(itemCount: number, scrollTop: number): ReturnType<typeof computeWindow> {
  return computeWindow({ itemCount, scrollTop, viewportHeight: VIEWPORT })
}

describe('virtual list windowing', () => {
  it('renders only a bounded slice of a very long list', () => {
    const top = windowFor(10_000, 0)
    expect(top.start).toBe(0)
    expect(top.totalHeight).toBe(10_000 * ROW_HEIGHT)
    expect(top.offsetTop).toBe(0)
    expect(top.end - top.start).toBeLessThan(40)

    const middle = windowFor(10_000, 100_000)
    expect(middle.end - middle.start).toBeLessThan(40)
    expect(middle.start).toBeGreaterThan(1_000)
  })

  it('keeps the viewport covered after scrolling', () => {
    const scrollTop = ROW_HEIGHT * 100
    const window = windowFor(1_000, scrollTop)
    // The first visible row is 100, so the window must start at or before it.
    expect(window.start).toBeLessThanOrEqual(100)
    expect(window.start).toBe(100 - OVERSCAN)
    // Every row that can be on screen is rendered.
    const lastVisible = Math.floor((scrollTop + VIEWPORT) / ROW_HEIGHT)
    expect(window.end).toBeGreaterThan(lastVisible)
  })

  it('offsets the rendered slice inside the spacer', () => {
    const window = windowFor(1_000, ROW_HEIGHT * 50)
    expect(window.offsetTop).toBe(window.start * ROW_HEIGHT)
  })

  it('clamps at the end of the list instead of over-rendering', () => {
    const window = windowFor(120, 1_000_000)
    expect(window.end).toBe(120)
    expect(window.start).toBeLessThan(120)
  })

  it('handles an empty list and a zero-height viewport', () => {
    expect(windowFor(0, 0)).toEqual({
      start: 0,
      end: 0,
      totalHeight: 0,
      offsetTop: 0
    })
    const unmeasured = computeWindow({
      itemCount: 10,
      scrollTop: 0,
      viewportHeight: 0
    })
    expect(unmeasured.start).toBe(0)
    expect(unmeasured.end).toBeGreaterThan(0)
  })

  it('honours a custom overscan', () => {
    const window = computeWindow({
      itemCount: 1_000,
      scrollTop: ROW_HEIGHT * 100,
      viewportHeight: VIEWPORT,
      overscan: 0
    })
    expect(window.start).toBe(100)
  })
})

describe('virtual list reveal', () => {
  const metrics = { itemCount: 1_000, viewportHeight: VIEWPORT }

  it('leaves the scroll offset alone when the row is already visible', () => {
    const scrollTop = ROW_HEIGHT * 100
    expect(scrollTopForIndex(102, { ...metrics, scrollTop })).toBe(scrollTop)
    expect(isIndexVisible(102, { ...metrics, scrollTop })).toBe(true)
  })

  it('scrolls up to a row above the viewport', () => {
    const scrollTop = ROW_HEIGHT * 100
    expect(scrollTopForIndex(10, { ...metrics, scrollTop })).toBe(10 * ROW_HEIGHT)
  })

  it('scrolls down the minimum distance to a row below the viewport', () => {
    const scrollTop = 0
    const next = scrollTopForIndex(500, { ...metrics, scrollTop })
    expect(next).toBe(500 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT)
    expect(isIndexVisible(500, { ...metrics, scrollTop: next })).toBe(true)
  })

  it('clamps the reveal at the end of the list', () => {
    const next = scrollTopForIndex(999, { ...metrics, scrollTop: 0 })
    expect(next).toBe(1_000 * ROW_HEIGHT - VIEWPORT)
  })

  it('ignores an unknown index', () => {
    expect(scrollTopForIndex(-1, { ...metrics, scrollTop: 40 })).toBe(40)
    expect(scrollTopForIndex(1_000, { ...metrics, scrollTop: 40 })).toBe(40)
  })

  it('reveals a row requested by key, the way the revealRow IPC does', () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      key: `download:${index}`
    }))
    const index = rowIndexFor(rows, 'download:4321')
    expect(index).toBe(4321)

    const scrollTop = scrollTopForIndex(index, {
      itemCount: rows.length,
      scrollTop: 0,
      viewportHeight: VIEWPORT
    })
    const window = computeWindow({
      itemCount: rows.length,
      scrollTop,
      viewportHeight: VIEWPORT
    })
    expect(window.start).toBeLessThanOrEqual(index)
    expect(window.end).toBeGreaterThan(index)
  })

  it('reports a missing key as -1', () => {
    expect(rowIndexFor([{ key: 'download:1' }], 'download:2')).toBe(-1)
    expect(rowIndexFor([{ key: 'download:1' }], null)).toBe(-1)
  })
})
