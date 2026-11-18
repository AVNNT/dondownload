import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import {
  errorLine,
  formatLogMessage,
  redact,
  type RedactOptions
} from './redact'

/**
 * Buffered, privacy-safe log files.
 *
 * Cost matters: the app already keeps a flat memory profile and a download can
 * progress hundreds of times a second, so nothing here touches the disk on the
 * hot path. `log()` only formats a string (when its level is enabled) and pushes
 * it onto an in-memory buffer. One timer — unref'd, so it never keeps the process
 * alive — writes at most once per `flushIntervalMs`, and only while there is
 * something to write. A full buffer forces an earlier flush instead of growing.
 *
 * Every line passes through `redact()` before it enters the buffer, so a URL, a
 * profile path or a cookie can never reach the file, even if a caller forgets.
 *
 * Rotation happens at write time: `main.log` grows towards `maxBytes`, is
 * renamed to `main.1.log` (shifting older generations up), and `main.log` starts
 * empty. `files` files are kept in total. A record is never split across files.
 * The file system is injected so the tests can drive a temporary directory.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
}

/** The small `fs` surface the writer uses; tests inject a fake or a temp dir. */
export interface LogFileSystem {
  mkdir(directory: string): Promise<void>
  append(file: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(file: string): Promise<void>
  stat(file: string): Promise<{ size: number }>
}

export function createNodeLogFileSystem(): LogFileSystem {
  return {
    async mkdir(directory) {
      await fsPromises.mkdir(directory, { recursive: true })
    },
    async append(file, data) {
      await fsPromises.appendFile(file, data, 'utf8')
    },
    async rename(from, to) {
      await fsPromises.rename(from, to)
    },
    async rm(file) {
      await fsPromises.rm(file, { force: true })
    },
    async stat(file) {
      const info = await fsPromises.stat(file)
      return { size: info.size }
    }
  }
}

export interface FileLoggerOptions {
  directory: string
  /** Base name without a numeric suffix, for example `main.log`. */
  fileName?: string
  /** Rotate when the active file would grow beyond this many bytes. */
  maxBytes?: number
  /** Total files kept, including the active one. */
  files?: number
  /** Minimum level written; `debug` only when explicitly enabled. */
  level?: LogLevel
  /** How often buffered lines are written to disk. */
  flushIntervalMs?: number
  /** Lines held in memory between flushes. */
  maxBufferedLines?: number
  redactOptions?: RedactOptions
  fileSystem?: LogFileSystem
  /** Wall-clock stamps for every record; injected in tests. */
  now?: () => Date
  /** Called with a redacted error line when a write fails. Never throws. */
  onWriteError?: (message: string) => void
}

export interface FileLogger {
  readonly directory: string
  /** Path of the active file. */
  readonly filePath: string
  level: LogLevel
  enabled(level: LogLevel): boolean
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  /** A `console.error`-compatible sink for existing callbacks. */
  errorSink(message: string): void
  /** Write everything buffered now; resolves after the write settles. */
  flush(): Promise<void>
  /** Stop the timer and flush the remaining lines. */
  close(): Promise<void>
  /** Recent already-redacted records, oldest first, for the diagnostics copy. */
  tail(maxLines: number): string[]
  /** Lines waiting for the next flush. */
  readonly bufferedLines: number
}

export const DEFAULT_LOG_FILE = 'main.log'
export const DEFAULT_LOG_MAX_BYTES = 1_000_000
export const DEFAULT_LOG_FILES = 3
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000
export const DEFAULT_MAX_BUFFERED_LINES = 500
/** A single record is capped so one huge error message cannot flood the file. */
export const MAX_LOG_LINE_CHARS = 2_048

function two(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** `2026-11-18T15:04:05.123Z` — UTC, so a pasted report is unambiguous. */
export function timestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}` +
    `T${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}` +
    `.${String(date.getUTCMilliseconds()).padStart(3, '0')}Z`
  )
}

/** `main.log` → `main.1.log`, `main.1.log` → `main.2.log`, … */
export function rotatedName(fileName: string, index: number): string {
  const extension = path.extname(fileName)
  const base = fileName.slice(0, fileName.length - extension.length)
  return `${base}.${index}${extension}`
}

/** Format one record for the file. Never throws. */
export function toLogLine(
  message: unknown,
  args: readonly unknown[],
  redactOptions: RedactOptions
): string {
  try {
    const text =
      args.length > 0
        ? formatLogMessage(String(message), args, redactOptions)
        : redact(String(message), redactOptions)
    return text.length > MAX_LOG_LINE_CHARS
      ? `${text.slice(0, MAX_LOG_LINE_CHARS)}…`
      : text
  } catch {
    return '[log entry could not be formatted]'
  }
}

/** Run an fs step whose target may legitimately be missing. */
async function attempt(step: Promise<unknown>): Promise<void> {
  try {
    await step
  } catch {
    // A missing generation (or a file the user removed) is not an error.
  }
}

export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const directory = options.directory
  const fileName = options.fileName ?? DEFAULT_LOG_FILE
  const maxBytes = Math.max(4_096, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES)
  const files = Math.max(1, Math.floor(options.files ?? DEFAULT_LOG_FILES))
  const flushIntervalMs = Math.max(
    100,
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  )
  const maxBufferedLines = Math.max(
    1,
    Math.floor(options.maxBufferedLines ?? DEFAULT_MAX_BUFFERED_LINES)
  )
  const redactOptions = options.redactOptions ?? {}
  const fs = options.fileSystem ?? createNodeLogFileSystem()
  const now = options.now ?? (() => new Date())
  const onWriteError = options.onWriteError ?? (() => undefined)
  const filePath = path.join(directory, fileName)

  let level: LogLevel = options.level ?? 'info'
  /** Redacted records waiting for the next flush. */
  let pending: string[] = []
  /** Every redacted record, for the diagnostics tail (bounded). */
  const recent: string[] = []
  /** Size of the active file in bytes, once known. */
  let size = 0
  let knownSize = false
  let directoryReady = false
  let timer: ReturnType<typeof setInterval> | null = null
  /** Serializes writes so two flushes never race on rotation. */
  let chain: Promise<void> = Promise.resolve()
  let closed = false

  function enabled(candidate: LogLevel): boolean {
    return LEVEL_WEIGHT[candidate] <= LEVEL_WEIGHT[level]
  }

  function push(candidate: LogLevel, line: string): void {
    if (!enabled(candidate) || closed) return
    const stamp = timestamp(now())
    const record = `${stamp} ${candidate.toUpperCase().padEnd(5)} ${line}`
    pending.push(record)
    recent.push(record)
    if (recent.length > 400) recent.splice(0, recent.length - 200)
    if (pending.length >= maxBufferedLines) {
      void flush()
      return
    }
    ensureTimer()
  }

  function ensureTimer(): void {
    if (timer !== null || closed) return
    timer = setInterval(() => {
      if (pending.length > 0) void flush()
    }, flushIntervalMs)
    // Logging must never be a reason for the process to stay alive.
    ;(timer as { unref?: () => void }).unref?.()
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  async function currentSize(): Promise<number> {
    if (knownSize) return size
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      size = 0
    }
    knownSize = true
    return size
  }

  async function rotate(): Promise<void> {
    // Drop the oldest generation, then shift every remaining index up by one.
    // A generation that does not exist yet is not an error, and on Windows a
    // missing file fails both rm and rename, so each step is best effort.
      await attempt(fs.rm(path.join(directory, rotatedName(fileName, files - 1))))
    for (let index = files - 2; index >= 1; index -= 1) {
      await attempt(
        fs.rename(
          path.join(directory, rotatedName(fileName, index)),
          path.join(directory, rotatedName(fileName, index + 1))
        )
      )
    }
    await attempt(
      fs.rename(filePath, path.join(directory, rotatedName(fileName, 1)))
    )
    size = 0
    knownSize = true
  }

  /** Append whole records, rotating between records so none is split. */
  async function writeAll(records: readonly string[]): Promise<void> {
    if (!directoryReady) {
      await fs.mkdir(directory)
      directoryReady = true
    }
    await currentSize()
    await currentSize()
    for (const record of records) {
      const recordBytes = Buffer.byteLength(record, 'utf8') + 1
      // Rotate between records, never inside one.
      if (size > 0 && size + recordBytes > maxBytes) {
        await rotate()
      }
      await fs.append(filePath, `${record}\n`)
      size += recordBytes
    }
  }

  async function drain(): Promise<void> {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    try {
      await writeAll(batch)
    } catch (error) {
      // A failed write must never take the app (or the caller) down. The
      // detail is the redacted error line: it may mention a path.
      onWriteError(errorLine(error))
    }
  }

  function flush(): Promise<void> {
    stopTimer()
    chain = chain.then(drain, drain)
    const done = chain
    // Restart the interval only while something is still buffered.
    void done.then(() => {
      if (!closed && pending.length > 0) ensureTimer()
    })
    return done
  }

  return {
    directory,
    filePath,
    get level() {
      return level
    },
    set level(next: LogLevel) {
      level = next
    },
    enabled,
    error(message: string, ...args: unknown[]) {
      push('error', toLogLine(message, args, redactOptions))
    },
    warn(message: string, ...args: unknown[]) {
      push('warn', toLogLine(message, args, redactOptions))
    },
    info(message: string, ...args: unknown[]) {
      push('info', toLogLine(message, args, redactOptions))
    },
    debug(message: string, ...args: unknown[]) {
      if (!enabled('debug')) return
      push('debug', toLogLine(message, args, redactOptions))
    },
    errorSink(message: string) {
      push('error', toLogLine(message, [], redactOptions))
    },
    flush,
    async close() {
      closed = true
      stopTimer()
      await flush()
    },
    tail(maxLines: number): string[] {
      const bounded = Math.max(0, Math.floor(maxLines))
      return recent.slice(-bounded)
    },
    get bufferedLines() {
      return pending.length
    }
  }
}
