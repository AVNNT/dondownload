import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State, DownloadItem, DownloadRequestHeaders } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import { DownloadManager } from '../src/main/downloads/manager'
import { AppError } from '../src/main/errors'

interface TrackedStatus {
  gid: string
  status: string
  dir: string
  totalLength: string
  completedLength: string
  downloadSpeed: string
  errorCode: string
  errorMessage: string
  files: Array<{ path: string; length: string; completedLength: string }>
}

class FakeAria2 {
  readonly tracked = new Map<string, TrackedStatus>()
  readonly calls: Array<{ method: string; params: unknown[] }> = []
  private nextGid = 1

  setStatus(gid: string, status: string): void {
    const tracked = this.tracked.get(gid)
    if (tracked) tracked.status = status
  }

  setError(gid: string, errorCode: number, errorMessage: string): void {
    const tracked = this.tracked.get(gid)
    if (!tracked) return
    tracked.status = 'error'
    tracked.errorCode = String(errorCode)
    tracked.errorMessage = errorMessage
  }

  readonly client = {
    call: async (method: string, params: unknown[] = []): Promise<unknown> => {
      this.calls.push({ method, params })
      switch (method) {
        case 'aria2.addUri': {
          const hex = (this.nextGid++).toString(16).padStart(16, '0')
          this.tracked.set(hex, {
            gid: hex,
            status: 'waiting',
            dir: '',
            totalLength: '1000',
            completedLength: '0',
            downloadSpeed: '0',
            errorCode: '0',
            errorMessage: '',
            files: []
          })
          return hex
        }
        case 'system.multicall': {
          const entries = Array.isArray(params[0]) ? params[0] : []
          return entries.map((entry) => {
            const sub = entry as { methodName?: string; params?: unknown[] }
            switch (sub.methodName) {
              case 'aria2.tellActive':
                return [
                  [...this.tracked.values()]
                    .filter((tracked) => tracked.status === 'active')
                    .map((tracked) => ({ ...tracked }))
                ]
              case 'aria2.tellWaiting':
                return [
                  [...this.tracked.values()]
                    .filter(
                      (tracked) =>
                        tracked.status === 'waiting' ||
                        tracked.status === 'paused'
                    )
                    .map((tracked) => ({ ...tracked }))
                ]
              case 'aria2.getGlobalStat':
                return [{ numActive: '0', numWaiting: '0' }]
              case 'aria2.tellStatus': {
                const subGid =
                  typeof sub.params?.[0] === 'string' ? sub.params[0] : ''
                const tracked = this.tracked.get(subGid)
                return tracked === undefined
                  ? { code: 1, message: 'GID is not found.' }
                  : [{ ...tracked }]
              }
              default:
                return { code: 1, message: 'Unsupported method.' }
            }
          })
        }
        case 'aria2.pause':
        case 'aria2.unpause':
        case 'aria2.forceRemove':
        case 'aria2.removeDownloadResult':
          return 'OK'
        default:
          throw new AppError('ARIA2_RPC_ERROR', `Unexpected method ${method}`)
      }
    }
  }

  asService(): Aria2Service {
    const state: Aria2State = {
      status: 'ready',
      version: 'test-aria2',
      binaryPath: null,
      message: null,
      hint: null
    }
    return {
      getState: () => ({ ...state }),
      getReadyClient: () => this.client,
      getClient: async () => this.client,
      start: async () => this.client,
      stop: async () => undefined,
      restart: async () => undefined
    } as unknown as Aria2Service
  }
}

const tempDirs: string[] = []
const managers: DownloadManager[] = []

