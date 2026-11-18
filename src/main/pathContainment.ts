import path from 'node:path'

/**
 * Shared path-containment policy for file actions on recorded outputs.
 *
 * Windows paths are case-insensitive. Node's `path.win32.relative` already
 * compares drive letters, folders and file names without regard to case, and
 * this helper relies on it instead of doing its own string prefix check. That
 * keeps one rule for downloads, media jobs and the Recycle Bin policy.
 */

/** True when `candidate` is inside `root` (optionally including `root`). */
export function isPathInside(
  root: string,
  candidate: string,
  options: { allowEqual?: boolean } = {}
): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false
  if (root.trim().length === 0 || candidate.trim().length === 0) return false
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '') return options.allowEqual === true
  // Only the exact parent segment means "outside". A sibling folder whose
  // name merely starts with two dots (`..data`) stays a child.
  if (relative === '..') return false
  if (relative.startsWith(`..${path.sep}`)) return false
  return !path.isAbsolute(relative)
}

/**
 * True when `value` names the root of a filesystem, for example `C:\` or `/`.
 *
 * A recorded output folder is never allowed to be a drive root: containment
 * against `C:\` would otherwise authorise every file on the drive. A row that
 * carries such a directory is treated as untrusted and checked against the
 * configured download folder instead.
 */
export function isFileSystemRoot(value: string): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  const resolved = path.resolve(value)
  return path.parse(resolved).root === resolved
}

/** Use the recorded folder only when it cannot authorise a whole drive. */
export function safeContainmentRoot(
  recordedDir: string,
  fallbackRoot: string
): string {
  return isFileSystemRoot(recordedDir) ? fallbackRoot : recordedDir
}
