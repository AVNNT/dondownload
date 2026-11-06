import { describe, expect, it } from 'vitest'
import {
  shouldBlockWheel,
  type ScrollNode,
  type ScrollOverflow
} from '../src/renderer/src/lib/scrollLock'

type TestNode = ScrollNode & {
  overflowX: string
  overflowY: string
}

function makeNode(overrides: Partial<TestNode> = {}): TestNode {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 1_000,
    scrollWidth: 1_000,
    clientHeight: 500,
    clientWidth: 500,
    parentElement: null,
    overflowX: 'visible',
    overflowY: 'visible',
    ...overrides
  }
}

function overflowOf(node: ScrollNode): ScrollOverflow {
  const testNode = node as TestNode
  return { x: testNode.overflowX, y: testNode.overflowY }
}

describe('shouldBlockWheel', () => {
  it('blocks when no ancestor is scrollable', () => {
    const backdrop = makeNode({ clientHeight: 800, scrollHeight: 800 })
    const target = makeNode({
      parentElement: backdrop,
      clientHeight: 100,
      scrollHeight: 100
    })

    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 0, y: 120 },
        overflowOf
      })
    ).toBe(true)
  })

  it('blocks when the scrollable ancestor is already at the edge', () => {
    const backdrop = makeNode({ clientHeight: 800, scrollHeight: 800 })
    const list = makeNode({
      parentElement: backdrop,
      scrollTop: 0,
      scrollHeight: 900,
      overflowY: 'auto'
    })
    const target = makeNode({ parentElement: list })

    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 0, y: -120 },
        overflowOf
      })
    ).toBe(true)

    list.scrollTop = 400
    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 0, y: 120 },
        overflowOf
      })
    ).toBe(true)
  })

  it('allows the wheel when the scrollable ancestor has room', () => {
    const backdrop = makeNode({ clientHeight: 800, scrollHeight: 800 })
    const list = makeNode({
      parentElement: backdrop,
      scrollTop: 200,
      scrollHeight: 900,
      overflowY: 'auto'
    })
    const target = makeNode({ parentElement: list })

    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 0, y: 120 },
        overflowOf
      })
    ).toBe(false)
    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 0, y: -120 },
        overflowOf
      })
    ).toBe(false)
  })

  it('allows horizontal scrolling on a horizontal scroller', () => {
    const backdrop = makeNode({ clientHeight: 800, scrollHeight: 800 })
    const row = makeNode({
      parentElement: backdrop,
      scrollLeft: 50,
      scrollWidth: 900,
      overflowX: 'scroll'
    })
    const target = makeNode({ parentElement: row })

    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 120, y: 0 },
        overflowOf
      })
    ).toBe(false)
    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: -120, y: 0 },
        overflowOf
      })
    ).toBe(false)
  })

  it('ignores scroll containers above the boundary', () => {
    const page = makeNode({
      scrollTop: 100,
      scrollHeight: 5_000,
      overflowY: 'auto'
    })
    const backdrop = makeNode({
      parentElement: page,
      clientHeight: 800,
      scrollHeight: 800
    })
    const target = makeNode({ parentElement: backdrop })

    expect(
      shouldBlockWheel({
        target,
        boundary: backdrop,
        delta: { x: 0, y: 120 },
        overflowOf
      })
    ).toBe(true)
  })
})
