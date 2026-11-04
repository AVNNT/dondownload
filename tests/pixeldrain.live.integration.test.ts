import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// DownloadManager and Aria2Service import Electron for shell/app access. The
// live test exercises the real Pixeldrain API, the real aria2 process and a
// real SQLite database, so only the Electron module itself is replaced.
vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

import { Aria2Service } from '../src/main/aria2/service'
import { openDownloadDatabase } from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import {
  PIXELDRAIN_ORIGIN,
  resolvePixeldrainFile
} from '../src/main/hosts/pixeldrain'
import type { DownloadItem } from '../src/shared/types'

/**
 * Opt-in live check for the single-file Pixeldrain path.
 *
 * The default `npm test` / `npm run test:gate` runs collect this file but skip
 * it because no network is allowed there. It only runs when both
 * DONDOWNLOAD_LIVE_PIXELDRAIN=1 and ARIA2_TEST_BINARY point at a real aria2c:
 *
 *   $env:DONDOWNLOAD_LIVE_PIXELDRAIN = '1'
 *   $env:ARIA2_TEST_BINARY = 'C:\tools\aria2\aria2c.exe'
 *   npm run test:pixeldrain:live
 *
 * The public fixture is a small, openly shared test video. Before any file
 * transfer the metadata is re-queried and compared with the pinned identity
 * below. If the provider changed the fixture, the test fails before aria2 is
 * asked to download anything and reports which field changed.
 *
 * List downloads are deliberately not exercised: there is no clearly licensed,
 * known public list fixture in this repository, so live list verification is
 * blocked rather than guessed. Only the documented public metadata endpoint is
 * queried, with no authentication, cookies, redirects, CAPTCHA handling or
 * rate-limit workarounds.
 */

const FIXTURE_URL = 'https://pixeldrain.com/u/VFjemoqC'
const FIXTURE_ID = 'VFjemoqC'
const FIXTURE_NAME = 'youtube-dl_test_video.mp4'
const FIXTURE_SIZE = 1_828_366
const FIXTURE_SHA256 =
  '064ff1aeea14849f670d95f4096325625e46dac5a9d109a18aa5b84e3ab2b51e'
const FIXTURE_MIME_TYPE = 'video/mp4'
const FIXTURE_DOWNLOAD_URL = `${PIXELDRAIN_ORIGIN}/api/file/${FIXTURE_ID}`

const LIVE_ENABLED = process.env.DONDOWNLOAD_LIVE_PIXELDRAIN === '1'
const ARIA2_BINARY = process.env.ARIA2_TEST_BINARY?.trim() ?? ''
const runLive =
  LIVE_ENABLED && ARIA2_BINARY.length > 0 ? describe : describe.skip

/** Keep every artifact under the approved temp base, never user Downloads. */
const TEMP_BASE = path.join(os.tmpdir(), 'opencode')
const DOWNLOAD_TIMEOUT_MS = 90_000

interface LiveFixtureMetadata {
  id: string
  name: string
  size: number
  sha256: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Re-query the public info endpoint without following redirects or auth. */
async function fetchLiveFixtureMetadata(): Promise<LiveFixtureMetadata> {
  const response = await fetch(
    `${PIXELDRAIN_ORIGIN}/api/file/${FIXTURE_ID}/info`,
    {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    }
  )

  if (response.status !== 200) {
    throw new Error(
      `Pixeldrain fixture metadata returned HTTP ${response.status}; refusing to download.`
    )
  }

  const payload: unknown = await response.json()
  if (!isRecord(payload) || payload.success !== true) {
    throw new Error(
      'Pixeldrain fixture metadata was not a successful JSON object; refusing to download.'
    )
  }

  const { id, name, size, hash_sha256: sha256 } = payload
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    typeof sha256 !== 'string'
  ) {
    throw new Error(
      'Pixeldrain fixture metadata is missing id, name, size or hash_sha256; refusing to download.'
    )
  }

  return { id, name, size, sha256 }
}

/** Return a human-readable list of changed fields, or null when pinned. */
function describeFixtureMismatch(
  metadata: LiveFixtureMetadata
): string | null {
  const differences: string[] = []
  if (metadata.id !== FIXTURE_ID) differences.push(`id=${metadata.id}`)
  if (metadata.name !== FIXTURE_NAME) differences.push(`name=${metadata.name}`)
  if (metadata.size !== FIXTURE_SIZE) differences.push(`size=${metadata.size}`)
  if (metadata.sha256.toLowerCase() !== FIXTURE_SHA256) {
    differences.push(`sha256=${metadata.sha256}`)
  }
  return differences.length === 0 ? null : differences.join(', ')
}

async function sha256File(filePath: string): Promise<string> {
  const contents = await fs.readFile(filePath)
  return createHash('sha256').update(contents).digest('hex')
}

function getDownload(manager: DownloadManager, id: string): DownloadItem {
  const download = manager
    .getSnapshot()
    .downloads.find((record) => record.id === id)
  if (!download) throw new Error(`Download ${id} is missing from the snapshot.`)
  return download
}

