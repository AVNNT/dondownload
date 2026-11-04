import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMediaEngine } from '../src/main/media/engine'
import type {
  MediaDownloadProgress,
  MediaLookup,
  MediaLookupAddress
} from '../src/main/media/engine'
import type { MediaSpawn, MediaSpawnOptions } from '../src/main/media/process'
import { PROGRESS_TEMPLATE, parseProgressLine } from '../src/main/media/args'
import { parseMediaAnalysis } from '../src/shared/media'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  closed = false

  constructor(readonly pid: number) {
    super()
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true
    return true
  }

  close(code: number): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, code === 0 ? null : 'SIGTERM')
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: MediaSpawnOptions
  child: FakeChild
}

interface HarnessOptions {
  toolMode?: 'explicit' | 'path' | 'vendor' | 'missing'
  withFfmpeg?: boolean
  ytdlpProbeOk?: boolean
  ffmpegProbeOk?: boolean
  analyzeJson?: unknown
  analyzeCode?: number
  analyzeStdout?: string
  lookup?: MediaLookup
  now?: () => number
  analysisTtlMs?: number
  cancellationGraceMs?: number
  download?: (
    call: SpawnCall,
    context: { base: string; outputDir: string }
  ) => void
  defaultOutputExt?: string
}

const tempDirectories: string[] = []
const JOB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SOURCE_URL = 'https://example.com/watch?v=1'

function sampleInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Example video',
    duration: 120,
    formats: [
      {
        format_id: '137',
        ext: 'mp4',
        vcodec: 'avc1.640028',
        acodec: 'none',
        width: 1920,
        height: 1080,
        fps: 30,
        filesize: 1_000,
        tbr: 4_000
      },
      {
        format_id: '140',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 192,
        filesize: 500,
        tbr: 192
      },
      {
        format_id: '22',
        ext: 'mp4',
        vcodec: 'avc1.64001F',
        acodec: 'mp4a.40.2',
        width: 1280,
        height: 720,
        fps: 30,
        filesize: 800,
        tbr: 1_000
      },
      {
        format_id: '251',
        ext: 'webm',
        vcodec: 'none',
        acodec: 'opus',
        abr: 160,
        filesize: 600,
        tbr: 160
      }
    ],
    ...overrides
  }
}

