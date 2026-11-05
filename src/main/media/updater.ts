import { createHash, randomBytes } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
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
 * - The Windows asset is the official one-folder `yt-dlp_win.zip`, which starts
 *   far faster than the PyInstaller one-file executable because it does not
 *   self-extract on every launch. The archive must match the release's
 *   `SHA2-256SUMS` entry exactly and stay below the size cap before extraction.
 * - Archive entries are validated before anything is written: absolute paths,
 *   drive letters, `..` segments, symlinks and control characters are rejected,
 *   and the entry count and total extracted size are capped. The zip is never
 *   extracted in place; it is unpacked into a temporary sibling directory.
 * - The extracted `yt-dlp.exe` is run with `--version` and must print the
 *   expected release tag before the temporary directory is atomically renamed
 *   into place.
 * - The bundled app resources are never written. Every managed file lives below
 *   `<userData>/tools/yt-dlp`, and an active media job never has its executable
 *   swapped underneath it.
 * - An already-installed one-file managed `<version>/yt-dlp.exe` stays usable
 *   until a newer onedir version replaces it; the layout is self-describing, so
 *   the locator needs no migration step.
 *
 * Network, filesystem, clock and process verification are injectable so unit
 * tests never touch the network or run a real binary.
 */

export const YTDLP_RELEASE_API =
  'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
/** Official Windows one-folder archive: `yt-dlp.exe` plus `_internal/`. */
export const YTDLP_ASSET_NAME = 'yt-dlp_win.zip'
/** One-file Windows executable, kept for the pre-onedir compatibility path. */
export const YTDLP_LEGACY_ASSET_NAME = 'yt-dlp.exe'
export const YTDLP_SUMS_NAME = 'SHA2-256SUMS'
export const MAX_YTDLP_DOWNLOAD_BYTES = 100 * 1024 * 1024
export const MAX_YTDLP_SUMS_BYTES = 1024 * 1024
export const MAX_YTDLP_EXTRACTED_BYTES = 300 * 1024 * 1024
export const MAX_YTDLP_ARCHIVE_ENTRIES = 20_000
export const YTDLP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const YTDLP_EXTRACTOR_RETRY_AFTER_MS = 60 * 60 * 1000
export const YTDLP_VERSION_TIMEOUT_MS = 15_000
const ONEDIR_EXECUTABLE = 'yt-dlp.exe'
const ONEDIR_LIBRARY_DIRECTORY = '_internal'

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
  /** Windows: `yt-dlp_win.zip`; other platforms use the legacy one-file asset. */
  assetName: string
  assetUrl: string
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

/* ------------------------------------------------------------------------- *
 * Minimal, defensive ZIP reader.
 *
 * The updater only needs stored/deflated entries, so a small reader keeps the
 * security rules auditable and avoids adding a dependency to the packaged main
 * process. Every offset is bounds-checked before use.
 * ------------------------------------------------------------------------- */

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8
const ZIP_FLAG_ENCRYPTED = 1 << 0
const ZIP_FLAG_UTF8 = 1 << 11
const ZIP_UNIX_FILE_TYPE = 0xf000
const ZIP_UNIX_SYMLINK = 0xa000

export interface ZipLimits {
  maxEntries: number
  maxTotalBytes: number
  maxEntryBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: MAX_YTDLP_ARCHIVE_ENTRIES,
  maxTotalBytes: MAX_YTDLP_EXTRACTED_BYTES,
  maxEntryBytes: MAX_YTDLP_EXTRACTED_BYTES
}

export interface ExtractedArchiveEntry {
  /** Validated relative path using the host path separator. */
  relativePath: string
  data: Uint8Array
}

interface ZipCentralEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  crc32: number
  localOffset: number
  method: number
  flags: number
  externalAttributes: number
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function requireRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  what: string
): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    fail(`The yt-dlp archive is truncated (${what}).`)
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2, 'u16')
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4, 'u32')
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  )
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 22 - 0xffff)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(bytes, offset) === ZIP_EOCD_SIGNATURE) return offset
  }
  return -1
}

