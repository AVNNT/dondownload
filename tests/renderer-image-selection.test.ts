import { describe, expect, it } from 'vitest'
import { MAX_SCAN_SELECTION } from '../src/shared/scanner'
import {
  pruneImageSelection,
  selectAllImages,
  selectNoImages,
  selectedImageIds,
  shiftClickImage,
  toggleImage,
  type SelectableImage
} from '../src/renderer/src/components/imageSelection'

function images(count: number): SelectableImage[] {
  return Array.from({ length: count }, (_, index) => ({ id: `img-${index}` }))
}

describe('image picker selection', () => {
  const items = images(5)

  it('starts with nothing selected', () => {
    const selected = selectNoImages()
    expect(selected.size).toBe(0)
    expect(selectedImageIds(items, selected)).toEqual([])
  })

  it('toggles a tile on and off', () => {
    const once = toggleImage(items, selectNoImages(), 'img-2')
    expect(selectedImageIds(items, once)).toEqual(['img-2'])

    const twice = toggleImage(items, once, 'img-2')
    expect(selectedImageIds(items, twice)).toEqual([])
  })

  it('keeps selected ids in item order, not click order', () => {
    let selected = toggleImage(items, selectNoImages(), 'img-3')
    selected = toggleImage(items, selected, 'img-1')
    expect(selectedImageIds(items, selected)).toEqual(['img-1', 'img-3'])
  })

  it('shift-clicks a range from the anchor and deselects it again', () => {
    const anchor = toggleImage(items, selectNoImages(), 'img-1')
    const range = shiftClickImage(items, anchor, 'img-1', 'img-3')
    expect(selectedImageIds(items, range)).toEqual(['img-1', 'img-2', 'img-3'])

    // Shift-clicking a selected tile removes the whole range.
    const cleared = shiftClickImage(items, range, 'img-1', 'img-3')
    expect(selectedImageIds(items, cleared)).toEqual([])

    // Backwards ranges work the same way.
    const backwards = shiftClickImage(items, anchor, 'img-1', 'img-0')
    expect(selectedImageIds(items, backwards)).toEqual(['img-0', 'img-1'])
  })

  it('shift-clicks the clicked tile alone when there is no anchor', () => {
    const selected = shiftClickImage(items, selectNoImages(), null, 'img-2')
    expect(selectedImageIds(items, selected)).toEqual(['img-2'])
    expect(selectedImageIds(items, shiftClickImage(items, selected, null, 'img-2'))).toEqual(
      []
    )
  })

  it('selects all items up to the cap', () => {
    const many = images(MAX_SCAN_SELECTION + 5)
    const selected = selectAllImages(many)
    expect(selected.size).toBe(MAX_SCAN_SELECTION)
    expect(selectedImageIds(many, selected)).toHaveLength(MAX_SCAN_SELECTION)
    expect(selectedImageIds(many, selected)[0]).toBe('img-0')
    expect(selected.has(`img-${MAX_SCAN_SELECTION}`)).toBe(false)
  })

  it('does not auto-select items that arrive later', () => {
    const selected = toggleImage(items.slice(0, 2), selectNoImages(), 'img-0')
    const grown = images(8)
    expect(selectedImageIds(grown, selected)).toEqual(['img-0'])
    expect(pruneImageSelection(grown, new Set(selected))).toEqual(selected)
  })

  it('ignores ids that are no longer in the items', () => {
    const selected = new Set(['img-0', 'img-4', 'gone'])
    expect(selectedImageIds(items.slice(0, 3), selected)).toEqual(['img-0'])

    const pruned = pruneImageSelection(items.slice(0, 3), selected)
    expect(pruned).toEqual(new Set(['img-0']))

    // Unchanged state keeps the same instance so it is safe as a state updater.
    const stable = new Set(['img-0'])
    expect(pruneImageSelection(items, stable)).toBe(stable)
  })

  it('caps toggled selections too', () => {
    const many = images(MAX_SCAN_SELECTION + 1)
    const full = selectAllImages(many)
    const overflow = toggleImage(many, full, `img-${MAX_SCAN_SELECTION}`)
    expect(overflow.size).toBe(MAX_SCAN_SELECTION)
    expect(overflow.has(`img-${MAX_SCAN_SELECTION}`)).toBe(false)
  })
})
