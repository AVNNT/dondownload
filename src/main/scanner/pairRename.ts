import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FunscriptPairingError,
  planRenamesForFiles,
  type ScriptSetFile
} from '@shared/funscriptPairing'

/**
 * Post-download funscript rename.
 *
 * Scripts are downloaded into the same folder as their video (the scanner
 * passes that folder to the download manager), so this step never moves a file
 * across folders. Both the video and every script must resolve inside the
 * configured download root; anything else is rejected before a single rename.
 *
 * Policy decisions (explicit, tested):
 * - All-or-nothing: if any paired script failed, was interrupted or cannot be
 *   located, no file of the set is renamed.
 * - Never overwrite: if a planned target already exists (and is not another
 *   source of the same plan), the whole set is skipped with a clear message
 *   instead of creating ` (1)` names that a funscript player would not
 *   auto-load.
 * - Renames that would overwrite another source in the same plan are executed
 *   through unique temporary names in the same folder.
 * - Rename-off keeps the original names.
 */

export interface PairRenameFile {
  itemId: string
  /** Final path reported by the download engine, or null when unknown. */
  filePath: string | null
  axis: string | null
  variant: string | null
  status: string
}

export interface PairRenameInput {
  rootDir: string
  videoPath: string | null
  videoStatus: string
  files: readonly PairRenameFile[]
  primaryVariant: string | null
  rename: boolean
}

export interface RenamedPairFile {
  itemId: string
  path: string
  name: string
}

export type PairRenameResult =
  | {
      status: 'renamed'
      renamed: RenamedPairFile[]
      unchanged: RenamedPairFile[]
    }
  | { status: 'kept' | 'skipped'; reason: string }

export const PAIR_RENAME_OFF =
  'Rename is off; scripts keep their original names.'
export const PAIR_RENAME_SCRIPT_FAILED =
  'Rename skipped: a paired script did not finish downloading.'
export const PAIR_RENAME_VIDEO_FAILED =
  'Rename skipped: the video download did not finish.'
export const PAIR_RENAME_SCRIPT_MISSING =
  'Rename skipped: a paired script file could not be located.'
export const PAIR_RENAME_VIDEO_MISSING =
  'Rename skipped: the video file could not be located.'
export const PAIR_RENAME_OUTSIDE_ROOT =
  'Rename skipped: a paired file is outside the download folder.'
export const PAIR_RENAME_WRONG_FOLDER =
  'Rename skipped: a paired script is not in the video folder.'
export const PAIR_RENAME_TARGET_EXISTS =
  'Rename skipped: a matching script file already exists.'
export const PAIR_RENAME_FAILED =
  'Rename skipped: the script names could not be changed.'
export const PAIR_RENAME_PLAN_INVALID =
  'Rename skipped: the script set has conflicting target names.'

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function samePath(left: string, right: string): boolean {
  const leftPath = path.resolve(left)
  const rightPath = path.resolve(right)
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath
}

