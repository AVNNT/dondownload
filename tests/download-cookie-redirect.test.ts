import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import {
  defaultResolveCookieTarget,
  DownloadManager,
  type CookieTargetResolver
} from '../src/main/downloads/manager'
import { AppError } from '../src/main/errors'

const tempDirs: string[] = []
const managers: DownloadManager[] = []

interface AddCall {
  url: string
  options: Record<string, string | string[]>
}

function createManager(
  resolveCookieTarget: CookieTargetResolver
): { manager: DownloadManager; calls: AddCall[]; downloadDir: string } {
  const calls: AddCall[] = []
  const downloadDir = path.join(
    os.tmpdir(),
    `dondownload-cookie-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  tempDirs.push(downloadDir)
  let nextGid = 0
  const state: Aria2State = {
    status: 'ready',
    version: 'test-aria2',
    binaryPath: null,
    message: null,
    hint: null
  }
  const client = {
    call: async (method: string, params: unknown[]): Promise<unknown> => {
      if (method !== 'aria2.addUri') {
        throw new AppError('ARIA2_RPC_ERROR', `Unexpected method ${method}`)
      }
      calls.push({
        url: (params[0] as string[])[0] ?? '',
        options: (params[1] as Record<string, string | string[]>) ?? {}
      })
      nextGid += 1
      return nextGid.toString(16).padStart(16, '0')
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
    downloadDir,
    () => undefined,
    null,
    { resolveCookieTarget }
  )
  managers.push(manager)
  return { manager, calls, downloadDir }
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      manager.close()
    } catch {
      // Best effort for a failing test.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

const ORIGINAL = 'https://discuss.example/uploads/short-url/XXXX.funscript'
const COOKIE = 'forum_session=secret'

describe('aria2 one-job cookie redirect scope', () => {
  it('uses a cross-host final URL and never sends the Cookie header', async () => {
    const finalUrl =
      'https://storage.example/bucket/XXXX.funscript?X-Amz-Signature=abc'
    const { manager, calls } = createManager(async () => ({ finalUrl }))

    await manager.add({
      url: ORIGINAL,
      filename: 'XXXX.funscript',
      requestHeaders: {
        referer: 'https://discuss.example/t/example/1',
        userAgent: 'Browser/1.0',
        cookie: COOKIE
      }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(finalUrl)
    expect(calls[0]!.options.header).toBeUndefined()
    expect(calls[0]!.options.referer).toBe('https://discuss.example/t/example/1')
    expect(calls[0]!.options['user-agent']).toBe('Browser/1.0')
    // The user-facing/duplicate record keeps the original source URL.
    expect(manager.getSnapshot().downloads[0]!.url).toBe(ORIGINAL)
  })

  it('keeps the Cookie for a same-host redirect and hands aria2 the final URL', async () => {
    const finalUrl = 'https://discuss.example/uploads/real.funscript'
    const { manager, calls } = createManager(async () => ({ finalUrl }))

    await manager.add({
      url: ORIGINAL,
      requestHeaders: { cookie: COOKIE }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(finalUrl)
    expect(calls[0]!.options.header).toEqual([`Cookie: ${COOKIE}`])
  })

  it('drops the Cookie on a same-host HTTPS -> HTTP downgrade', async () => {
    const finalUrl = 'http://discuss.example/uploads/real.funscript'
    const { manager, calls } = createManager(async () => ({ finalUrl }))

    await manager.add({
      url: ORIGINAL,
      requestHeaders: { cookie: COOKIE }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(finalUrl)
    expect(calls[0]!.options.header).toBeUndefined()
  })

  it('fails closed without adding an aria2 job when the redirect cannot be resolved', async () => {
    const { manager, calls } = createManager(async () => {
      throw new AppError(
        'HANDOFF_NEEDS_LOGIN',
        'The resource needs the browser login to be downloaded.'
      )
    })

    await expect(
      manager.add({
        url: ORIGINAL,
        requestHeaders: { cookie: COOKIE }
      })
    ).rejects.toMatchObject({ code: 'HANDOFF_NEEDS_LOGIN' })

    expect(calls).toHaveLength(0)
    expect(manager.getSnapshot().downloads).toHaveLength(0)
  })

  it('reuses a caller-resolved target instead of probing again', async () => {
    const finalUrl = 'https://discuss.example/uploads/real.funscript'
    const resolver = vi.fn(async (input: { resolvedUrl?: string }) => ({
      finalUrl: input.resolvedUrl ?? ORIGINAL
    }))
    const { manager, calls } = createManager(resolver)

    await manager.add({
      url: ORIGINAL,
      resolvedUrl: finalUrl,
      requestHeaders: { cookie: COOKIE }
    })

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ url: ORIGINAL, resolvedUrl: finalUrl })
    )
    expect(calls[0]!.url).toBe(finalUrl)
    expect(calls[0]!.options.header).toEqual([`Cookie: ${COOKIE}`])
  })
})

describe('production resolver re-validates a caller-resolved target', () => {
  it('refuses a caller-supplied private final URL instead of handing it to aria2', async () => {
    // The IPC path drops `resolvedUrl`, but a main-process caller could still
    // pass one. The production resolver must not forward it unchecked.
    await expect(
      defaultResolveCookieTarget({
        url: ORIGINAL,
        cookie: COOKIE,
        resolvedUrl: 'http://169.254.169.254/latest/meta-data/iam/'
      })
    ).rejects.toMatchObject({ code: 'MEDIA_TARGET_NOT_PUBLIC' })
  })

  it('refuses a loopback or localhost caller-supplied target', async () => {
    for (const target of [
      'http://127.0.0.1:8787/admin',
      'http://localhost:3000/file.zip'
    ]) {
      await expect(
        defaultResolveCookieTarget({
          url: ORIGINAL,
          cookie: COOKIE,
          resolvedUrl: target
        })
      ).rejects.toMatchObject({ code: 'MEDIA_TARGET_NOT_PUBLIC' })
    }
  })

  it('returns a canonicalized public caller-supplied target', async () => {
    await expect(
      defaultResolveCookieTarget({
        url: ORIGINAL,
        cookie: COOKIE,
        // example.com resolves here; the path fragment is dropped by URL().href.
        resolvedUrl: 'https://example.com/files/real.funscript#frag'
      })
    ).resolves.toEqual({ finalUrl: 'https://example.com/files/real.funscript' })
  })

  it('hands aria2 the final validated URL, not the redirecting original', async () => {
    // H3: aria2 replays --header on download-time redirects, so a Cookie job
    // must be added with the preflight-observed final URL. The original URL
    // can legitimately redirect, so it must never be what aria2 receives.
    const finalUrl = 'https://discuss.example/uploads/real.funscript?token=1'
    const resolver = vi.fn(async () => ({ finalUrl }))
    const { manager, calls } = createManager(resolver)

    await manager.add({
      url: ORIGINAL,
      requestHeaders: { cookie: COOKIE }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(finalUrl)
    expect(calls[0]!.options.header).toEqual([`Cookie: ${COOKIE}`])
    // A retry also reuses the already-resolved target, never the original, so
    // aria2 is still not asked to follow the download-time redirect chain.
    const record = manager.getSnapshot().downloads[0]!
    await manager.cancel(record.id)
    await manager.retry(record.id)
    expect(calls[calls.length - 1]!.url).toBe(finalUrl)
  })
})
