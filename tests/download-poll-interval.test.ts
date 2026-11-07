import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State } from '../src/shared/types'
import { defaultDownloadSettings } from '../src/shared/settings'
import type { Aria2Service } from '../src/main/aria2/service'
import { DownloadManager } from '../src/main/downloads/manager'
import {
  ACTIVE_POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  nextPollDelay
} from '../src/main/downloads/pollInterval'
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

interface FakeCall {
  method: string
  params: unknown[]
}

class FakeAria2 {
  readonly calls: FakeCall[] = []
  readonly tracked = new Map<string, TrackedStatus>()
  private nextGid = 1

  get addUriCalls(): FakeCall[] {
    return this.calls.filter((call) => call.method === 'aria2.addUri')
  }

  setStatus(gid: string, status: string): void {
    const tracked = this.tracked.get(gid)
    if (tracked) tracked.status = status
  }

  setProgress(gid: string, completedLength: number): void {
    const tracked = this.tracked.get(gid)
    if (tracked) tracked.completedLength = String(completedLength)
  }

  private addTracked(gid: string): TrackedStatus {
    const tracked: TrackedStatus = {
      gid,
      status: 'waiting',
      dir: '',
      totalLength: '1000',
      completedLength: '0',
      downloadSpeed: '0',
      errorCode: '0',
      errorMessage: '',
      files: []
    }
    this.tracked.set(gid, tracked)
    return tracked
  }

