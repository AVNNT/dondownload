/**
 * The on-disk shape of one memory benchmark run.
 *
 * `runner.ts` samples Electron once per phase and writes this report where the
 * `bench/memory.mjs` harness can read it and compare runs. Everything here is
 * pure (no Electron, no filesystem) so the report shape and the unit conversion
 * stay unit tested.
 */
import type { MemoryProcessGroup, MemorySample } from './metrics'

/** Set to a JSON file path to run the memory benchmark instead of the normal app. */
export const MEMORY_BENCH_OUT_ENV = 'DONDOWNLOAD_MEMORY_BENCH'

/**
 * The three real states a user compares: the window open and idle, the window
 * closed to tray (renderer destroyed), and the window shown again.
 */
export const MEMORY_BENCH_PHASES = [
  'window-open-idle',
  'hidden-to-tray',
  'shown-again'
] as const

export type MemoryBenchPhase = (typeof MEMORY_BENCH_PHASES)[number]

export interface MemoryBenchPhaseResult {
  phase: MemoryBenchPhase
  /** Working-set megabytes, one decimal, for every group (always all five). */
  totalsByGroup: Record<MemoryProcessGroup, number>
  /** Working-set megabytes for every measured process. */
  total: number
  processes: number
  timestamp: string
}

export interface MemoryBenchReport {
  generatedAt: string
  electron: string
  platform: string
  arch: string
  phases: MemoryBenchPhaseResult[]
}

const BYTES_PER_MEGABYTE = 1024 * 1024

/**
 * Convert bytes to megabytes with one decimal. The benchmark reports the
 * number a user sees in Task Manager, so MB here means MiB (1024² bytes).
 */
export function toMegabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round((bytes / BYTES_PER_MEGABYTE) * 10) / 10
}

export function createPhaseResult(
  phase: MemoryBenchPhase,
  sample: MemorySample,
  timestamp: string = new Date().toISOString()
): MemoryBenchPhaseResult {
  const totalsByGroup: Record<MemoryProcessGroup, number> = {
    main: 0,
    gpu: 0,
    renderer: 0,
    utility: 0,
    other: 0
  }
  for (const group of sample.groups) {
    totalsByGroup[group.group] = toMegabytes(group.workingSetBytes)
  }
  return {
    phase,
    totalsByGroup,
    total: toMegabytes(sample.total.workingSetBytes),
    processes: sample.total.processes,
    timestamp
  }
}

/**
 * The outfile requested by `DONDOWNLOAD_MEMORY_BENCH=<outfile.json>`.
 * Unset or blank means the benchmark stays off, so a stray empty variable in a
 * shell profile can never make the desktop app quit after ten seconds.
 */
export function memoryBenchOutPath(
  env: Record<string, string | undefined>
): string | null {
  const raw = env[MEMORY_BENCH_OUT_ENV]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}
