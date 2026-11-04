import { promises as fs } from 'node:fs'
import path from 'node:path'

export type MediaToolName = 'ytdlp' | 'ffmpeg' | 'deno'

export interface LocateToolOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  cwd: string
}

export interface ToolLocation {
  path: string | null
  /** The explicit DONDOWNLOAD_*_PATH override was used. */
  explicit: boolean
  /** An explicit override was set but does not point to a file. */
  missingExplicit: boolean
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
  const base = tool === 'ytdlp' ? 'yt-dlp' : tool === 'ffmpeg' ? 'ffmpeg' : 'deno'
  return platform === 'win32' ? [`${base}.exe`, base] : [base]
}

function vendorCandidates(
  tool: MediaToolName,
  platform: NodeJS.Platform,
  cwd: string
): string[] {
  const names = executableNames(tool, platform)
  const roots: string[] = [path.join(cwd, 'vendor')]

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    roots.push(path.join(resourcesPath, 'vendor'))
  }

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
 * Locate yt-dlp or FFmpeg without invoking a shell or downloading anything.
 * Precedence is: explicit environment override, app/vendor locations, PATH.
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
      return { path: resolved, explicit: true, missingExplicit: false }
    }
    return { path: null, explicit: true, missingExplicit: true }
  }

  for (const candidate of vendorCandidates(tool, options.platform, options.cwd)) {
    if (await isFile(candidate)) {
      return { path: candidate, explicit: false, missingExplicit: false }
    }
  }

  for (const candidate of pathCandidates(tool, options.platform, options.env)) {
    if (await isFile(candidate)) {
      return { path: candidate, explicit: false, missingExplicit: false }
    }
  }

  return { path: null, explicit: false, missingExplicit: false }
}
