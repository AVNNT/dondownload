import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMediaEngine } from '../src/main/media/engine'
import type {
  MediaDownloadProgress,
  MediaDownloadResult,
  MediaLookup,
  MediaLookupAddress
} from '../src/main/media/engine'
import type { MediaSpawn, MediaSpawnOptions } from '../src/main/media/process'
import { PROGRESS_TEMPLATE, parseProgressLine } from '../src/main/media/args'
import { MAX_COLLECTION_ENTRIES, parseCollectionPreview } from '../src/shared/batches'
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
  playlistJson?: unknown
  playlistCode?: number
  playlistStdout?: string
  lookup?: MediaLookup
  now?: () => number
  analysisTtlMs?: number
  collectionTtlMs?: number
  cancellationGraceMs?: number
  analyze?: (call: SpawnCall) => void
  playlist?: (call: SpawnCall) => void
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
  const info: Record<string, unknown> = {
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

  if (Array.isArray(info.formats)) {
    info.formats = (info.formats as unknown[]).map((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return value
      }
      return {
        protocol: 'https',
        url: 'https://cdn.example.com/media',
        ...(value as Record<string, unknown>)
      }
    })
  }
  return info
}

function samplePlaylistEntry(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    _type: 'url',
    url: 'https://www.youtube.com/watch?v=entry-one',
    title: 'Playlist entry',
    duration: 120,
    ...overrides
  }
}

