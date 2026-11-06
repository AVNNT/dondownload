import { MAX_SCAN_SELECTION } from '@shared/scanner'

/**
 * Pure selection logic for the image picker.
 *
 * The picker starts with nothing selected, so the state is the set of chosen
 * ids rather than a set of exclusions. Ids that are no longer part of the
 * session are ignored everywhere, and the result is always capped at
 * {@link MAX_SCAN_SELECTION} in item order.
 */
export interface SelectableImage {
  id: string
}

/** Selected ids in item order, capped at MAX_SCAN_SELECTION. */
export function selectedImageIds(
  items: readonly SelectableImage[],
  selected: ReadonlySet<string>
): string[] {
  return items
    .filter((item) => selected.has(item.id))
    .slice(0, MAX_SCAN_SELECTION)
    .map((item) => item.id)
}

function capped(
  items: readonly SelectableImage[],
  ids: ReadonlySet<string>
): Set<string> {
  return new Set(selectedImageIds(items, ids))
}

/** Normal click: add the tile to the selection, or drop it when it is already in. */
export function toggleImage(
  items: readonly SelectableImage[],
  selected: ReadonlySet<string>,
  id: string
): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return capped(items, next)
}

/** "Select all" keeps the first MAX_SCAN_SELECTION items only. */
export function selectAllImages(items: readonly SelectableImage[]): Set<string> {
  return new Set(items.slice(0, MAX_SCAN_SELECTION).map((item) => item.id))
}

export function selectNoImages(): Set<string> {
  return new Set()
}

/**
 * Shift+click: select every tile between the anchor (the last plain click) and
 * the clicked tile, or deselect that whole range when the clicked tile was
 * already selected. Without a usable anchor the clicked tile alone is affected.
 */
export function shiftClickImage(
  items: readonly SelectableImage[],
  selected: ReadonlySet<string>,
  anchorId: string | null,
  targetId: string
): Set<string> {
  const targetIndex = items.findIndex((item) => item.id === targetId)
  if (targetIndex < 0) return new Set(selected)
  const anchorIndex =
    anchorId === null ? -1 : items.findIndex((item) => item.id === anchorId)
  const start = anchorIndex < 0 ? targetIndex : anchorIndex
  const range = items
    .slice(Math.min(start, targetIndex), Math.max(start, targetIndex) + 1)
    .map((item) => item.id)

  const next = new Set(selected)
  if (next.has(targetId)) {
    for (const id of range) next.delete(id)
  } else {
    for (const id of range) next.add(id)
  }
  return capped(items, next)
}

/**
 * Drop ids that are no longer in `items` (the session can shrink). Returns the
 * same set instance when nothing changed so it is safe to use as a state
 * updater.
 */
export function pruneImageSelection(
  items: readonly SelectableImage[],
  selected: Set<string>
): Set<string> {
  const available = new Set(items.map((item) => item.id))
  const next = new Set<string>()
  for (const id of selected) {
    if (available.has(id)) next.add(id)
  }
  return next.size === selected.size ? selected : next
}