function publicLookup(): MediaLookup {
  return vi.fn(async () => [
    { address: '93.184.216.34', family: 4 }
  ]) as unknown as MediaLookup
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function outputBase(call: SpawnCall): string {
  const template = argValue(call.args, '--output')
  if (!template) throw new Error('missing --output')
  return template.replace(/\.%\(ext\)s$/, '')
}

function downloadOutputExt(call: SpawnCall, fallback = 'mp4'): string {
  return argValue(call.args, '--merge-output-format') ?? fallback
}

async function makeHarness(options: HarnessOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondl-media-engine-'))
  tempDirectories.push(root)
  const toolsDir = path.join(root, 'tools')
  const downloadDir = path.join(root, 'downloads')
  await fs.mkdir(toolsDir, { recursive: true })
  await fs.mkdir(downloadDir, { recursive: true })

  const toolMode = options.toolMode ?? 'explicit'
  const withFfmpeg = options.withFfmpeg ?? true
  const ytdlpFile =
    toolMode === 'vendor'
      ? path.join(root, 'vendor', 'yt-dlp', 'yt-dlp.exe')
      : path.join(toolsDir, 'yt-dlp.exe')
  const ffmpegFile =
    toolMode === 'vendor'
      ? path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe')
      : path.join(toolsDir, 'ffmpeg.exe')

  if (toolMode !== 'missing') {
    await fs.mkdir(path.dirname(ytdlpFile), { recursive: true })
    await fs.writeFile(ytdlpFile, 'fake yt-dlp')
    if (withFfmpeg) {
      await fs.mkdir(path.dirname(ffmpegFile), { recursive: true })
      await fs.writeFile(ffmpegFile, 'fake ffmpeg')
    }
  }

  const env: NodeJS.ProcessEnv = { PATH: '' }
  if (toolMode === 'explicit' || toolMode === 'missing') {
    env.DONDOWNLOAD_YTDLP_PATH =
      toolMode === 'missing'
        ? path.join(root, 'missing', 'yt-dlp.exe')
        : ytdlpFile
    if (withFfmpeg && toolMode === 'explicit') {
      env.DONDOWNLOAD_FFMPEG_PATH = ffmpegFile
    }
  } else if (toolMode === 'path') {
    env.PATH = toolsDir
  }

  const calls: SpawnCall[] = []
  let nextPid = 4_000
  const spawn: MediaSpawn = (command, args, spawnOptions) => {
    const child = new FakeChild((nextPid += 1))
    const call: SpawnCall = {
      command,
      args: [...args],
      options: spawnOptions,
      child
    }
    calls.push(call)

    if (command === 'taskkill') {
      queueMicrotask(() => child.close(0))
      return child
    }

    if (args.includes('--version')) {
      queueMicrotask(() => {
        if (options.ytdlpProbeOk === false) {
          child.stderr.write('probe failed')
          child.close(1)
          return
        }
        child.stdout.write('2026.01.01\n')
        child.close(0)
      })
      return child
    }

    if (args.includes('-version')) {
      queueMicrotask(() => {
        if (options.ffmpegProbeOk === false) {
          child.stderr.write('probe failed')
          child.close(1)
          return
        }
        child.stdout.write('ffmpeg version 7.1 Copyright (c) 2000-2026\n')
        child.close(0)
      })
      return child
    }

    if (args.includes('--dump-single-json')) {
      queueMicrotask(() => {
        if (options.analyzeCode !== undefined && options.analyzeCode !== 0) {
          child.stderr.write('[example] ERROR: private video\n')
          child.close(options.analyzeCode)
          return
        }
        const stdout =
          options.analyzeStdout ??
          JSON.stringify(options.analyzeJson ?? sampleInfo())
        child.stdout.write(stdout)
        child.close(0)
      })
      return child
    }

    const base = outputBase(call)
    if (options.download) {
      queueMicrotask(() => {
        options.download?.(call, { base, outputDir: downloadDir })
      })
      return child
    }

    queueMicrotask(() => {
      void (async () => {
        const ext = downloadOutputExt(call, options.defaultOutputExt ?? 'mp4')
        await fs.writeFile(
          `${base}.${ext}`,
          Buffer.alloc(2_048, 1)
        )
        child.close(0)
      })()
    })
    return child
  }

  const engine = createMediaEngine({
    env,
    platform: 'win32',
    cwd: root,
    spawn,
    lookup: options.lookup ?? publicLookup(),
    now: options.now,
    analysisTtlMs: options.analysisTtlMs,
    cancellationGraceMs: options.cancellationGraceMs
  })

  return {
    engine,
    calls,
    root,
    downloadDir,
    ytdlpFile,
    ffmpegFile,
    spawn
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for the fake process.')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function downloadRequest(
  analysisId: string,
  optionId: string,
  dir: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    jobId: JOB_ID,
    sourceUrl: SOURCE_URL,
    analysisId,
    optionId,
    dir,
    ...overrides
  }
}

function downloadCall(calls: SpawnCall[]): SpawnCall {
  const call = calls.find((entry) => entry.args.includes('--format'))
  if (!call) throw new Error('download process was not spawned')
  return call
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    )
  )
})

