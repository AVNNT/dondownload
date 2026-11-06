import {
  MAX_SCAN_SELECTION,
  isQueueableScanItem,
  type ScanItem,
  type ScanQueueVideoOption,
  type ScanScriptPairingInput,
  type ScanScriptSet,
  type ScanSession
} from './scanner'

/**
 * Pure pre-selection and bulk payload helpers for the Smart Link Scanner.
 *
 * The renderer only ever ticks things. Nothing here queues or fetches; a
 * download exists only after the user clicks the download button and main
 * revalidates every opaque ID.
 */

export interface ScanPreSelection {
  itemIds: string[]
  videoOptions: ScanQueueVideoOption[]
  pairings: ScanScriptPairingInput[]
  /** Videos with a pre-selected matching script set. */
  videoCount: number
  /** Script files ticked, paired or standalone. */
  scriptCount: number
  /** Deduplicated item count before the selection cap. */
  total: number
  /** True when the natural selection exceeded MAX_SCAN_SELECTION. */
  overLimit: boolean
}

const BUCKET_RANK = {
  strong: 3,
  likely: 2,
  weak: 1,
  none: 0
} as const

function isVideoCard(item: ScanItem): boolean {
  return item.category === 'video' && item.kind === 'page-link'
}

export function isReadyVideoCard(item: ScanItem): boolean {
  return isVideoCard(item) && item.status === 'ready'
}

/**
 * Rank the sets that already matched one video. The match bucket is derived in
 * main from the existing funscript pairing score; ties are broken by a complete
 * main stroke, fewer conflicts and then a stable ID order.
 */
export function bestScriptSetForVideo(
  videoItemId: string,
  sets: readonly ScanScriptSet[]
): ScanScriptSet | null {
  let best: ScanScriptSet | null = null
  let bestKey: [number, number, number, number, string] | null = null
  for (const set of sets) {
    if (set.matchedVideoItemId !== videoItemId || set.ambiguous) continue
    const rank = BUCKET_RANK[set.matchBucket]
    if (rank <= 0) continue
    const key: [number, number, number, number, string] = [
      rank,
      set.missingMain ? 0 : 1,
      set.conflicts.length === 0 ? 1 : 0,
      set.files.length,
      set.id
    ]
    if (bestKey === null || compareSetKeys(key, bestKey) > 0) {
      best = set
      bestKey = key
    }
  }
  return best
}

/** Positive when `left` is the better set key. */
function compareSetKeys(
  left: [number, number, number, number, string],
  right: [number, number, number, number, string]
): number {
  for (let index = 0; index < 4; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }
  // Stable ID order keeps pre-selection deterministic across snapshots.
  return right[4].localeCompare(left[4])
}

function queueableIdsOf(files: readonly { id: string }[], queueable: Set<string>): string[] {
  return files.map((file) => file.id).filter((id) => queueable.has(id))
}

/**
 * Default tick set for one finished topic:
 *   - every queueable video with a confident matching script set, plus that
 *     set's queueable scripts;
 *   - every standalone script set (no resolved video), with original names;
 *   - never a browser-only, protected or page card.
 *
 * The best available quality option is used for every video.
 */
export function buildScanPreSelection(
  session: Pick<ScanSession, 'items' | 'scriptSets'>,
  limit = MAX_SCAN_SELECTION
): ScanPreSelection {
  const items = session.items
  const sets = session.scriptSets ?? []
  const queueable = new Set(
    items.filter((item) => isQueueableScanItem(item)).map((item) => item.id)
  )
  const maximum = Math.max(1, Math.min(limit, MAX_SCAN_SELECTION))

  const ids: string[] = []
  const pairings: ScanScriptPairingInput[] = []
  const pairedVideoIds = new Set<string>()

  for (const item of items) {
    if (!isReadyVideoCard(item) || !queueable.has(item.id)) continue
    const set = bestScriptSetForVideo(item.id, sets)
    if (set === null) continue
    const scriptIds = queueableIdsOf(set.files, queueable)
    if (scriptIds.length === 0) continue
    ids.push(item.id, ...scriptIds)
    pairedVideoIds.add(item.id)
    pairings.push({
      videoItemId: item.id,
      setId: set.id,
      scriptItemIds: scriptIds,
      primaryVariant: null,
      rename: true
    })
  }

  for (const set of sets) {
    if (set.ambiguous) continue
    // A set that matched a ready video is already handled above; a set that
    // only matched a browser-only/unavailable video is downloaded standalone.
    if (
      set.matchedVideoItemId !== null &&
      pairedVideoIds.has(set.matchedVideoItemId)
    ) {
      continue
    }
    const matched = items.find((item) => item.id === set.matchedVideoItemId)
    if (matched !== undefined && isReadyVideoCard(matched)) continue
    const scriptIds = queueableIdsOf(set.files, queueable)
    ids.push(...scriptIds)
  }

  const unique = [...new Set(ids)]
  const clipped = unique.slice(0, maximum)
  const selected = new Set(clipped)

  const videoOptions: ScanQueueVideoOption[] = []
  for (const item of items) {
    if (!selected.has(item.id) || !isReadyVideoCard(item)) continue
    const optionId = item.bestOptionId ?? item.formats?.[0]?.optionId
    videoOptions.push({
      itemId: item.id,
      ...(optionId === null || optionId === undefined ? {} : { optionId })
    })
  }

  const safePairings = pairings.filter(
    (pairing) =>
      selected.has(pairing.videoItemId) &&
      pairing.scriptItemIds.every((id) => selected.has(id))
  )

  return {
    itemIds: clipped,
    videoOptions,
    pairings: safePairings,
    videoCount: items.filter(
      (item) => selected.has(item.id) && isReadyVideoCard(item)
    ).length,
    scriptCount: items.filter(
      (item) => selected.has(item.id) && item.category === 'script'
    ).length,
    total: unique.length,
    overLimit: unique.length > maximum
  }
}

