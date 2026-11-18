/**
 * Memory benchmark runner.
 *
 * Enabled only by `DONDOWNLOAD_MEMORY_BENCH=<outfile.json>`. The normal app
 * starts unchanged, then this module samples `app.getAppMetrics()` in three
 * phases — window open and idle, hidden to tray, and shown again — writes the
 * grouped totals to the outfile after every phase, and quits. The harness in
 * `bench/memory.mjs` launches the built app several times and medians the
 * phases, so RAM claims can be measured instead of guessed.
 */
import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sampleProcessMetrics, type ProcessMetricLike } from './metrics'
import {
  MEMORY_BENCH_PHASES,
  createPhaseResult,
  type MemoryBenchPhase,
  type MemoryBenchPhaseResult,
  type MemoryBenchReport
} from './report'

/** Each phase settles for this long before sampling, matching the documented run. */
export const MEMORY_BENCH_SETTLE_MS = 10_000

export interface MemoryBenchOptions {
  /** JSON file the app writes; the harness reads it after the app exits. */
  outPath: string
  /** The existing close-to-tray path from the main entry point. */
  hideToTray: () => void
  /** The existing restore-from-tray path (may recreate the window). */
  showWindow: () => void
  /** Quit after the last sample, even when a phase failed. */
  quit: () => void
  /** Per-phase settle time; overridable for tests and quick manual runs. */
  settleMs?: number
  sampleMetrics?: () => readonly ProcessMetricLike[]
  writeReport?: (path: string, report: MemoryBenchReport) => Promise<void>
  now?: () => Date
  log?: (message: string) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function writeReportFile(
  path: string,
  report: MemoryBenchReport
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function defaultLog(message: string): void {
  console.error(`[dondownload-memory-bench] ${message}`)
}

/**
 * Run the three phases and return the report. The outfile is rewritten after
 * every sample, so a timed-out run still leaves the phases it reached.
 */
export async function runMemoryBench(
  options: MemoryBenchOptions
): Promise<MemoryBenchReport> {
  const settleMs = options.settleMs ?? MEMORY_BENCH_SETTLE_MS
  const readMetrics =
    options.sampleMetrics ?? (() => app.getAppMetrics())
  const write = options.writeReport ?? writeReportFile
  const now = options.now ?? (() => new Date())
  const log = options.log ?? defaultLog

  const phases: MemoryBenchPhaseResult[] = []
  const report: MemoryBenchReport = {
    generatedAt: now().toISOString(),
    electron: process.versions.electron ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    phases
  }

  const samplePhase = async (phase: MemoryBenchPhase): Promise<void> => {
    await delay(settleMs)
    const result = createPhaseResult(
      phase,
      sampleProcessMetrics(readMetrics()),
      now().toISOString()
    )
    phases.push(result)
    log(
      `${phase}: ${result.total.toFixed(1)} MB across ${result.processes} processes`
    )
    await write(options.outPath, report)
  }

  await samplePhase(MEMORY_BENCH_PHASES[0])
  options.hideToTray()
  await samplePhase(MEMORY_BENCH_PHASES[1])
  options.showWindow()
  await samplePhase(MEMORY_BENCH_PHASES[2])

  return report
}

/**
 * Fire-and-forget entry point for the main process hook: run the phases, then
 * always quit so the harness never waits on a window that is already gone.
 */
export function startMemoryBench(options: MemoryBenchOptions): void {
  void runMemoryBench(options)
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      ;(options.log ?? defaultLog)(`failed: ${detail}`)
    })
    .finally(() => {
      options.quit()
    })
}