  readonly client = {
    call: async (method: string, params: unknown[] = []): Promise<unknown> => {
      this.calls.push({ method, params })
      const gid = typeof params[0] === 'string' ? params[0] : ''
      switch (method) {
        case 'aria2.addUri': {
          const hex = (this.nextGid++).toString(16).padStart(16, '0')
          this.addTracked(hex)
          return hex
        }
        case 'aria2.tellStatus': {
          const tracked = this.tracked.get(gid)
          if (!tracked) {
            throw new AppError('ARIA2_RPC_ERROR', 'GID is not found.')
          }
          return { ...tracked }
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
                return [
                  {
                    numActive: String(
                      [...this.tracked.values()].filter(
                        (tracked) => tracked.status === 'active'
                      ).length
                    ),
                    numWaiting: String(
                      [...this.tracked.values()].filter(
                        (tracked) =>
                          tracked.status === 'waiting' ||
                          tracked.status === 'paused'
                      ).length
                    )
                  }
                ]
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

const managers: DownloadManager[] = []
const tempDirs: string[] = []

async function makeDownloadDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-poll-'))
  tempDirs.push(dir)
  return path.join(dir, 'downloads')
}

function createManager(
  aria2: FakeAria2,
  clock: { value: number },
  downloadDir: string,
  settings = { value: defaultDownloadSettings() }
): DownloadManager {
  const manager = new DownloadManager(
    aria2.asService(),
    downloadDir,
    () => undefined,
    null,
    { now: () => clock.value, settings: () => settings.value }
  )
  managers.push(manager)
  return manager
}

function mediaPort() {
  return {
    hasPendingPolicyWork: () => false,
    pumpPolicy: vi.fn((_now: number) => undefined)
  }
}

/** Captured before fake timers replace the global functions. */
const realSetTimeout = globalThis.setTimeout

/**
 * Advance fake time and let the fire-and-forget poll promise chain settle.
 * `advanceTimersByTimeAsync` only awaits work returned by a timer callback;
 * the manager intentionally starts its poll with `void`. A real event-loop
 * turn is also needed because submitting a job awaits real filesystem I/O.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve()
  }
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0))
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve()
  }
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
  vi.useRealTimers()
})

describe('nextPollDelay', () => {
  it('uses one second for active work, five seconds for pending work and stops when idle', () => {
    expect(
      nextPollDelay({ hasActiveWork: true, hasPendingWork: true })
    ).toBe(ACTIVE_POLL_INTERVAL_MS)
    expect(
      nextPollDelay({ hasActiveWork: false, hasPendingWork: true })
    ).toBe(IDLE_POLL_INTERVAL_MS)
    expect(
      nextPollDelay({ hasActiveWork: false, hasPendingWork: false })
    ).toBeNull()
  })
})

describe('adaptive download polling', () => {
  it('polls every second while a transfer is active and stops when it completes', async () => {
    vi.useFakeTimers()
    const aria2 = new FakeAria2()
    const clock = { value: Date.UTC(2026, 10, 4, 12, 0, 0) }
    const manager = createManager(aria2, clock, await makeDownloadDir())
    const port = mediaPort()
    manager.setMediaPolicyPort(port)

    await manager.add({ url: 'https://example.com/active.bin' })
    const gid = manager.getSnapshot().downloads[0]?.gid
    if (!gid) throw new Error('missing gid')
    aria2.setStatus(gid, 'active')

    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(1)
    expect(manager.getSnapshot().downloads[0]?.status).toBe('active')

    aria2.setStatus(gid, 'complete')
    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(2)
    expect(manager.getSnapshot().downloads[0]?.status).toBe('complete')

    // Nothing is pending any more: the timer is gone and long waits do not
    // produce further RPC traffic.
    const callsAfterCompletion = aria2.calls.length
    await advance(30_000)
    expect(aria2.calls.length).toBe(callsAfterCompletion)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(2)
  })

  it('backs off to five seconds while only waiting work remains and wakes on schedule', async () => {
    vi.useFakeTimers()
    const aria2 = new FakeAria2()
    const start = Date.UTC(2026, 10, 4, 12, 0, 0)
    const clock = { value: start }
    const manager = createManager(aria2, clock, await makeDownloadDir())
    const port = mediaPort()
    manager.setMediaPolicyPort(port)

    await manager.add({
      url: 'https://example.com/scheduled.bin',
      controls: {
        scheduledAt: start + 60_000,
        speedLimitBps: null,
        connections: null
      }
    })
    expect(manager.getSnapshot().downloads[0]?.status).toBe('waiting')
    expect(aria2.addUriCalls).toHaveLength(0)

    // The old fixed one-second poll would have fired here.
    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(0)

    await advance(IDLE_POLL_INTERVAL_MS - ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(1)
    expect(aria2.addUriCalls).toHaveLength(0)

    // The clock reaches the schedule: the same policy timer submits the job
    // and the manager switches back to the active cadence.
    clock.value = start + 60_000
    await advance(IDLE_POLL_INTERVAL_MS)
    expect(aria2.addUriCalls).toHaveLength(1)
    expect(manager.getSnapshot().downloads[0]?.status).toBe('queued')

    const before = port.pumpPolicy.mock.calls.length
    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy.mock.calls.length).toBe(before + 1)
  })

  it('shortens a slow idle timer when new active work arrives', async () => {
    vi.useFakeTimers()
    const aria2 = new FakeAria2()
    const start = Date.UTC(2026, 10, 4, 12, 0, 0)
    const clock = { value: start }
    const manager = createManager(aria2, clock, await makeDownloadDir())
    const port = mediaPort()
    manager.setMediaPolicyPort(port)

    await manager.add({
      url: 'https://example.com/far-future.bin',
      controls: {
        scheduledAt: start + 3_600_000,
        speedLimitBps: null,
        connections: null
      }
    })
    // The first job alone schedules the slow five-second cadence.
    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(0)

    // A new download must be observed on the next one-second tick, not after
    // the remaining four seconds of the idle timer.
    await manager.add({ url: 'https://example.com/new.bin' })
    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(1)
  })

  it('does not poll at all when idle and wakes on a new download', async () => {
    vi.useFakeTimers()
    const aria2 = new FakeAria2()
    const clock = { value: Date.UTC(2026, 10, 4, 12, 0, 0) }
    const manager = createManager(aria2, clock, await makeDownloadDir())
    const port = mediaPort()
    manager.setMediaPolicyPort(port)

    await advance(30_000)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(0)
    expect(aria2.calls).toHaveLength(0)

    await manager.add({ url: 'https://example.com/wake.bin' })
    await advance(ACTIVE_POLL_INTERVAL_MS)
    expect(port.pumpPolicy).toHaveBeenCalledTimes(1)
  })
})
