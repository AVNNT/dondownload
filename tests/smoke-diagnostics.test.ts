import { describe, expect, it } from 'vitest'
import {
  MAX_SMOKE_DIAGNOSTIC_LENGTH,
  SmokeDiagnosticsCollector,
  firstFatalDiagnostic,
  isKnownBenignConsoleWarning,
  isLocalRendererUrl,
  normalizeConsoleLevel,
  summarizeDiagnostics,
  type SmokeDiagnosticsSnapshot
} from '../src/main/smoke/diagnostics'
import {
  createSmokeResult,
  type SmokeEnvironmentInfo
} from '../src/main/smoke/report'

function collect(
  record: (collector: SmokeDiagnosticsCollector) => void
): SmokeDiagnosticsSnapshot {
  const collector = new SmokeDiagnosticsCollector()
  record(collector)
  return collector.snapshot()
}

const environment: SmokeEnvironmentInfo = {
  appVersion: '1.3.2',
  electronVersion: '45.2.2',
  chromeVersion: '140.0.0.0',
  nodeVersion: '24.19.0',
  platform: 'win32',
  arch: 'x64',
  packaged: true,
  userDataPath: 'C:\\Temp\\dd-smoke',
  resourcesPath: 'C:\\app\\resources'
}

describe('smoke renderer diagnostic classification', () => {
  it('normalizes current string levels and legacy numeric levels', () => {
    expect(normalizeConsoleLevel('error')).toBe('error')
    expect(normalizeConsoleLevel('warning')).toBe('warning')
    expect(normalizeConsoleLevel('warn')).toBe('warning')
    expect(normalizeConsoleLevel('info')).toBe('info')
    expect(normalizeConsoleLevel('debug')).toBe('debug')
    expect(normalizeConsoleLevel(3)).toBe('error')
    expect(normalizeConsoleLevel(2)).toBe('warning')
    expect(normalizeConsoleLevel(1)).toBe('info')
    expect(normalizeConsoleLevel(0)).toBe('debug')
    expect(normalizeConsoleLevel(undefined)).toBe('info')
  })

  it('records error-level console messages as fatal and warnings as nonfatal', () => {
    const snapshot = collect((collector) => {
      collector.recordConsoleMessage({
        level: 'error',
        message: 'Uncaught TypeError: render failed\n  at App'
      })
      collector.recordConsoleMessage({
        level: 'warning',
        message: 'A renderer warning'
      })
      collector.recordConsoleMessage({
        level: 'info',
        message: 'Informational message is ignored'
      })
    })

    expect(snapshot.entries).toEqual([
      {
        category: 'console',
        severity: 'error',
        fatal: true,
        message: 'Uncaught TypeError: render failed at App'
      },
      {
        category: 'console',
        severity: 'warning',
        fatal: false,
        message: 'A renderer warning'
      }
    ])
    expect(summarizeDiagnostics(snapshot)).toMatchObject({
      errors: 1,
      warnings: 1,
      fatal: 1
    })
  })

  it('suppresses only the warning-level meta frame-ancestors notice', () => {
    const warning =
      "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."

    expect(isKnownBenignConsoleWarning('warning', warning)).toBe(true)
    expect(isKnownBenignConsoleWarning('error', warning)).toBe(false)

    const warningSnapshot = collect((collector) => {
      collector.recordConsoleMessage({ level: 'warning', message: warning })
    })
    expect(warningSnapshot.entries).toEqual([])
    expect(warningSnapshot.suppressed).toBe(1)

    const errorSnapshot = collect((collector) => {
      collector.recordConsoleMessage({ level: 'error', message: warning })
    })
    expect(errorSnapshot.entries).toHaveLength(1)
    expect(errorSnapshot.entries[0]).toMatchObject({
      severity: 'error',
      fatal: true
    })
    expect(errorSnapshot.suppressed).toBe(0)
  })

  it('fails main-frame and local renderer resource loads but not aborts or remote resources', () => {
    const snapshot = collect((collector) => {
      collector.recordLoadFailure({
        errorCode: -6,
        errorDescription: 'ERR_FILE_NOT_FOUND',
        validatedURL: 'file:///C:/app/out/renderer/index.html',
        isMainFrame: true
      })
      collector.recordLoadFailure({
        errorCode: -6,
        errorDescription: 'ERR_FILE_NOT_FOUND',
        validatedURL: 'file:///C:/app/out/renderer/missing.js',
        isMainFrame: false
      })
      collector.recordLoadFailure({
        errorCode: -3,
        errorDescription: 'ERR_ABORTED',
        validatedURL: 'file:///C:/app/out/renderer/index.html',
        isMainFrame: true
      })
      collector.recordLoadFailure({
        errorCode: -6,
        errorDescription: 'ERR_FILE_NOT_FOUND',
        validatedURL: 'https://example.invalid/remote.js',
        isMainFrame: false
      })
      collector.recordResourceFailure({
        url: 'file:///C:/app/out/renderer/assets/logo.png',
        error: 'net::ERR_FILE_NOT_FOUND',
        resourceType: 'image'
      })
      collector.recordResourceFailure({
        url: 'https://example.invalid/remote.js',
        error: 'net::ERR_NAME_NOT_RESOLVED',
        resourceType: 'script'
      })
    })

    expect(snapshot.entries.map((entry) => entry.fatal)).toEqual([
      true,
      true,
      false,
      false,
      true,
      false
    ])
    expect(snapshot.entries[2]?.severity).toBe('warning')
    expect(snapshot.entries[3]?.severity).toBe('error')
    expect(snapshot.entries[4]?.category).toBe('resource')
  })

  it('treats renderer process loss and preload failures as fatal', () => {
    const snapshot = collect((collector) => {
      collector.recordRendererGone({ reason: 'crashed', exitCode: 5 })
      collector.recordPreloadError({
        preloadPath: 'C:\\app\\preload\\index.js',
        error: new Error('preload exploded')
      })
    })

    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries.every((entry) => entry.fatal)).toBe(true)
    expect(snapshot.entries.map((entry) => entry.category)).toEqual([
      'renderer-process',
      'preload'
    ])
    expect(snapshot.entries[1]?.message).toContain('preload exploded')
  })

  it('bounds entry count and sanitizes/truncates message length', () => {
    const collector = new SmokeDiagnosticsCollector({
      maxEntries: 2,
      maxMessageLength: 12
    })
    collector.recordConsoleMessage({
      level: 'warning',
      message: 'line\u0000one\nline two is definitely too long'
    })
    collector.recordConsoleMessage({ level: 'warning', message: 'second' })
    collector.recordConsoleMessage({ level: 'warning', message: 'third' })

    const snapshot = collector.snapshot()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries[0]?.message).toBe('line one lin')
    expect(snapshot.dropped).toBe(1)
  })

  it('identifies local renderer URLs and the first fatal diagnostic', () => {
    expect(isLocalRendererUrl('file:///C:/app/index.html')).toBe(true)
    expect(isLocalRendererUrl('FILE:///C:/app/index.html')).toBe(true)
    expect(isLocalRendererUrl('https://example.invalid/')).toBe(false)

    const snapshot = collect((collector) => {
      collector.recordConsoleMessage({ level: 'warning', message: 'just a warning' })
      collector.recordConsoleMessage({ level: 'error', message: 'fatal one' })
      collector.recordConsoleMessage({ level: 'error', message: 'fatal two' })
    })

    expect(firstFatalDiagnostic(snapshot)?.message).toBe('fatal one')
    expect(summarizeDiagnostics(snapshot)).toEqual({
      errors: 2,
      warnings: 1,
      fatal: 2,
      suppressed: 0,
      dropped: 0
    })
  })

  it('keeps the default message bound at the documented limit', () => {
    const snapshot = collect((collector) => {
      collector.recordConsoleMessage({
        level: 'error',
        message: 'x'.repeat(MAX_SMOKE_DIAGNOSTIC_LENGTH + 100)
      })
    })
    expect(snapshot.entries[0]?.message).toHaveLength(
      MAX_SMOKE_DIAGNOSTIC_LENGTH
    )
  })
})

