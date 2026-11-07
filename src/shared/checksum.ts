/**
 * Checksum contracts shared by the main process, the preload bridge and the
 * renderer. Expected hashes are detected purely from their hex length, which is
 * unambiguous for the four supported algorithms.
 */
export const CHECKSUM_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'] as const
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number]

export const CHECKSUM_ALGORITHM_LABELS: Readonly<
  Record<ChecksumAlgorithm, string>
> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha512: 'SHA-512'
}

export const CHECKSUM_HEX_LENGTHS: Readonly<
  Record<ChecksumAlgorithm, number>
> = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha512: 128
}

const HEX_HASH_PATTERN = /^[0-9a-f]+$/

export interface ParsedExpectedHash {
  algorithm: ChecksumAlgorithm
  /** Lowercase hex, trimmed, ready for a case-insensitive comparison. */
  hash: string
}

/**
 * Last completed checksum for one download. `ok` is null for a compute-only
 * job and true/false for an expected-hash verification.
 */
export interface ChecksumResult {
  algorithm: ChecksumAlgorithm
  ok: boolean | null
  computed: string
  checkedAt: number
}

/** Streamed progress event, throttled by the main process. */
export interface ChecksumProgress {
  downloadId: string
  hashedBytes: number
  totalBytes: number
}

export function isChecksumAlgorithm(
  value: unknown
): value is ChecksumAlgorithm {
  return (
    typeof value === 'string' &&
    (CHECKSUM_ALGORITHMS as readonly string[]).includes(value)
  )
}

/** Algorithm implied by a trimmed hex digest's length, or null. */
export function detectChecksumAlgorithm(
  raw: unknown
): ChecksumAlgorithm | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!HEX_HASH_PATTERN.test(trimmed)) return null
  for (const algorithm of CHECKSUM_ALGORITHMS) {
    if (trimmed.length === CHECKSUM_HEX_LENGTHS[algorithm]) return algorithm
  }
  return null
}

/**
 * Trim whitespace, lowercase and classify an expected hash. Non-hex input and
 * lengths other than 32/40/64/128 are rejected with null.
 */
export function parseExpectedHash(raw: unknown): ParsedExpectedHash | null {
  const algorithm = detectChecksumAlgorithm(raw)
  if (algorithm === null || typeof raw !== 'string') return null
  return { algorithm, hash: raw.trim().toLowerCase() }
}

export function isChecksumResult(value: unknown): value is ChecksumResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!isChecksumAlgorithm(record.algorithm)) return false
  if (record.ok !== null && typeof record.ok !== 'boolean') return false
  const computed = record.computed
  if (
    typeof computed !== 'string' ||
    computed.length !== CHECKSUM_HEX_LENGTHS[record.algorithm] ||
    !HEX_HASH_PATTERN.test(computed)
  ) {
    return false
  }
  return (
    typeof record.checkedAt === 'number' &&
    Number.isFinite(record.checkedAt) &&
    record.checkedAt >= 0
  )
}
