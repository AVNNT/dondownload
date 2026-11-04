import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createMediaEngine } from '../src/main/media/engine'
import { normalizeMediaSourceUrl } from '../src/shared/media'
import type { CollectionPreview } from '../src/shared/batches'

/**
 * Opt-in live preview check for the 3B playlist path.
 *
 * This test intentionally performs NO media download. It calls the real
 * yt-dlp-backed MediaEngine exactly once to obtain a public playlist preview,
 * then resolves exactly one explicitly selected opaque entry ID to its
 * normalized page URL inside this main-process test. It never passes that URL
 * to a download manager and never writes media output.
 *
 * Enable it explicitly (the default suite skips it, and `test:fast` excludes
 * this file):
 *
 *   $env:DONDOWNLOAD_LIVE_PLAYLIST = '1'
 *   $env:DONDOWNLOAD_YTDLP_PATH = 'C:\tools\yt-dlp\yt-dlp.exe'
 *   # Optional when yt-dlp needs a JavaScript runtime for YouTube extraction:
 *   $env:DONDOWNLOAD_DENO_PATH = 'C:\tools\deno\deno.exe'
 *   npm run test:playlist:live
 *
 * The fixture is the official Blender Open Movies playlist (public, CC-BY):
 * https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz
 *
 * No cookies, browser profile, account, authentication, CAPTCHA handling or
 * provider scraping are used. Only yt-dlp's public flat-playlist metadata is
 * requested. If YouTube blocks anonymous access or the tool is unavailable, the
 * test fails once with the real error; it does not retry in a loop.
 */

const PLAYLIST_URL =
  'https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz'
const LIVE_ENABLED = process.env.DONDOWNLOAD_LIVE_PLAYLIST === '1'
const YTDLP_PATH = process.env.DONDOWNLOAD_YTDLP_PATH?.trim() ?? ''
const DENO_PATH = process.env.DONDOWNLOAD_DENO_PATH?.trim() ?? ''
const runLive =
  LIVE_ENABLED && YTDLP_PATH.length > 0 ? describe : describe.skip

/** Keep every artifact under the approved temp base, never user Downloads. */
const TEMP_BASE = path.join(os.tmpdir(), 'opencode')

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

/** List files recursively so the test can prove no media output appeared. */
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

/**
 * Build a child environment with the explicit yt-dlp path and, when provided,
 * Deno on PATH (yt-dlp uses it for YouTube JS extraction in recent releases).
 * No profile, cookie or authentication environment is added.
 */
function buildLiveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DONDOWNLOAD_YTDLP_PATH: path.resolve(YTDLP_PATH)
  }

  if (DENO_PATH.length > 0) {
    const denoDir = path.dirname(path.resolve(DENO_PATH))
    const currentPath = env.PATH ?? env.Path ?? ''
    const nextPath = `${denoDir}${path.delimiter}${currentPath}`
    env.PATH = nextPath
    env.Path = nextPath
  }

  return env
}

/** Assert the renderer-safe preview contains no URL or provider identifier. */
function expectSafePreview(preview: CollectionPreview): void {
  const serialized = JSON.stringify(preview)
  expect(serialized).not.toMatch(/https?:\/\//i)
  expect(serialized.toLowerCase()).not.toContain('youtube.com')
  expect(serialized.toLowerCase()).not.toContain('youtu.be')
  expect(serialized.toLowerCase()).not.toContain('watch?v=')
  expect(serialized.toLowerCase()).not.toContain('list=')
}

/** Extract a YouTube video ID only for the negative public-preview assertion. */
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
    const id = parsed.searchParams.get('v')
    return id && id.length > 0 ? id : null
  }
  return null
}

runLive('playlist live preview and selection resolution', () => {
  let tempRoot = ''
  let engine: ReturnType<typeof createMediaEngine> | null = null

  afterAll(async () => {
    try {
      await engine?.cancelAll()
    } catch {
      // Best effort during teardown.
    }
    await delay(200)
    if (tempRoot.length > 0) {
      const approvedPrefix = `${path.resolve(TEMP_BASE)}${path.sep}`
      if (path.resolve(tempRoot).startsWith(approvedPrefix)) {
        await removeDirectory(tempRoot)
      }
    }
  }, 30_000)

  it('previews the public Blender playlist and resolves one opaque entry without downloading media', async () => {
    await fs.mkdir(TEMP_BASE, { recursive: true })
    tempRoot = await fs.mkdtemp(path.join(TEMP_BASE, 'playlist-live-'))
    engine = createMediaEngine({
      env: buildLiveEnv(),
      platform: process.platform,
      // Any accidental yt-dlp output template relative to the working
      // directory lands here, where it can be detected and removed.
      cwd: tempRoot,
      // One public flat-playlist request can be slow on a cold yt-dlp cache.
      analysisTimeoutMs: 180_000
    })

    const activeEngine = engine

    // Exactly one analyzeCollection call. This is metadata-only.
    const preview = await activeEngine.analyzeCollection(PLAYLIST_URL)

    expect(preview.kind).toBe('playlist')
    expect(preview.title.toLowerCase()).toContain('blender')
    expect(preview.entryCount).toBe(preview.entries.length)
    expect(preview.entryCount).toBeGreaterThan(0)
    expect(preview.availableCount + preview.unavailableCount).toBe(
      preview.entryCount
    )
    expect(preview.availableCount).toBeGreaterThan(0)
    expect(preview.entries.map((entry) => entry.position)).toEqual(
      Array.from({ length: preview.entryCount }, (_value, index) => index)
    )
    expectSafePreview(preview)

    const selected = preview.entries.find(
      (entry) => entry.availability === 'available'
    )
    if (!selected) throw new Error('The playlist preview has no available entry.')

    // Explicit selection of one opaque entry ID. This is the only resolver
    // call and it stays entirely inside the main-process test.
    const targets = await activeEngine.resolveCollectionEntries(preview.id, [
      selected.id
    ])
    expect(targets).toHaveLength(1)

    const target = targets[0]
    if (!target) throw new Error('No selection target was returned.')
    expect(target.entryId).toBe(selected.id)
    expect(target.title).toBe(selected.title)

    const url = new URL(target.url)
    expect(url.protocol).toBe('https:')
    expect(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']).toContain(
      url.hostname
    )
    // The internal target is normalized exactly like any other media source.
    expect(() => normalizeMediaSourceUrl(target.url)).not.toThrow()
    expect(normalizeMediaSourceUrl(target.url)).toBe(target.url)
    expect(target.url).not.toBe(PLAYLIST_URL)

    // The public preview must never contain the resolved URL or its video ID;
    // that value exists only in this main-process result.
    const serializedPreview = JSON.stringify(preview)
    expect(serializedPreview).not.toContain(target.url)
    const videoId = videoIdFromUrl(target.url)
    if (videoId !== null) {
      expect(serializedPreview).not.toContain(videoId)
    }

    // No download was requested, so the isolated working directory must still
    // contain no media output.
    const files = await listFilesRecursive(tempRoot)
    expect(files).toEqual([])

    console.log(
      `[playlist-live] previewed "${preview.title}" with ${preview.entryCount} entries (${preview.availableCount} available); resolved one opaque entry to a normalized page URL without downloading media`
    )
  }, 240_000)
})