describe('media engine URL and target validation', () => {
  it('rejects credential-bearing URLs before starting any process', async () => {
    const harness = await makeHarness()
    await expect(
      harness.engine.analyze('https://user:secret@example.com/watch?v=1')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(harness.calls).toHaveLength(0)
  })

  it('rejects localhost, private, loopback, link-local and IPv6 literals without DNS lookups', async () => {
    const lookup = publicLookup()
    const harness = await makeHarness({ lookup })

    for (const url of [
      'http://localhost/video',
      'http://127.0.0.1/video',
      'http://127.1/video',
      'http://10.0.0.8/video',
      'http://192.168.1.20/video',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/video',
      'http://[fe80::1]/video',
      'http://[fc00::1]/video'
    ]) {
      await expect(harness.engine.analyze(url)).rejects.toMatchObject({
        code: 'MEDIA_TARGET_NOT_PUBLIC'
      })
    }

    expect(lookup).not.toHaveBeenCalled()
    expect(harness.calls).toHaveLength(0)
  })

  it('rejects hostnames whose resolved addresses are private or mixed', async () => {
    const lookup = vi.fn(async (hostname: string): Promise<MediaLookupAddress[]> => {
      if (hostname === 'private.example') {
        return [{ address: '10.0.0.5', family: 4 }]
      }
      if (hostname === 'mixed.example') {
        return [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 }
        ]
      }
      return [{ address: '93.184.216.34', family: 4 }]
    }) as unknown as MediaLookup
    const harness = await makeHarness({ lookup })

    await expect(
      harness.engine.analyze('https://private.example/video')
    ).rejects.toMatchObject({ code: 'MEDIA_TARGET_NOT_PUBLIC' })
    await expect(
      harness.engine.analyze('https://mixed.example/video')
    ).rejects.toMatchObject({ code: 'MEDIA_TARGET_NOT_PUBLIC' })

    const analysis = await harness.engine.analyze('https://public.example/video')
    expect(analysis.options.length).toBeGreaterThan(0)
  })

  it('reports an unresolved hostname honestly', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('lookup failed')
    }) as unknown as MediaLookup
    const harness = await makeHarness({ lookup })

    await expect(
      harness.engine.analyze('https://does-not-resolve.example/video')
    ).rejects.toMatchObject({ code: 'MEDIA_TARGET_UNRESOLVED' })
    expect(harness.calls).toHaveLength(0)
  })
})

describe('media engine format mapping', () => {
  it('maps video-only plus audio into a merged deliverable and picks a real audio-only stream', async () => {
    const harness = await makeHarness()
    const analysis = await harness.engine.analyze(SOURCE_URL)

    expect(() => parseMediaAnalysis(analysis)).not.toThrow()
    const videos = analysis.options.filter((option) => option.kind === 'video')
    const merged = videos.find((option) => option.height === 1080)
    const muxed = videos.find((option) => option.height === 720)

    expect(merged).toMatchObject({
      container: 'mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: 'avc1.640028',
      audioCodec: 'mp4a.40.2',
      hasAudio: true,
      requiresMerge: true,
      filesizeBytes: null
    })
    expect(muxed).toMatchObject({
      container: 'mp4',
      height: 720,
      hasAudio: true,
      requiresMerge: false,
      filesizeBytes: 800
    })
    expect(analysis.bestVideoOptionId).toBe(merged?.optionId)

    const bestAudio = analysis.options.find(
      (option) => option.optionId === analysis.bestAudioOptionId
    )
    expect(bestAudio).toMatchObject({
      kind: 'audio',
      container: 'm4a',
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: 'mp4a.40.2',
      hasAudio: true,
      requiresMerge: false,
      filesizeBytes: 500
    })

    for (const option of analysis.options) {
      expect(option.optionId).toMatch(/^option_[A-Za-z0-9_-]+$/)
      expect(option.optionId).not.toBe('137')
      expect(option.optionId).not.toBe('140')
    }
    expect(analysis.analysisId).toMatch(/^analysis_[A-Za-z0-9_-]+$/)
  })

  it('does not offer merged options when FFmpeg is missing, and keeps an honest tool state', async () => {
    const harness = await makeHarness({ withFfmpeg: false })
    const state = await harness.engine.getToolState()

    expect(state.status).toBe('ready')
    expect(state.message).toMatch(/FFmpeg/)
    expect(state.hint).toMatch(/DONDOWNLOAD_FFMPEG_PATH/)

    const analysis = await harness.engine.analyze(SOURCE_URL)
    const videos = analysis.options.filter((option) => option.kind === 'video')
    expect(videos).toHaveLength(1)
    expect(videos[0]).toMatchObject({ height: 720, requiresMerge: false })
    expect(analysis.bestVideoOptionId).toBe(videos[0]?.optionId)
  })

  it('does not offer merged options when the FFmpeg probe fails', async () => {
    const harness = await makeHarness({ ffmpegProbeOk: false })
    const state = await harness.engine.getToolState()
    expect(state.status).toBe('ready')
    expect(state.message).toMatch(/could not be started/)

    const analysis = await harness.engine.analyze(SOURCE_URL)
    expect(
      analysis.options.some((option) => option.requiresMerge)
    ).toBe(false)
  })

  it('skips DRM, storyboard, unsafe format IDs and approximate sizes', async () => {
    const harness = await makeHarness({
      analyzeJson: sampleInfo({
        title: 'Filtered formats',
        formats: [
          {
            format_id: '137',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'none',
            height: 1080,
            width: 1920,
            filesize: 1000,
            has_drm: true
          },
          {
            format_id: 'sb0',
            ext: 'mhtml',
            vcodec: 'none',
            acodec: 'none'
          },
          {
            format_id: 'bad format id',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a',
            height: 720,
            width: 1280
          },
          {
            format_id: '18',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a',
            height: 360,
            width: 640,
            filesize_approx: 99_999
          },
          {
            format_id: '140',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128,
            filesize: 400
          }
        ]
      })
    })

    const analysis = await harness.engine.analyze(SOURCE_URL)
    const videos = analysis.options.filter((option) => option.kind === 'video')
    expect(videos).toHaveLength(1)
    expect(videos[0]).toMatchObject({
      height: 360,
      requiresMerge: false,
      filesizeBytes: null
    })
    expect(analysis.options.some((option) => option.height === 1080)).toBe(false)
  })

  it('reports playlist, live and malformed analysis results distinctly', async () => {
    const playlist = await makeHarness({
      analyzeJson: { _type: 'playlist', entries: [sampleInfo()] }
    })
    await expect(playlist.engine.analyze(SOURCE_URL)).rejects.toMatchObject({
      code: 'MEDIA_UNSUPPORTED_PLAYLIST'
    })

    const live = await makeHarness({
      analyzeJson: sampleInfo({ is_live: true })
    })
    await expect(live.engine.analyze(SOURCE_URL)).rejects.toMatchObject({
      code: 'MEDIA_UNSUPPORTED_LIVE'
    })

    const malformed = await makeHarness({ analyzeStdout: 'not json' })
    await expect(malformed.engine.analyze(SOURCE_URL)).rejects.toMatchObject({
      code: 'MEDIA_ANALYSIS_FAILED'
    })
  })
})

