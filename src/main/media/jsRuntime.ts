/**
 * On-demand Deno runtime for yt-dlp's YouTube JavaScript challenges.
 *
 * yt-dlp only needs a JavaScript runtime for YouTube's JS challenges, so Deno is
 * not bundled in the installer. The first time a YouTube analysis or download
 * actually needs one, the pinned release archive is downloaded into
 * `<userData>/tools/deno/<version>/deno.exe`, its SHA-256 is verified against the
 * checksum published in the same pinned release, and the executable is written
 * through a temporary directory and an atomic directory rename.
 *
 * Everything here is best effort: a failed download, an unverifiable archive or
 * an unwritable userData directory all resolve to `null`, and yt-dlp then runs
 * exactly as it would on a machine without a JavaScript runtime.
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { locateMediaTool } from './locator'
import { extractZipArchive } from './updater'
import type { UpdaterFetch, UpdaterHttpResponse, ZipLimits } from './updater'

export const DENO_PINNED_VERSION = '2.9.8'
export const DENO_ARCHIVE_URL =
  `https://github.com/denoland/deno/releases/download/v${DENO_PINNED_VERSION}/` +
  'deno-x86_64-pc-windows-msvc.zip'
/** Published next to the archive in the same pinned release. */
export const DENO_CHECKSUM_URL = `${DENO_ARCHIVE_URL}.sha256sum`
/**
 * Optional hard pin for the exact archive bytes. When null the SHA-256 is taken
 * from the pinned release's own `.sha256sum` asset and must still match.
 */
export const DENO_ARCHIVE_SHA256: string | null = null
export const MAX_DENO_ARCHIVE_BYTES = 160 * 1024 * 1024
export const MAX_DENO_CHECKSUM_BYTES = 4 * 1024
export const DENO_DOWNLOAD_TIMEOUT_MS = 180_000
/** Do not retry a failed download on every analysis; wait before trying again. */
export const DENO_RETRY_AFTER_MS = 30 * 60 * 1000

const DENO_EXECUTABLE = 'deno.exe'
const MAX_REDIRECTS = 5
const DENO_ZIP_LIMITS: ZipLimits = {
  maxEntries: 32,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024
}
const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])
const STALE_TEMP_DIRECTORY = /^\.deno-[0-9a-f]{16}\.tmp$/

export interface JsRuntimeFsEntry {
  name: string
  isDirectory(): boolean
}

export interface JsRuntimeFs {
  mkdir(directory: string, options: { recursive: true }): Promise<void>
  writeFile(
    filePath: string,
    data: Uint8Array,
    options?: { mode?: number }
  ): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(target: string, options: { recursive?: boolean; force?: boolean }): Promise<void>
  stat(target: string): Promise<{ isFile(): boolean }>
  readdir(directory: string): Promise<JsRuntimeFsEntry[]>
}

export interface JsRuntimeOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  cwd: string
  /** Per-user app data dir the verified runtime is installed into. */
  userDataPath: string | null
  fetchImpl?: UpdaterFetch
  fs?: JsRuntimeFs
  now?: () => number
}

export interface JsRuntime {
  /** An already installed Deno. Never touches the network. */
  locate(): Promise<string | null>
  /** Locate, or download the pinned build once. Never throws; null on failure. */
  ensure(): Promise<string | null>
}

/**
 * True only for the YouTube origins whose extraction needs a JavaScript
 * runtime. Any other site keeps working without one, so nothing is downloaded.
 */
export function needsJsRuntime(targetUrl: string): boolean {
  let host: string
  try {
    host = new URL(targetUrl).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  return (
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  )
}

const defaultFs: JsRuntimeFs = {
  mkdir: async (directory, options) => {
    await fsPromises.mkdir(directory, options)
  },
  writeFile: (filePath, data, options) =>
    fsPromises.writeFile(filePath, data, options),
  rename: (from, to) => fsPromises.rename(from, to),
  rm: (target, options) => fsPromises.rm(target, options),
  stat: (target) => fsPromises.stat(target),
  readdir: (directory) => fsPromises.readdir(directory, { withFileTypes: true })
}

const defaultFetch: UpdaterFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<UpdaterHttpResponse>

class JsRuntimeFailure extends Error {}

function isAllowedDenoUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
  )
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

