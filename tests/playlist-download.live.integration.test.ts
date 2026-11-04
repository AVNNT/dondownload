import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// MediaJobsManager imports Electron only for `shell.showItemInFolder`, which
// this live test never calls. The real engine, manager, yt-dlp and FFmpeg are
// used; only the Electron module itself is replaced.
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

import { createMediaEngine } from '../src/main/media/engine'
import { MediaJobsManager } from '../src/main/mediaJobs/manager'
import type { MediaAnalysis, MediaJob } from '../src/shared/media'
import type { CollectionEntry, CollectionPreview } from '../src/shared/batches'

/**
 * Opt-in live download check for exactly one explicitly selected Blender Open
 * Movies playlist entry.
 *
 * The default suite skips this file, and `test:fast` excludes it. It runs only
 * when all of the following are configured explicitly:
 *
 *   $env:DONDOWNLOAD_LIVE_PLAYLIST_DOWNLOAD = '1'
 *   $env:DONDOWNLOAD_YTDLP_PATH = 'C:\tools\yt-dlp\yt-dlp.exe'
 *   $env:DONDOWNLOAD_FFMPEG_PATH = 'C:\tools\ffmpeg\ffmpeg.exe'
 *   $env:DONDOWNLOAD_DENO_PATH = 'C:\tools\deno\deno.exe' # optional but expected
 *   npm run test:playlist-download:live
 *
 * The playlist is the official public Blender Open Movies playlist:
 * https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz
 *
 * The fixture entry is pinned by title, playlist position, duration and video
 * ID. Only that one entry is selected; only one `queueMedia` call is made. The
 * test never queues the whole playlist and never retries a failed transfer.
 *
 * Before any download starts, a fixed read-only yt-dlp metadata probe checks
 * the selected entry's duration and the smallest muxed HTTP format estimate
 * against a hard 25 MiB transfer bound. If the metadata is missing, changes, or
 * exceeds the bound, the test fails before `queueMedia` is called. A runtime
 * progress guard also cancels the job if the actual transfer crosses the bound.
 *
 * No cookies, browser profile, account, authentication, CAPTCHA handling,
 * provider scraping or rate-limit workaround is used. The download runs in a
 * unique approved temp root and that root is always removed.
 */

const PLAYLIST_URL =
  'https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz'
const PINNED_ENTRY_TITLE =
  '"Caminandes 2: Gran Dillama" - Blender Animated Short'
const PINNED_ENTRY_POSITION = 13
const PINNED_ENTRY_DURATION_SECONDS = 147
const PINNED_VIDEO_ID = 'Z4C82eyhwgU'
const PINNED_CONTAINER = 'mp4'
const PINNED_HEIGHT = 360
const MAX_TRANSFER_BYTES = 25 * 1024 * 1024
const MAX_DURATION_SECONDS = 180
const DOWNLOAD_TIMEOUT_MS = 240_000
const METADATA_TIMEOUT_MS = 180_000

const LIVE_ENABLED = process.env.DONDOWNLOAD_LIVE_PLAYLIST_DOWNLOAD === '1'
const YTDLP_PATH = process.env.DONDOWNLOAD_YTDLP_PATH?.trim() ?? ''
const FFMPEG_PATH = process.env.DONDOWNLOAD_FFMPEG_PATH?.trim() ?? ''
const DENO_PATH = process.env.DONDOWNLOAD_DENO_PATH?.trim() ?? ''
const runLive =
  LIVE_ENABLED && YTDLP_PATH.length > 0 && FFMPEG_PATH.length > 0
    ? describe
    : describe.skip

/** Keep every artifact under the approved temp base, never user Downloads. */
const TEMP_BASE = path.join(os.tmpdir(), 'opencode')

interface PreflightBound {
  durationSeconds: number
  container: string
  height: number
  estimateBytes: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return null
  }
  return value
}

function boundedInteger(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null
  }
  return value
}

/** Build a child environment with explicit tool paths and no auth material. */
function buildLiveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DONDOWNLOAD_YTDLP_PATH: path.resolve(YTDLP_PATH),
    DONDOWNLOAD_FFMPEG_PATH: path.resolve(FFMPEG_PATH)
  }
  if (DENO_PATH.length > 0) {
    env.DONDOWNLOAD_DENO_PATH = path.resolve(DENO_PATH)
  }
  return env
}

