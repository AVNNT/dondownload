import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The probe only reads the filesystem, so a small in-memory tree is enough to
 * pin down which file it samples and what it compares the size against.
 */
interface FakeEntry {
  kind: 'file' | 'directory'
  size?: number
  mtimeMs?: number
}

const tree = vi.hoisted(() => new Map<string, FakeEntry>())
const readdirCalls = vi.hoisted(() => [] as string[])

vi.mock('node:fs', () => ({
  promises: {
    readdir: async (directory: string) => {
      readdirCalls.push(directory)
      const prefix = directory.endsWith('\\') || directory.endsWith('/')
        ? directory
        : `${directory}\\`
      const seen = new Set<string>()
      const entries: Array<{
        name: string
        isFile: () => boolean
        isDirectory: () => boolean
      }> = []
      for (const [fullPath, entry] of tree) {
        if (!fullPath.startsWith(prefix)) continue
        const rest = fullPath.slice(prefix.length)
        if (rest.length === 0 || rest.includes('\\')) continue
        if (seen.has(rest)) continue
        seen.add(rest)
        entries.push({
          name: rest,
          isFile: () => entry.kind === 'file',
          isDirectory: () => entry.kind === 'directory'
        })
      }
      return entries
    },
    stat: async (filePath: string) => {
      const entry = tree.get(filePath)
      if (!entry || entry.kind !== 'file') throw new Error('ENOENT')
      return {
        isFile: () => true,
        size: entry.size ?? 0,
        mtimeMs: entry.mtimeMs ?? 0
      }
    }
  }
}))

import { readMergeProgress } from '../src/main/mediaJobs/mergeProgress'

const ROOT = 'C:\\Media'
const STAGING = `${ROOT}\\.dondownload-job`
const MERGE_STARTED_AT = 1_700_000_000_000

function seed(
  filePath: string,
  entry: FakeEntry
): void {
  tree.set(filePath, entry)
}

function seedDirectory(directory: string): void {
  tree.set(directory, { kind: 'directory' })
}

beforeEach(() => {
  tree.clear()
  readdirCalls.length = 0
  seedDirectory(ROOT)
  seedDirectory(STAGING)
})

describe('readMergeProgress', () => {
  it('samples the staging temp file against the reported input total', async () => {
    seed(`${STAGING}\\Title.temp.mp4`, {
      kind: 'file',
      size: 4_100,
      mtimeMs: MERGE_STARTED_AT + 2_000
    })

    await expect(
      readMergeProgress({
        dir: ROOT,
        since: MERGE_STARTED_AT,
        totalBytes: 10_200
      })
    ).resolves.toEqual({ completedBytes: 4_100, totalBytes: 10_200 })
  })

  it('grows with the merge output file', async () => {
    const tempPath = `${STAGING}\\Title.temp.mp4`
    seed(tempPath, { kind: 'file', size: 1_000, mtimeMs: MERGE_STARTED_AT + 1_000 })
    const probe = { dir: ROOT, since: MERGE_STARTED_AT, totalBytes: 10_200 }

    await expect(readMergeProgress(probe)).resolves.toEqual({
      completedBytes: 1_000,
      totalBytes: 10_200
    })

    seed(tempPath, { kind: 'file', size: 6_000, mtimeMs: MERGE_STARTED_AT + 2_000 })
    await expect(readMergeProgress(probe)).resolves.toEqual({
      completedBytes: 6_000,
      totalBytes: 10_200
    })
  })

  it('never reports more than the total, so the bar cannot pass the end', async () => {
    seed(`${STAGING}\\Title.temp.mp4`, {
      kind: 'file',
      size: 12_000,
      mtimeMs: MERGE_STARTED_AT + 1_000
    })

    await expect(
      readMergeProgress({
        dir: ROOT,
        since: MERGE_STARTED_AT,
        totalBytes: 10_200
      })
    ).resolves.toEqual({ completedBytes: 10_200, totalBytes: 10_200 })
  })

  it('ignores a stale temp file from an earlier merge', async () => {
    seed(`${STAGING}\\Old title.temp.mp4`, {
      kind: 'file',
      size: 9_999,
      mtimeMs: MERGE_STARTED_AT - 10 * 60_000
    })

    await expect(
      readMergeProgress({
        dir: ROOT,
        since: MERGE_STARTED_AT,
        totalBytes: 10_200
      })
    ).resolves.toBeNull()
  })

  it('falls back to the on-disk input parts when no total was reported', async () => {
    seed(`${STAGING}\\Title.temp.mp4`, {
      kind: 'file',
      size: 500,
      mtimeMs: MERGE_STARTED_AT + 1_000
    })
    seed(`${STAGING}\\Title.f137.mp4`, {
      kind: 'file',
      size: 3_000,
      mtimeMs: MERGE_STARTED_AT - 1_000
    })
    seed(`${STAGING}\\Title.f140.m4a`, {
      kind: 'file',
      size: 1_000,
      mtimeMs: MERGE_STARTED_AT - 1_000
    })
    // Unrelated staging content must not inflate the total.
    seed(`${STAGING}\\cookies-abc123.txt`, {
      kind: 'file',
      size: 400,
      mtimeMs: MERGE_STARTED_AT - 1_000
    })

    await expect(
      readMergeProgress({ dir: ROOT, since: MERGE_STARTED_AT, totalBytes: null })
    ).resolves.toEqual({ completedBytes: 500, totalBytes: 4_000 })
  })

  it('reports nothing while the merge output does not exist yet', async () => {
    seed(`${STAGING}\\Title.f137.mp4`, {
      kind: 'file',
      size: 3_000,
      mtimeMs: MERGE_STARTED_AT
    })

    await expect(
      readMergeProgress({
        dir: ROOT,
        since: MERGE_STARTED_AT,
        totalBytes: 10_200
      })
    ).resolves.toBeNull()
  })

  it('reports nothing when the output directory is unreadable', async () => {
    await expect(
      readMergeProgress({
        dir: 'C:\\Missing',
        since: MERGE_STARTED_AT,
        totalBytes: 10_200
      })
    ).resolves.toBeNull()
  })
})
