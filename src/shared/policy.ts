export const MAX_DOWNLOAD_ATTEMPTS = 3

/**
 * aria2 retries transient failures internally (max-tries=3). This caps the
 * number of user-visible attempts so a permanently broken URL cannot loop.
 */
export function canRetry(attempts: number, maxAttempts = MAX_DOWNLOAD_ATTEMPTS): boolean {
  return Number.isInteger(attempts) && attempts >= 1 && attempts < maxAttempts
}
