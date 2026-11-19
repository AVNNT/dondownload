import { logError } from './index'

/** A repeated failure is re-logged at most this often (once per 5 minutes). */
export const PERSISTENCE_ERROR_LOG_INTERVAL_MS = 5 * 60_000

/**
 * Rate limiter for "history could not be persisted" logs.
 *
 * A single latch that only ever turns on hides every later loss: the first
 * failure is logged, then the database can stay broken for the rest of the
 * session and the log stays silent. This logger instead records the failure at
 * most once per `intervalMs` and starts a fresh window after a successful
 * write, so a recovered and then broken-again store is reported again while a
 * retry storm still only writes one line per window.
 */
export class PersistenceErrorLogger {
  private lastLoggedAt: number | null = null
  private suppressed = 0

  constructor(
    private readonly label: string,
    private readonly now: () => number = Date.now,
    private readonly intervalMs: number = PERSISTENCE_ERROR_LOG_INTERVAL_MS,
    /** Injected in tests; production uses the process error log. */
    private readonly write: (message: string) => void = (message) =>
      logError(message)
  ) {}

  /** A persist attempt failed; log it unless the window is still open. */
  failed(context: string): void {
    const now = this.now()
    if (
      this.lastLoggedAt !== null &&
      now - this.lastLoggedAt < this.intervalMs
    ) {
      this.suppressed += 1
      return
    }
    const skipped = this.suppressed
    this.suppressed = 0
    this.lastLoggedAt = now
    // Never include URLs, paths or record payloads in logs.
    const suffix = skipped > 0 ? ` (${skipped} earlier failures not logged)` : ''
    this.write(`${this.label} ${context}.${suffix}`)
  }

  /** A persist attempt succeeded; the next failure is logged immediately. */
  succeeded(): void {
    this.lastLoggedAt = null
    this.suppressed = 0
  }
}
