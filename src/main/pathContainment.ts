import { realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * Shared path-containment policy for file actions on recorded outputs.
 *
 * Windows paths are case-insensitive. Node's `path.win32.relative` already
 * compares drive letters, folders and file names without regard to case, and
 * this helper relies on it instead of doing its own string prefix check. That
 * keeps one rule for downloads, media jobs and the Recycle Bin policy.
 *
 * The lexical rule is not enough on its own: a junction or symlink inside the
 * download folder can point anywhere. `resolvePathInside` follows links for
 * the parts of the path that exist on disk and re-checks containment, so a
 * trashed, opened or hashed file is really under the recorded folder.
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
 * `realpath` that falls back to the lexically resolved path when the entry or
 * one of its parents does not exist (or linking is not permitted here).
 */
async function realPathOrResolved(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    return path.resolve(value)
  }
}

/**
 * Resolve `candidate` to the real (link-free) path it names.
 *
 * The nearest existing ancestor is resolved with `realpath`, then the missing
 * tail is appended verbatim. That keeps "does not exist yet" working while
 * still following a junction or symlink that is already in place above it.
 */
export async function resolveRealPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate)
  const missing: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : path.join(real, ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      // Reached the drive/filesystem root without an existing ancestor.
      if (parent === current) return path.resolve(candidate)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * True when `candidate` really lies inside `root` once symlinks and junctions
 * are followed. The root is resolved the same way, so a link that merely
 * points at the root's own target is still treated as inside.
 *
 * The lexical check runs first: a path that is not inside the recorded folder
 * as written is refused before any filesystem access.
 */
export async function isPathReallyInside(
  root: string,
  candidate: string,
  options: { allowEqual?: boolean } = {}
): Promise<boolean> {
  if (!isPathInside(root, candidate, options)) return false
  const [realRoot, realCandidate] = await Promise.all([
    realPathOrResolved(root),
    resolveRealPath(candidate)
  ])
  return isPathInside(realRoot, realCandidate, options)
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
