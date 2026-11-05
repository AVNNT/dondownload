import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() }
}))

import type { Aria2State } from '../src/shared/types'
import type { Aria2Service } from '../src/main/aria2/service'
import { openDownloadDatabase, type DownloadDatabase } from '../src/main/db/database'
import { DownloadManager } from '../src/main/downloads/manager'
import {
  startNativeBridge,
  type BridgeDownloadManager,
  type NativeBridge
} from '../src/main/nativeBridge/server'
import { parseNativeBridgeEndpoint } from '../src/shared/nativeBridge'

const tempDirs: string[] = []
const managers: DownloadManager[] = []
const bridges: NativeBridge[] = []
const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

interface AriaCall {
  method: string
  params: unknown[]
}

async function makeWorkspace(): Promise<{
  dir: string
  database: DownloadDatabase
  downloadDir: string
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-durable-'))
  tempDirs.push(dir)
  return {
    dir,
    database: openDownloadDatabase(path.join(dir, 'downloads.sqlite3')),
    downloadDir: path.join(dir, 'downloads')
  }
}

function createManager(
  database: DownloadDatabase | null,
  downloadDir: string
): { manager: DownloadManager; calls: AriaCall[]; gids: string[] } {
  const calls: AriaCall[] = []
  const gids: string[] = []
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
      calls.push({ method, params })
      if (method === 'aria2.addUri') {
        nextGid += 1
        const gid = nextGid.toString(16).padStart(16, '0')
        gids.push(gid)
        return gid
      }
      if (
        method === 'aria2.forceRemove' ||
        method === 'aria2.removeDownloadResult'
      ) {
        return 'OK'
      }
      throw new Error(`Unexpected method ${method}`)
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
    database,
    { now: () => 1_800_000_000_000 }
  )
  managers.push(manager)
  return { manager, calls, gids }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    try {
      await bridge.close()
    } catch {
      // Best effort for a failing test.
    }
  }
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

describe('strict durable hand-off', () => {
  it('returns a verified receipt, rolls back uncertain aria2 work, and exposes a separate fail-closed route', async () => {
    const { dir, database, downloadDir } = await makeWorkspace()
    const { manager, calls, gids } = createManager(database, downloadDir)

    const receipt = await manager.addDurable({
      url: 'https://example.com/files/report.zip'
    })
    expect(receipt).toEqual({
      downloadId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      persistedAt: 1_800_000_000_000
    })
    expect(database.loadAll()).toHaveLength(1)
    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(calls.map((entry) => entry.method)).toEqual(['aria2.addUri'])

    // A failed/uncertain SQLite write must remove both the local row and the
    // aria2 job it just queued, then report failure so the browser keeps its
    // own download.
    const writeFailure = vi
      .spyOn(database, 'saveDurable')
      .mockImplementation(() => {
        throw new Error('disk unavailable')
      })
    await expect(
      manager.addDurable({ url: 'https://example.com/files/second.zip' })
    ).rejects.toMatchObject({ code: 'DURABLE_PERSISTENCE_FAILED' })
    writeFailure.mockRestore()

    expect(manager.getSnapshot().downloads).toHaveLength(1)
    expect(database.loadAll()).toHaveLength(1)
    expect(gids).toHaveLength(2)
    expect(calls.map((entry) => entry.method)).toEqual([
      'aria2.addUri',
      'aria2.addUri',
      'aria2.forceRemove',
      'aria2.removeDownloadResult'
    ])
    expect(calls[2]?.params).toEqual([gids[1]])

    // No database means no durable promise: reject before queuing anything.
    const noDatabaseDir = path.join(dir, 'no-database')
    const noDatabase = createManager(null, noDatabaseDir)
    await expect(
      noDatabase.manager.addDurable({
        url: 'https://example.com/files/third.zip'
      })
    ).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' })
    expect(noDatabase.calls).toEqual([])
    expect(noDatabase.manager.getSnapshot().downloads).toHaveLength(0)

    // The bridge route is separate from queue-download and requires the
    // additive manager capability. Without it the browser download is kept.
    const bridgeManager: BridgeDownloadManager = {
      add: async () => ({ accepted: true }),
      addDurable: async () => ({
        downloadId: DOWNLOAD_ID,
        persistedAt: 1_800_000_000_000
      })
    }
    const bridge = await startNativeBridge({
      manager: bridgeManager,
      userDataPath: dir,
      logger: () => undefined,
      publicTargetLookup: async () => [
        { address: '93.184.216.34', family: 4 }
      ]
    })
    bridges.push(bridge)
    const endpoint = parseNativeBridgeEndpoint(
      JSON.parse(await readFile(bridge.statePath, 'utf8'))
    )

    async function postHandoff(body: unknown): Promise<Response> {
      return fetch(`http://127.0.0.1:${endpoint.port}/handoff-download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    }

    const accepted = await postHandoff({
      url: 'https://example.com/files/report.zip'
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      ok: true,
      accepted: true,
      operation: 'handoff-download',
      durable: true,
      receipt: {
        downloadId: DOWNLOAD_ID,
        persistedAt: 1_800_000_000_000
      }
    })

    delete bridgeManager.addDurable
    const unavailable = await postHandoff({
      url: 'https://example.com/files/report.zip'
    })
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'HANDOFF_UNAVAILABLE' }
    })
  })
})