export function createJsRuntime(options: JsRuntimeOptions): JsRuntime {
  const { env, platform, cwd, userDataPath } = options
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const fs = options.fs ?? defaultFs
  const now = options.now ?? Date.now

  const toolsDir =
    userDataPath === null || userDataPath.length === 0
      ? null
      : path.join(userDataPath, 'tools', 'deno')
  const versionDir =
    toolsDir === null ? null : path.join(toolsDir, DENO_PINNED_VERSION)
  const managedExecutable =
    versionDir === null ? null : path.join(versionDir, DENO_EXECUTABLE)

  let cachedPath: string | null = null
  let lastFailureAt: number | null = null
  let inFlight: Promise<string | null> | null = null

  async function isFile(candidate: string): Promise<boolean> {
    try {
      return (await fs.stat(candidate)).isFile()
    } catch {
      return false
    }
  }

  async function locate(): Promise<string | null> {
    if (cachedPath !== null && (await isFile(cachedPath))) return cachedPath
    if (managedExecutable !== null && (await isFile(managedExecutable))) {
      cachedPath = managedExecutable
      return managedExecutable
    }
    const located = await locateMediaTool('deno', { env, platform, cwd })
    if (located.path !== null) {
      cachedPath = located.path
      return located.path
    }
    return null
  }

  async function request(
    url: string,
    timeoutMs: number
  ): Promise<UpdaterHttpResponse> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedDenoUrl(current)) {
        throw new JsRuntimeFailure('The Deno download used an unapproved host.')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      let response: UpdaterHttpResponse
      try {
        response = await fetchImpl(current, {
          redirect: 'manual',
          headers: { 'User-Agent': 'DonDownload' },
          signal: controller.signal
        })
      } catch {
        throw new JsRuntimeFailure('GitHub could not be reached for Deno.')
      } finally {
        clearTimeout(timer)
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location.length === 0) {
          throw new JsRuntimeFailure('The Deno download redirect was incomplete.')
        }
        let next: string
        try {
          next = new URL(location, current).href
        } catch {
          throw new JsRuntimeFailure('The Deno download redirect was invalid.')
        }
        current = next
        continue
      }

      if (response.url.length > 0 && !isAllowedDenoUrl(response.url)) {
        throw new JsRuntimeFailure('The Deno download used an unapproved host.')
      }
      return response
    }
    throw new JsRuntimeFailure('The Deno download redirected too many times.')
  }

  async function readBody(
    response: UpdaterHttpResponse,
    maximum: number
  ): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maximum) {
      throw new JsRuntimeFailure('The Deno download was larger than the limit.')
    }
    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch {
      throw new JsRuntimeFailure('The Deno download could not be read.')
    }
    const bytes = new Uint8Array(buffer)
    if (bytes.byteLength > maximum) {
      throw new JsRuntimeFailure('The Deno download was larger than the limit.')
    }
    return bytes
  }

  async function fetchExpectedSha256(): Promise<string> {
    const response = await request(DENO_CHECKSUM_URL, 15_000)
    if (!response.ok) {
      throw new JsRuntimeFailure('GitHub did not return the Deno checksum.')
    }
    const text = decodeUtf8(
      await readBody(response, MAX_DENO_CHECKSUM_BYTES)
    ).trim()
    const token = text.split(/\s+/)[0] ?? ''
    if (!/^[0-9a-f]{64}$/i.test(token)) {
      throw new JsRuntimeFailure('The Deno checksum was malformed.')
    }
    return token.toLowerCase()
  }

  async function removeStaleTemps(directory: string): Promise<void> {
    let entries: JsRuntimeFsEntry[]
    try {
      entries = await fs.readdir(directory)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !STALE_TEMP_DIRECTORY.test(entry.name)) {
        continue
      }
      const stale = path.join(directory, entry.name)
      if (!isInsideDirectory(directory, stale)) continue
      await fs.rm(stale, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function install(): Promise<string | null> {
    if (toolsDir === null || versionDir === null || managedExecutable === null) {
      return null
    }
    // Only the Windows release archive is pinned, and it is the only platform
    // this app ships for.
    if (platform !== 'win32') return null
    if (!isInsideDirectory(toolsDir, versionDir)) return null

    const expected = DENO_ARCHIVE_SHA256 ?? (await fetchExpectedSha256())
    const response = await request(DENO_ARCHIVE_URL, DENO_DOWNLOAD_TIMEOUT_MS)
    if (!response.ok) {
      throw new JsRuntimeFailure('GitHub did not return the Deno archive.')
    }
    const archive = await readBody(response, MAX_DENO_ARCHIVE_BYTES)
    if (sha256Hex(archive) !== expected.toLowerCase()) {
      throw new JsRuntimeFailure('The Deno archive checksum did not match.')
    }

    const entries = extractZipArchive(archive, DENO_ZIP_LIMITS)
    const executable = entries.find(
      (entry) => entry.relativePath === DENO_EXECUTABLE
    )
    if (executable === undefined) {
      throw new JsRuntimeFailure('The Deno archive had no deno.exe.')
    }

    await fs.mkdir(toolsDir, { recursive: true })
    await removeStaleTemps(toolsDir)
    const tempDir = path.join(
      toolsDir,
      `.deno-${randomBytes(8).toString('hex')}.tmp`
    )
    await fs.mkdir(tempDir, { recursive: true })
    try {
      const staged = path.join(tempDir, DENO_EXECUTABLE)
      if (!isInsideDirectory(tempDir, staged)) return null
      await fs.writeFile(staged, executable.data, { mode: 0o755 })
      if (await isFile(managedExecutable)) {
        // Another run finished first; keep its verified copy.
        return managedExecutable
      }
      // A directory rename is atomic on the same volume, so a half-written
      // runtime is never visible under the version directory.
      await fs.rename(tempDir, versionDir)
    } finally {
      await fs
        .rm(tempDir, { recursive: true, force: true })
        .catch(() => undefined)
    }

    return (await isFile(managedExecutable)) ? managedExecutable : null
  }

  async function ensure(): Promise<string | null> {
    const installed = await locate()
    if (installed !== null) return installed
    if (inFlight !== null) return inFlight
    if (lastFailureAt !== null && now() - lastFailureAt < DENO_RETRY_AFTER_MS) {
      return null
    }

    const task = install()
      .then((installedPath) => {
        if (installedPath !== null) {
          cachedPath = installedPath
          lastFailureAt = null
        } else {
          lastFailureAt = now()
        }
        return installedPath
      })
      .catch(() => {
        lastFailureAt = now()
        return null
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = task
    return task
  }

  return { locate, ensure }
}