function sameDirectory(left: string, right: string): boolean {
  return samePath(path.dirname(left), path.dirname(right))
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

export async function applyPairRename(
  input: PairRenameInput
): Promise<PairRenameResult> {
  if (!input.rename) {
    return { status: 'kept', reason: PAIR_RENAME_OFF }
  }
  if (input.files.length === 0) {
    return {
      status: 'skipped',
      reason: 'Rename skipped: no scripts were paired with the video.'
    }
  }
  if (input.videoStatus !== 'complete' || input.videoPath === null) {
    return { status: 'skipped', reason: PAIR_RENAME_VIDEO_MISSING }
  }
  if (input.files.some((file) => file.status !== 'complete')) {
    return { status: 'skipped', reason: PAIR_RENAME_SCRIPT_FAILED }
  }
  if (input.files.some((file) => file.filePath === null)) {
    return { status: 'skipped', reason: PAIR_RENAME_SCRIPT_MISSING }
  }

  const root = path.resolve(input.rootDir)
  const videoPath = path.resolve(input.videoPath)
  if (!isInside(root, videoPath)) {
    return { status: 'skipped', reason: PAIR_RENAME_OUTSIDE_ROOT }
  }
  const videoDir = path.dirname(videoPath)

  const scripts: Array<{ file: PairRenameFile; source: string }> = []
  for (const file of input.files) {
    const source = path.resolve(file.filePath as string)
    if (!isInside(root, source)) {
      return { status: 'skipped', reason: PAIR_RENAME_OUTSIDE_ROOT }
    }
    if (!sameDirectory(source, videoPath)) {
      return { status: 'skipped', reason: PAIR_RENAME_WRONG_FOLDER }
    }
    scripts.push({ file, source })
  }

  const setFiles: ScriptSetFile[] = scripts.map(({ file, source }) => ({
    fileId: file.itemId,
    filename: path.basename(source),
    base: '',
    axis: file.axis,
    axisToken: null,
    variant: file.variant,
    isMain: file.axis === null
  }))

  let plan: ReturnType<typeof planRenamesForFiles>
  try {
    plan = planRenamesForFiles(setFiles, path.basename(videoPath), {
      primaryVariant: input.primaryVariant
    })
  } catch (error) {
    return {
      status: 'skipped',
      reason:
        error instanceof FunscriptPairingError
          ? PAIR_RENAME_PLAN_INVALID
          : PAIR_RENAME_FAILED
    }
  }

  const targetByItem = new Map(
    plan.map((entry) => [entry.fileId, entry.targetName])
  )
  const sourceKey = new Set(scripts.map(({ source }) => pathKey(source)))
  const operations: Array<{ itemId: string; source: string; target: string }> = []
  const unchanged: RenamedPairFile[] = []

  for (const { file, source } of scripts) {
    const targetName = targetByItem.get(file.itemId)
    if (targetName === undefined) {
      return { status: 'skipped', reason: PAIR_RENAME_FAILED }
    }
    const target = path.join(videoDir, targetName)
    if (!sameDirectory(target, videoPath)) {
      return { status: 'skipped', reason: PAIR_RENAME_OUTSIDE_ROOT }
    }
    if (samePath(source, target)) {
      unchanged.push({
        itemId: file.itemId,
        path: source,
        name: path.basename(source)
      })
      continue
    }
    if (!sourceKey.has(pathKey(target))) {
      if (await exists(target)) {
        return { status: 'skipped', reason: PAIR_RENAME_TARGET_EXISTS }
      }
    }
    operations.push({ itemId: file.itemId, source, target })
  }

  const temporary: Array<{
    itemId: string
    source: string
    target: string
    temp: string
  }> = []
  try {
    for (const operation of operations) {
      const temp = path.join(
        videoDir,
        `.dondownload-rename-${randomUUID()}.tmp`
      )
      if (!isInside(root, temp) || !sameDirectory(temp, videoPath)) {
        throw new Error('temporary rename path escaped the download folder')
      }
      await fs.rename(operation.source, temp)
      temporary.push({ ...operation, temp })
    }
    for (const operation of temporary) {
      if (await exists(operation.target)) {
        throw new Error('target appeared during rename')
      }
      await fs.rename(operation.temp, operation.target)
    }
  } catch {
    // Best effort rollback. A failure never loses a file: every temporary name
    // is inside the video folder and is moved back to its original source.
    for (const operation of temporary.reverse()) {
      try {
        if (await exists(operation.temp)) {
          await fs.rename(operation.temp, operation.source)
        } else if (await exists(operation.target)) {
          await fs.rename(operation.target, operation.source)
        }
      } catch {
        // Leave the file where it is; the batch label reports the failure.
      }
    }
    return { status: 'skipped', reason: PAIR_RENAME_FAILED }
  }

  return {
    status: 'renamed',
    renamed: operations.map((operation) => ({
      itemId: operation.itemId,
      path: operation.target,
      name: path.basename(operation.target)
    })),
    unchanged
  }
}

function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
