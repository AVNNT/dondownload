import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MediaAnalysis,
  MediaJob,
  MediaSnapshot
} from '../src/shared/media'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import { BatchManager } from '../src/main/batches/manager'
import {
  ManualMatchStore,
  isUnsafeLocalPath
} from '../src/main/scanner/manualMatch'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-manual-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function aria() {
  return {
    status: 'ready' as const,
    version: '1.37.0',
    binaryPath: null,
    message: null,
    hint: null
  }
}

async function setup() {
  const root = await tempRoot()
  const downloadRoot = path.join(root, 'Downloads')
  const outside = path.join(root, 'Outside')
  await fs.mkdir(downloadRoot, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  const videoPath = path.join(outside, 'My Video.mp4')
  await fs.writeFile(videoPath, 'video')

  const store = new ManualMatchStore({ now: () => 1 })
  const picked = store.register(videoPath)

  let sequence = 0
  const downloads = new Map<string, DownloadItem>()
  const addedTokens: string[] = []
  const addedDirectories: string[] = []

  const snapshot = (): AppSnapshot => ({
    aria2: aria(),
    downloads: [...downloads.values()]
  })

  const downloadsPort = {
    add: vi.fn(async () => {
      throw new Error('manual match must not use the normal download root')
    }),
    addPairingFile: vi.fn(async (input: unknown, token: string) => {
      addedTokens.push(token)
      const folder = store.resolveFolder(token)
      if (!folder) throw new Error('token did not resolve')
      addedDirectories.push(folder.directory)
      const record = input as { url: string; filename?: string }
      const item: DownloadItem = {
        id: `dl_${sequence++}`,
        gid: `gid_${sequence}`,
        url: record.url,
        filename: record.filename ?? 'file.bin',
        dir: folder.directory,
        filePath: null,
        status: 'queued',
        totalBytes: 10,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: 1,
        updatedAt: 1,
        completedAt: null
      }
      downloads.set(item.id, item)
      return snapshot()
    }),
    pause: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => snapshot()),
    getItem: (id: string) => downloads.get(id) ?? null,
    getFilePath: (id: string) => downloads.get(id)?.filePath ?? null,
    adoptRenamedFileInFolder: (id: string, filePath: string) => {
      const item = downloads.get(id)
      if (!item) return
      item.filePath = filePath
      item.filename = path.basename(filePath)
    }
  }

  const mediaSnapshot = (): MediaSnapshot => ({
    tool: { status: 'ready', version: '1', message: null, hint: null },
    jobs: []
  })
  const mediaPort = {
    analyzeMedia: vi.fn(async (): Promise<MediaAnalysis> => {
      throw new Error('not used')
    }),
    queueMedia: vi.fn(async (): Promise<MediaJob> => {
      throw new Error('not used')
    }),
    cancelMedia: vi.fn(async (): Promise<MediaJob> => {
      throw new Error('not used')
    }),
    getMediaSnapshot: vi.fn(() => mediaSnapshot()),
    getJob: vi.fn(() => null),
    getFilePath: vi.fn(() => null)
  }

  const batches = new BatchManager({
    downloads: downloadsPort,
    mediaJobs: mediaPort,
    collectionEngine: {
      analyzeCollection: vi.fn(),
      resolveCollectionEntries: vi.fn()
    },
    pixeldrain: {
      parseLink: vi.fn(),
      resolveFile: vi.fn(),
      resolveList: vi.fn()
    },
    onUpdate: () => undefined,
    pollIntervalMs: 0,
    scanMediaDir: path.join(downloadRoot, 'Media'),
    scanRootDir: downloadRoot,
    resolvePairingFolder: (token) => store.resolveFolder(token)
  })

  const batch = await batches.createManualMatchBatch({
    title: 'Scan: My Video',
    scripts: [
      {
        url: 'https://forum.example/uploads/old.funscript',
        title: 'Old.funscript',
        filename: 'Old.funscript',
        scanItemId: 'item_script_main'
      },
      {
        url: 'https://forum.example/uploads/old.roll.funscript',
        title: 'Old.roll.funscript',
        filename: 'Old.roll.funscript',
        scanItemId: 'item_script_roll'
      }
    ],
    pairing: {
      setId: 'set:my-video@1',
      scriptItemIds: ['item_script_main', 'item_script_roll'],
      primaryVariant: null,
      rename: true
    },
    folderToken: picked.token
  })
  await batches.waitForIdle()

  return {
    root,
    downloadRoot,
    outside,
    videoPath,
    store,
    picked,
    downloads,
    addedTokens,
    addedDirectories,
    batches,
    batch
  }
}

async function completeDownloads(
  downloads: Map<string, DownloadItem>
): Promise<void> {
  for (const download of downloads.values()) {
    download.status = 'complete'
    download.filePath = path.join(download.dir, download.filename)
    download.completedBytes = 10
    download.completedAt = 2
    await fs.writeFile(download.filePath, download.filename)
  }
}

