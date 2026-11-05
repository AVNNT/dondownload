import { createHash, randomBytes } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import {
  compareYtdlpVersions,
  isYtdlpVersion
} from '@shared/ytdlpVersion'
import {
  defaultMediaToolSettings,
  parseMediaToolSettings,
  parseMediaToolSettingsPatch,
  type MediaToolSettings,
  type YtdlpUpdateState
} from '@shared/mediaTools'
import { locateMediaTool } from './locator'
import {
  defaultMediaSpawn,
  runCapturedProcess
} from './process'

/**
 * Verified, app-managed yt-dlp updater.
 *
 * Security properties:
 * - Only `https://github.com`, `api.github.com`, `objects.githubusercontent.com`
 *   and `release-assets.githubusercontent.com` URLs are requested or followed.
 * - The executable must match the release's `SHA2-256SUMS` entry exactly and
 *   stay below the size cap before it is written as an executable.
 * - The downloaded file is run with `--version` and must print the expected
 *   release tag before it becomes visible to the locator.
 * - The bundled app resources are never written. Every managed file lives below
 *   `<userData>/tools/yt-dlp`, and an active media job never has its executable
 *   swapped underneath it.
 *
 * Network, filesystem, clock and process verification are injectable so unit
 * tests never touch the network or run a real binary.
 */

export const YTDLP_RELEASE_API =
  'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
export const YTDLP_ASSET_NAME = 'yt-dlp.exe'
export const YTDLP_SUMS_NAME = 'SHA2-256SUMS'
export const MAX_YTDLP_DOWNLOAD_BYTES = 50 * 1024 * 1024
export const MAX_YTDLP_SUMS_BYTES = 1024 * 1024
export const YTDLP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const YTDLP_EXTRACTOR_RETRY_AFTER_MS = 60 * 60 * 1000
export const YTDLP_VERSION_TIMEOUT_MS = 15_000

const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])

const MAX_REDIRECTS = 5

export interface UpdaterFs {
  mkdir(directory: string, options: { recursive: true }): Promise<void>
  writeFile(
    filePath: string,
    data: Uint8Array,
    options?: { mode?: number }
  ): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(
    target: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<void>
  readdir(directory: string): Promise<Dirent[]>
  stat(target: string): Promise<{ isFile(): boolean; size: number }>
}

export interface UpdaterHttpResponse {
  ok: boolean
  status: number
  url: string
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type UpdaterFetch = (
  url: string,
  init: {
    method?: string
    redirect: 'manual'
    headers: Record<string, string>
    signal?: AbortSignal
  }
) => Promise<UpdaterHttpResponse>

export interface MediaToolSettingsStore {
  loadMediaToolSettings(): MediaToolSettings
  saveMediaToolSettings(settings: MediaToolSettings): void
}

export interface YtdlpUpdaterOptions {
  userDataPath: string
  appVersion: string
  store?: MediaToolSettingsStore | null
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: string
  fetchImpl?: UpdaterFetch
  fs?: UpdaterFs
  now?: () => number
  /** True while any media analysis or download is running. */
  isJobActive?: () => boolean
  /** Runs `<path> --version` and returns its first line, or null on failure. */
  runVersion?: (binaryPath: string) => Promise<string | null>
  /** False in smoke/test modes so startup never performs network work. */
  autoUpdateAllowed?: boolean
  onStateChanged?: (state: YtdlpUpdateState) => void
}

export interface YtdlpUpdater {
  readonly toolsDir: string
  getSettings(): MediaToolSettings
  updateSettings(input: unknown): MediaToolSettings
  getState(): YtdlpUpdateState
  check(options?: { force?: boolean }): Promise<YtdlpUpdateState>
  autoCheck(): Promise<YtdlpUpdateState>
  /** Returns true when an extractor-style failure triggered a successful update. */
  notifyExtractorFailure(): Promise<boolean>
  /** Called after a media job settles so a deferred activation can apply. */
  onJobsChanged(): void
  close(): void
}

interface PendingInstall {
  version: string
  tempPath: string
  targetPath: string
}

interface LatestRelease {
  version: string
  exeUrl: string
  sumsUrl: string
}

class UpdateFailure extends Error {}

const defaultFs: UpdaterFs = {
  mkdir: async (directory, options) => {
    await fsPromises.mkdir(directory, options)
  },
  writeFile: (filePath, data, options) =>
    fsPromises.writeFile(filePath, data, options),
  rename: (from, to) => fsPromises.rename(from, to),
  rm: (target, options) => fsPromises.rm(target, options),
  readdir: (directory) => fsPromises.readdir(directory, { withFileTypes: true }),
  stat: (target) => fsPromises.stat(target)
}

const defaultFetch: UpdaterFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<UpdaterHttpResponse>

function fail(message: string): never {
  throw new UpdateFailure(message)
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof UpdateFailure) return error.message
  return 'The yt-dlp update could not be completed. Try again later.'
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

export function isAllowedGithubUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
}

export function parseSha256Sums(
  text: string,
  filename = YTDLP_ASSET_NAME
): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (match === null) continue
    const hash = match[1]
    const rawName = match[2]
    if (hash === undefined || rawName === undefined) continue
    const name = rawName.trim().replace(/^\.\//, '')
    if (name === filename) return hash.toLowerCase()
  }
  return null
}

function firstNonEmptyLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length > 0) {
      return line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100)
    }
  }
  return null
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data)
}

function parseLatestRelease(value: unknown): LatestRelease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('GitHub returned an unreadable yt-dlp release.')
  }
  const record = value as Record<string, unknown>
  if (!isYtdlpVersion(record.tag_name)) {
    fail('The latest yt-dlp release has an unsupported version tag.')
  }
  if (!Array.isArray(record.assets)) {
    fail('The latest yt-dlp release has no downloadable assets.')
  }

  let exeUrl: string | null = null
  let sumsUrl: string | null = null
  for (const asset of record.assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const entry = asset as Record<string, unknown>
    if (entry.name === YTDLP_ASSET_NAME && typeof entry.browser_download_url === 'string') {
      exeUrl = entry.browser_download_url
    } else if (
      entry.name === YTDLP_SUMS_NAME &&
      typeof entry.browser_download_url === 'string'
    ) {
      sumsUrl = entry.browser_download_url
    }
  }

  if (exeUrl === null || sumsUrl === null) {
    fail('The latest yt-dlp release is missing yt-dlp.exe or its checksum file.')
  }
  if (!isAllowedGithubUrl(exeUrl) || !isAllowedGithubUrl(sumsUrl)) {
    fail('The latest yt-dlp release points outside the approved GitHub hosts.')
  }

  return { version: record.tag_name, exeUrl, sumsUrl }
}