describe('media engine tool discovery', () => {
  it('reports unavailable with an install hint when yt-dlp is missing', async () => {
    const harness = await makeHarness({ toolMode: 'missing' })
    const state = await harness.engine.getToolState()

    expect(state).toMatchObject({
      status: 'unavailable',
      version: null
    })
    expect(state.message).toMatch(/configured yt-dlp path does not exist/)
    expect(state.hint).toMatch(/DONDOWNLOAD_YTDLP_PATH/)
    await expect(harness.engine.analyze(SOURCE_URL)).rejects.toMatchObject({
      code: 'MEDIA_TOOL_UNAVAILABLE'
    })
    expect(harness.calls).toHaveLength(0)
  })

  it('honours an explicit override and reports verified versions', async () => {
    const harness = await makeHarness()
    const state = await harness.engine.getToolState()

    expect(state.status).toBe('ready')
    expect(state.version).toMatch(/yt-dlp 2026\.01\.01/)
    expect(state.version).toMatch(/ffmpeg 7\.1/)
    expect(state.message).toBeNull()
    expect(state.hint).toBeNull()

    const versionCall = harness.calls.find((call) =>
      call.args.includes('--version')
    )
    expect(versionCall?.command).toBe(harness.ytdlpFile)
    expect(versionCall?.options.shell).toBe(false)
  })

  it('falls back to PATH and app vendor locations', async () => {
    const pathHarness = await makeHarness({ toolMode: 'path' })
    const pathState = await pathHarness.engine.getToolState()
    expect(pathState.status).toBe('ready')

    const vendorHarness = await makeHarness({ toolMode: 'vendor' })
    const vendorState = await vendorHarness.engine.getToolState()
    expect(vendorState.status).toBe('ready')
    const versionCall = vendorHarness.calls.find((call) =>
      call.args.includes('--version')
    )
    expect(versionCall?.command).toContain(path.join('vendor', 'yt-dlp'))
  })

  it('reports an error when yt-dlp exists but cannot run', async () => {
    const harness = await makeHarness({ ytdlpProbeOk: false })
    const state = await harness.engine.getToolState()

    expect(state.status).toBe('error')
    expect(state.version).toBeNull()
    expect(state.hint).toMatch(/DONDOWNLOAD_YTDLP_PATH/)
    await expect(harness.engine.analyze(SOURCE_URL)).rejects.toMatchObject({
      code: 'MEDIA_TOOL_UNAVAILABLE'
    })
  })
})

