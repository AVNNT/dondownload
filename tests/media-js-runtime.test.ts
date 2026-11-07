import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAnalyzeArgs,
  buildDownloadArgs,
  buildPlaylistArgs
} from '../src/main/media/args'
import { locateMediaTool } from '../src/main/media/locator'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('optional Deno runtime support', () => {
  it('locates Deno from a vendor resource directory when one is present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-deno-'))
    roots.push(root)
    const denoPath = path.join(root, 'vendor', 'deno', 'deno.exe')
    await fs.mkdir(path.dirname(denoPath), { recursive: true })
    await fs.writeFile(denoPath, 'fixture')

    await expect(
      locateMediaTool('deno', {
        env: {},
        platform: 'win32',
        cwd: root
      })
    ).resolves.toMatchObject({ path: denoPath, explicit: false, missingExplicit: false })
  })

  it('adds the located runtime before the URL terminator for each yt-dlp operation', () => {
    const denoPath = 'C:\\Program Files\\DonDownload\\resources\\vendor\\deno\\deno.exe'
    const analyze = buildAnalyzeArgs('https://example.com/video', denoPath)
    const playlist = buildPlaylistArgs('https://example.com/list', denoPath)
    const download = buildDownloadArgs({
      sourceUrl: 'https://example.com/video',
      formatSelector: 'best',
      outputTemplate: 'video.%(ext)s',
      mergeOutputFormat: null,
      ffmpegLocation: null,
      denoPath
    })

    for (const args of [analyze, playlist, download]) {
      const separator = args.indexOf('--')
      expect(args.slice(separator - 2, separator)).toEqual([
        '--js-runtimes',
        `deno:${denoPath}`
      ])
      expect(args[separator + 1]).toMatch(/^https:\/\//)
    }
  })

  it('emits exactly the same arguments as a machine without Deno', () => {
    for (const denoPath of [undefined, null, '']) {
      const analyze = buildAnalyzeArgs('https://example.com/video', denoPath)
      const playlist = buildPlaylistArgs('https://example.com/list', denoPath)
      const download = buildDownloadArgs({
        sourceUrl: 'https://example.com/video',
        formatSelector: 'best',
        outputTemplate: 'video.%(ext)s',
        mergeOutputFormat: null,
        ffmpegLocation: null,
        denoPath
      })

      for (const args of [analyze, playlist, download]) {
        expect(args).not.toContain('--js-runtimes')
        expect(args.filter((arg) => arg.startsWith('deno:'))).toEqual([])
      }
    }
  })
})
