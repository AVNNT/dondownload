import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PAIR_RENAME_OUTSIDE_ROOT,
  PAIR_RENAME_SCRIPT_FAILED,
  PAIR_RENAME_TARGET_EXISTS,
  applyPairRename,
  type PairRenameFile
} from '../src/main/scanner/pairRename'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-pair-'))
  roots.push(root)
  return root
}

async function writeFile(filePath: string, contents = 'script'): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, contents, 'utf8')
}

function file(
  itemId: string,
  filePath: string,
  axis: string | null = null,
  variant: string | null = null,
  status = 'complete'
): PairRenameFile {
  return { itemId, filePath, axis, variant, status }
}

async function names(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).sort()
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('applyPairRename', () => {
  it('renames a full multi-axis set in place', async () => {
    const root = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, 'Fancam 01 Wonyoung.mp4')
    const main = path.join(media, 'Old name.funscript')
    const roll = path.join(media, 'Old name.roll.funscript')
    const surge = path.join(media, 'Old name.surge.funscript')
    await writeFile(video)
    await writeFile(main, 'main')
    await writeFile(roll, 'roll')
    await writeFile(surge, 'surge')

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [
        file('main', main),
        file('roll', roll, 'roll'),
        file('surge', surge, 'surge')
      ],
      primaryVariant: null,
      rename: true
    })

    expect(result.status).toBe('renamed')
    expect(await names(media)).toEqual([
      'Fancam 01 Wonyoung.funscript',
      'Fancam 01 Wonyoung.mp4',
      'Fancam 01 Wonyoung.roll.funscript',
      'Fancam 01 Wonyoung.surge.funscript'
    ])
    expect(await fs.readFile(path.join(media, 'Fancam 01 Wonyoung.roll.funscript'), 'utf8')).toBe(
      'roll'
    )
  })

  it('promotes a primary variant and keeps the displaced plain file as original', async () => {
    const root = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, 'Fancam 02 Wonyoung.mp4')
    const plain = path.join(media, 'Old.funscript')
    const hard = path.join(media, 'Old.hard.funscript')
    const hardRoll = path.join(media, 'Old.hard.roll.funscript')
    await writeFile(video)
    await writeFile(plain, 'plain')
    await writeFile(hard, 'hard')
    await writeFile(hardRoll, 'hard-roll')

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [
        file('plain', plain),
        file('hard', hard, null, 'hard'),
        file('hard-roll', hardRoll, 'roll', 'hard')
      ],
      primaryVariant: 'hard',
      rename: true
    })

    expect(result.status).toBe('renamed')
    expect(await names(media)).toEqual([
      'Fancam 02 Wonyoung.funscript',
      'Fancam 02 Wonyoung.mp4',
      'Fancam 02 Wonyoung.original.funscript',
      'Fancam 02 Wonyoung.roll.funscript'
    ])
  })

  it('keeps every original name when renaming is off', async () => {
    const root = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, 'Video.mp4')
    const main = path.join(media, 'Old.funscript')
    await writeFile(video)
    await writeFile(main)

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [file('main', main)],
      primaryVariant: null,
      rename: false
    })

    expect(result).toMatchObject({ status: 'kept' })
    expect(await names(media)).toEqual(['Old.funscript', 'Video.mp4'])
  })

  it('never overwrites an existing target', async () => {
    const root = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, 'Fancam 01 Wonyoung.mp4')
    const main = path.join(media, 'Old.funscript')
    const roll = path.join(media, 'Old.roll.funscript')
    const existing = path.join(media, 'Fancam 01 Wonyoung.roll.funscript')
    await writeFile(video)
    await writeFile(main, 'main')
    await writeFile(roll, 'roll')
    await writeFile(existing, 'existing')

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [file('main', main), file('roll', roll, 'roll')],
      primaryVariant: null,
      rename: true
    })

    expect(result).toEqual({
      status: 'skipped',
      reason: PAIR_RENAME_TARGET_EXISTS
    })
    // All-or-nothing: the main file was not renamed either.
    expect(await names(media)).toEqual([
      'Fancam 01 Wonyoung.mp4',
      'Fancam 01 Wonyoung.roll.funscript',
      'Old.funscript',
      'Old.roll.funscript'
    ])
    expect(await fs.readFile(existing, 'utf8')).toBe('existing')
  })

  it('renames none of the set when a script download failed', async () => {
    const root = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, 'Video.mp4')
    const main = path.join(media, 'Old.funscript')
    const roll = path.join(media, 'Old.roll.funscript')
    await writeFile(video)
    await writeFile(main)
    await writeFile(roll)

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [
        file('main', main),
        file('roll', roll, 'roll', null, 'error')
      ],
      primaryVariant: null,
      rename: true
    })

    expect(result).toEqual({
      status: 'skipped',
      reason: PAIR_RENAME_SCRIPT_FAILED
    })
    expect(await names(media)).toEqual(['Old.funscript', 'Old.roll.funscript', 'Video.mp4'])
  })

  it('rejects a path outside the download root before touching any file', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, 'Video.mp4')
    const main = path.join(media, 'Old.funscript')
    const escaped = path.join(outside, 'Escaped.funscript')
    await writeFile(video)
    await writeFile(main)
    await writeFile(escaped)

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [file('main', main), file('escaped', escaped, 'roll')],
      primaryVariant: null,
      rename: true
    })

    expect(result).toEqual({
      status: 'skipped',
      reason: PAIR_RENAME_OUTSIDE_ROOT
    })
    expect(await names(media)).toEqual(['Old.funscript', 'Video.mp4'])
    expect(await names(outside)).toEqual(['Escaped.funscript'])
  })

  it('rejects a video path outside the download root', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const media = path.join(root, 'Media')
    const main = path.join(media, 'Old.funscript')
    const video = path.join(outside, 'Video.mp4')
    await writeFile(main)
    await writeFile(video)

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [file('main', main)],
      primaryVariant: null,
      rename: true
    })

    expect(result).toEqual({
      status: 'skipped',
      reason: PAIR_RENAME_OUTSIDE_ROOT
    })
  })

  it('handles unicode and bracket characters in the video name', async () => {
    const root = await tempRoot()
    const media = path.join(root, 'Media')
    const video = path.join(media, '【4K】캠 [Fancam] 01.mp4')
    const main = path.join(media, '원본.funscript')
    const roll = path.join(media, '원본.roll.funscript')
    await writeFile(video)
    await writeFile(main)
    await writeFile(roll)

    const result = await applyPairRename({
      rootDir: root,
      videoPath: video,
      videoStatus: 'complete',
      files: [file('main', main), file('roll', roll, 'roll')],
      primaryVariant: null,
      rename: true
    })

    expect(result.status).toBe('renamed')
    expect(await names(media)).toEqual([
      '【4K】캠 [Fancam] 01.funscript',
      '【4K】캠 [Fancam] 01.mp4',
      '【4K】캠 [Fancam] 01.roll.funscript'
    ])
  })
})