describe('media engine analysis identity and download request validation', () => {
  it('rejects mismatched, stale and expired analysis selections', async () => {
    let clock = 1_000_000
    const harness = await makeHarness({
      now: () => clock,
      analysisTtlMs: 1_000
    })

    const first = await harness.engine.analyze(SOURCE_URL)
    const second = await harness.engine.analyze(SOURCE_URL)
    expect(first.analysisId).not.toBe(second.analysisId)

    const optionFromSecond = second.bestVideoOptionId
    const optionFromFirst = first.bestVideoOptionId
    expect(optionFromSecond).not.toBeNull()
    expect(optionFromFirst).not.toBeNull()

    await expect(
      harness.engine.download(
        downloadRequest(
          first.analysisId,
          optionFromSecond as string,
          harness.downloadDir
        ),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'MEDIA_OPTION_INVALID' })

    await expect(
      harness.engine.download(
        downloadRequest(
          first.analysisId,
          optionFromFirst as string,
          harness.downloadDir,
          { sourceUrl: 'https://example.com/other' }
        ),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_MISMATCH' })

    clock += 1_000
    await expect(
      harness.engine.download(
        downloadRequest(
          first.analysisId,
          optionFromFirst as string,
          harness.downloadDir
        ),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_EXPIRED' })

    await expect(
      harness.engine.download(
        downloadRequest(
          'analysis_missing_0123456789',
          optionFromFirst as string,
          harness.downloadDir
        ),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'MEDIA_ANALYSIS_NOT_FOUND' })
  })

  it('rejects duplicate job identifiers while another download is starting', async () => {
    const harness = await makeHarness({ download: () => undefined })
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const request = downloadRequest(
      analysis.analysisId,
      analysis.bestVideoOptionId as string,
      harness.downloadDir
    )

    const first = harness.engine.download(request, () => undefined)
    const firstOutcome = first.then(
      () => null,
      (error: unknown) => error
    )
    await expect(
      harness.engine.download(request, () => undefined)
    ).rejects.toMatchObject({ code: 'MEDIA_JOB_ACTIVE' })

    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--format'))
    )
    downloadCall(harness.calls).child.close(1)
    expect(await firstOutcome).toMatchObject({
      code: 'MEDIA_DOWNLOAD_FAILED'
    })
  })

  it('rejects credential-bearing and invalid download inputs', async () => {
    const harness = await makeHarness()
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const optionId = analysis.bestVideoOptionId as string

    await expect(
      harness.engine.download(
        downloadRequest(analysis.analysisId, optionId, harness.downloadDir, {
          sourceUrl: 'https://user:secret@example.com/watch?v=1'
        }),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await expect(
      harness.engine.download(
        downloadRequest(analysis.analysisId, optionId, 'relative-folder'),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('media engine subprocess arguments and progress', () => {
  it('uses fixed shell-free arguments and avoids config, cookies, credentials and aria2', async () => {
    const harness = await makeHarness({
      download: (call) => call.child.close(1)
    })
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const optionId = analysis.bestVideoOptionId as string

    const promise = harness.engine.download(
      downloadRequest(analysis.analysisId, optionId, harness.downloadDir),
      () => undefined
    )
    const failure = promise.then(
      () => null,
      (error: unknown) => error
    )
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--format'))
    )
    expect(await failure).toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })

    const analyzeCall = harness.calls.find((call) =>
      call.args.includes('--dump-single-json')
    )
    const download = downloadCall(harness.calls)
    expect(analyzeCall).toBeDefined()

    for (const call of harness.calls) {
      expect(call.options.shell).toBe(false)
      expect(call.options.windowsHide).toBe(true)
    }

    for (const args of [analyzeCall?.args ?? [], download.args]) {
      expect(args).toContain('--ignore-config')
      expect(args).toContain('--no-playlist')
      for (const forbidden of [
        '--cookies',
        '--cookies-from-browser',
        '--username',
        '--password',
        '--netrc',
        '--config-locations',
        '--downloader',
        'aria2c',
        '--exec',
        '--plugin-dirs',
        '-o',
        '--output-template'
      ]) {
        expect(args).not.toContain(forbidden)
      }
      expect(args[args.length - 2]).toBe('--')
    }

    expect(download.args).toContain('--no-simulate')
    expect(download.args).toContain('--progress')
    expect(argValue(download.args, '--format')).toBe('137+140')
    expect(argValue(download.args, '--merge-output-format')).toBe('mp4')
    expect(argValue(download.args, '--output')).toContain(
      harness.downloadDir
    )
    expect(download.args[download.args.length - 1]).toBe(SOURCE_URL)

    const outputTemplate = argValue(download.args, '--output') as string
    expect(analyzeCall?.args).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      '--dump-single-json',
      '--no-cache-dir',
      '--',
      SOURCE_URL
    ])
    expect(download.args).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-playlist',
      '--no-warnings',
      '--no-simulate',
      '--windows-filenames',
      '--newline',
      '--progress',
      '--no-mtime',
      '--no-cache-dir',
      '--progress-template',
      PROGRESS_TEMPLATE,
      '--format',
      '137+140',
      '--output',
      outputTemplate,
      '--merge-output-format',
      'mp4',
      '--',
      SOURCE_URL
    ])
  })

  it('parses progress lines and reports downloading, merging and the verified file', async () => {
    const harness = await makeHarness({ download: () => undefined })
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const optionId = analysis.bestVideoOptionId as string
    const updates: MediaDownloadProgress[] = []

    const promise = harness.engine.download(
      downloadRequest(analysis.analysisId, optionId, harness.downloadDir),
      (update) => updates.push(update)
    )
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--format'))
    )

    const call = downloadCall(harness.calls)
    const base = outputBase(call)
    const child = call.child

    child.stdout.write('DONDOWNLOAD_PROGRESS|100|1000|NA|50|137\n')
    child.stdout.write('DONDOWNLOAD_PROGRESS|300|1000|NA|60|137\n')
    child.stdout.write('DONDOWNLOAD_PROGRESS|200|500|NA|20|140\n')
    await tick()

    expect(updates.at(-1)).toMatchObject({
      status: 'downloading',
      completedBytes: 500,
      totalBytes: 1_500,
      speedBps: 80,
      filePath: null
    })

    child.stderr.write('[Merger] Merging formats into "ignored"\n')
    await tick()
    expect(updates.at(-1)).toMatchObject({
      status: 'merging',
      completedBytes: 500,
      totalBytes: 1_500
    })

    const ext = downloadOutputExt(call)
    const finalPath = `${base}.${ext}`
    await fs.writeFile(finalPath, Buffer.from('merged'))
    child.close(0)

    const result = await promise
    expect(result.filePath).toBe(finalPath)
    expect(result.totalBytes).toBe(6)
    expect(updates.at(-1)).toMatchObject({
      status: 'merging',
      completedBytes: 6,
      totalBytes: 6,
      speedBps: 0,
      filePath: finalPath
    })
  })

  it('parses total estimates and rejects malformed progress records', () => {
    expect(parseProgressLine('DONDOWNLOAD_PROGRESS|10|NA|800|12.5|137')).toEqual({
      completedBytes: 10,
      totalBytes: 800,
      speedBps: 12,
      streamId: '137'
    })
    expect(parseProgressLine('DONDOWNLOAD_PROGRESS|10|NA|NA|NA|NA')).toEqual({
      completedBytes: 10,
      totalBytes: null,
      speedBps: 0,
      streamId: 'stream'
    })
    expect(parseProgressLine('DONDOWNLOAD_PROGRESS|NA|1|1|1|1')).toBeNull()
    expect(parseProgressLine('not progress')).toBeNull()
  })

  it('sanitizes the title into a filename component under the trusted directory', async () => {
    const harness = await makeHarness({
      analyzeJson: sampleInfo({
        title: '../bad\\name:? 100% "video".mp4'
      }),
      download: (call) => call.child.close(1)
    })
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const optionId = analysis.bestVideoOptionId as string

    const promise = harness.engine.download(
      downloadRequest(analysis.analysisId, optionId, harness.downloadDir),
      () => undefined
    )
    const failure = promise.then(
      () => null,
      (error: unknown) => error
    )
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--format'))
    )
    const call = downloadCall(harness.calls)
    const template = argValue(call.args, '--output') as string

    expect(path.dirname(template)).toBe(harness.downloadDir)
    expect(path.basename(template)).not.toContain('..')
    expect(path.basename(template)).not.toContain('\\')
    expect(path.basename(template)).not.toContain('/')
    expect(path.basename(template)).not.toContain(':')
    expect(path.basename(template)).not.toContain('?')
    expect(path.basename(template)).not.toContain('"')
    expect(template).toContain('100%%')
    expect(template).toContain('.%(ext)s')

    expect(await failure).toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })
  })
})