async function waitForDownload(
  manager: DownloadManager,
  id: string,
  predicate: (download: DownloadItem) => boolean,
  label: string,
  timeoutMs: number
): Promise<DownloadItem> {
  const deadline = Date.now() + timeoutMs
  let last: DownloadItem | null = null

  while (Date.now() < deadline) {
    last = getDownload(manager, id)
    if (predicate(last)) return last
    await delay(100)
  }

  throw new Error(
    `Timed out waiting for ${label}. Last download state: ${JSON.stringify(last)}`
  )
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

/**
 * Optional decode probe. It is informational only: size and SHA-256 are the
 * authoritative integrity checks. A missing or failing ffprobe never turns a
 * verified download into a failure.
 */
function probeWithFfprobe(filePath: string): string | null {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration',
      '-of',
      'json',
      filePath
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }
  )

  if (result.error) return null
  if (result.status !== 0) {
    console.warn(
      '[pixeldrain-live] ffprobe could not inspect the download; optional decode check skipped.'
    )
    return null
  }
  return result.stdout.trim()
}

runLive('Pixeldrain live file integration', () => {
  let tempRoot = ''
  let downloadDir = ''
  let databasePath = ''
  let service: Aria2Service | null = null
  let manager: DownloadManager | null = null
  const previousAria2Override = process.env.DONDOWNLOAD_ARIA2_PATH

  beforeAll(async () => {
    await fs.mkdir(TEMP_BASE, { recursive: true })
    tempRoot = await fs.mkdtemp(path.join(TEMP_BASE, 'pixeldrain-live-'))
    downloadDir = path.join(tempRoot, 'downloads')
    databasePath = path.join(tempRoot, 'downloads.sqlite3')

    process.env.DONDOWNLOAD_ARIA2_PATH = path.resolve(ARIA2_BINARY)
    service = new Aria2Service(() => downloadDir)
    manager = new DownloadManager(
      service,
      downloadDir,
      () => undefined,
      openDownloadDatabase(databasePath)
    )
    await service.start()
  }, 60_000)

  afterAll(async () => {
    try {
      manager?.close()
    } catch {
      // Best effort during teardown.
    }
    try {
      await service?.stop()
    } catch {
      // Best effort during teardown.
    }
    // Give the killed aria2 process a moment to release its handles before the
    // unique temp root is removed.
    await delay(500)

    if (previousAria2Override === undefined) {
      delete process.env.DONDOWNLOAD_ARIA2_PATH
    } else {
      process.env.DONDOWNLOAD_ARIA2_PATH = previousAria2Override
    }

    if (tempRoot.length > 0) {
      const approvedPrefix = `${path.resolve(TEMP_BASE)}${path.sep}`
      if (path.resolve(tempRoot).startsWith(approvedPrefix)) {
        await removeDirectory(tempRoot)
      }
    }
  }, 30_000)

  it('resolves live metadata and downloads the public fixture exactly', async () => {
    if (!manager) throw new Error('DownloadManager is not ready.')
    const activeManager = manager
    const startedAt = Date.now()

    // 1. Real adapter metadata resolution through the public info endpoint.
    const resolved = await resolvePixeldrainFile(FIXTURE_URL, {
      timeoutMs: 20_000
    })
    expect(resolved).toEqual({
      kind: 'file',
      fileId: FIXTURE_ID,
      name: FIXTURE_NAME,
      size: FIXTURE_SIZE,
      mimeType: FIXTURE_MIME_TYPE,
      sourceUrl: FIXTURE_URL,
      downloadUrl: FIXTURE_DOWNLOAD_URL
    })

    // 2. Re-query immediately before transfer and fail safely if the fixture
    //    identity changed. Nothing has been added to aria2 at this point.
    const metadata = await fetchLiveFixtureMetadata()
    const mismatch = describeFixtureMismatch(metadata)
    if (mismatch !== null) {
      throw new Error(
        `Pixeldrain fixture metadata changed (${mismatch}); refusing to start the file transfer.`
      )
    }
    expect(metadata).toEqual({
      id: FIXTURE_ID,
      name: FIXTURE_NAME,
      size: FIXTURE_SIZE,
      sha256: FIXTURE_SHA256
    })

    // 3. Use the existing production path: resolve to the raw endpoint, then
    //    hand that URL and name to DownloadManager/aria2.
    const added = await activeManager.add({
      url: resolved.downloadUrl,
      filename: resolved.name
    })
    const id = added.downloads[0]?.id
    if (!id) throw new Error('The added download has no id.')

    const finished = await waitForDownload(
      activeManager,
      id,
      (download) => download.status === 'complete' || download.status === 'error',
      'the Pixeldrain download to finish',
      DOWNLOAD_TIMEOUT_MS
    )
    if (finished.status !== 'complete') {
      throw new Error(
        `The Pixeldrain download failed: ${finished.errorMessage ?? 'unknown aria2 error'}`
      )
    }

    expect(finished.totalBytes).toBe(FIXTURE_SIZE)
    expect(finished.completedBytes).toBe(FIXTURE_SIZE)
    expect(finished.filePath).not.toBeNull()

    const filePath = finished.filePath as string
    const relative = path.relative(downloadDir, filePath)
    expect(relative.startsWith('..')).toBe(false)
    expect(path.isAbsolute(relative)).toBe(false)
    expect(path.basename(filePath)).toBe(FIXTURE_NAME)

    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(FIXTURE_SIZE)

    const actualSha256 = await sha256File(filePath)
    expect(actualSha256).toBe(FIXTURE_SHA256)

    const probe = probeWithFfprobe(filePath)
    if (probe !== null) {
      console.log(`[pixeldrain-live] optional ffprobe: ${probe}`)
    }

    const durationMs = Date.now() - startedAt
    console.log(
      `[pixeldrain-live] verified ${FIXTURE_NAME} (${FIXTURE_SIZE} bytes, sha256=${actualSha256}) in ~${durationMs} ms`
    )
  }, 120_000)
})
