import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import { DownloadManager } from '../src/main/downloads/manager'
import { buildDownloadArgs } from '../src/main/media/args'
import {
  parseSniffedMediaInput,
  redactCookieHeader,
  redactCookieValue,
  sniffedMediaFilename
} from '../src/shared/sniffedMedia'
import { parseDownloadRequestHeaders } from '../src/shared/validation'

const PAGE = 'https://site.example/watch/1'

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://cdn.example/media/clip.mp4?token=1',
    pageUrl: PAGE,
    referer: PAGE,
    userAgent: 'Mozilla/5.0 Test Browser',
    kind: 'file',
    title: 'My clip',
    ...overrides
  }
}

describe('detected media contract', () => {
  it('accepts a normal file and a pinned HLS variant', () => {
    expect(parseSniffedMediaInput(valid())).toMatchObject({
      url: 'https://cdn.example/media/clip.mp4?token=1',
      pageUrl: PAGE,
      referer: PAGE,
      kind: 'file'
    })
    expect(
      parseSniffedMediaInput(
        valid({
          url: 'https://cdn.example/master.m3u8',
          kind: 'hls',
          variant: {
            url: 'https://cdn.example/high.m3u8',
            label: '720p',
            width: 1280,
            height: 720,
            bandwidth: 2_400_000
          }
        })
      )
    ).toMatchObject({
      kind: 'hls',
      variant: { url: 'https://cdn.example/high.m3u8', height: 720 }
    })
  })

  it('rejects non-http URLs, cross-origin referers and variant misuse', () => {
    expect(() => parseSniffedMediaInput(valid({ url: 'file:///etc/passwd' }))).toThrow()
    expect(() =>
      parseSniffedMediaInput(valid({ referer: 'https://evil.example/' }))
    ).toThrow()
    expect(() =>
      parseSniffedMediaInput(
        valid({ variant: { url: 'https://cdn.example/high.m3u8' } })
      )
    ).toThrow()
  })

  it('rejects oversized or control-character header values', () => {
    expect(() =>
      parseSniffedMediaInput(valid({ userAgent: 'x'.repeat(513) }))
    ).toThrow()
    expect(() =>
      parseSniffedMediaInput(valid({ cookie: 'a=1\r\nX-Evil: 1' }))
    ).toThrow()
    expect(() =>
      parseSniffedMediaInput(valid({ title: 'x'.repeat(501) }))
    ).toThrow()
    expect(() =>
      parseSniffedMediaInput(valid({ expectedBytes: 1024 ** 4 }))
    ).toThrow()
  })

  it('accepts only the three per-download headers', () => {
    expect(
      parseDownloadRequestHeaders({
        referer: PAGE,
        userAgent: 'UA',
        cookie: 'auth=1; theme=dark'
      })
    ).toEqual({ referer: PAGE, userAgent: 'UA', cookie: 'auth=1; theme=dark' })
    expect(() =>
      parseDownloadRequestHeaders({ referer: PAGE, authorization: 'secret' })
    ).toThrow()
    expect(() =>
      parseDownloadRequestHeaders({ cookie: 'a=1\nb=2' })
    ).toThrow()
  })

  it('builds a title-based filename, never a URL id', () => {
    const input = parseSniffedMediaInput(valid({ title: 'Clip: one?' }))
    expect(sniffedMediaFilename(input)).toBe('Clip_ one_.mp4')
    const hls = parseSniffedMediaInput(
      valid({
        url: 'https://cdn.example/abc123/master.m3u8',
        kind: 'hls',
        title: 'Episode 4'
      })
    )
    expect(sniffedMediaFilename(hls)).toBe('Episode 4.mp4')
    const mp3 = parseSniffedMediaInput(
      valid({
        url: 'https://cdn.example/track-123456',
        kind: 'file',
        filename: 'song.mp3',
        title: 'A song/with:slashes'
      })
    )
    expect(sniffedMediaFilename(mp3)).toBe('A song_with_slashes.mp3')
  })

  it('redacts cookie headers from diagnostics', () => {
    const secret = 'auth=top-secret; theme=dark'
    const line = `request failed\nCookie: ${secret}\nretry`
    const safe = redactCookieHeader(line)
    expect(safe).not.toContain('top-secret')
    expect(safe).toContain('Cookie: [REDACTED]')
    expect(redactCookieValue(secret)).toBe('[REDACTED]')
  })
})

