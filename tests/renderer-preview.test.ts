import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import electronViteConfig from '../electron.vite.config'
import {
  parseCollectionPreview,
  parseBatch,
  type CollectionPreview
} from '../src/shared/batches'
import { parseMediaAnalysis, parseMediaSnapshot } from '../src/shared/media'
import { parseDownloadSettings } from '../src/shared/settings'
import type { DonDownloadApi } from '../src/shared/types'
import { createPreviewApi } from '../src/renderer/src/preview/fixtures'

const FIXED_NOW = Date.UTC(2026, 10, 5, 12, 0, 0)

function api(): DonDownloadApi {
  return createPreviewApi({ now: () => FIXED_NOW })
}

describe('browser preview fixture adapter', () => {
  it('implements the production DonDownloadApi contract with isolated state', async () => {
    const first = api()
    const second = api()

    const before = await second.getSnapshot()
    expect(before.ok).toBe(true)
    if (!before.ok) return

    const added = await first.addDownload({
      url: 'https://example.com/new-file.bin'
    })
    expect(added.ok).toBe(true)

    const after = await second.getSnapshot()
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.downloads).toHaveLength(before.value.downloads.length)
  })

  it('returns deterministic seeded snapshots for a fixed clock', async () => {
    const left = await api().getSnapshot()
    const right = await api().getSnapshot()
    expect(left).toEqual(right)
    expect(left.ok).toBe(true)
    if (!left.ok) return
    expect(left.value.aria2.status).toBe('ready')
    expect(left.value.downloads.map((item) => item.status)).toEqual(
      expect.arrayContaining([
        'active',
        'waiting',
        'paused',
        'complete',
        'error',
        'cancelled'
      ])
    )
  })

  it('demonstrates scheduling and per-download controls', async () => {
    const preview = api()
    const snapshot = await preview.getSnapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return

    const scheduled = snapshot.value.downloads.find(
      (item) => item.blockReason === 'scheduled'
    )
    const allowedHours = snapshot.value.downloads.find(
      (item) => item.blockReason === 'allowed-hours'
    )
    expect(scheduled?.scheduledAt).toBeGreaterThan(FIXED_NOW)
    expect(scheduled?.speedLimitBps).toBe(5 * 1024 * 1024)
    expect(allowedHours?.connections).toBe(16)

    const queued = await preview.addDownload({
      url: 'https://example.com/later.zip',
      controls: {
        scheduledAt: FIXED_NOW + 60_000,
        speedLimitBps: 1024,
        connections: 2
      }
    })
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    const added = queued.value.downloads[0]
    expect(added?.status).toBe('waiting')
    expect(added?.blockReason).toBe('scheduled')
    expect(added?.connections).toBe(2)

    const started = await preview.startDownloadNow(added!.id)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value.downloads[0]?.status).toBe('active')
    expect(started.value.downloads[0]?.blockReason).toBeNull()
  })

  it('validates duplicate and malformed download input without external calls', async () => {
    const preview = api()
    const duplicate = await preview.addDownload({
      url: 'https://example.com/ubuntu-24.04.1-desktop-amd64.iso'
    })
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('DUPLICATE_DOWNLOAD')

    const forced = await preview.addDownload({
      url: 'https://example.com/ubuntu-24.04.1-desktop-amd64.iso',
      force: true
    })
    expect(forced.ok).toBe(true)

    const invalid = await preview.addDownload({ url: 'ftp://example.com/a' })
    expect(invalid.ok).toBe(false)
  })

  it('notifies subscribers and unsubscribes cleanly', async () => {
    const preview = api()
    const seen: Array<{ id: string; status: string }> = []
    const unsubscribe = preview.onSnapshotChanged((delta) => {
      const item = delta.kind === 'full' ? delta.rows[0] : undefined
      seen.push({
        id: item?.id ?? 'missing',
        status: item?.status ?? 'missing'
      })
    })

    const paused = await preview.pauseDownload('preview-download-active')
    expect(paused.ok).toBe(true)
    expect(seen).toEqual([
      { id: 'preview-download-active', status: 'paused' }
    ])

    unsubscribe()
    await preview.resumeDownload('preview-download-active')
    expect(seen).toEqual([
      { id: 'preview-download-active', status: 'paused' }
    ])
  })

  it('drives a clearly simulated download through resume, progress and completion', async () => {
    const preview = createPreviewApi({ now: () => FIXED_NOW })
    const paused = await preview.pauseDownload('preview-download-active')
    expect(paused.ok).toBe(true)
    const resumed = await preview.resumeDownload('preview-download-active')
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    const resumedItem = resumed.value.downloads.find(
      (item) => item.id === 'preview-download-active'
    )
    expect(resumedItem?.status).toBe('waiting')
    expect(resumedItem?.completedBytes).toBe(2_300 * 1024 * 1024)
    expect(resumedItem?.blockReason).toBeNull()

    expect(preview.advanceDownloadFixture()).toContain('Simulated progress')
    const progressing = await preview.getSnapshot()
    expect(progressing.ok).toBe(true)
    if (!progressing.ok) return
    const active = progressing.value.downloads.find(
      (item) => item.id === 'preview-download-active'
    )
    expect(active?.status).toBe('active')
    expect(active?.completedBytes).toBeGreaterThan(2_300 * 1024 * 1024)

    expect(preview.advanceDownloadFixture()).toContain('Simulated completion')
    const completed = await preview.getSnapshot()
    expect(completed.ok).toBe(true)
    if (!completed.ok) return
    const done = completed.value.downloads.find(
      (item) => item.id === 'preview-download-active'
    )
    expect(done?.status).toBe('complete')
    expect(done?.completedBytes).toBe(done?.totalBytes)
    expect(done?.filePath).toContain(done?.filename)
  })

  it('cancels a running fixture download and keeps it retryable', async () => {
    const preview = api()
    const cancelled = await preview.cancelDownload('preview-download-active')
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    const item = cancelled.value.downloads.find(
      (download) => download.id === 'preview-download-active'
    )
    expect(item).toMatchObject({
      status: 'cancelled',
      gid: '',
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      completedAt: FIXED_NOW
    })

    // An explicit cancel is not a failed attempt, so Retry keeps the count.
    const retried = await preview.retryDownload('preview-download-active')
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    const again = retried.value.downloads.find(
      (download) => download.id === 'preview-download-active'
    )
    expect(again).toMatchObject({
      status: 'queued',
      attempts: 1,
      completedAt: null
    })
  })

  it('retries a failed download with reset progress and no invented success', async () => {
    const preview = api()
    const retried = await preview.retryDownload('preview-download-error')
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    const item = retried.value.downloads.find(
      (download) => download.id === 'preview-download-error'
    )
    expect(item?.id).toBe('preview-download-error')
    expect(item?.status).toBe('queued')
    expect(item?.completedBytes).toBe(0)
    expect(item?.speedBps).toBe(0)
    expect(item?.etaSeconds).toBeNull()
    expect(item?.errorMessage).toBeNull()
    expect(item?.filePath).toBeNull()
    expect(item?.completedAt).toBeNull()
    expect(item?.attempts).toBe(3)
    expect(item?.totalBytes).toBe(512 * 1024 * 1024)
    expect(item?.connections).toBe(4)
    expect(item?.blockReason).toBeNull()
  })

  it('supports media analysis, queueing, cancellation and polling snapshots', async () => {
    const preview = api()
    const analysis = await preview.analyzeMedia({
      url: 'https://example.com/watch?v=fixture'
    })
    expect(analysis.ok).toBe(true)
    if (!analysis.ok) return

    const parsedAnalysis = parseMediaAnalysis(analysis.value)
    expect(parsedAnalysis.expiresAt).toBeGreaterThan(FIXED_NOW)
    expect(parsedAnalysis.bestVideoOptionId).not.toBeNull()
    expect(parsedAnalysis.bestAudioOptionId).not.toBeNull()

    const queued = await preview.queueMedia({
      analysisId: parsedAnalysis.analysisId,
      optionId: parsedAnalysis.bestVideoOptionId!
    })
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    const snapshot = parseMediaSnapshot(queued.value)
    expect(snapshot.tool.status).toBe('ready')
    expect(snapshot.jobs[0]?.status).toBe('queued')

    const jobId = snapshot.jobs[0]!.id
    const cancelled = await preview.cancelMedia(jobId)
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    expect(cancelled.value.jobs.find((job) => job.id === jobId)?.status).toBe(
      'cancelled'
    )

    const removed = await preview.removeMedia(jobId)
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.value.jobs.some((job) => job.id === jobId)).toBe(false)

    const invalid = await preview.analyzeMedia({ url: 'file:///secret' })
    expect(invalid.ok).toBe(false)
  })

  it('supports batch submit, collection previews and explicit selection', async () => {
    const preview = api()
    const submitted = await preview.submitSmartBatch({
      urls: [
        'https://example.com/one.zip',
        'https://example.com/two.zip',
        'https://www.youtube.com/playlist?list=fixture',
        'not-a-url'
      ]
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return

    expect(submitted.value.batch).not.toBeNull()
    expect(submitted.value.previews).toHaveLength(1)
    expect(submitted.value.entries.map((entry) => entry.outcome)).toEqual([
      'batch-item',
      'batch-item',
      'collection-preview',
      'invalid'
    ])
    if (submitted.value.batch) {
      expect(() => parseBatch(submitted.value.batch)).not.toThrow()
    }

    const previewResult = submitted.value.previews[0] as CollectionPreview
    const parsedPreview = parseCollectionPreview(previewResult)
    const available = parsedPreview.entries.filter(
      (entry) => entry.availability === 'available'
    )
    const unavailable = parsedPreview.entries.find(
      (entry) => entry.availability === 'unavailable'
    )
    expect(available).toHaveLength(3)
    expect(unavailable).toBeDefined()

    const selected = await preview.analyzeCollectionSelection({
      previewId: parsedPreview.id,
      selectedEntryIds: available.slice(0, 2).map((entry) => entry.id)
    })
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.value.entries[0]?.qualities.map((item) => item.quality)).toEqual(
      expect.arrayContaining(['best', '1080p', '720p', 'audio-only'])
    )

    const created = await preview.createCollectionBatch({
      previewId: parsedPreview.id,
      selectedEntryIds: [available[0]!.id, unavailable!.id],
      mediaQuality: '720p'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(() => parseBatch(created.value)).not.toThrow()
    expect(created.value.status).toBe('queued')
    expect(created.value.items).toHaveLength(2)
    expect(created.value.items.map((item) => item.status)).toEqual([
      'queued',
      'unavailable'
    ])
    expect(created.value.items[1]?.errorMessage).toBe(
      'This fixture entry is not available.'
    )

    const snapshot = await preview.getBatchSnapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(
      snapshot.value.batches.some((batch) => batch.id === created.value.id)
    ).toBe(true)
  })

  it('supports batch retry, cancel and removal actions', async () => {
    const preview = api()

    const retried = await preview.retryBatchItem({
      batchId: 'preview-batch-playlist',
      itemId: 'preview-item-video-3'
    })
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    const retriedBatch = retried.value.batches.find(
      (batch) => batch.id === 'preview-batch-playlist'
    )!
    expect(
      retriedBatch.items.find((item) => item.id === 'preview-item-video-3')
        ?.status
    ).toBe('queued')
    expect(() => parseBatch(retriedBatch)).not.toThrow()

    const cancelled = await preview.cancelBatch({
      batchId: 'preview-batch-direct'
    })
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    expect(
      cancelled.value.batches.find((batch) => batch.id === 'preview-batch-direct')
        ?.status
    ).toBe('cancelled')

    const removed = await preview.removeBatch({
      batchId: 'preview-batch-pixeldrain'
    })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(
      removed.value.batches.some(
        (batch) => batch.id === 'preview-batch-pixeldrain'
      )
    ).toBe(false)
  })

  it('supports scan discovery and an explicit selection only', async () => {
    const preview = api()
    const started = await preview.startScan({
      url: 'https://discuss.example/t/topic/346779'
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.value.status).toBe('scanning')
    expect(started.value.items.length).toBeGreaterThan(0)
    // Thumbnails are validated public HTTPS images; every other URL stays out.
    const withoutThumbnails = {
      ...started.value,
      items: started.value.items.map((item) => ({
        ...item,
        thumbnailUrl: item.thumbnailUrl === undefined ? undefined : '[thumb]'
      }))
    }
    expect(JSON.stringify(withoutThumbnails)).not.toContain('https://')

    const script = started.value.items.find(
      (item) => item.category === 'script'
    )
    const queued = await preview.queueScanSelection(started.value.sessionId, [
      script!.id
    ])
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    expect(queued.value.queuedItemIds).toEqual([script!.id])

    const cancelled = await preview.cancelScan(started.value.sessionId)
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    expect(cancelled.value.status).toBe('cancelled')
  })

  it('persists validated settings including themes and allowed hours', async () => {
    const preview = api()
    const initial = await preview.getSettings()
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    expect(() => parseDownloadSettings(initial.value)).not.toThrow()
    expect(initial.value.theme).toBe('dark')

    const updated = await preview.updateSettings({
      ...initial.value,
      theme: 'light',
      maxConcurrentDownloads: 6,
      allowedHours: { enabled: false, start: '00:00', end: '00:00' }
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.theme).toBe('light')
    expect(updated.value.maxConcurrentDownloads).toBe(6)

    const invalid = await preview.updateSettings({
      ...updated.value,
      maxConcurrentDownloads: 99
    })
    expect(invalid.ok).toBe(false)
  })
})

describe('browser preview production boundary', () => {
  it('keeps preview.html out of the production renderer rollup input', () => {
    const renderer = (
      electronViteConfig as {
        renderer?: {
          build?: {
            rollupOptions?: { input?: unknown }
          }
        }
      }
    ).renderer
    const input = renderer?.build?.rollupOptions?.input
    expect(input).toEqual({
      index: resolve(process.cwd(), 'src/renderer/index.html')
    })
    expect(JSON.stringify(input)).not.toContain('preview')
  })

  it('keeps the production renderer entry free of preview imports', () => {
    const main = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/main.tsx'),
      'utf8'
    )
    expect(main).not.toContain('preview')
    expect(main).not.toContain('createPreviewApi')
  })

  it('exposes the fixture route only through the dev renderer script', () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/renderer/preview.html'),
      'utf8'
    )
    expect(html).toContain('/src/preview.tsx')

    const entry = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/preview.tsx'),
      'utf8'
    )
    expect(entry).toContain('import.meta.env.DEV')
    expect(entry).toContain('createPreviewApi')

    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    expect(packageJson.scripts?.['dev:preview']).toBe(
      'vite --config vite.preview.config.ts'
    )

    const config = readFileSync(
      resolve(process.cwd(), 'vite.preview.config.ts'),
      'utf8'
    )
    expect(config).toContain("src/renderer")
    expect(config).not.toContain('startElectron')
  })
})
