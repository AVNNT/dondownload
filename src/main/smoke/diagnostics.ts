import type { WebContents } from 'electron'
import { safeDetail } from './report'

/**
 * Bounded renderer diagnostics for the opt-in production smoke test.
 *
 * Only the real smoke BrowserWindow's webContents is observed. Normal desktop
 * startup never constructs a collector or attaches these listeners. Messages
 * are sanitized, length-bounded and count-bounded so a noisy or hostile
 * renderer cannot grow the result file without limit.
 */

export type SmokeConsoleLevel = 'debug' | 'info' | 'warning' | 'error'
export type SmokeDiagnosticSeverity = 'warning' | 'error'
export type SmokeDiagnosticCategory =
  | 'console'
  | 'document'
  | 'resource'
  | 'preload'
  | 'renderer-process'

export interface SmokeDiagnostic {
  category: SmokeDiagnosticCategory
  severity: SmokeDiagnosticSeverity
  /** Fatal diagnostics fail the smoke test through `renderer.diagnostics`. */
  fatal: boolean
  message: string
}

export interface SmokeDiagnosticsSnapshot {
  entries: SmokeDiagnostic[]
  /** Known benign Chromium warnings that were intentionally not recorded. */
  suppressed: number
  /** Diagnostics discarded after the bounded entry limit was reached. */
  dropped: number
}

export interface SmokeDiagnosticsSummary {
  errors: number
  warnings: number
  fatal: number
  suppressed: number
  dropped: number
}

export interface SmokeDiagnosticsOptions {
  maxEntries?: number
  maxMessageLength?: number
}

export interface SmokeConsoleMessageInput {
  level: unknown
  message: unknown
  sourceId?: unknown
  lineNumber?: unknown
}

export interface SmokeLoadFailureInput {
  errorCode?: unknown
  errorDescription?: unknown
  validatedURL?: unknown
  isMainFrame?: unknown
}

export interface SmokeResourceFailureInput {
  url?: unknown
  error?: unknown
  resourceType?: unknown
  webContentsId?: unknown
}

export interface SmokeRendererGoneInput {
  reason?: unknown
  exitCode?: unknown
}

export interface SmokePreloadErrorInput {
  preloadPath?: unknown
  error?: unknown
}

export const MAX_SMOKE_DIAGNOSTICS = 50
export const MAX_SMOKE_DIAGNOSTIC_LENGTH = 400

/**
 * Chromium logs this at warning level when a document's meta CSP contains
 * `frame-ancestors`. It is a platform warning about a directive that has no
 * effect in a meta element, not an application error. Keep the match narrow:
 * only this exact warning text, and only at warning level, is ignored.
 */
