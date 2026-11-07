/**
 * Lightweight, opt-in startup instrumentation.
 *
 * `DONDOWNLOAD_STARTUP_TRACE=1` prints one line per startup phase with both the
 * time since the main bundle started loading and, where a span is measured, the
 * duration of that phase. It is a no-op in normal runs and never changes the
 * order or result of any startup work.
 */
const traceEnabled = process.env.DONDOWNLOAD_STARTUP_TRACE === '1'

const origin = performance.now()

export function isStartupTraceEnabled(): boolean {
  return traceEnabled
}

export function startupNow(): number {
  return performance.now()
}

/** Log a point-in-time phase, optionally with a duration measured in ms. */
export function traceStartup(phase: string, durationMs?: number): void {
  if (!traceEnabled) return
  const sinceStart = performance.now() - origin
  const duration =
    durationMs === undefined ? '' : ` (${durationMs.toFixed(1)}ms)`
  // eslint-disable-next-line no-console -- explicit opt-in diagnostics only
  console.log(
    `[dondownload-startup] +${sinceStart.toFixed(1)}ms ${phase}${duration}`
  )
}

/** Await a task and trace its duration, even when it throws. */
export async function traceStartupSpan<T>(
  phase: string,
  task: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  try {
    return await task()
  } finally {
    traceStartup(phase, performance.now() - startedAt)
  }
}
