import { canRetry } from '@shared/policy'

/**
 * aria2 error codes that usually clear up on their own: an unknown failure,
 * a timeout, a transfer stopped for being too slow, a dropped connection and a
 * broken HTTP response. Everything else (missing file, disk full, auth, bad
 * URL, name conflict) would fail again immediately and is left to the user.
 */
export const TRANSIENT_ARIA2_CODES: ReadonlySet<number> = new Set([
  1, 2, 5, 6, 22
])

/**
 * Backoff before each automatic retry. The first automatic retry waits 3 s,
 * the next 10 s. A record gets at most one automatic retry per failure and
 * only while its normal attempt budget allows it.
 */
export const AUTO_RETRY_BACKOFF_MS: readonly number[] = [3_000, 10_000]

export interface AutoRetryDecisionInput {
  /** aria2 error code of the failure. */
  errorCode: number
  /** Raw aria2 message; a 5xx status there marks a server-side failure. */
  errorMessage?: string
  /** Attempts already used (1 after the first try). */
  attempts: number
  maxAttempts: number
  /** How many automatic retries this record already used. */
  autoRetriesUsed: number
}

export function isTransientAria2Failure(
  errorCode: number,
  errorMessage = ''
): boolean {
  if (TRANSIENT_ARIA2_CODES.has(errorCode)) return true
  // aria2 folds some HTTP failures into its generic code; a 5xx response is
  // still a transient server-side problem.
  return /\b5\d\d\b/.test(errorMessage)
}

export function autoRetryDelayMs(autoRetriesUsed: number): number | null {
  if (!Number.isInteger(autoRetriesUsed) || autoRetriesUsed < 0) return null
  return AUTO_RETRY_BACKOFF_MS[autoRetriesUsed] ?? null
}

/**
 * Decide whether a failed download should be retried automatically. Returns
 * the delay in milliseconds, or null when the failure must stay visible.
 */
export function planAutoRetry(input: AutoRetryDecisionInput): number | null {
  if (!isTransientAria2Failure(input.errorCode, input.errorMessage ?? '')) {
    return null
  }
  if (!canRetry(input.attempts, input.maxAttempts)) return null
  return autoRetryDelayMs(input.autoRetriesUsed)
}

/** "Retrying in 3s…" text for a waiting retry. */
export function autoRetryStatusText(secondsRemaining: number): string {
  const seconds = Math.max(0, Math.ceil(secondsRemaining))
  return `Retrying in ${seconds}s…`
}