const META_FRAME_ANCESTORS_WARNING =
  /\bcontent security policy directive ['"]frame-ancestors['"] is ignored when delivered via a <meta> element\b/i

const ERR_ABORTED = -3

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

export function normalizeConsoleLevel(level: unknown): SmokeConsoleLevel {
  if (typeof level === 'number') {
    if (level >= 3) return 'error'
    if (level === 2) return 'warning'
    if (level === 1) return 'info'
    return 'debug'
  }

  const normalized = typeof level === 'string' ? level.trim().toLowerCase() : ''
  if (normalized === 'error') return 'error'
  if (normalized === 'warning' || normalized === 'warn') return 'warning'
  if (normalized === 'info') return 'info'
  if (normalized === 'debug' || normalized === 'verbose') return 'debug'
  // Electron has used numeric levels historically and string levels recently.
  // Anything unrecognized is treated as informational rather than failing.
  return 'info'
}

export function isKnownBenignConsoleWarning(
  level: SmokeConsoleLevel,
  message: string
): boolean {
  return level === 'warning' && META_FRAME_ANCESTORS_WARNING.test(message)
}

/** The smoke renderer is a local production `file:` document. */
export function isLocalRendererUrl(url: string): boolean {
  return /^file:/i.test(url)
}

function isAborted(description: string, errorCode: number | null): boolean {
  return errorCode === ERR_ABORTED || /ERR_ABORTED/i.test(description)
}

export class SmokeDiagnosticsCollector {
  private readonly entries: SmokeDiagnostic[] = []
  private readonly maxEntries: number
  private readonly maxMessageLength: number
  private suppressed = 0
  private dropped = 0

  constructor(options: SmokeDiagnosticsOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_SMOKE_DIAGNOSTICS)
    this.maxMessageLength = Math.max(
      1,
      options.maxMessageLength ?? MAX_SMOKE_DIAGNOSTIC_LENGTH
    )
  }

  private add(
    entry: Omit<SmokeDiagnostic, 'message'> & { message: unknown }
  ): void {
    if (this.entries.length >= this.maxEntries) {
      this.dropped += 1
      return
    }
    this.entries.push({
      category: entry.category,
      severity: entry.severity,
      fatal: entry.fatal,
      message: safeDetail(entry.message, this.maxMessageLength)
    })
  }

  recordConsoleMessage(input: SmokeConsoleMessageInput): void {
    const level = normalizeConsoleLevel(input.level)
    if (level === 'debug' || level === 'info') return

    const message = text(input.message) || 'Renderer console message.'
    if (isKnownBenignConsoleWarning(level, message)) {
      this.suppressed += 1
      return
    }

    this.add({
      category: 'console',
      severity: level,
      fatal: level === 'error',
      message
    })
  }

  recordLoadFailure(input: SmokeLoadFailureInput): void {
    const errorCode =
      typeof input.errorCode === 'number' ? input.errorCode : null
    const description = text(input.errorDescription) || 'Load failed.'
    const url = text(input.validatedURL)
    const mainFrame = input.isMainFrame === true
    const local = isLocalRendererUrl(url)
    const aborted = isAborted(description, errorCode)
    const severity: SmokeDiagnosticSeverity = aborted ? 'warning' : 'error'
    const fatal = !aborted && (mainFrame || local || url.length === 0)
    const location = url.length > 0 ? ` (${url})` : ''
    const code = errorCode === null ? '' : ` (${errorCode})`

    this.add({
      category: mainFrame ? 'document' : 'resource',
      severity,
      fatal,
      message: `Load failed${code}: ${description}${location}`
    })
  }

  recordResourceFailure(input: SmokeResourceFailureInput): void {
    const url = text(input.url)
    const error = text(input.error) || 'Resource load failed.'
    const resourceType = text(input.resourceType) || 'resource'
    const mainFrame = resourceType === 'mainFrame'
    const local = isLocalRendererUrl(url)
    const aborted = isAborted(error, null)
    const severity: SmokeDiagnosticSeverity = aborted ? 'warning' : 'error'
    // Only local renderer resources and document/frame loads fail the smoke.
    // A remote resource error is still reported, but cannot prove the local
    // production bundle is broken.
    const fatal = !aborted && (mainFrame || local)
    const location = url.length > 0 ? ` (${url})` : ''

    this.add({
      category: mainFrame ? 'document' : 'resource',
      severity,
      fatal,
      message: `${resourceType} load failed: ${error}${location}`
    })
  }

  recordRendererGone(input: SmokeRendererGoneInput): void {
    const reason = text(input.reason) || 'unknown'
    const exitCode =
      typeof input.exitCode === 'number' ? ` (exitCode=${input.exitCode})` : ''
    this.add({
      category: 'renderer-process',
      severity: 'error',
      fatal: true,
      message: `Renderer process exited unexpectedly: ${reason}${exitCode}`
    })
  }

  recordPreloadError(input: SmokePreloadErrorInput): void {
    const detail =
      input.error instanceof Error ? input.error.message : text(input.error)
    const preloadPath = text(input.preloadPath)
    const location = preloadPath.length > 0 ? ` (${preloadPath})` : ''
    this.add({
      category: 'preload',
      severity: 'error',
      fatal: true,
      message: `Preload script failed${location}: ${detail || 'unknown error'}`
    })
  }

  snapshot(): SmokeDiagnosticsSnapshot {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      suppressed: this.suppressed,
      dropped: this.dropped
    }
  }
}

