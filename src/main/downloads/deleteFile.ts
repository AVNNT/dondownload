import path from 'node:path'

/**
 * Safety policy for the "Delete file" action.
 *
 * A file may only be trashed when it is the exact output of a finished job and
 * that output still lies inside the job's recorded output directory. The caller
 * supplies an `lstat`-derived descriptor so a symlink is refused without ever
 * resolving or following it. The actual deletion is always Electron's
 * `shell.trashItem` (Recycle Bin), never an unlink/rm.
 */
export type DeleteTargetProblem =
  | 'not-finished'
  | 'missing-path'
  | 'outside-directory'
  | 'missing'
  | 'symbolic-link'
  | 'not-a-file'

export interface DeleteTargetEntry {
  isFile: boolean
  isSymbolicLink: boolean
}

export type DeleteTargetCheck =
  | { ok: true }
  | { ok: false; problem: DeleteTargetProblem }

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

export interface DeleteTargetErrorInfo {
  code: string
  message: string
  hint?: string
}

/** Stable, user-safe error copy for every refusal reason. */
export function deleteTargetError(
  problem: DeleteTargetProblem
): DeleteTargetErrorInfo {
  switch (problem) {
    case 'not-finished':
      return {
        code: 'FILE_NOT_READY',
        message: 'Only a finished job can have its file deleted.'
      }
    case 'missing-path':
      return {
        code: 'FILE_NOT_READY',
        message: 'This job has no recorded output file.'
      }
    case 'outside-directory':
      return {
        code: 'FILE_OUTSIDE_DOWNLOAD_DIR',
        message: 'The reported file is outside this job’s output folder.'
      }
    case 'symbolic-link':
      return {
        code: 'FILE_SYMLINK_REFUSED',
        message: 'A symbolic link cannot be deleted from download history.'
      }
    case 'missing':
      return {
        code: 'FILE_MISSING',
        message: 'The file is no longer on disk.',
        hint: 'It may have been moved or deleted.'
      }
    default:
      return {
        code: 'FILE_DELETE_REFUSED',
        message: 'That path is not a regular downloaded file.'
      }
  }
}

export function checkDeleteTarget(input: {
  /** The job's recorded output directory. */
  root: string
  /** The exact recorded output path, or null when it was never recorded. */
  filePath: string | null
  /** True only for a `complete` job. */
  finished: boolean
  /** Result of `lstat`, or null when the file does not exist. */
  entry: DeleteTargetEntry | null
}): DeleteTargetCheck {
  if (!input.finished) return { ok: false, problem: 'not-finished' }
  if (input.filePath === null || input.filePath.trim().length === 0) {
    return { ok: false, problem: 'missing-path' }
  }
  if (!isInsideDirectory(input.root, input.filePath)) {
    return { ok: false, problem: 'outside-directory' }
  }
  if (input.entry === null) return { ok: false, problem: 'missing' }
  if (input.entry.isSymbolicLink) return { ok: false, problem: 'symbolic-link' }
  if (!input.entry.isFile) return { ok: false, problem: 'not-a-file' }
  return { ok: true }
}