async function makeManager(aria2: FakeAria2): Promise<DownloadManager> {
  const dir = path.join(
    os.tmpdir(),
    `dondownload-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  tempDirs.push(dir)
  const manager = new DownloadManager(
    aria2.asService(),
    dir,
    () => undefined,
    null,
    { resolveCookieTarget: async (input) => ({ finalUrl: input.url }) }
  )
  managers.push(manager)
  return manager
}

interface ManagerInternals {
  records: Map<string, DownloadItem>
  requestHeaders: Map<string, DownloadRequestHeaders>
  cookieHosts: Map<string, string>
}

function internals(manager: DownloadManager): ManagerInternals {
  return manager as unknown as ManagerInternals
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      manager.close()
    } catch {
      // Best effort cleanup.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

const URL = 'https://discuss.example/uploads/file.funscript'
const COOKIE = 'forum_session=secret'

async function addCookieJob(
  manager: DownloadManager
): Promise<DownloadItem> {
  await manager.add({
    url: URL,
    filename: 'file.funscript',
    requestHeaders: { cookie: COOKIE, referer: 'https://discuss.example/t/1' }
  })
  const record = manager.getSnapshot().downloads[0]
  if (!record) throw new Error('missing download')
  return record
}

describe('download request-header retention', () => {
  it('drops one-job headers and cookie scope when the job completes', async () => {
    const aria2 = new FakeAria2()
    const manager = await makeManager(aria2)
    const record = await addCookieJob(manager)
    expect(internals(manager).requestHeaders.has(record.id)).toBe(true)
    expect(internals(manager).cookieHosts.has(record.id)).toBe(true)

    aria2.setStatus(record.gid, 'complete')
    await manager.refreshPolicy()

    expect(manager.getItem(record.id)?.status).toBe('complete')
    expect(internals(manager).requestHeaders.has(record.id)).toBe(false)
    expect(internals(manager).cookieHosts.has(record.id)).toBe(false)
  })

  it('keeps them for a failure that still has a retry, and Retry reuses the cookie', async () => {
    const aria2 = new FakeAria2()
    const manager = await makeManager(aria2)
    const record = await addCookieJob(manager)

    aria2.setError(record.gid, 3, 'Resource not found')
    await manager.refreshPolicy()
    expect(manager.getItem(record.id)?.status).toBe('error')
    expect(internals(manager).requestHeaders.get(record.id)).toEqual({
      cookie: COOKIE,
      referer: 'https://discuss.example/t/1'
    })
    expect(internals(manager).cookieHosts.has(record.id)).toBe(true)

    const retried = await manager.retry(record.id)
    expect(retried.downloads[0]?.status).toBe('queued')
    const retryAdd = aria2.calls
      .filter((call) => call.method === 'aria2.addUri')
      .at(-1)
    const options = retryAdd?.params[1] as Record<string, string | string[]>
    expect(options.header).toEqual([`Cookie: ${COOKIE}`])
  })

  it('drops them when the failure has exhausted the retry budget', async () => {
    const aria2 = new FakeAria2()
    const manager = await makeManager(aria2)
    const record = await addCookieJob(manager)
    const stored = internals(manager).records.get(record.id)
    if (!stored) throw new Error('missing stored record')
    stored.attempts = stored.maxAttempts

    aria2.setError(record.gid, 3, 'Resource not found')
    await manager.refreshPolicy()

    expect(manager.getItem(record.id)?.status).toBe('error')
    expect(internals(manager).requestHeaders.has(record.id)).toBe(false)
    expect(internals(manager).cookieHosts.has(record.id)).toBe(false)
  })

  it('reports only active rows in the taskbar aggregate', async () => {
    const aria2 = new FakeAria2()
    const manager = await makeManager(aria2)
    const first = await addCookieJob(manager)

    expect(manager.getActiveProgress()).toEqual({
      activeCount: 0,
      sizedCount: 0,
      completedBytes: 0,
      totalBytes: 0
    })

    const tracked = aria2.tracked.get(first.gid)
    if (!tracked) throw new Error('missing tracked row')
    aria2.setStatus(first.gid, 'active')
    tracked.completedLength = '250'
    await manager.refreshPolicy()

    expect(manager.getActiveProgress()).toEqual({
      activeCount: 1,
      sizedCount: 1,
      completedBytes: 250,
      totalBytes: 1_000
    })

    aria2.setStatus(first.gid, 'complete')
    await manager.refreshPolicy()
    expect(manager.getActiveProgress().activeCount).toBe(0)
  })
})
