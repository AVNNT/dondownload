/**
 * GitHub release source for application self-updates.
 *
 * `UPDATE_REPO` stays null until DonDownload has a public repository with
 * signed/checksummed release assets. While it is null every update UI reports
 * "Update source not configured" and the main process never makes a request.
 */
export const UPDATE_REPO: { owner: string; repo: string } | null = null

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