describe('manual match folder token', () => {
  it('rejects raw, relative, UNC and device paths', () => {
    expect(isUnsafeLocalPath('C:\\Videos\\clip.mp4')).toBe(false)
    expect(isUnsafeLocalPath('relative\\clip.mp4')).toBe(true)
    expect(isUnsafeLocalPath('\\\\server\\share\\clip.mp4')).toBe(true)
    expect(isUnsafeLocalPath('\\\\.\\C:\\Videos\\clip.mp4')).toBe(true)
    expect(isUnsafeLocalPath('')).toBe(true)
  })

  it('requires a token and an existing picked file', async () => {
    const root = await tempRoot()
    const store = new ManualMatchStore({ now: () => 1 })
    expect(store.resolve('not-a-token')).toBeNull()
    expect(() => store.register(path.join(root, 'missing.mp4'))).toThrow()
    const video = path.join(root, 'clip.mp4')
    await fs.writeFile(video, 'v')
    const picked = store.register(video)
    expect(store.resolveFolder(picked.token)).toMatchObject({
      filePath: video,
      directory: root,
      filename: 'clip.mp4'
    })
    expect(store.resolveFolder('f'.repeat(32))).toBeNull()
  })
})

describe('manual match batch', () => {
  it('downloads scripts outside the download root only through the token', async () => {
    const setupState = await setup()
    // The fake addPairingFile exists only on the token path; the normal add
    // would throw. The scripts were queued into the exact picked folder.
    expect(setupState.addedTokens).toEqual([
      setupState.picked.token,
      setupState.picked.token
    ])
    expect(setupState.addedDirectories).toEqual([
      setupState.outside,
      setupState.outside
    ])
    expect(setupState.addedDirectories[0]).not.toBe(setupState.downloadRoot)

    await completeDownloads(setupState.downloads)
    setupState.batches.refresh()
    await setupState.batches.waitForIdle()

    const finished = setupState.batches.getBatch(setupState.batch.id)
    expect(finished.items.map((item) => item.label)).toEqual([
      'Renamed to match video',
      'Renamed to match video'
    ])
    expect((await fs.readdir(setupState.outside)).sort()).toEqual([
      'My Video.funscript',
      'My Video.mp4',
      'My Video.roll.funscript'
    ])
  })

  it('skips the whole set when a target already exists', async () => {
    const setupState = await setup()
    await fs.writeFile(path.join(setupState.outside, 'My Video.funscript'), 'x')
    await completeDownloads(setupState.downloads)
    setupState.batches.refresh()
    await setupState.batches.waitForIdle()

    const finished = setupState.batches.getBatch(setupState.batch.id)
    expect(finished.items.every((item) => item.label === 'Rename skipped: a matching script file already exists.')).toBe(true)
    expect((await fs.readdir(setupState.outside)).sort()).toEqual([
      'My Video.funscript',
      'My Video.mp4',
      'Old.funscript',
      'Old.roll.funscript'
    ])
  })

  it('renames nothing when one script fails', async () => {
    const setupState = await setup()
    const list = [...setupState.downloads.values()]
    for (const download of list) {
      download.status = 'complete'
      download.filePath = path.join(download.dir, download.filename)
      download.completedBytes = 10
      download.completedAt = 2
      await fs.writeFile(download.filePath, download.filename)
    }
    const first = list[0]
    if (first) {
      first.status = 'error'
      first.filePath = null
    }
    setupState.batches.refresh()
    await setupState.batches.waitForIdle()

    const finished = setupState.batches.getBatch(setupState.batch.id)
    expect(
      finished.items.every(
        (item) =>
          item.label ===
          'Rename skipped: a paired script did not finish downloading.'
      )
    ).toBe(true)
    expect((await fs.readdir(setupState.outside)).sort()).toEqual([
      'My Video.mp4',
      'Old.funscript',
      'Old.roll.funscript'
    ])
  })

  it('rejects a token that does not resolve in main', async () => {
    const root = await tempRoot()
    const batches = new BatchManager({
      downloads: {
        add: vi.fn(),
        pause: vi.fn(),
        getSnapshot: vi.fn(),
        getItem: vi.fn(() => null)
      },
      mediaJobs: {
        analyzeMedia: vi.fn(),
        queueMedia: vi.fn(),
        cancelMedia: vi.fn(),
        getMediaSnapshot: vi.fn(() => ({ tool: {} as never, jobs: [] })),
        getJob: vi.fn(() => null)
      },
      collectionEngine: {
        analyzeCollection: vi.fn(),
        resolveCollectionEntries: vi.fn()
      },
      pixeldrain: {
        parseLink: vi.fn(),
        resolveFile: vi.fn(),
        resolveList: vi.fn()
      },
      onUpdate: () => undefined,
      pollIntervalMs: 0,
      scanRootDir: root,
      resolvePairingFolder: () => null
    })
    await expect(
      batches.createManualMatchBatch({
        title: 'Scan: x',
        scripts: [
          {
            url: 'https://forum.example/a.funscript',
            title: 'a.funscript',
            filename: 'a.funscript',
            scanItemId: 'item_a'
          }
        ],
        pairing: {
          setId: 'set:x@1',
          scriptItemIds: ['item_a'],
          primaryVariant: null,
          rename: true
        },
        folderToken: 'a'.repeat(32)
      })
    ).rejects.toMatchObject({ code: 'PAIR_FOLDER_UNAVAILABLE' })
  })
})
