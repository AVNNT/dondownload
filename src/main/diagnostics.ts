import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type { AppUpdateState } from '@shared/appUpdate'
import type { YtdlpUpdateState } from '@shared/mediaTools'
import { redact, type RedactOptions } from './logging/redact'

/**
 * The text behind Settings → Help & diagnostics → Copy diagnostics.
 *
 * It is assembled only from renderer-safe values and already-redacted log
 * records, so a pasted report never contains a download URL, a file name or a
 * path: no history, no settings that name a folder, no tool paths. Every field
 * is optional, so a partially started app still produces something useful.
 */

export const BUG_REPORT_URL =
  'https://github.com/AVNNT/dondownload/issues/new?template=bug_report.yml'

/** How many log records the copy includes. */
export const DIAGNOSTICS_LOG_LINES = 100

export interface DiagnosticsInput {
  appVersion: string
  /** `Windows 11 Pro 10.0.22631` from `os.version()`/`os.release()`. */
  windowsVersion: string
  windowsBuild: string
  arch: string
  packaged: boolean
  /** Electron, Chrome and Node versions as reported by `process.versions`. */
  runtime: { electron: string; chrome: string; node: string }
  /** `aria2`/`yt-dlp`/`ffmpeg` versions from the app's own detection. */
  tools: {
    aria2: { version: string | null; status: string }
    media: { version: string | null; status: string }
  }
  ytdlpUpdate?: YtdlpUpdateState | null
  appUpdate?: AppUpdateState | null
  extension?: BrowserExtensionStatus | null
  /** Only non-personal values: counts and the theme name. */
  downloadSettings: {
    maxConcurrentDownloads: number
    perHostConnections: number
    theme: string
  }
  desktopSettings: {
    exitToTrayStubWhenIdle: boolean
    watchClipboard: boolean
  }
  dbSchemaVersion: number | null
  /** Debug logging on/off (`DONDOWNLOAD_DEBUG_LOG=1`). */
  debugLogging: boolean
  /** Recent log records, already redacted by the writer. */
  logLines: readonly string[]
  /** Redaction rules applied once more to every log line, as a backstop. */
  redactOptions?: RedactOptions
}

function yesNo(value: boolean): string {
  return value ? 'on' : 'off'
}

function extensionLine(status: BrowserExtensionStatus | null | undefined): string {
  if (!status) return 'not available'
  const parts = status.browsers.map(
    (browser) => `${browser.browser}: ${browser.registered ? 'connected' : 'not connected'}`
  )
  const error = status.lastError ? ` (last error: ${status.lastError})` : ''
  return `${status.registered ? 'registered' : 'incomplete'}; ${parts.join(', ')}${error}`
}

function versionLine(version: string | null, status: string): string {
  return version === null ? `not available (${status})` : `${version} (${status})`
}

function timeLine(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'never'
  return new Date(value).toISOString()
}

/**
 * Render the diagnostics block. Perspective: the app's own facts first, then
 * the redacted log tail, so a maintainer can read it top to bottom.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const appUpdate = input.appUpdate ?? null
  const ytdlpUpdate = input.ytdlpUpdate ?? null
  // The writer already redacted every record. Redacting again here is a cheap
  // backstop: a line that somehow reached the buffer unredacted still cannot
  // carry a URL, a file name or a profile path into a pasted report.
  const logTail = input.logLines
    .slice(-DIAGNOSTICS_LOG_LINES)
    .map((line) => redact(line, input.redactOptions))
  const lines: string[] = [
    'DonDownload diagnostics',
    `App version: ${input.appVersion}`,
    `Windows: ${input.windowsVersion} (build ${input.windowsBuild}, ${input.arch})`,
    `Packaged build: ${input.packaged ? 'yes' : 'no (development)'}`,
    `Runtime: Electron ${input.runtime.electron}, Chromium ${input.runtime.chrome}, Node ${input.runtime.node}`,
    `aria2: ${versionLine(input.tools.aria2.version, input.tools.aria2.status)}`,
    `Media tools: ${versionLine(input.tools.media.version, input.tools.media.status)}`,
    `yt-dlp update: ${ytdlpUpdate?.status ?? 'unknown'}${ytdlpUpdate?.currentVersion ? ` (${ytdlpUpdate.currentVersion})` : ''}; last check ${timeLine(ytdlpUpdate?.lastCheckedAt)}`,
    `App update: ${appUpdate?.status ?? 'unknown'}; auto-check ${yesNo(appUpdate?.autoCheck ?? false)}; last check ${timeLine(appUpdate?.lastCheckedAt)}`,
    `Browser extension: ${extensionLine(input.extension)}`,
    `Settings: parallel downloads ${input.downloadSettings.maxConcurrentDownloads}, connections per server ${input.downloadSettings.perHostConnections}, theme ${input.downloadSettings.theme}`,
    `Idle tray hand-off: ${yesNo(input.desktopSettings.exitToTrayStubWhenIdle)}` +
    `; clipboard watching ${yesNo(input.desktopSettings.watchClipboard)}`,
    `History database schema: ${input.dbSchemaVersion ?? 'unavailable'}`,
    `Debug logging: ${yesNo(input.debugLogging)}`,
    '',
    `Recent log (last ${logTail.length} of ${input.logLines.length} lines, already redacted):`,
    ...(logTail.length === 0 ? ['(no log lines yet)'] : logTail)
  ]
  return lines.join('\n')
}
