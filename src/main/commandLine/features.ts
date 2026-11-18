/**
 * Helpers for Chromium command-line feature switches.
 *
 * `appendSwitch('enable-features', …)` replaces any earlier value, so a second
 * call would silently drop the first set. These helpers merge instead, which
 * keeps the memory switches in `index.ts` composable with anything else that
 * enables or disables a feature. Pure, so the merge rules are unit tested.
 */

/** Chromium's separator inside the `enable-features`/`disable-features` value. */
const FEATURE_SEPARATOR = ','

/**
 * Return the feature list with `additions` appended, without duplicates and
 * without dropping any existing entry. Blank entries are ignored.
 */
export function mergeFeatureList(
  existing: string | undefined,
  additions: readonly string[]
): string {
  const merged: string[] = []
  const seen = new Set<string>()
  const consider = (raw: string): void => {
    const name = raw.trim()
    if (name.length === 0 || seen.has(name)) return
    seen.add(name)
    merged.push(name)
  }

  if (existing !== undefined) {
    for (const entry of existing.split(FEATURE_SEPARATOR)) consider(entry)
  }
  for (const entry of additions) consider(entry)
  return merged.join(FEATURE_SEPARATOR)
}
