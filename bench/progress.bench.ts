/**
 * Benchmark 2 — aria2 status → renderer snapshot pipeline.
 *
 * This drives the real DownloadManager poll path with 50 and 200 active
 * downloads. Only the aria2 RPC transport is faked: `system.multicall` returns
 * the same string-shaped status payload aria2 produces, and everything after
 * that (parseAria2Status, applyStatus, revision tracking, getSnapshot and the
 * onUpdate callback that production forwards over IPC) is the real code.
 *
 * Reported CPU excludes snapshot serialization, which is measured separately as
 * the IPC encoding cost.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { serialize } from 'node:v8'
import { it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))

import type { AppSnapshot, Aria2State } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import { openDownloadDatabase } from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import { makeDownloadEntry, stats, writePartial } from './lib/common'

const TICK_RATE_MS = 1_000
const MEASURED_TICKS = 60
const WARMUP_TICKS = 3
const TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const TICK_BYTES = 4 * 1024 * 1024

type RawStatus = Record<string, string>

/** Minimal aria2 RPC transport: only what DownloadManager.poll() calls. */
class FakeAria2Transport {
  private readonly statuses = new Map<string, RawStatus>()

  constructor(gids: readonly string[]) {
    for (const gid of gids) {
      this.statuses.set(gid, {
        gid,
        status: 'active',
        dir: 'C:\\Users\\bench\\Downloads\\DonDownload',
        totalLength: String(TOTAL_BYTES),
        completedLength: '0',
        downloadSpeed: String(TICK_BYTES),
        errorCode: '0',
        errorMessage: '',
        files: ''
      })
    }
  }

  advance(): void {
    for (const status of this.statuses.values()) {
      const completed = Math.min(
        TOTAL_BYTES - 1,
        Number(status.completedLength) + TICK_BYTES
      )
      status.completedLength = String(completed)
    }
  }

  readonly client = {
    call: async (method: string, params: unknown[] = []): Promise<unknown> => {
      if (method !== 'system.multicall') {
        throw new Error(`bench: unexpected aria2 method ${method}`)
      }
      const calls = Array.isArray(params[0]) ? params[0] : []
      return calls.map((entry) => {
        const sub = entry as { params?: unknown[] }
        const gid = typeof sub.params?.[0] === 'string' ? sub.params[0] : ''
        const status = this.statuses.get(gid)
        return status === undefined
          ? { code: 1, message: 'GID is not found.' }
          : [{ ...status }]
      })
    }
  }

  asService(): Aria2Service {
    const state: Aria2State = {
      status: 'ready',
      version: 'bench-aria2',
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

async function runPipeline(activeDownloads: number): Promise<{
  activeDownloads: number
  ticks: number
  tickMs: ReturnType<typeof stats>
  ipcEncodeMs: ReturnType<typeof stats>
  ipcBytes: ReturnType<typeof stats>
  jsonBytes: ReturnType<typeof stats>
  snapshotItems: number
}> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dondownload-bench-ipc-'))
  const database = openDownloadDatabase(path.join(directory, 'downloads.sqlite3'))
  let manager: DownloadManager | null = null

  try {
    const entries = Array.from({ length: activeDownloads }, (_, index) =>
      makeDownloadEntry(index, {
        status: 'active',
        totalBytes: TOTAL_BYTES,
        completedBytes: 0
      })
    )
    database.saveMany(entries)

    const transport = new FakeAria2Transport(
      entries.map((entry) => entry.record.gid)
    )
    let latest: AppSnapshot | null = null
    manager = new DownloadManager(
      transport.asService(),
      path.join(directory, 'downloads'),
      (snapshot) => {
        latest = snapshot
      },
      database,
      { now: () => 1_760_000_000_000 }
    )

    // Records are loaded; the persistence timer is not part of this benchmark.
    // (Benchmark 1 measures the database write path separately.)
    ;(manager as unknown as { database: unknown }).database = null

    const poll = (): Promise<void> =>
      (
        manager as unknown as {
          poll: () => Promise<void>
        }
      ).poll()

    for (let tick = 0; tick < WARMUP_TICKS; tick += 1) {
      transport.advance()
      await poll()
    }

    const tickSamples: number[] = []
    const encodeSamples: number[] = []
    const byteSamples: number[] = []
    const jsonSamples: number[] = []
    let snapshotItems = 0

    for (let tick = 0; tick < MEASURED_TICKS; tick += 1) {
      transport.advance()

      const started = performance.now()
      await poll()
      tickSamples.push(performance.now() - started)

      const snapshot = latest
      if (snapshot === null) throw new Error('bench: no snapshot published')
      snapshotItems = snapshot.downloads.length

      const encodeStarted = performance.now()
      const encoded = serialize(snapshot)
      encodeSamples.push(performance.now() - encodeStarted)
      byteSamples.push(encoded.byteLength)
      jsonSamples.push(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'))
    }

    return {
      activeDownloads,
      ticks: MEASURED_TICKS,
      tickMs: stats(tickSamples),
      ipcEncodeMs: stats(encodeSamples),
      ipcBytes: stats(byteSamples),
      jsonBytes: stats(jsonSamples),
      snapshotItems
    }
  } finally {
    manager?.close()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

it('progress pipeline: 50 and 200 active downloads', async () => {
  const fifty = await runPipeline(50)
  const twoHundred = await runPipeline(200)

  writePartial('progress', {
    id: 'progress',
    title: 'Progress pipeline',
    tickRateMs: TICK_RATE_MS,
    measuredTicks: MEASURED_TICKS,
    results: [fifty, twoHundred],
    note:
      'CPU is DownloadManager.poll() only; IPC bytes are v8.serialize(snapshot) after the real status mapping.'
  })

  if (fifty.snapshotItems !== 50 || twoHundred.snapshotItems !== 200) {
    throw new Error(
      `bench: expected 50/200 snapshot items, got ${fifty.snapshotItems}/${twoHundred.snapshotItems}`
    )
  }
})
