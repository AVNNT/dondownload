/**
 * Environment policy for the idle tray stub hand-off.
 *
 * Kept in its own tiny module so both the controller and the process wiring
 * can use it without importing each other.
 */

/** Default grace period: one minute of continuous tray idleness. */
export const DEFAULT_IDLE_STUB_GRACE_MS = 60_000

/**
 * `DONDOWNLOAD_IDLE_STUB=0` disables the hand-off entirely; every other value
 * (including unset) leaves the user's setting in charge. `1` additionally
 * allows the hand-off in a development build, which is otherwise never
 * eligible, so the spawn path can be exercised without packaging.
 */
export function idleStubEnvPolicy(
  raw: string | undefined
): { enabled: boolean; forceInDev: boolean } {
  const value = raw?.trim()
  if (value === '0') return { enabled: false, forceInDev: false }
  return { enabled: true, forceInDev: value === '1' }
}

/**
 * `DONDOWNLOAD_IDLE_STUB_GRACE_MS` overrides the grace period for testing.
 * Only a positive, finite value is used; anything else keeps the fallback so a
 * typo cannot make the app hand off at once or never.
 */
export function resolveIdleStubGraceMs(
  raw: string | undefined,
  fallback: number = DEFAULT_IDLE_STUB_GRACE_MS
): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (trimmed.length === 0) return fallback
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
