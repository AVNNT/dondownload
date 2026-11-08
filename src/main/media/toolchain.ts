/**
 * Tool discovery and version reporting for the media engine. Probing never
 * downloads anything and is cached per yt-dlp path and version so the verified
 * updater can swap the executable safely.
 */
import type { MediaToolState } from '@shared/media'
import {
  FFMPEG_HINT,
  YTDLP_HINT,
  ffmpegVersion,
  firstLineVersion
} from './analysis'
import { locateMediaTool } from './locator'
import type { CapturedProcessResult } from './process'

const TOOL_PROBE_TIMEOUT_MS = 5_000

export interface Toolchain {
  state: MediaToolState
  ytdlpPath: string | null
  ffmpegPath: string | null
  /**
   * Deno for yt-dlp's YouTube JS challenges. Optional: it is located when it is
   * already installed and downloaded on demand by the JS runtime manager, so a
   * missing runtime only means yt-dlp runs without `--js-runtimes`.
   */
  denoPath: string | null
  /** True only when the active yt-dlp build lists a Chrome impersonate target. */
  impersonate: boolean
}

export interface ToolchainResolverOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  cwd: string
  managedToolsDir: string | null
  /** Locates an installed Deno without downloading anything. */
  jsRuntime?: { locate(): Promise<string | null> } | null
  runCaptured: (
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ) => Promise<CapturedProcessResult>
}

export interface ToolchainResolver {
  resolveToolchain(): Promise<Toolchain>
}

export function createToolchainResolver(
  options: ToolchainResolverOptions
): ToolchainResolver {
  const { env, platform, cwd, managedToolsDir, runCaptured } = options
  const jsRuntime = options.jsRuntime ?? null
  // Impersonation support is probed once per yt-dlp path *and* version: the
  // verified updater may swap the executable, and an older build does not know
  // `--list-impersonate-targets` at all.
  const impersonationSupport = new Map<string, boolean>()

  async function probeTool(
    command: string,
    args: string[],
    versionParser: (output: string) => string | null
  ): Promise<{ ok: boolean; version: string | null }> {
    try {
      const result = await runCaptured(command, args, {
        timeoutMs: TOOL_PROBE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024
      })
      if (result.code !== 0) return { ok: false, version: null }
      return { ok: true, version: versionParser(result.stdout) }
    } catch {
      return { ok: false, version: null }
    }
  }

  async function probeImpersonation(
    ytdlpPath: string,
    version: string | null
  ): Promise<boolean> {
    const key = `${ytdlpPath}\u0000${version ?? ''}`
    const cached = impersonationSupport.get(key)
    if (cached !== undefined) return cached

    let supported: boolean
    try {
      const result = await runCaptured(
        ytdlpPath,
        ['--ignore-config', '--list-impersonate-targets'],
        { timeoutMs: TOOL_PROBE_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
      )
      supported =
        result.code === 0 && /^\s*Chrome(?:-|\s)/im.test(result.stdout)
    } catch {
      supported = false
    }
    impersonationSupport.set(key, supported)
    return supported
  }

  async function resolveToolchain(): Promise<Toolchain> {
    const locationOptions = { env, platform, cwd, managedToolsDir }
    const ytdlp = await locateMediaTool('ytdlp', locationOptions)
    if (ytdlp.path === null) {
      const message = ytdlp.missingExplicit
        ? 'The configured yt-dlp path does not exist.'
        : 'yt-dlp was not found on this computer.'
      return {
        state: {
          status: 'unavailable',
          version: null,
          message,
          hint: YTDLP_HINT
        },
        ytdlpPath: null,
        ffmpegPath: null,
        denoPath: null,
        impersonate: false
      }
    }

    const ytdlpProbe = await probeTool(
      ytdlp.path,
      ['--ignore-config', '--version'],
      firstLineVersion
    )
    if (!ytdlpProbe.ok) {
      return {
        state: {
          status: 'error',
          version: null,
          message: 'yt-dlp was found but could not be started.',
          hint: YTDLP_HINT
        },
        ytdlpPath: null,
        ffmpegPath: null,
        denoPath: null,
        impersonate: false
      }
    }

    const impersonate = await probeImpersonation(
      ytdlp.path,
      ytdlpProbe.version
    )
    const ffmpeg = await locateMediaTool('ffmpeg', locationOptions)
    let denoPath: string | null = null
    if (jsRuntime !== null) {
      try {
        denoPath = await jsRuntime.locate()
      } catch {
        denoPath = null
      }
    }
    let ffmpegPath: string | null = null
    let ffmpegVersionValue: string | null = null
    let ffmpegProblem: string | null = null

    if (ffmpeg.path === null) {
      ffmpegProblem = ffmpeg.missingExplicit
        ? 'The configured FFmpeg path does not exist; merged video and audio formats are unavailable.'
        : 'FFmpeg was not found; merged video and audio formats are unavailable.'
    } else {
      const ffmpegProbe = await probeTool(
        ffmpeg.path,
        ['-version'],
        ffmpegVersion
      )
      if (ffmpegProbe.ok) {
        ffmpegPath = ffmpeg.path
        ffmpegVersionValue = ffmpegProbe.version
      } else {
        ffmpegProblem =
          'FFmpeg was found but could not be started; merged video and audio formats are unavailable.'
      }
    }

    const version = ffmpegVersionValue
      ? `yt-dlp ${ytdlpProbe.version ?? 'unknown'}; ffmpeg ${ffmpegVersionValue}`.slice(
          0,
          100
        )
      : `yt-dlp ${ytdlpProbe.version ?? 'unknown'}`.slice(0, 100)

    return {
      state: {
        status: 'ready',
        version,
        message: ffmpegProblem,
        hint: ffmpegProblem === null ? null : FFMPEG_HINT
      },
      ytdlpPath: ytdlp.path,
      ffmpegPath,
      denoPath,
      impersonate
    }
  }

  return { resolveToolchain }
}
