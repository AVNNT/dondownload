/**
 * Performance measurement, not a correctness suite. Excluded from test:fast
 * because it is a benchmark:
 *
 *   npx vitest run tests/bench/publish-fanout.bench.test.ts
 *
 * "Before" is the old per-publish work: the taskbar rebuilt both full
 * snapshots, and the notification service kept a status entry plus a seen-set
 * entry for every historical row. "After" uses the cheap aggregate readers and
 * only remembers non-terminal rows.
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    on(): void {}
    show(): void {}
  }
}))

import type { AppSnapshot, DownloadItem } from '../../src/shared/types'
import { CompletionNotificationService } from '../../src/main/notifications/service'
import {
  createTaskbarProgress,
  TASKBAR_ACTIVE_PROGRESS_EMPTY,
  type TaskbarActiveProgress
} from '../../src/main/taskbar/progress'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const HISTORY_ROWS = 10_000

function download(
  id: string,
  status: DownloadItem['status'],
  completedBytes = 0
): DownloadItem {
  return {
    id,
    gid: id,
    url: `https://example.com/${id}.bin`,
    filename: `${id}.bin`,
    dir: 'C:\\Downloads',
    filePath: null,
    status,
    totalBytes: 1_000,
    completedBytes,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  }
}

function snapshot(): AppSnapshot {
  const downloads = Array.from({ length: HISTORY_ROWS }, (_value, index) =>
    download(`history-${index}`, 'complete', 1_000)
  )
  // A handful of live rows is the only part that can still change.
  for (let index = 0; index < 5; index += 1) {
    downloads.push(download(`active-${index}`, 'active', 500))
  }
  return {
    aria2: {
      status: 'ready',
      version: 'bench',
      binaryPath: null,
      message: null,
      hint: null
    },
    downloads
  }
}

/** The pre-fix algorithm: every row enters the map and the seen set. */
class LegacyNotificationTracker {
  private readonly statuses = new Map<string, string>()

  observeDownloads(snapshot: AppSnapshot): void {
    const seen = new Set<string>()
    for (const item of snapshot.downloads) {
      const key = `download:${item.id}`
      seen.add(key)
      const previous = this.statuses.get(key)
      this.statuses.set(key, item.status)
      if (previous === undefined) continue
    }
    for (const key of this.statuses.keys()) {
      if (!key.startsWith('download:')) continue
      if (!seen.has(key)) this.statuses.delete(key)
    }
  }
}

function measurePerPublish(run: () => void, iterations: number): number {
  run() // Warm up caches and the first-observation baseline.
  const start = performance.now()
  for (let index = 0; index < iterations; index += 1) run()
  return (performance.now() - start) / iterations
}

describe('publish fan-out performance measurement', () => {
  it('reports getSnapshot calls per publish for the taskbar', () => {
    const rows = snapshot().downloads
    const active: TaskbarActiveProgress = {
      activeCount: 5,
      sizedCount: 5,
      completedBytes: 2_500,
      totalBytes: 5_000
    }
    let snapshots = 0
    const aria2 = {
      status: 'ready' as const,
      version: 'bench',
      binaryPath: null,
      message: null,
      hint: null
    }
    const managers = {
      getSnapshot: () => {
        snapshots += 1
        return { aria2, downloads: rows }
      },
      getActiveProgress: () => active
    }
    const media = {
      getMediaSnapshot: () => {
        snapshots += 1
        return { tool: { status: 'ready' }, jobs: [] }
      },
      getActiveProgress: () => TASKBAR_ACTIVE_PROGRESS_EMPTY
    }
    const publishes = 1_000

    const before = createTaskbarProgress({
      getWindow: () => null,
      throttleMs: 1_000
    })
    for (let index = 0; index < publishes; index += 1) {
      before.update({
        downloads: managers.getSnapshot().downloads,
        mediaJobs: media.getMediaSnapshot().jobs
      })
    }
    const beforeCalls = snapshots / publishes
    before.dispose()

    snapshots = 0
    const after = createTaskbarProgress({
      getWindow: () => null,
      throttleMs: 1_000,
      read: {
        downloads: () => managers.getActiveProgress(),
        mediaJobs: () => media.getActiveProgress()
      }
    })
    for (let index = 0; index < publishes; index += 1) after.refresh()
    const afterCalls = snapshots / publishes
    after.dispose()

    console.log(
      `\n[taskbar benchmark] getSnapshot calls/publish ${beforeCalls} -> ${afterCalls}`
    )
    expect(beforeCalls).toBe(2)
    expect(afterCalls).toBe(0)
  })

  it('reports notification-service ms per publish at 10k rows', () => {
    const rows = snapshot()
    const iterations = 25
    const legacy = new LegacyNotificationTracker()
    const beforeMs = measurePerPublish(
      () => legacy.observeDownloads(rows),
      iterations
    )

    const current = new CompletionNotificationService({
      isEnabled: () => false,
      isSupported: () => false
    })
    const afterMs = measurePerPublish(
      () => current.observeDownloads(rows),
      iterations
    )

    console.log(
      `\n[notification benchmark] ${HISTORY_ROWS + 5} rows: ` +
        `${beforeMs.toFixed(3)} ms/publish -> ${afterMs.toFixed(3)} ms/publish`
    )
    expect(afterMs).toBeLessThan(beforeMs)
  })
})