function samplePlaylist(
  entries: unknown[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    _type: 'playlist',
    title: 'Example playlist',
    entries,
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
  const childrenByPid = new Map<number, FakeChild>()
  let nextPid = 4_000
  const spawn: MediaSpawn = (command, args, spawnOptions) => {
    const child = new FakeChild((nextPid += 1))
    childrenByPid.set(child.pid, child)
    const call: SpawnCall = {
      command,
      args: [...args],
      options: spawnOptions,
      child
    }
    calls.push(call)

    if (command === 'taskkill') {
      queueMicrotask(() => {
        // Simulate taskkill terminating the target tree so aborted children
        // settle like a real process would.
        const targetPid = Number(args[1])
        const target = childrenByPid.get(targetPid)
        if (target && !target.closed) {
          target.kill()
          target.close(1)
        }
        child.close(0)
      })
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

    if (args.includes('--flat-playlist')) {
      if (options.playlist) {
        queueMicrotask(() => options.playlist?.(call))
        return child
      }
      queueMicrotask(() => {
        if (options.playlistCode !== undefined && options.playlistCode !== 0) {
          child.stderr.write('[example] ERROR: playlist is private\n')
          child.close(options.playlistCode)
          return
        }
        const stdout =
          options.playlistStdout ??
          JSON.stringify(options.playlistJson ?? samplePlaylist([samplePlaylistEntry()]))
        child.stdout.write(stdout)
        child.close(0)
      })
      return child
    }

    if (args.includes('--dump-single-json')) {
      if (options.analyze) {
        queueMicrotask(() => options.analyze?.(call))
        return child
      }
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
    collectionTtlMs: options.collectionTtlMs,
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

async function startDownload(
  harness: Awaited<ReturnType<typeof makeHarness>>
): Promise<{
  promise: Promise<MediaDownloadResult>
  updates: MediaDownloadProgress[]
  child: FakeChild
  finalPath: string
}> {
  const analysis = await harness.engine.analyze(SOURCE_URL)
  const updates: MediaDownloadProgress[] = []
  const promise = harness.engine.download(
    downloadRequest(
      analysis.analysisId,
      analysis.bestVideoOptionId as string,
      harness.downloadDir
    ),
    (update) => updates.push(update)
  )
  await waitFor(() =>
    harness.calls.some((call) => call.args.includes('--format'))
  )
  const call = downloadCall(harness.calls)
  return {
    promise,
    updates,
    child: call.child,
    finalPath: `${outputBase(call)}.${downloadOutputExt(call)}`
  }
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
      'http://192.0.0.1/video',
      'http://192.88.99.1/video',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/video',
      'http://[fe80::1]/video',
      'http://[fc00::1]/video',
      'http://[2001:db8::1]/video',
      'http://[2001:2::1]/video',
      'http://[2001:11::1]/video'
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

  it('revalidates DNS immediately before downloading an earlier analysis', async () => {
    let sourceLookups = 0
    const lookup = vi.fn(async (hostname: string): Promise<MediaLookupAddress[]> => {
      if (hostname === 'example.com') {
        sourceLookups += 1
        return sourceLookups === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '10.0.0.5', family: 4 }]
      }
      return [{ address: '93.184.216.35', family: 4 }]
    }) as unknown as MediaLookup
    const harness = await makeHarness({ lookup })
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
    ).rejects.toMatchObject({ code: 'MEDIA_TARGET_NOT_PUBLIC' })

    expect(sourceLookups).toBe(2)
    expect(harness.calls.some((call) => call.args.includes('--format'))).toBe(false)
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

  it('filters non-HTTP protocols and private stream URLs from format options', async () => {
    const harness = await makeHarness({
      analyzeJson: sampleInfo({
        formats: [
          {
            format_id: '18',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a',
            width: 640,
            height: 360,
            protocol: 'https',
            url: 'https://cdn.example.com/public.mp4'
          },
          {
            format_id: '140',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128,
            protocol: 'https',
            url: 'http://127.0.0.1/private.m4a'
          },
          {
            format_id: 'rtmp-1',
            ext: 'flv',
            vcodec: 'h264',
            acodec: 'aac',
            width: 640,
            height: 360,
            protocol: 'rtmp',
            url: 'rtmp://cdn.example.com/private.flv'
          }
        ]
      })
    })

    const analysis = await harness.engine.analyze(SOURCE_URL)
    expect(analysis.options).toHaveLength(1)
    expect(analysis.options[0]).toMatchObject({
      kind: 'video',
      label: expect.stringContaining('360p')
    })
    expect(analysis.bestAudioOptionId).toBeNull()
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

describe('media engine playlist collection analysis', () => {
  it('uses a fixed flat metadata listing without cookies, config or download flags', async () => {
    const harness = await makeHarness()
    const preview = await harness.engine.analyzeCollection(SOURCE_URL)

    expect(preview.kind).toBe('playlist')
    const playlistCall = harness.calls.find((call) =>
      call.args.includes('--flat-playlist')
    )
    expect(playlistCall).toBeDefined()
    expect(playlistCall?.command).toBe(harness.ytdlpFile)
    expect(playlistCall?.options.shell).toBe(false)
    expect(playlistCall?.options.windowsHide).toBe(true)
    expect(playlistCall?.args).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--flat-playlist',
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--no-cache-dir',
      '--',
      SOURCE_URL
    ])

    for (const forbidden of [
      '--no-playlist',
      '--format',
      '--output',
      '--no-simulate',
      '--progress',
      '--cookies',
      '--cookies-from-browser',
      '--username',
      '--password',
      '--netrc',
      '--config-locations',
      '--downloader',
      'aria2c',
      '--exec'
    ]) {
      expect(playlistCall?.args).not.toContain(forbidden)
    }
  })

  it('returns only opaque IDs and bounded safe display data', async () => {
    const entries = [
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_0',
        url: 'https://www.youtube.com/watch?v=entry-one',
        title: 'First public entry',
        duration: 120
      }),
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_1',
        url: 'https://www.youtube.com/watch?v=entry-two',
        title: '[Private video]'
      }),
      samplePlaylistEntry({ id: 'RAW_INTERNAL_ID_2', title: '[Deleted video]' }),
      samplePlaylistEntry({ id: 'RAW_INTERNAL_ID_3', is_live: true }),
      samplePlaylistEntry({ id: 'RAW_INTERNAL_ID_4', has_drm: true }),
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_5',
        availability: 'needs_auth'
      }),
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_6',
        availability: 'subscriber_only'
      }),
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_7',
        availability: 'region_restricted'
      }),
      samplePlaylistEntry({ id: 'RAW_INTERNAL_ID_8', age_restricted: true }),
      null,
      samplePlaylistEntry({ id: 'RAW_INTERNAL_ID_10', url: undefined }),
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_11',
        title: `https://private.example/secret/${'x'.repeat(5_000)}`
      }),
      samplePlaylistEntry({
        id: 'RAW_INTERNAL_ID_12',
        url: 'https://www.youtube.com/watch?v=entry-thirteen',
        title: 'https://leak.example/should-not-appear',
        duration: -5
      })
    ]
    const harness = await makeHarness({ playlistJson: samplePlaylist(entries) })
    const preview = await harness.engine.analyzeCollection(SOURCE_URL)

    expect(() => parseCollectionPreview(preview)).not.toThrow()
    expect(preview).toMatchObject({
      kind: 'playlist',
      title: 'Example playlist',
      entryCount: entries.length,
      availableCount: 2,
      unavailableCount: entries.length - 2
    })
    expect(preview.entries.map((entry) => entry.position)).toEqual(
      entries.map((_entry, position) => position)
    )
    expect(preview.entries[0]).toMatchObject({
      title: 'First public entry',
      availability: 'available',
      errorCode: null,
      errorReason: null
    })

    const codes = preview.entries
      .slice(1, 12)
      .map((entry) => entry.errorCode)
    expect(codes).toEqual([
      'private',
      'removed',
      'unsupported',
      'unsupported',
      'private',
      'members-only',
      'region-restricted',
      'age-restricted',
      'unknown',
      'unavailable',
      'too-large'
    ])
    for (const entry of preview.entries) {
      expect(entry.id).toMatch(/^entry_[A-Za-z0-9_-]+$/)
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.title.length).toBeLessThanOrEqual(240)
    }
    expect(preview.entries.at(-1)).toMatchObject({
      title: 'Untitled entry',
      availability: 'available',
      errorCode: null
    })

    const serialized = JSON.stringify(preview)
    for (const secret of [
      'http',
      'youtube.com',
      'watch?v=',
      'private.example',
      'leak.example',
      'RAW_INTERNAL_ID'
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('rejects single videos, malformed output, empty and oversized playlists safely', async () => {
    const single = await makeHarness({ playlistJson: sampleInfo() })
    await expect(
      single.engine.analyzeCollection(SOURCE_URL)
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_NOT_PLAYLIST' })

    const malformed = await makeHarness({ playlistStdout: 'not json' })
    await expect(
      malformed.engine.analyzeCollection(SOURCE_URL)
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_FAILED' })

    const failed = await makeHarness({ playlistCode: 1 })
    await expect(
      failed.engine.analyzeCollection(SOURCE_URL)
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_FAILED' })

    const empty = await makeHarness({ playlistJson: samplePlaylist([]) })
    await expect(
      empty.engine.analyzeCollection(SOURCE_URL)
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_EMPTY' })

    const oversized = await makeHarness({
      playlistJson: samplePlaylist(
        Array.from({ length: MAX_COLLECTION_ENTRIES + 1 }, (_value, index) =>
          samplePlaylistEntry({
            url: `https://www.youtube.com/watch?v=entry-${index}`,
            title: `Entry ${index}`
          })
        )
      )
    })
    await expect(
      oversized.engine.analyzeCollection(SOURCE_URL)
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_TOO_LARGE' })
    expect(oversized.calls.some((call) => call.args.includes('--flat-playlist'))).toBe(
      true
    )
  })

  it('resolves only explicitly selected available entries and keeps URLs internal', async () => {
    const harness = await makeHarness({
      playlistJson: samplePlaylist([
        samplePlaylistEntry({
          url: 'https://www.youtube.com/watch?v=entry-one',
          title: 'First public entry',
          duration: 120
        }),
        samplePlaylistEntry({
          url: 'https://www.youtube.com/watch?v=entry-two',
          title: 'Second public entry',
          duration: 90
        }),
        samplePlaylistEntry({ title: '[Private video]' })
      ])
    })
    const preview = await harness.engine.analyzeCollection(SOURCE_URL)
    const first = preview.entries[0]
    const second = preview.entries[1]
    const unavailable = preview.entries[2]
    if (!first || !second || !unavailable) throw new Error('missing entries')

    const targets = await harness.engine.resolveCollectionEntries(preview.id, [
      first.id,
      second.id
    ])
    expect(targets).toEqual([
      {
        entryId: first.id,
        url: 'https://www.youtube.com/watch?v=entry-one',
        title: 'First public entry',
        durationSeconds: 120,
        position: 0
      },
      {
        entryId: second.id,
        url: 'https://www.youtube.com/watch?v=entry-two',
        title: 'Second public entry',
        durationSeconds: 90,
        position: 1
      }
    ])
    expect(Object.keys(targets[0] ?? {}).sort()).toEqual([
      'durationSeconds',
      'entryId',
      'position',
      'title',
      'url'
    ])

    await expect(
      harness.engine.resolveCollectionEntries(preview.id, [unavailable.id])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_ENTRY_UNAVAILABLE' })

    await expect(
      harness.engine.resolveCollectionEntries(preview.id, ['entry_unknown'])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_ENTRY_INVALID' })

    await expect(
      harness.engine.resolveCollectionEntries('preview_unknown', [first.id])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_NOT_FOUND' })

    await expect(
      harness.engine.resolveCollectionEntries(preview.id, [])
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const other = await harness.engine.analyzeCollection(SOURCE_URL)
    await expect(
      harness.engine.resolveCollectionEntries(other.id, [first.id])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_ENTRY_INVALID' })
  })

  it('revalidates public targets when a stored selection is resolved', async () => {
    let blockEntryHost = false
    const lookup = vi.fn(
      async (hostname: string): Promise<MediaLookupAddress[]> => [
        {
          address:
            blockEntryHost && hostname === 'www.youtube.com'
              ? '127.0.0.1'
              : '93.184.216.34',
          family: 4
        }
      ]
    ) as unknown as MediaLookup
    const harness = await makeHarness({ lookup })
    const preview = await harness.engine.analyzeCollection(SOURCE_URL)
    const entry = preview.entries[0]
    if (!entry) throw new Error('missing entry')

    blockEntryHost = true
    await expect(
      harness.engine.resolveCollectionEntries(preview.id, [entry.id])
    ).rejects.toMatchObject({ code: 'MEDIA_TARGET_NOT_PUBLIC' })
  })

  it('expires previews and drops their private entry URLs', async () => {
    let clock = 1_000_000
    const harness = await makeHarness({
      now: () => clock,
      collectionTtlMs: 500,
      playlistJson: samplePlaylist([samplePlaylistEntry()])
    })
    const preview = await harness.engine.analyzeCollection(SOURCE_URL)
    const entry = preview.entries[0]
    if (!entry) throw new Error('missing entry')

    clock += 501
    await expect(
      harness.engine.resolveCollectionEntries(preview.id, [entry.id])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_EXPIRED' })
    await expect(
      harness.engine.resolveCollectionEntries(preview.id, [entry.id])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_NOT_FOUND' })
  })

  it('evicts the oldest preview when the bounded preview cache is full', async () => {
    const harness = await makeHarness({
      playlistJson: samplePlaylist([samplePlaylistEntry()])
    })
    const previews = []
    for (let index = 0; index < 9; index += 1) {
      previews.push(await harness.engine.analyzeCollection(SOURCE_URL))
    }
    const oldest = previews[0]
    const newest = previews[8]
    const oldestEntry = oldest?.entries[0]
    const newestEntry = newest?.entries[0]
    if (!oldest || !newest || !oldestEntry || !newestEntry) {
      throw new Error('missing previews')
    }

    await expect(
      harness.engine.resolveCollectionEntries(oldest.id, [oldestEntry.id])
    ).rejects.toMatchObject({ code: 'MEDIA_COLLECTION_NOT_FOUND' })
    await expect(
      harness.engine.resolveCollectionEntries(newest.id, [newestEntry.id])
    ).resolves.toHaveLength(1)
  })

  it('cancelAll aborts an in-flight playlist listing', async () => {
    const harness = await makeHarness({ playlist: () => undefined })
    const promise = harness.engine.analyzeCollection(SOURCE_URL)
    const rejection = promise.then(
      () => null,
      (error: unknown) => error as { code?: string }
    )
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--flat-playlist'))
    )

    await harness.engine.cancelAll()
    expect(await rejection).toMatchObject({ code: 'MEDIA_COLLECTION_CANCELLED' })
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
    expect(argValue(download.args, '--ffmpeg-location')).toBe(harness.ffmpegFile)
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
      '--ffmpeg-location',
      harness.ffmpegFile,
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

    child.stdout.write('[Merger] Merging formats into "ignored"\n')
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

  it('detects a post-processing marker split across stdout chunks', async () => {
    const harness = await makeHarness({ download: () => undefined })
    const { promise, updates, child, finalPath } = await startDownload(harness)

    child.stdout.write('DONDOWNLOAD_PROGRESS|100|1000|NA|50|137\n')
    child.stdout.write('[Merger] Merging for')
    await tick()
    expect(updates.some((update) => update.status === 'merging')).toBe(false)

    child.stdout.write('mats into "ignored"\n')
    await tick()
    expect(updates.at(-1)).toMatchObject({
      status: 'merging',
      completedBytes: 100,
      totalBytes: 1_000
    })

    await fs.writeFile(finalPath, Buffer.from('merged'))
    child.close(0)
    await promise
    expect(updates.at(-1)).toMatchObject({
      status: 'merging',
      filePath: finalPath
    })
  })

  it('detects a trailing post-processing marker without a newline at close', async () => {
    const harness = await makeHarness({ download: () => undefined })
    const { promise, updates, child, finalPath } = await startDownload(harness)

    child.stdout.write('[Merger] Merging formats into "ignored"')
    await tick()
    expect(updates.some((update) => update.status === 'merging')).toBe(false)

    await fs.writeFile(finalPath, Buffer.from('merged'))
    child.close(0)
    await promise
    expect(updates.at(-1)).toMatchObject({
      status: 'merging',
      filePath: finalPath
    })
  })

  it('detects post-processing markers on stdout and stderr', async () => {
    const cases = [
      { stream: 'stdout' as const, line: '[Merger] Merging formats into x\n' },
      { stream: 'stderr' as const, line: '[Merger] Merging formats into x\n' },
      { stream: 'stdout' as const, line: '[ExtractAudio] Destination: x.m4a\n' },
      { stream: 'stderr' as const, line: '[ExtractAudio] Destination: x.m4a\n' }
    ]

    for (const testCase of cases) {
      const harness = await makeHarness({ download: () => undefined })
      const { promise, updates, child, finalPath } = await startDownload(harness)

      child[testCase.stream].write(testCase.line)
      await tick()
      expect(updates.at(-1)?.status).toBe('merging')

      await fs.writeFile(finalPath, Buffer.from('merged'))
      child.close(0)
      await promise
    }
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
    expect(path.basename(template)).toContain(JOB_ID.replace(/-/g, ''))
    expect(template).toContain('100%%')
    expect(template).toContain('.%(ext)s')

    expect(await failure).toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })
  })
})

describe('media engine cancellation and failure cleanup', () => {
  it('cancels a running download, kills the tree and preserves partial files', async () => {
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
    await expect(fs.readFile(partialPath, 'utf8')).resolves.toBe('partial bytes')
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

  it('cancelAll terminates an in-flight analysis child and prevents new work', async () => {
    const harness = await makeHarness({ analyze: () => undefined })
    const pending = harness.engine.analyze(SOURCE_URL)
    await waitFor(() =>
      harness.calls.some((call) => call.args.includes('--dump-single-json'))
    )
    const analyzeCall = harness.calls.find((call) =>
      call.args.includes('--dump-single-json')
    )
    if (!analyzeCall) throw new Error('analysis did not start')

    await harness.engine.cancelAll()

    await expect(pending).rejects.toMatchObject({
      code: 'MEDIA_ANALYSIS_CANCELLED'
    })
    const taskkill = harness.calls.find((entry) => entry.command === 'taskkill')
    expect(taskkill?.args).toEqual([
      '/pid',
      String(analyzeCall.child.pid),
      '/T',
      '/F'
    ])
    expect(analyzeCall.child.killed).toBe(true)

    // The engine is closed for new work once cancellation completes.
    await expect(harness.engine.analyze(SOURCE_URL)).rejects.toMatchObject({
      code: 'MEDIA_ANALYSIS_CANCELLED'
    })
    await expect(harness.engine.cancelAll()).resolves.toBeUndefined()
  })

  it('cancelAll waits for a running download cancellation to settle', async () => {
    const harness = await makeHarness({
      download: () => undefined,
      cancellationGraceMs: 5_000
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
    const call = downloadCall(harness.calls)
    const partialPath = `${outputBase(call)}.part`
    await fs.writeFile(partialPath, 'partial bytes')

    // Hold the child's close event so this proves cancelAll waits for the
    // download run promise instead of resolving as soon as cancellation starts.
    let releaseChildClose: () => void = () => undefined
    const childCloseGate = new Promise<void>((resolve) => {
      releaseChildClose = resolve
    })
    let requestedCloseCode: number | null = null
    const originalClose = call.child.close.bind(call.child)
    call.child.close = (code: number) => {
      requestedCloseCode = code
      void childCloseGate.then(() => originalClose(code))
    }

    let closed = false
    const closing = harness.engine.cancelAll().then(() => {
      closed = true
    })
    await tick()

    expect(call.child.killed).toBe(true)
    expect(requestedCloseCode).toBe(1)
    expect(closed).toBe(false)

    releaseChildClose()
    await closing

    await expect(promise).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_CANCELLED'
    })
    await expect(fs.readFile(partialPath, 'utf8')).resolves.toBe(
      'partial bytes'
    )
  })

  it('cancelAll stays bounded when a cancelled download child never closes', async () => {
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
    const call = downloadCall(harness.calls)
    const partialPath = `${outputBase(call)}.part`
    await fs.writeFile(partialPath, 'partial bytes')
    // Simulate a process tree that ignores termination and never emits close.
    call.child.close = () => undefined

    const startedAt = Date.now()
    await harness.engine.cancelAll()

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await expect(promise).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_CANCELLED'
    })
    await expect(fs.readFile(partialPath, 'utf8')).resolves.toBe(
      'partial bytes'
    )
  })

  it('cancelAll bounds its wait when a pending download never settles', async () => {
    let sourceLookups = 0
    const lookup: MediaLookup = vi.fn(async (hostname: string) => {
      if (hostname === 'example.com') {
        sourceLookups += 1
        if (sourceLookups > 1) {
          // The download is stuck re-validating the page target; cancellation
          // cannot reach a pending download that has no child yet.
          return new Promise<never>(() => undefined)
        }
      }
      return [{ address: '93.184.216.34', family: 4 }]
    }) as unknown as MediaLookup
    const harness = await makeHarness({ lookup, cancellationGraceMs: 30 })
    const analysis = await harness.engine.analyze(SOURCE_URL)

    let settled = false
    const promise = harness.engine.download(
      downloadRequest(
        analysis.analysisId,
        analysis.bestVideoOptionId as string,
        harness.downloadDir
      ),
      () => undefined
    )
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await tick()

    const startedAt = Date.now()
    await harness.engine.cancelAll()

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(settled).toBe(false)
  })

  it('preserves partial artifacts on failure and redacts errors', async () => {
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
    const base = path.basename(outputBase(downloadCall(harness.calls)))
    expect(remaining.sort()).toEqual(
      ['keep-me.txt', `${base}.part`, `${base}.f137.mp4`].sort()
    )
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