function decodeEntryName(nameBytes: Uint8Array, flags: number): string {
  const encoding = (flags & ZIP_FLAG_UTF8) !== 0 ? 'utf-8' : 'latin1'
  return new TextDecoder(encoding).decode(nameBytes)
}

function readCentralDirectory(bytes: Uint8Array): ZipCentralEntry[] {
  if (bytes.byteLength < 22) fail('The yt-dlp archive is empty.')
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) fail('The yt-dlp archive is not a ZIP file.')

  const entryCount = readU16(bytes, eocd + 10)
  const centralOffset = readU32(bytes, eocd + 16)
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    fail('The yt-dlp archive uses an unsupported ZIP64 layout.')
  }
  requireRange(bytes, centralOffset, 0, 'central directory')

  const entries: ZipCentralEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, offset) !== ZIP_CENTRAL_SIGNATURE) {
      fail('The yt-dlp archive has a corrupt central directory.')
    }
    const flags = readU16(bytes, offset + 8)
    const method = readU16(bytes, offset + 10)
    const crc = readU32(bytes, offset + 16)
    const compressedSize = readU32(bytes, offset + 20)
    const uncompressedSize = readU32(bytes, offset + 24)
    const nameLength = readU16(bytes, offset + 28)
    const extraLength = readU16(bytes, offset + 30)
    const commentLength = readU16(bytes, offset + 32)
    const externalAttributes = readU32(bytes, offset + 38)
    const localOffset = readU32(bytes, offset + 42)
    requireRange(bytes, offset + 46, nameLength, 'entry name')

    entries.push({
      name: decodeEntryName(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
        flags
      ),
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localOffset,
      method,
      flags,
      externalAttributes
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Validate one archive member name and map it onto a relative host path.
 * Returns null for anything that could escape the extraction directory.
 */
export function sanitizeZipEntryName(name: string): string | null {
  if (name.length === 0 || name.length > 4096) return null
  const unified = name.replace(/\\/g, '/')
  if (unified.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(unified)) return null
  if (/[\u0000-\u001f\u007f]/.test(unified)) return null

  const segments = unified.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  const relative = segments.join(path.sep)
  return path.isAbsolute(relative) ? null : relative
}

function readEntryData(
  archive: Uint8Array,
  entry: ZipCentralEntry
): Uint8Array {
  if (readU32(archive, entry.localOffset) !== ZIP_LOCAL_SIGNATURE) {
    fail('The yt-dlp archive has a corrupt local file header.')
  }
  if ((entry.flags & ZIP_FLAG_ENCRYPTED) !== 0) {
    fail('The yt-dlp archive contains an encrypted entry.')
  }
  const nameLength = readU16(archive, entry.localOffset + 26)
  const extraLength = readU16(archive, entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  requireRange(archive, dataStart, entry.compressedSize, 'entry data')

  const compressed = archive.subarray(dataStart, dataStart + entry.compressedSize)
  let data: Uint8Array
  if (entry.method === ZIP_METHOD_STORED) {
    data = compressed
  } else if (entry.method === ZIP_METHOD_DEFLATE) {
    try {
      // Cap the inflater at the declared size so a hostile archive cannot
      // expand far beyond the entry caps before the length check below.
      data = new Uint8Array(
        inflateRawSync(compressed, {
          maxOutputLength: Math.max(entry.uncompressedSize, 1)
        })
      )
    } catch {
      fail('The yt-dlp archive contains an unreadable compressed entry.')
    }
  } else {
    fail('The yt-dlp archive uses an unsupported compression method.')
  }

  if (data.byteLength !== entry.uncompressedSize) {
    fail('The yt-dlp archive entry size did not match its header.')
  }
  if (crc32(data) !== entry.crc32) {
    fail('The yt-dlp archive entry failed its CRC check.')
  }
  return data
}

/**
 * Read and validate every file member of a ZIP archive in memory. Directory
 * entries are skipped. Nothing is written to disk here.
 */
export function extractZipArchive(
  archive: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): ExtractedArchiveEntry[] {
  const central = readCentralDirectory(archive)
  if (central.length > limits.maxEntries) {
    fail('The yt-dlp archive contained too many entries.')
  }

  const files: ExtractedArchiveEntry[] = []
  let totalBytes = 0
  for (const entry of central) {
    const unixType = (entry.externalAttributes >>> 16) & ZIP_UNIX_FILE_TYPE
    if (unixType === ZIP_UNIX_SYMLINK) {
      fail('The yt-dlp archive contains a symbolic link.')
    }
    if (entry.name.endsWith('/') || entry.name.endsWith('\\')) continue

    if (entry.uncompressedSize > limits.maxEntryBytes) {
      fail('A yt-dlp archive entry exceeded the extraction size limit.')
    }
    totalBytes += entry.uncompressedSize
    if (totalBytes > limits.maxTotalBytes) {
      fail('The yt-dlp archive expanded beyond the extraction size limit.')
    }

    const relativePath = sanitizeZipEntryName(entry.name)
    if (relativePath === null) {
      fail('The yt-dlp archive contained an unsafe file path.')
    }
    files.push({ relativePath, data: readEntryData(archive, entry) })
  }

  if (files.length === 0) fail('The yt-dlp archive contained no files.')
  return files
}

function parseLatestRelease(
  value: unknown,
  platform: NodeJS.Platform
): LatestRelease {
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

  // The official Windows one-folder build is `yt-dlp_win.zip`. Other
  // platforms keep the legacy single-file asset name used before onedir.
  const assetName =
    platform === 'win32' ? YTDLP_ASSET_NAME : YTDLP_LEGACY_ASSET_NAME
  let assetUrl: string | null = null
  let sumsUrl: string | null = null
  for (const asset of record.assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const entry = asset as Record<string, unknown>
    if (entry.name === assetName && typeof entry.browser_download_url === 'string') {
      assetUrl = entry.browser_download_url
    } else if (
      entry.name === YTDLP_SUMS_NAME &&
      typeof entry.browser_download_url === 'string'
    ) {
      sumsUrl = entry.browser_download_url
    }
  }

  if (assetUrl === null || sumsUrl === null) {
    fail(`The latest yt-dlp release is missing ${assetName} or its checksum file.`)
  }
  if (!isAllowedGithubUrl(assetUrl) || !isAllowedGithubUrl(sumsUrl)) {
    fail('The latest yt-dlp release points outside the approved GitHub hosts.')
  }

  return { version: record.tag_name, assetName, assetUrl, sumsUrl }
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
    return parseLatestRelease(parsed, platform)
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
    // Remove extraction directories left behind by an interrupted install.
    // The in-memory pending install is never touched here: prune runs during
    // an install, before a pending directory can be registered.
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        /^\.yt-dlp-[0-9a-f]{16}\.tmp$/.test(entry.name)
      ) {
        const stale = path.join(toolsDir, entry.name)
        if (!isInsideDirectory(toolsDir, stale)) continue
        try {
          await fs.rm(stale, { recursive: true, force: true })
        } catch {
          // Best effort; a later check will try again.
        }
      }
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

  function deferredState(version: string): YtdlpUpdateState {
    return publish({
      status: 'deferred',
      latestVersion: version,
      message: `yt-dlp ${version} is ready and will be used by the next media job.`
    })
  }

  function updatedState(version: string): YtdlpUpdateState {
    return publish({
      status: 'updated',
      currentVersion: version,
      latestVersion: version,
      message: `Updated to ${version}.`
    })
  }

  /**
   * Windows: the official one-folder build. The archive was checksum-verified
   * before this call; entries are validated and written into a temporary
   * sibling directory, the executable is version-checked, then the whole
   * directory is renamed into `<toolsDir>/<version>` atomically.
   */
  async function installOnedir(
    release: LatestRelease,
    archive: Uint8Array
  ): Promise<YtdlpUpdateState> {
    const versionDir = path.join(toolsDir, release.version)
    if (!isInsideDirectory(toolsDir, versionDir)) {
      fail('The yt-dlp update path was not inside the managed tools directory.')
    }
    const tempDir = path.join(
      toolsDir,
      `.yt-dlp-${randomBytes(8).toString('hex')}.tmp`
    )
    await fs.mkdir(tempDir, { recursive: true })

    try {
      const entries = extractZipArchive(archive)
      const hasExecutable = entries.some(
        (entry) => entry.relativePath === ONEDIR_EXECUTABLE
      )
      const hasLibraryDirectory = entries.some((entry) =>
        entry.relativePath.startsWith(ONEDIR_LIBRARY_DIRECTORY + path.sep)
      )
      if (!hasExecutable || !hasLibraryDirectory) {
        fail('The yt-dlp archive did not contain the one-folder layout.')
      }

      for (const entry of entries) {
        const destination = path.resolve(tempDir, entry.relativePath)
        if (!isInsideDirectory(tempDir, destination)) {
          fail('The yt-dlp archive contained an unsafe file path.')
        }
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(
          destination,
          entry.data,
          entry.relativePath === ONEDIR_EXECUTABLE ? { mode: 0o700 } : undefined
        )
      }

      const tempExecutable = path.join(tempDir, ONEDIR_EXECUTABLE)
      const reported = await runVersion(tempExecutable)
      if (reported !== release.version) {
        fail('The downloaded yt-dlp did not report the expected version.')
      }

      if (isJobActive()) {
        pending = {
          version: release.version,
          tempPath: tempDir,
          targetPath: versionDir
        }
        return deferredState(release.version)
      }

      // A version directory must never be the one currently in use here: an
      // install only happens for a release newer than the resolved version,
      // and no media job is active. Removing a stale partial install is safe.
      await fs
        .rm(versionDir, { recursive: true, force: true })
        .catch(() => undefined)
      await fs.rename(tempDir, versionDir)
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    await pruneVersions()
    return updatedState(release.version)
  }

  /**
   * Non-Windows legacy path and back-compat install of the one-file binary.
   * The layout stays `<version>/yt-dlp`, exactly as before onedir support.
   */
  async function installOneFile(
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
        return deferredState(release.version)
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
    return updatedState(release.version)
  }

  async function tryActivatePending(): Promise<boolean> {
    if (pending === null || isJobActive()) return false
    const ready = pending
    try {
      try {
        await fs.rm(ready.targetPath, { recursive: true, force: true })
      } catch {
        // Missing destination is fine.
      }
      await fs.rename(ready.tempPath, ready.targetPath)
      pending = null
      await pruneVersions()
      updatedState(ready.version)
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

      // A verified install is already waiting for the active job to finish.
      // Do not download the same release again.
      if (pending !== null && pending.version === release.version) {
        return deferredState(release.version)
      }

      publish({
        status: 'updating',
        message: `Downloading yt-dlp ${release.version}…`
      })

      const [asset, sums] = await Promise.all([
        download(release.assetUrl, MAX_YTDLP_DOWNLOAD_BYTES),
        download(release.sumsUrl, MAX_YTDLP_SUMS_BYTES)
      ])
      const expectedSha = parseSha256Sums(decodeUtf8(sums), release.assetName)
      if (expectedSha === null) {
        fail(`The yt-dlp checksum file did not contain ${release.assetName}.`)
      }
      if (sha256(asset) !== expectedSha) {
        fail('The downloaded yt-dlp checksum did not match the published SHA-256 sums.')
      }

      if (platform === 'win32') {
        return await installOnedir(release, asset)
      }
      return await installOneFile(release, expectedSha, asset)
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