describe('detected media download arguments', () => {
  it('adds Referer and User-Agent before -- and keeps cookies out of argv', () => {
    const args = buildDownloadArgs({
      sourceUrl: 'https://cdn.example/master.m3u8',
      formatSelector: 'bestvideo*+bestaudio/best',
      outputTemplate: 'out.%(ext)s',
      mergeOutputFormat: 'mp4',
      remuxOutputFormat: 'mp4',
      ffmpegLocation: 'C:\\tools\\ffmpeg.exe',
      referer: PAGE,
      userAgent: 'Browser UA',
      cookiesPath: 'C:\\staging\\.dondownload-cookies-abc.txt'
    })
    expect(args[args.indexOf('--referer') + 1]).toBe(PAGE)
    expect(args[args.indexOf('--user-agent') + 1]).toBe('Browser UA')
    // The cookie is only ever a Netscape file; a Cookie header on the command
    // line would be readable by any local process.
    expect(args[args.indexOf('--cookies') + 1]).toBe(
      'C:\\staging\\.dondownload-cookies-abc.txt'
    )
    expect(args).not.toContain('--add-header')
    expect(args.join(' ')).not.toContain('Cookie:')
    expect(args[args.length - 2]).toBe('--')
    expect(args[args.length - 1]).toBe('https://cdn.example/master.m3u8')
    expect(args).toContain('--concurrent-fragments')
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4')
  })

  it('does not add a Cookie header when the user did not opt in', () => {
    const args = buildDownloadArgs({
      sourceUrl: 'https://cdn.example/clip.mp4',
      formatSelector: 'best',
      outputTemplate: 'out.%(ext)s',
      mergeOutputFormat: null,
      ffmpegLocation: null,
      referer: PAGE,
      userAgent: 'Browser UA'
    })
    expect(args).not.toContain('--add-header')
    expect(args).not.toContain('--cookies')
    expect(args).toContain('--referer')
  })
})

describe('aria2 per-download headers', () => {
  const tempDirs: string[] = []
  const managers: DownloadManager[] = []

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      try {
        manager.close()
      } catch {
        // Best effort cleanup.
      }
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('passes referer, user-agent and the opted-in cookie to aria2 only', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-sniffed-'))
    tempDirs.push(dir)
    const calls: Array<{ url: string; options: Record<string, unknown> }> = []
    const state: Aria2State = {
      status: 'ready',
      version: 'test',
      binaryPath: null,
      message: null,
      hint: null
    }
    const client = {
      call: async (method: string, params: unknown[]) => {
        if (method !== 'aria2.addUri') throw new Error(method)
        calls.push({
          url: (params[0] as string[])[0] ?? '',
          options: (params[1] as Record<string, unknown>) ?? {}
        })
        return '0123456789abcdef'
      }
    }
    const aria2 = {
      getState: () => ({ ...state }),
      getReadyClient: () => client,
      getClient: async () => client,
      start: async () => client,
      stop: async () => undefined,
      restart: async () => undefined
    } as unknown as Aria2Service
    const manager = new DownloadManager(
      aria2,
      path.join(dir, 'downloads'),
      () => undefined,
      null,
      { resolveCookieTarget: async (input) => ({ finalUrl: input.url }) }
    )
    managers.push(manager)

    await manager.add({
      url: 'https://cdn.example/clip.mp4',
      filename: 'My clip.mp4',
      requestHeaders: {
        referer: PAGE,
        userAgent: 'Browser UA',
        cookie: 'auth=1'
      }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.referer).toBe(PAGE)
    expect(calls[0]?.options['user-agent']).toBe('Browser UA')
    expect(calls[0]?.options.header).toEqual(['Cookie: auth=1'])
    expect(calls[0]?.options.out).toBe('My clip.mp4')

    await manager.add({
      url: 'https://cdn.example/other.mp4',
      filename: 'My clip.mp4'
    })
    expect(calls[1]?.options.out).toBe('My clip (2).mp4')
  })
})