export function summarizeDiagnostics(
  snapshot: SmokeDiagnosticsSnapshot
): SmokeDiagnosticsSummary {
  let errors = 0
  let warnings = 0
  let fatal = 0
  for (const entry of snapshot.entries) {
    if (entry.severity === 'error') errors += 1
    if (entry.severity === 'warning') warnings += 1
    if (entry.fatal) fatal += 1
  }
  return {
    errors,
    warnings,
    fatal,
    suppressed: snapshot.suppressed,
    dropped: snapshot.dropped
  }
}

export function firstFatalDiagnostic(
  snapshot: SmokeDiagnosticsSnapshot
): SmokeDiagnostic | null {
  return snapshot.entries.find((entry) => entry.fatal) ?? null
}

function recordFromArgs(args: readonly unknown[]): Record<string, unknown> | null {
  const first = args[0]
  if (typeof first !== 'object' || first === null) return null
  return first as Record<string, unknown>
}

/**
 * Attach listeners to the actual smoke BrowserWindow. Returns a disposer so
 * the session-wide webRequest listener is removed after the smoke run.
 */
export function attachSmokeDiagnostics(
  webContents: WebContents,
  collector: SmokeDiagnosticsCollector
): () => void {
  const onConsoleMessage = (...args: unknown[]): void => {
    const details = recordFromArgs(args)
    if (details !== null && 'message' in details) {
      collector.recordConsoleMessage({
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber
      })
      return
    }
    collector.recordConsoleMessage({
      level: args[1],
      message: args[2],
      lineNumber: args[3],
      sourceId: args[4]
    })
  }

  const onDidFailLoad = (...args: unknown[]): void => {
    collector.recordLoadFailure({
      errorCode: args[1],
      errorDescription: args[2],
      validatedURL: args[3],
      isMainFrame: args[4]
    })
  }

  const onRenderProcessGone = (...args: unknown[]): void => {
    const details = recordFromArgs(args.slice(1))
    collector.recordRendererGone({
      reason: details?.reason,
      exitCode: details?.exitCode
    })
  }

  const onPreloadError = (...args: unknown[]): void => {
    collector.recordPreloadError({
      preloadPath: args[1],
      error: args[2]
    })
  }

  const onWebRequestError = (details: {
    url?: string
    error?: string
    resourceType?: string
    webContentsId?: number
  }): void => {
    if (
      typeof details.webContentsId === 'number' &&
      details.webContentsId !== webContents.id
    ) {
      return
    }
    collector.recordResourceFailure(details)
  }

  const rendererSession = webContents.session

  webContents.on('console-message', onConsoleMessage as never)
  webContents.on('did-fail-load', onDidFailLoad as never)
  webContents.on('render-process-gone', onRenderProcessGone as never)
  webContents.on('preload-error', onPreloadError as never)
  try {
    rendererSession.webRequest.onErrorOccurred(onWebRequestError as never)
  } catch {
    // Resource-level diagnostics are best effort; the window's own console
    // and did-fail-load events still cover document failures.
  }

  return () => {
    try {
      webContents.removeListener('console-message', onConsoleMessage as never)
      webContents.removeListener('did-fail-load', onDidFailLoad as never)
      webContents.removeListener('render-process-gone', onRenderProcessGone as never)
      webContents.removeListener('preload-error', onPreloadError as never)
    } catch {
      // The window or webContents may already be destroyed during shutdown.
    }
    try {
      rendererSession.webRequest.onErrorOccurred(null)
    } catch {
      // The session may already be gone during shutdown.
    }
  }
}
