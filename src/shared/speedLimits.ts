/**
 * Shared quick speed-limiter presets.
 *
 * The global download limit is stored as bytes per second with `0` meaning
 * unlimited. Presets intentionally use the same decimal units as the Settings
 * page (`1 MB/s = 1_000_000 B/s`), so choosing a preset there and here produces
 * exactly the same stored value and the checked menu item always matches.
 */

export interface SpeedLimitPreset {
  /** Bytes per second; `0` means unlimited. */
  bps: number
  label: string
}

const KB = 1_000
const MB = 1_000_000

export const SPEED_LIMIT_PRESETS: readonly SpeedLimitPreset[] = [
  { bps: 0, label: 'Unlimited' },
  { bps: 512 * KB, label: '512 KB/s' },
  { bps: 1 * MB, label: '1 MB/s' },
  { bps: 2 * MB, label: '2 MB/s' },
  { bps: 5 * MB, label: '5 MB/s' },
  { bps: 10 * MB, label: '10 MB/s' }
]

/** The preset with exactly this byte-per-second value, or null. */
export function speedLimitPreset(bps: number): SpeedLimitPreset | null {
  return SPEED_LIMIT_PRESETS.find((preset) => preset.bps === bps) ?? null
}

/** True when the stored limit is exactly one of the quick presets. */
export function isSpeedLimitPreset(bps: number): boolean {
  return speedLimitPreset(bps) !== null
}

function trimmed(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Human label for an arbitrary stored limit: the preset label when it matches,
 * otherwise a compact MB/s or KB/s value. `0` and non-positive values mean
 * unlimited.
 */
export function formatSpeedLimitBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return 'Unlimited'
  const preset = speedLimitPreset(bps)
  if (preset !== null) return preset.label
  if (bps >= MB) return `${trimmed(bps / MB)} MB/s`
  return `${trimmed(bps / KB)} KB/s`
}

/**
 * Label for a speed-limit menu entry. Presets keep their exact label; any other
 * saved value is shown as `Custom (<value>)`.
 */
export function speedLimitMenuLabel(bps: number): string {
  return isSpeedLimitPreset(bps)
    ? formatSpeedLimitBps(bps)
    : `Custom (${formatSpeedLimitBps(bps)})`
}