export interface ScanBulkSelectionOptions {
  selectedItemIds: ReadonlySet<string>
  /** Explicit quality option per video; otherwise the best available. */
  videoOptionIds?: Readonly<Record<string, string>>
  /** Explicit set per video; otherwise the highest-scoring match. */
  setChoiceByVideo?: Readonly<Record<string, string>>
  /** Explicit script file IDs per set; otherwise every file in the set. */
  scriptFileIdsBySet?: Readonly<Record<string, string[]>>
  primaryVariantBySet?: Readonly<Record<string, string>>
  renameBySet?: Readonly<Record<string, boolean>>
}

export interface ScanBulkSelection {
  sessionId: string
  itemIds: string[]
  videoOptions: ScanQueueVideoOption[]
  pairings: ScanScriptPairingInput[]
}

/**
 * Build the exact payload for one bulk "Download N videos + scripts" click.
 * Each session is isolated: pairings are created from that session's items and
 * script sets only, so a script from topic A can never pair with a video from
 * topic B.
 */
export function buildScanBulkSelection(
  sessions: readonly Pick<ScanSession, 'sessionId' | 'items' | 'scriptSets'>[],
  options: ScanBulkSelectionOptions
): ScanBulkSelection[] {
  const selections: ScanBulkSelection[] = []
  for (const session of sessions) {
    const items = session.items
    const sets = session.scriptSets ?? []
    const itemIds = items
      .filter(
        (item) =>
          options.selectedItemIds.has(item.id) && isQueueableScanItem(item)
      )
      .map((item) => item.id)
    const selected = new Set(itemIds)
    if (selected.size === 0) continue

    const videoOptions: ScanQueueVideoOption[] = []
    const pairings: ScanScriptPairingInput[] = []
    for (const item of items) {
      if (!selected.has(item.id) || !isReadyVideoCard(item)) continue
      const optionId =
        options.videoOptionIds?.[item.id] ??
        item.bestOptionId ??
        item.formats?.[0]?.optionId
      videoOptions.push({
        itemId: item.id,
        ...(optionId === null || optionId === undefined ? {} : { optionId })
      })

      const explicitSetId = options.setChoiceByVideo?.[item.id]
      const set =
        explicitSetId === undefined
          ? bestScriptSetForVideo(item.id, sets)
          : sets.find((candidate) => candidate.id === explicitSetId) ?? null
      if (set === null) continue
      const scriptIds = (
        options.scriptFileIdsBySet?.[set.id] ?? set.files.map((file) => file.id)
      ).filter((id) => selected.has(id))
      if (scriptIds.length === 0) continue

      const rawPrimary = options.primaryVariantBySet?.[set.id] ?? ''
      const primaryVariant =
        rawPrimary.length > 0 &&
        set.variants.some(
          (variant) => variant.toLowerCase() === rawPrimary.toLowerCase()
        )
          ? rawPrimary
          : null
      pairings.push({
        videoItemId: item.id,
        setId: set.id,
        scriptItemIds: scriptIds,
        primaryVariant,
        rename: options.renameBySet?.[set.id] ?? true
      })
    }

    selections.push({
      sessionId: session.sessionId,
      itemIds,
      videoOptions,
      pairings
    })
  }
  return selections
}

/** Total item count across the bulk payload (used for the selection cap). */
export function bulkSelectionItemCount(
  selections: readonly ScanBulkSelection[]
): number {
  return selections.reduce((total, entry) => total + entry.itemIds.length, 0)
}