describe('smoke report with renderer diagnostics', () => {
  it('includes diagnostics in the machine-readable report and fails on a failed check', () => {
    const snapshot = collect((collector) => {
      collector.recordConsoleMessage({ level: 'error', message: 'boom' })
      collector.recordConsoleMessage({
        level: 'warning',
        message:
          "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."
      })
    })

    const result = createSmokeResult({
      startedAt: '2026-11-04T00:00:00.000Z',
      now: () => Date.parse('2026-11-04T00:00:01.000Z'),
      environment,
      checks: [
        {
          name: 'renderer.diagnostics',
          status: 'FAIL',
          detail: 'errors=1; warnings=0',
          durationMs: 1
        }
      ],
      diagnostics: snapshot,
      logs: []
    })

    expect(result).toMatchObject({
      schemaVersion: 2,
      status: 'FAIL',
      diagnostics: {
        entries: [
          {
            category: 'console',
            severity: 'error',
            fatal: true,
            message: 'boom'
          }
        ],
        suppressed: 1,
        dropped: 0
      }
    })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('defaults to an empty diagnostics block for early failures', () => {
    const result = createSmokeResult({
      environment,
      checks: [
        {
          name: 'config.valid',
          status: 'FAIL',
          detail: 'invalid',
          durationMs: 0
        }
      ],
      logs: []
    })

    expect(result.diagnostics).toEqual({
      entries: [],
      suppressed: 0,
      dropped: 0
    })
  })
})
