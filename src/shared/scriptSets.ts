import {
  isFunscriptFilename,
  matchSetsToVideos,
  groupScriptSets,
  planRenamesForFiles,
  VIDEO_MATCH_THRESHOLD,
  type ScriptSet,
  type ScriptSetFile
} from './funscriptPairing'
import type {
  ScanCategory,
  ScanItemKind,
  ScanItemStatus,
  ScanMatchBucket,
  ScanScriptFile,
  ScanScriptSet
} from './scanner'

/**
 * Build renderer-safe funscript pairing DTOs from the current scan items.
 *
 * This is a pure projection: grouping uses the shared funscript helpers and
 * matching uses the video's display title and Discourse post number. It runs on
 * every published snapshot, so a video that resolves later immediately claims
 * its script set. No URL, directory or absolute path is ever included.
 */

export interface PairingScanItem {
  id: string
  name: string
  category: ScanCategory
  kind: ScanItemKind
  postNumber: number | null
  status: ScanItemStatus
}

export interface ScriptSetSource {
  set: ScriptSet
  files: ScriptSetFile[]
}

function matchBucket(score: number | null): ScanMatchBucket {
  if (score === null || score < VIDEO_MATCH_THRESHOLD) return 'none'
  if (score >= 0.72) return 'strong'
  if (score >= 0.58) return 'likely'
  return 'weak'
}

function toScriptFile(file: ScriptSetFile, targetName: string | null): ScanScriptFile {
  return {
    id: file.fileId,
    filename: file.filename,
    axis: file.axis,
    variant: file.variant,
    isMain: file.isMain,
    targetName
  }
}

function safeTargetNames(
  files: readonly ScriptSetFile[],
  videoName: string
): Map<string, string> | null {
  try {
    const plan = planRenamesForFiles(files, videoName, {
      primaryVariant: null
    })
    return new Map(plan.map((entry) => [entry.fileId, entry.targetName]))
  } catch {
    // A conflict (two files on one axis/variant) cannot be previewed until the
    // user resolves it. The DTO keeps the conflict and leaves targets null.
    return null
  }
}

/** Group only `.funscript` file items; everything else is ignored. */
export function buildScriptSetSources(
  items: readonly PairingScanItem[]
): ScriptSetSource[] {
  const scriptInputs = items
    .filter(
      (item) =>
        item.category === 'script' &&
        item.kind === 'file' &&
        isFunscriptFilename(item.name)
    )
    .map((item) => ({
      id: item.id,
      filename: item.name,
      ...(item.postNumber === null ? {} : { postNumber: item.postNumber })
    }))
  const sets = groupScriptSets(scriptInputs)
  const filenameById = new Map(scriptInputs.map((input) => [input.id, input.filename]))
  return sets.map((set) => ({
    set,
    files: set.files.map((file) => ({
      ...file,
      filename: filenameById.get(file.fileId) ?? file.filename
    }))
  }))
}

export function buildScanScriptSets(
  items: readonly PairingScanItem[]
): ScanScriptSet[] {
  const sources = buildScriptSetSources(items)
  if (sources.length === 0) return []

  const videos = items
    .filter(
      (item) =>
        item.category === 'video' &&
        item.kind === 'page-link' &&
        item.status === 'ready'
    )
    .map((item) => ({
      id: item.id,
      title: item.name,
      ...(item.postNumber === null ? {} : { postNumber: item.postNumber })
    }))
  const videoNameById = new Map(videos.map((video) => [video.id, video.title]))
  const matches = matchSetsToVideos(
    sources.map((source) => source.set),
    videos
  )
  const matchBySetId = new Map(matches.map((match) => [match.setId, match]))

  return sources.map(({ set, files }) => {
    const match = matchBySetId.get(set.id)
    const videoName =
      match?.videoId == null ? null : videoNameById.get(match.videoId) ?? null
    const targets =
      videoName === null ? null : safeTargetNames(files, videoName)
    return {
      id: set.id,
      base: set.base,
      postNumber: set.postNumber,
      axes: [...set.axes],
      variants: [...set.variants],
      missingMain: set.missingMain,
      conflicts: set.conflicts.map((conflict) => ({
        axis: conflict.axis,
        variant: conflict.variant,
        fileIds: [...conflict.fileIds]
      })),
      matchedVideoItemId: videoName === null ? null : match?.videoId ?? null,
      ambiguous: match?.ambiguous === true,
      matchBucket: matchBucket(match?.score ?? null),
      files: files.map((file) =>
        toScriptFile(file, targets?.get(file.fileId) ?? null)
      )
    }
  })
}
