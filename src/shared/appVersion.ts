/**
 * Strict semantic-version comparison for application release tags.
 *
 * Only `X.Y.Z` or `vX.Y.Z` with an optional `-prerelease` suffix is accepted.
 * Build metadata (`+...`) is deliberately not part of the release contract.
 * A prerelease always sorts before the same core version, so a `1.2.3-beta.1`
 * release is never offered over an installed `1.2.3`.
 */

interface ParsedAppVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const APP_VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseAppVersion(value: unknown): ParsedAppVersion | null {
  if (typeof value !== 'string') return null
  const match = APP_VERSION_PATTERN.exec(value)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null
  }
  const prerelease =
    match[4] === undefined ? [] : match[4].split('.')
  if (prerelease.some((part) => part.length === 0)) return null
  return { major, minor, patch, prerelease }
}

/** Return the normalised `X.Y.Z[-prerelease]` form, or null when invalid. */
export function normalizeAppVersion(value: unknown): string | null {
  const parsed = parseAppVersion(value)
  if (parsed === null) return null
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length === 0
    ? core
    : `${core}-${parsed.prerelease.join('.')}`
}

function comparePrerelease(left: string[], right: string[]): number {
  // A release without a prerelease suffix is newer than any prerelease.
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue

    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return 0
}

/** Negative when left < right, zero when equal, positive when left > right. */
export function compareAppVersions(left: string, right: string): number {
  const a = parseAppVersion(left)
  const b = parseAppVersion(right)
  if (a === null || b === null) {
    throw new Error('Cannot compare invalid application versions.')
  }
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}
