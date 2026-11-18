import os from 'node:os'
import path from 'node:path'
import {
  createFileLogger,
  type FileLogger,
  type LogLevel
} from './fileLogger'

/**
 * The one process-wide log file.
 *
 * `%APPDATA%\dondownload\logs\main.log` (`app.getPath('logs')` on Windows), with
 * two rotated generations. `configureLogger` is called once from the app entry
 * point, after Electron is ready and after the single-instance check, so a
 * second launch never appends to the file the running app owns.
 *
 * `debug` is off unless `DONDOWNLOAD_DEBUG_LOG=1`; error, warn and info always
 * write. Before configuration every call is a cheap no-op.
 */

export const DEBUG_LOG_ENV = 'DONDOWNLOAD_DEBUG_LOG'

export interface LoggerOptions {
  /** `%APPDATA%\dondownload\logs`; created on the first write. */
  directory: string
  /** The user's home directories, redacted to `%USERPROFILE%`. */
  userPaths?: readonly string[]
  level?: LogLevel
  /** Current user profile path; defaults to the operating system's home. */
  homeDir?: string
}

let active: FileLogger | null = null

/** True when the environment explicitly asks for debug records. */
export function debugLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEBUG_LOG_ENV] === '1'
}

/**
 * Paths that identify the current user. The profile goes first because it
 * contains the temporary directory, and both must become `%USERPROFILE%`.
 */
export function defaultUserPaths(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  // More specific first: the temp folder sits inside AppData, and both are
  // inside the profile. The environment lists the same folders on some
  // systems, so duplicates are dropped here instead of costing a second
  // regex on every log line.
  const candidates = [
    path.join(homeDir, 'AppData', 'Local', 'Temp'),
    path.join(homeDir, 'AppData'),
    homeDir
  ]
  for (const key of ['TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 2) candidates.push(value)
  }
  const seen = new Set<string>()
  const paths: string[] = []
  for (const candidate of candidates) {
    const key = candidate.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(candidate)
  }
  return paths
}

/** Environment values that must never appear in a line, e.g. proxy passwords. */
export function defaultSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < 4) continue
    if (!/(TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|_KEY)$/i.test(key)) continue
    secrets.push(value)
  }
  return secrets
}

export function configureLogger(options: LoggerOptions): FileLogger {
  const homeDir = options.homeDir ?? os.homedir()
  const level: LogLevel =
    options.level ?? (debugLoggingEnabled() ? 'debug' : 'info')
  active = createFileLogger({
    directory: options.directory,
    fileName: 'main.log',
    maxBytes: 1_000_000,
    files: 3,
    level,
    flushIntervalMs: 5_000,
    maxBufferedLines: 500,
    redactOptions: {
      userPaths: options.userPaths ?? defaultUserPaths(homeDir),
      secretValues: defaultSecretValues()
    }
  })
  return active
}

/** Build a logger around an injected file system; used by tests. */
export function setLoggerForTests(logger: FileLogger | null): void {
  active = logger
}

export function getLogger(): FileLogger | null {
  return active
}

export function isDebugLogging(): boolean {
  return active?.enabled('debug') ?? false
}

/** Path of the log folder, even before the first record is written. */
export function logDirectory(): string | null {
  return active?.directory ?? null
}

export function logError(message: string, ...args: unknown[]): void {
  active?.error(message, ...args)
}

export function logWarn(message: string, ...args: unknown[]): void {
  active?.warn(message, ...args)
}

export function logInfo(message: string, ...args: unknown[]): void {
  active?.info(message, ...args)
}

export function logDebug(message: string, ...args: unknown[]): void {
  active?.debug(message, ...args)
}

/** Recent already-redacted records for the diagnostics copy. */
export function recentLogLines(maxLines: number): string[] {
  return active?.tail(maxLines) ?? []
}

/** Flush and stop: called from the quit path after every service is closed. */
export async function closeLogger(): Promise<void> {
  const logger = active
  active = null
  if (logger === null) return
  try {
    await logger.close()
  } catch {
    // Losing the last lines must never block quitting.
  }
}
