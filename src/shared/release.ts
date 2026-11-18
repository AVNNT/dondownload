/**
 * GitHub release source for application self-updates.
 *
 * `UPDATE_REPO` points at the public DonDownload repository. Every release
 * published there must carry a signed `SHA256SUMS.txt`, so the updater can
 * authenticate the installer before downloading it. `scripts/release.mjs`
 * builds, checksums, signs and (with `--publish`) drafts that release locally.
 */
export const UPDATE_REPO: { owner: string; repo: string } | null = {
  owner: 'AVNNT',
  repo: 'dondownload'
}

/**
 * Ed25519 public key used to authenticate `SHA256SUMS.txt` before any hash in
 * it is trusted. The value is the base64 SPKI DER form, but an SPKI PEM block
 * is accepted too.
 *
 * The matching private key is generated outside this repository with
 * `node scripts/generate-update-signing-key.mjs <path>` and kept at
 * `%USERPROFILE%\.dondownload-release\update-signing-key.pem` (or the path in
 * `DONDOWNLOAD_UPDATE_SIGNING_KEY`). It must be backed up: losing it prevents
 * every future authenticated update. While this is null the updater refuses to
 * offer an update and reports "Update signing key not configured".
 */
export const UPDATE_SIGNING_PUBLIC_KEY: string | null =
  'MCowBQYDK2VwAyEA9fLGclrgcB1eHPWQiSTAlTbUdZyTiOHZ6ttF6UCbevY='
export const UPDATE_SIGNING_KEY_NOT_CONFIGURED =
  'Update signing key not configured'

/** GitHub owner (user or organisation) account name. */
export const UPDATE_OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/
/** GitHub repository name. */
export const UPDATE_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

export interface UpdateRepo {
  owner: string
  repo: string
}

export function isValidUpdateRepo(value: unknown): value is UpdateRepo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2) return false
  return (
    typeof record.owner === 'string' &&
    UPDATE_OWNER_PATTERN.test(record.owner) &&
    typeof record.repo === 'string' &&
    UPDATE_REPO_PATTERN.test(record.repo)
  )
}

/**
 * Validate an injected/configured source. Throws for a malformed object so a
 * future configuration mistake fails loudly instead of silently checking an
 * unintended repository.
 */
export function requireValidUpdateRepo(value: unknown): UpdateRepo | null {
  if (value === null || value === undefined) return null
  if (!isValidUpdateRepo(value)) {
    throw new Error('The configured update repository is not valid.')
  }
  return { owner: value.owner, repo: value.repo }
}
