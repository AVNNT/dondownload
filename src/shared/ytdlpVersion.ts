/**
 * yt-dlp release tags are calendar versions: `YYYY.MM.DD` with an optional
 * numeric build suffix (`YYYY.MM.DD.N`), for example `2026.10.26` or
 * `2026.11.01.2`. Keep parsing strict so a hostile or malformed release JSON
 * value can never order itself above installed versions.
 */

const YTDLP_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d{1,3}))?$/

export function isYtdlpVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = YTDLP_VERSION.exec(value)
  if (match === null) return false
  const month = Number(match[2])
  const day = Number(match[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function versionParts(value: string): number[] | null {
  if (!isYtdlpVersion(value)) return null
  const match = YTDLP_VERSION.exec(value)
  if (match === null) return null
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? 0 : Number(match[4])
  ]
}

/**
 * Compare two yt-dlp versions numerically. Returns a negative number when
 * `left` is older, zero when both describe the same release, and a positive
 * number when `left` is newer. Invalid versions compare as older.
 */
export function compareYtdlpVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  for (let index = 0; index < 4; index += 1) {
    const difference = (a[index] as number) - (b[index] as number)
    if (difference !== 0) return difference
  }
  return 0
}