async function removeDirectory(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch {
      if (attempt === 9) return
      await delay(200)
    }
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const found: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await listFilesRecursive(full)))
    else found.push(full)
  }
  return found
}

function sha256File(filePath: string): Promise<string> {
  return fs.readFile(filePath).then((contents) =>
    createHash('sha256').update(contents).digest('hex')
  )
}

function videoIdFromUrl(value: string): string | null {
  const parsed = new URL(value)
  if (parsed.hostname === 'youtu.be') {
    return parsed.pathname.split('/').filter(Boolean)[0] ?? null
  }
  if (
    parsed.hostname === 'www.youtube.com' ||
    parsed.hostname === 'youtube.com' ||
    parsed.hostname === 'm.youtube.com'
  ) {
    return parsed.searchParams.get('v')
  }
  return null
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

/**
 * Read-only, fixed-argument metadata probe used only as a pre-transfer bound.
 * It never downloads media, writes output or reads a config file. The result
 * identifies the smallest muxed HTTP format by height/container, not by handing
 * a raw selector back to the product.
 */
function probeTransferBound(
  url: string,
  cwd: string
): PreflightBound {
  const args = [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--dump-single-json',
    '--no-cache-dir'
  ]
  if (DENO_PATH.length > 0) {
    args.push('--js-runtimes', `deno:${path.resolve(DENO_PATH)}`)
  }
  args.push('--', url)

  const result = spawnSync(path.resolve(YTDLP_PATH), args, {
    cwd,
    env: buildLiveEnv(),
    encoding: 'utf8',
    timeout: METADATA_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })

  if (result.error) {
    throw new Error(
      `The pre-transfer metadata probe could not run: ${result.error.message}`
    )
  }
  if (result.status !== 0) {
    throw new Error(
      `The pre-transfer metadata probe failed with exit code ${String(
        result.status
      )}; refusing to download.`
    )
  }

  let info: unknown
  try {
    info = JSON.parse(result.stdout)
  } catch {
    throw new Error(
      'The pre-transfer metadata probe did not return JSON; refusing to download.'
    )
  }
  if (!isRecord(info)) {
    throw new Error(
      'The pre-transfer metadata was not an object; refusing to download.'
    )
  }

  const durationSeconds = boundedInteger(info.duration)
  if (durationSeconds === null || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(
      `The selected entry duration ${String(
        durationSeconds
      )}s exceeds the ${MAX_DURATION_SECONDS}s bound; refusing to download.`
    )
  }

  const rawFormats = Array.isArray(info.formats) ? info.formats : []
  const candidates: Array<{
    container: string
    height: number
    estimateBytes: number
  }> = []

  for (const raw of rawFormats) {
    if (!isRecord(raw)) continue
    if (raw.has_drm === true || raw.drm === true) continue

    const protocol =
      typeof raw.protocol === 'string' ? raw.protocol.toLowerCase() : ''
    if (protocol !== 'http' && protocol !== 'https') continue

    const videoCodec = typeof raw.vcodec === 'string' ? raw.vcodec : ''
    const audioCodec = typeof raw.acodec === 'string' ? raw.acodec : ''
    if (
      videoCodec.length === 0 ||
      videoCodec === 'none' ||
      audioCodec.length === 0 ||
      audioCodec === 'none'
    ) {
      continue
    }

    const container = typeof raw.ext === 'string' ? raw.ext.toLowerCase() : ''
    const height = positiveInteger(raw.height)
    if (container.length === 0 || height === null) continue

    const estimateBytes =
      positiveInteger(raw.filesize) ??
      positiveInteger(raw.filesize_approx)
    if (estimateBytes === null) continue

    candidates.push({ container, height, estimateBytes })
  }

  if (candidates.length === 0) {
    throw new Error(
      'No muxed HTTP format with a size estimate was found; refusing to download because the transfer cannot be bounded.'
    )
  }

  candidates.sort((left, right) => left.estimateBytes - right.estimateBytes)
  const smallest = candidates[0]
  if (!smallest) {
    throw new Error('The pre-transfer metadata bound is unavailable.')
  }
  if (smallest.estimateBytes > MAX_TRANSFER_BYTES) {
    throw new Error(
      `The smallest muxed format estimate ${smallest.estimateBytes} bytes exceeds the ${MAX_TRANSFER_BYTES}-byte bound; refusing to download.`
    )
  }

  return {
    durationSeconds,
    container: smallest.container,
    height: smallest.height,
    estimateBytes: smallest.estimateBytes
  }
}

function findPinnedEntry(preview: CollectionPreview): CollectionEntry {
  const matches = preview.entries.filter(
    (entry) =>
      entry.title === PINNED_ENTRY_TITLE &&
      entry.position === PINNED_ENTRY_POSITION
  )
  expect(matches).toHaveLength(1)
  const entry = matches[0]
  if (!entry) throw new Error('The pinned playlist entry is missing.')
  expect(entry.availability).toBe('available')
  return entry
}

function findMuxedOption(
  analysis: MediaAnalysis,
  bound: PreflightBound
) {
  const candidates = analysis.options.filter(
    (option) =>
      option.kind === 'video' &&
      option.hasAudio &&
      !option.requiresMerge &&
      option.container === bound.container &&
      option.height === bound.height
  )
  expect(candidates.length).toBeGreaterThan(0)
  const option = candidates[0]
  if (!option) throw new Error('The expected muxed format is missing.')
  return option
}

async function waitForTerminalJob(
  manager: MediaJobsManager,
  id: string,
  timeoutMs: number
): Promise<MediaJob> {
  const deadline = Date.now() + timeoutMs
  let last = manager.getMediaJob(id)
  while (Date.now() < deadline) {
    last = manager.getMediaJob(id)
    if (
      last.status === 'complete' ||
      last.status === 'error' ||
      last.status === 'cancelled' ||
      last.status === 'interrupted'
    ) {
      return last
    }
    await delay(100)
  }
  throw new Error(
    `Timed out waiting for the media job to finish. Last job state: ${JSON.stringify(
      last
    )}`
  )
}

runLive('playlist live selected-video download', () => {
  let tempRoot = ''
  let mediaDir = ''
  let engine: ReturnType<typeof createMediaEngine> | null = null
  let manager: MediaJobsManager | null = null

  afterAll(async () => {
    try {
      await manager?.close()
    } catch {
      // Best effort during teardown.
    }
    try {
      await engine?.cancelAll()
    } catch {
      // Best effort during teardown.
    }
    await delay(300)
    if (tempRoot.length > 0) {
      const approvedPrefix = `${path.resolve(TEMP_BASE)}${path.sep}`
      if (path.resolve(tempRoot).startsWith(approvedPrefix)) {
        await removeDirectory(tempRoot)
      }
    }
  }, 60_000)

  it('previews the official Blender playlist, selects exactly one short entry and downloads only that entry', async () => {
    await fs.mkdir(TEMP_BASE, { recursive: true })
    tempRoot = await fs.mkdtemp(
      path.join(TEMP_BASE, 'milestone-3b-playlist-download-')
    )
    mediaDir = path.join(tempRoot, 'media')
    await fs.mkdir(mediaDir, { recursive: true })

    engine = createMediaEngine({
      env: buildLiveEnv(),
      platform: process.platform,
      cwd: tempRoot,
      analysisTimeoutMs: METADATA_TIMEOUT_MS
    })
    const activeEngine = engine

    let activeJobId: string | null = null
    let overBound = false

    manager = new MediaJobsManager({
      engine: activeEngine,
      mediaDir,
      database: null,
      onUpdate: (next) => {
        if (activeJobId === null) return
        const job = next.jobs.find((candidate) => candidate.id === activeJobId)
        if (
          job &&
          job.completedBytes > MAX_TRANSFER_BYTES &&
          !overBound
        ) {
          overBound = true
          void manager?.cancelMedia(job.id)
        }
      }
    })
    const activeManager = manager

    // 1. One real flat-playlist preview through MediaEngine. No media output.
    const preview = await activeEngine.analyzeCollection(PLAYLIST_URL)
    expect(preview.kind).toBe('playlist')
    expect(preview.title.toLowerCase()).toContain('blender')
    expect(preview.entryCount).toBe(preview.entries.length)
    expect(preview.entryCount).toBeGreaterThan(PINNED_ENTRY_POSITION)
    expect(preview.availableCount).toBeGreaterThan(0)

    // 2. Explicitly select exactly one pinned short, public CC-BY entry.
    const selected = findPinnedEntry(preview)
    const targets = await activeEngine.resolveCollectionEntries(preview.id, [
      selected.id
    ])
    expect(targets).toHaveLength(1)
    const target = targets[0]
    if (!target) throw new Error('No selection target was returned.')
    expect(target.entryId).toBe(selected.id)
    expect(target.title).toBe(PINNED_ENTRY_TITLE)
    expect(target.position).toBe(PINNED_ENTRY_POSITION)
    expect(target.durationSeconds).toBe(PINNED_ENTRY_DURATION_SECONDS)
    expect(videoIdFromUrl(target.url)).toBe(PINNED_VIDEO_ID)
    expect(target.url).not.toBe(PLAYLIST_URL)

    // 3. Bound the transfer from read-only metadata before queueing anything.
    const bound = probeTransferBound(target.url, tempRoot)
    expect(bound.durationSeconds).toBeLessThanOrEqual(MAX_DURATION_SECONDS)
    expect(bound.estimateBytes).toBeLessThanOrEqual(MAX_TRANSFER_BYTES)
    expect(bound.container).toBe(PINNED_CONTAINER)
    expect(bound.height).toBe(PINNED_HEIGHT)

    // 4. Fresh MediaEngine analysis. The pinned entry identity must still
    //    match; no download is started until the option is chosen explicitly.
    const analysis = await activeManager.analyzeMedia({ url: target.url })
    expect(analysis.title).toBe(PINNED_ENTRY_TITLE)
    expect(analysis.durationSeconds).not.toBeNull()
    expect(
      Math.abs(
        (analysis.durationSeconds as number) - PINNED_ENTRY_DURATION_SECONDS
      )
    ).toBeLessThanOrEqual(2)

    const option = findMuxedOption(analysis, bound)
    if (option.filesizeBytes !== null) {
      expect(option.filesizeBytes).toBeLessThanOrEqual(MAX_TRANSFER_BYTES)
    }

    // 5. Exactly one explicit queue call for the selected entry and option.
    const queued = await activeManager.queueMedia({
      analysisId: analysis.analysisId,
      optionId: option.optionId
    })
    activeJobId = queued.id

    const finished = await waitForTerminalJob(
      activeManager,
      queued.id,
      DOWNLOAD_TIMEOUT_MS
    )
    expect(overBound).toBe(false)
    if (finished.status !== 'complete') {
      throw new Error(
        `The selected playlist download failed: ${finished.errorMessage ?? 'unknown media error'} (status=${finished.status})`
      )
    }

    expect(finished.title).toBe(PINNED_ENTRY_TITLE)
    expect(finished.kind).toBe('video')
    expect(finished.label).toBe(option.label)
    expect(finished.errorMessage).toBeNull()

    // MediaJob is deliberately renderer-safe and exposes no disk path. The
    // isolated output directory must contain exactly the one completed file.
    const files = await listFilesRecursive(mediaDir)
    expect(files).toHaveLength(1)
    const filePath = files[0]
    if (!filePath) throw new Error('The completed media file is missing.')
    expect(isInsideDirectory(mediaDir, filePath)).toBe(true)
    expect(files.some((file) => file.endsWith('.part'))).toBe(false)
    expect(files.some((file) => file.endsWith('.ytdl'))).toBe(false)

    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(0)
    expect(stat.size).toBeLessThanOrEqual(MAX_TRANSFER_BYTES)
    expect(finished.completedBytes).toBe(stat.size)
    expect(finished.totalBytes).toBe(stat.size)

    const sha256 = await sha256File(filePath)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)

    // 6. Decode the whole file in bounded, quiet mode. This proves both the
    //    video and audio streams are readable, not only that bytes landed.
    const decode = spawnSync(
      path.resolve(FFMPEG_PATH),
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-f',
        'null',
        '-'
      ],
      {
        cwd: tempRoot,
        env: buildLiveEnv(),
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      }
    )
    if (decode.error) {
      throw new Error(
        `The downloaded media could not be decoded: ${decode.error.message}`
      )
    }
    expect(decode.status).toBe(0)

    console.log(
      `[playlist-download-live] verified "${finished.title}" at position ${PINNED_ENTRY_POSITION}: ${stat.size} bytes, sha256=${sha256}, option="${option.label}", previewEntries=${preview.entryCount}`
    )

    // 7. Deterministic cleanup inside the test as well as in afterAll.
    await activeManager.close()
    manager = null
    await removeDirectory(tempRoot)
    tempRoot = ''
  }, 360_000)
})
