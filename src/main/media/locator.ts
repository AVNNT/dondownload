import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { compareYtdlpVersions, isYtdlpVersion } from '@shared/ytdlpVersion'

export type MediaToolName = 'ytdlp' | 'ffmpeg' | 'deno'

export type ToolLocationSource = 'explicit' | 'managed' | 'bundled' | 'path'

export interface LocateToolOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  cwd: string
  /**
   * Managed yt-dlp root: `<userData>/tools/yt-dlp`. Only version directories
   * written by the verified updater are considered. Other tools ignore it.
   */
  managedToolsDir?: string | null
  /** Override the version reported by the bundled vendor manifest. */
  bundledVersion?: string | null
}

export interface ToolLocation {
  path: string | null
  /** The explicit DONDOWNLOAD_*_PATH override was used. */
  explicit: boolean
  /** An explicit override was set but does not point to a file. */
  missingExplicit: boolean
  /** Where the resolved executable came from. */
  source?: ToolLocationSource
}

export interface ManagedToolVersion {
  version: string
  path: string
}

export async function isFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

function envValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  const direct = env[key]
  if (direct !== undefined) return direct
  if (platform !== 'win32') return undefined

  const target = key.toLowerCase()
  for (const entry of Object.keys(env)) {
    if (entry.toLowerCase() === target) return env[entry]
  }
  return undefined
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1')
}

function executableNames(
  tool: MediaToolName,
  platform: NodeJS.Platform
): string[] {
  const base =
    tool === 'ytdlp' ? 'yt-dlp' : tool === 'ffmpeg' ? 'ffmpeg' : 'deno'
  return platform === 'win32' ? [`${base}.exe`, base] : [base]
}

function vendorRoots(cwd: string): string[] {
  const roots: string[] = [path.join(cwd, 'vendor')]

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    const packagedRoot = path.join(resourcesPath, 'vendor')
    if (!roots.includes(packagedRoot)) roots.push(packagedRoot)
  }
  return roots
}

function vendorCandidates(
  tool: MediaToolName,
  platform: NodeJS.Platform,
  cwd: string
): string[] {
  const names = executableNames(tool, platform)
  const roots = vendorRoots(cwd)

  const candidates: string[] = []
  for (const root of roots) {
    if (tool === 'ytdlp') {
      for (const name of names) {
        candidates.push(path.join(root, 'yt-dlp', name))
        candidates.push(path.join(root, 'bin', name))
      }
    } else if (tool === 'ffmpeg') {
      for (const name of names) {
        candidates.push(path.join(root, 'ffmpeg', name))
        candidates.push(path.join(root, 'ffmpeg', 'bin', name))
        candidates.push(path.join(root, 'bin', name))
      }
    } else {
      for (const name of names) {
        candidates.push(path.join(root, 'deno', name))
        candidates.push(path.join(root, 'bin', name))
      }
    }
  }
  return candidates
}

function pathCandidates(
  tool: MediaToolName,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const rawPath = envValue(env, 'PATH', platform) ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const names = executableNames(tool, platform)
  const candidates: string[] = []

  for (const rawEntry of rawPath.split(delimiter)) {
    const entry = stripQuotes(rawEntry)
    if (entry.length === 0) continue
    for (const name of names) {
      candidates.push(path.join(entry, name))
    }
  }
  return candidates
}

/**
 * Read the version recorded by `scripts/stage-vendor.ps1` in the bundled
 * vendor manifest. Returns null for a development checkout without staged
 * vendor files (or any unreadable/malformed manifest).
 */
export async function readBundledYtdlpVersion(
  cwd: string
): Promise<string | null> {
  for (const root of vendorRoots(cwd)) {
    let raw: string
    try {
      raw = await fs.readFile(path.join(root, 'manifest.json'), 'utf8')
    } catch {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) continue
      const tools = (parsed as { tools?: unknown }).tools
      if (!Array.isArray(tools)) continue
      for (const tool of tools) {
        if (typeof tool !== 'object' || tool === null) continue
        const record = tool as Record<string, unknown>
        if (record.name !== 'yt-dlp') continue
        if (isYtdlpVersion(record.version)) return record.version
      }
    } catch {
      // Ignore a malformed manifest and try the next vendor root.
    }
  }
  return null
}

/**
 * Only direct child directories named exactly like a yt-dlp version, each
 * containing the platform executable, are considered managed versions. The
 * updater writes that final file with an atomic rename, so its presence means
 * the binary was verified after download.
 */
export async function listManagedYtdlpVersions(
  managedToolsDir: string,
  platform: NodeJS.Platform
): Promise<ManagedToolVersion[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(managedToolsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const names = executableNames('ytdlp', platform)
  const found: ManagedToolVersion[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isYtdlpVersion(entry.name)) continue
    for (const name of names) {
      const candidate = path.join(managedToolsDir, entry.name, name)
      if (await isFile(candidate)) {
        found.push({ version: entry.name, path: candidate })
        break
      }
    }
  }

  found.sort((left, right) =>
    compareYtdlpVersions(right.version, left.version)
  )
  return found
}

/**
 * Locate yt-dlp or FFmpeg without invoking a shell or downloading anything.
 * Precedence is: explicit environment override, managed yt-dlp version newer
 * than the bundled one, app/vendor locations, PATH.
 */
export async function locateMediaTool(
  tool: MediaToolName,
  options: LocateToolOptions
): Promise<ToolLocation> {
  const overrideKey =
    tool === 'ytdlp'
      ? 'DONDOWNLOAD_YTDLP_PATH'
      : tool === 'ffmpeg'
        ? 'DONDOWNLOAD_FFMPEG_PATH'
        : 'DONDOWNLOAD_DENO_PATH'
  const override = envValue(options.env, overrideKey, options.platform)

  if (override !== undefined && override.trim().length > 0) {
    const raw = stripQuotes(override)
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(options.cwd, raw)
    if (await isFile(resolved)) {
      return {
        path: resolved,
        explicit: true,
        missingExplicit: false,
        source: 'explicit'
      }
    }
    return { path: null, explicit: true, missingExplicit: true }
  }

  if (
    tool === 'ytdlp' &&
    typeof options.managedToolsDir === 'string' &&
    options.managedToolsDir.length > 0
  ) {
    const bundledVersion =
      options.bundledVersion === undefined
        ? await readBundledYtdlpVersion(options.cwd)
        : options.bundledVersion
    const managed = await listManagedYtdlpVersions(
      options.managedToolsDir,
      options.platform
    )
    for (const candidate of managed) {
      // A managed copy is only preferred while it is newer than the bundled
      // executable. A new app release with a newer bundled version therefore
      // wins over an older managed copy automatically.
      if (
        bundledVersion !== null &&
        !(compareYtdlpVersions(candidate.version, bundledVersion) > 0)
      ) {
        continue
      }
      return {
        path: candidate.path,
        explicit: false,
        missingExplicit: false,
        source: 'managed'
      }
    }
  }

  for (const candidate of vendorCandidates(tool, options.platform, options.cwd)) {
    if (await isFile(candidate)) {
      return {
        path: candidate,
        explicit: false,
        missingExplicit: false,
        source: 'bundled'
      }
    }
  }

  for (const candidate of pathCandidates(tool, options.platform, options.env)) {
    if (await isFile(candidate)) {
      return {
        path: candidate,
        explicit: false,
        missingExplicit: false,
        source: 'path'
      }
    }
  }

  return { path: null, explicit: false, missingExplicit: false }
}