function defaultRunVersion(
  binaryPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string | null> {
  return (async () => {
    try {
      const result = await runCapturedProcess(
        binaryPath,
        ['--ignore-config', '--version'],
        {
          spawn: defaultMediaSpawn,
          platform,
          env,
          cwd,
          timeoutMs: YTDLP_VERSION_TIMEOUT_MS,
          maxOutputBytes: 64 * 1024
        }
      )
      if (result.code !== 0) return null
      return firstNonEmptyLine(result.stdout)
    } catch {
      return null
    }
  })()
}

/**
 * True for the errors YouTube changes usually produce when an installed
 * yt-dlp is too old to understand the current player. Raw output is never
 * forwarded to a caller.
 */
export function looksLikeExtractorFailure(text: string): boolean {
  return /(?:unable to extract|extraction failed|nsig extraction failed|signature extraction failed|failed to extract|no video formats found|player (?:response|js)|unable to download webpage|requested format is not available)/i.test(
    text
  )
}

export function createYtdlpUpdater(
  options: YtdlpUpdaterOptions
): YtdlpUpdater {
  const userDataPath = options.userDataPath
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const fs = options.fs ?? defaultFs
  const isJobActive = options.isJobActive ?? (() => false)
  const runVersion =
    options.runVersion ??
    ((binaryPath: string) =>
      defaultRunVersion(binaryPath, platform, env, cwd))
  const autoUpdateAllowed = options.autoUpdateAllowed ?? true
  const toolsDir = path.join(userDataPath, 'tools', 'yt-dlp')

  let settings: MediaToolSettings
  try {
    settings = options.store
      ? parseMediaToolSettings(options.store.loadMediaToolSettings())
      : defaultMediaToolSettings()
  } catch {
    settings = defaultMediaToolSettings()
  }

  let state: YtdlpUpdateState = {
    status: 'idle',
    currentVersion: null,
    latestVersion: null,
    message: null,
    lastCheckedAt: settings.lastYtdlpCheckAt
  }
  let pending: PendingInstall | null = null
  let inFlight: Promise<YtdlpUpdateState> | null = null
  let closed = false

  function publish(patch: Partial<YtdlpUpdateState>): YtdlpUpdateState {
    state = { ...state, ...patch }
    try {
      options.onStateChanged?.({ ...state })
    } catch {
      // A UI listener must never break the updater.
    }
    return { ...state }
  }

  function saveSettings(next: MediaToolSettings): void {
    settings = next
    if (!options.store) return
    try {
      options.store.saveMediaToolSettings(next)
    } catch {
      // Keep the in-memory value; a later check will try to persist again.
    }
  }

  function recordCheckTime(): void {
    saveSettings({ ...settings, lastYtdlpCheckAt: now() })
    publish({ lastCheckedAt: settings.lastYtdlpCheckAt })
  }

  async function request(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<UpdaterHttpResponse> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedGithubUrl(current)) {
        fail('The yt-dlp update redirected to an unapproved host.')
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      let response: UpdaterHttpResponse
      try {
        response = await fetchImpl(current, {
          redirect: 'manual',
          headers,
          signal: controller.signal
        })
      } catch {
        fail('GitHub could not be reached for the yt-dlp update.')
      } finally {
        clearTimeout(timer)
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location.length === 0) {
          fail('GitHub returned an incomplete yt-dlp download redirect.')
        }
        let next: string
        try {
          next = new URL(location, current).href
        } catch {
          fail('GitHub returned an invalid yt-dlp download redirect.')
        }
        if (!isAllowedGithubUrl(next)) {
          fail('The yt-dlp update redirected to an unapproved host.')
        }
        current = next
        continue
      }

      if (response.url && !isAllowedGithubUrl(response.url)) {
        fail('The yt-dlp update redirected to an unapproved host.')
      }
      return response
    }
    fail('The yt-dlp update redirected too many times.')
  }

  async function readBody(
    response: UpdaterHttpResponse,
    maximum: number
  ): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maximum) {
      fail('The downloaded yt-dlp file was larger than the safety limit.')
    }
    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch {
      fail('The yt-dlp download could not be read.')
    }
    const bytes = new Uint8Array(buffer)
    if (bytes.byteLength > maximum) {
      fail('The downloaded yt-dlp file was larger than the safety limit.')
    }
    return bytes
  }

  async function fetchLatestRelease(): Promise<LatestRelease> {
    const response = await request(
      YTDLP_RELEASE_API,
      {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DonDownload/${options.appVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      15_000
    )
    if (!response.ok) {
      fail(`GitHub returned HTTP ${response.status} for the yt-dlp release.`)
    }
    const raw = await readBody(response, 2 * 1024 * 1024)
    let parsed: unknown
    try {
      parsed = JSON.parse(decodeUtf8(raw))
    } catch {
      fail('GitHub returned an unreadable yt-dlp release.')
    }
    return parseLatestRelease(parsed)
  }

  async function download(
    url: string,
    maximum: number
  ): Promise<Uint8Array> {
    const response = await request(
      url,
      { 'User-Agent': `DonDownload/${options.appVersion}` },
      120_000
    )
    if (!response.ok) {
      fail(`GitHub returned HTTP ${response.status} for a yt-dlp asset.`)
    }
    return readBody(response, maximum)
  }

  async function resolveCurrent(): Promise<{
    version: string | null
    explicit: boolean
    managed: boolean
  }> {
    const location = await locateMediaTool('ytdlp', {
      env,
      platform,
      cwd,
      managedToolsDir: toolsDir
    })
    if (location.path === null) {
      return { version: null, explicit: location.explicit, managed: false }
    }

    const reported = await runVersion(location.path)
    if (reported !== null && isYtdlpVersion(reported)) {
      return {
        version: reported,
        explicit: location.explicit,
        managed: location.source === 'managed'
      }
    }

    // Fall back to the managed directory name or the bundled manifest version
    // when a binary cannot currently report its own version.
    if (location.source === 'managed') {
      const candidate = path.basename(path.dirname(location.path))
      if (isYtdlpVersion(candidate)) {
        return { version: candidate, explicit: false, managed: true }
      }
    }
    return {
      version: null,
      explicit: location.explicit,
      managed: location.source === 'managed'
    }
  }

  async function pruneVersions(): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(toolsDir)
    } catch {
      return
    }
    const versions = entries
      .filter((entry) => entry.isDirectory() && isYtdlpVersion(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => compareYtdlpVersions(right, left))

    for (const version of versions.slice(2)) {
      const candidate = path.join(toolsDir, version)
      if (!isInsideDirectory(toolsDir, candidate)) continue
      try {
        await fs.rm(candidate, { recursive: true, force: true })
      } catch {
        // Retention is best effort; the current file stays usable.
      }
    }
  }

  async function install(
    release: LatestRelease,
    expectedSha: string,
    binary: Uint8Array
  ): Promise<YtdlpUpdateState> {
    const versionDir = path.join(toolsDir, release.version)
    if (!isInsideDirectory(toolsDir, versionDir)) {
      fail('The yt-dlp update path was not inside the managed tools directory.')
    }
    const finalName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    const finalPath = path.join(versionDir, finalName)
    const tempName = `.yt-dlp-${randomBytes(8).toString('hex')}.tmp.exe`
    const tempPath = path.join(versionDir, tempName)

    await fs.mkdir(versionDir, { recursive: true })

    // Verify the checksum again immediately before writing. The in-memory
    // bytes came from the verified download; this keeps the invariant obvious
    // and makes an accidental future refactor fail closed.
    if (sha256(binary) !== expectedSha) {
      fail('The downloaded yt-dlp checksum did not match the published SHA-256 sums.')
    }

    try {
      await fs.writeFile(tempPath, binary, { mode: 0o700 })
      const reported = await runVersion(tempPath)
      if (reported !== release.version) {
        fail('The downloaded yt-dlp did not report the expected version.')
      }

      if (isJobActive()) {
        pending = {
          version: release.version,
          tempPath,
          targetPath: finalPath
        }
        return publish({
          status: 'deferred',
          latestVersion: release.version,
          message: `yt-dlp ${release.version} is ready and will be used by the next media job.`
        })
      }

      try {
        await fs.rm(finalPath, { force: true })
      } catch {
        // A missing destination is expected; a locked destination fails the
        // rename below and keeps the current binary untouched.
      }
      await fs.rename(tempPath, finalPath)
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }

    await pruneVersions()
    return publish({
      status: 'updated',
      currentVersion: release.version,
      latestVersion: release.version,
      message: `Updated to ${release.version}.`
    })
  }

  async function tryActivatePending(): Promise<boolean> {
    if (pending === null || isJobActive()) return false
    const ready = pending
    try {
      try {
        await fs.rm(ready.targetPath, { force: true })
      } catch {
        // Missing destination is fine.
      }
      await fs.rename(ready.tempPath, ready.targetPath)
      pending = null
      await pruneVersions()
      publish({
        status: 'updated',
        currentVersion: ready.version,
        latestVersion: ready.version,
        message: `Updated to ${ready.version}.`
      })
      return true
    } catch {
      // Keep the pending file for the next attempt.
      return false
    }
  }

  async function runCheck(force: boolean): Promise<YtdlpUpdateState> {
    if (closed) {
      return publish({
        status: 'disabled',
        message: 'The yt-dlp updater is shutting down.'
      })
    }

    if (await tryActivatePending()) return { ...state }

    const last = settings.lastYtdlpCheckAt
    if (
      !force &&
      last !== null &&
      now() - last < YTDLP_CHECK_INTERVAL_MS
    ) {
      return publish({
        status: 'throttled',
        message: 'yt-dlp was checked recently.'
      })
    }

    publish({ status: 'checking', message: null })
    recordCheckTime()

    try {
      const current = await resolveCurrent()
      publish({ currentVersion: current.version })
      if (current.explicit) {
        return publish({
          status: 'disabled',
          message:
            'A custom yt-dlp path is configured, so automatic updates are disabled.'
        })
      }

      const release = await fetchLatestRelease()
      publish({ latestVersion: release.version })

      if (
        current.version !== null &&
        compareYtdlpVersions(release.version, current.version) <= 0
      ) {
        return publish({
          status: 'up-to-date',
          message: 'Up to date.'
        })
      }

      publish({
        status: 'updating',
        message: `Downloading yt-dlp ${release.version}…`
      })

      const [binary, sums] = await Promise.all([
        download(release.exeUrl, MAX_YTDLP_DOWNLOAD_BYTES),
        download(release.sumsUrl, MAX_YTDLP_SUMS_BYTES)
      ])
      const expectedSha = parseSha256Sums(decodeUtf8(sums))
      if (expectedSha === null) {
        fail('The yt-dlp checksum file did not contain yt-dlp.exe.')
      }
      if (sha256(binary) !== expectedSha) {
        fail('The downloaded yt-dlp checksum did not match the published SHA-256 sums.')
      }

      return await install(release, expectedSha, binary)
    } catch (error) {
      return publish({
        status: 'failed',
        message: safeErrorMessage(error)
      })
    }
  }

  const updater: YtdlpUpdater = {
    toolsDir,

    getSettings(): MediaToolSettings {
      return { ...settings }
    },

    updateSettings(input: unknown): MediaToolSettings {
      const patch = parseMediaToolSettingsPatch(input)
      saveSettings({ ...settings, autoUpdateYtdlp: patch.autoUpdateYtdlp })
      return { ...settings }
    },

    getState(): YtdlpUpdateState {
      return { ...state }
    },

    check(optionsInput = {}): Promise<YtdlpUpdateState> {
      if (inFlight !== null) return inFlight
      const run = runCheck(optionsInput.force === true).finally(() => {
        if (inFlight === run) inFlight = null
      })
      inFlight = run
      return run
    },

    autoCheck(): Promise<YtdlpUpdateState> {
      if (!autoUpdateAllowed) {
        return Promise.resolve(
          publish({
            status: 'disabled',
            message: 'Automatic yt-dlp updates are disabled in this mode.'
          })
        )
      }
      if (!settings.autoUpdateYtdlp) {
        return Promise.resolve(
          publish({
            status: 'disabled',
            message: 'Automatic yt-dlp updates are turned off.'
          })
        )
      }
      return updater.check({ force: false })
    },

    async notifyExtractorFailure(): Promise<boolean> {
      const last = settings.lastYtdlpCheckAt
      if (
        last !== null &&
        now() - last < YTDLP_EXTRACTOR_RETRY_AFTER_MS
      ) {
        return false
      }
      const before = state.currentVersion
      const result = await updater.check({ force: true })
      return (
        result.status === 'updated' &&
        result.currentVersion !== null &&
        result.currentVersion !== before
      )
    },

    onJobsChanged(): void {
      if (pending === null || isJobActive()) return
      void tryActivatePending()
    },

    close(): void {
      closed = true
    }
  }
  return updater
}