describe('media engine cancellation and failure cleanup', () => {
  it('cancels a running download, kills the tree and removes partial files', async () => {
    const harness = await makeHarness({
      download: () => undefined,
      cancellationGraceMs: 50
    })
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const optionId = analysis.bestVideoOptionId as string

    const promise = harness.engine.download(
      downloadRequest(analysis.analysisId, optionId, harness.downloadDir),
      () => undefined
    )
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--format'))
    )
    const call = downloadCall(harness.calls)
    const base = outputBase(call)
    const partialPath = `${base}.part`
    await fs.writeFile(partialPath, 'partial bytes')

    harness.engine.cancel(JOB_ID)

    const taskkill = harness.calls.find((entry) => entry.command === 'taskkill')
    expect(taskkill?.args).toEqual(['/pid', String(call.child.pid), '/T', '/F'])
    expect(taskkill?.options.shell).toBe(false)

    await expect(promise).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_CANCELLED'
    })
    await expect(fs.stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honours cancellation requested before the child process starts', async () => {
    const harness = await makeHarness()
    const analysis = await harness.engine.analyze(SOURCE_URL)

    const promise = harness.engine.download(
      downloadRequest(
        analysis.analysisId,
        analysis.bestVideoOptionId as string,
        harness.downloadDir
      ),
      () => undefined
    )
    harness.engine.cancel(JOB_ID)

    await expect(promise).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_CANCELLED'
    })
    expect(
      harness.calls.some((call) => call.args.includes('--format'))
    ).toBe(false)
  })

  it('bounds cancellation even when the child never emits close', async () => {
    const harness = await makeHarness({
      download: () => undefined,
      cancellationGraceMs: 30
    })
    const analysis = await harness.engine.analyze(SOURCE_URL)

    const promise = harness.engine.download(
      downloadRequest(
        analysis.analysisId,
        analysis.bestVideoOptionId as string,
        harness.downloadDir
      ),
      () => undefined
    )
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--format'))
    )
    harness.engine.cancel(JOB_ID)

    await expect(promise).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_CANCELLED'
    })
  })

  it('ignores unknown or malformed cancel requests', async () => {
    const harness = await makeHarness()
    expect(() => harness.engine.cancel('not a job id')).not.toThrow()
    expect(() => harness.engine.cancel(JOB_ID)).not.toThrow()
  })

  it('removes only its own partial artifacts on failure and redacts errors', async () => {
    const harness = await makeHarness({
      download: (call, { base }) => {
        void (async () => {
          await fs.writeFile(`${base}.part`, 'partial')
          await fs.writeFile(`${base}.f137.mp4`, 'video')
          call.child.close(1)
        })()
      }
    })
    const analysis = await harness.engine.analyze(SOURCE_URL)
    const unrelated = path.join(harness.downloadDir, 'keep-me.txt')
    await fs.writeFile(unrelated, 'keep')

    const error = await harness.engine
      .download(
        downloadRequest(
          analysis.analysisId,
          analysis.bestVideoOptionId as string,
          harness.downloadDir
        ),
        () => undefined
      )
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })
    expect((error as Error).message).not.toContain(SOURCE_URL)
    expect((error as Error).message).not.toContain(harness.downloadDir)
    expect((error as Error).message).not.toContain('https://')

    const remaining = await fs.readdir(harness.downloadDir)
    expect(remaining).toEqual(['keep-me.txt'])
  })

  it('fails and cleans up when yt-dlp exits successfully without an output file', async () => {
    const harness = await makeHarness({
      download: (call) => call.child.close(0)
    })
    const analysis = await harness.engine.analyze(SOURCE_URL)

    await expect(
      harness.engine.download(
        downloadRequest(
          analysis.analysisId,
          analysis.bestVideoOptionId as string,
          harness.downloadDir
        ),
        () => undefined
      )
    ).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })
    expect(await fs.readdir(harness.downloadDir)).toEqual([])
  })
})
