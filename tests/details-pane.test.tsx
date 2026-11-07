import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import { downloadToRow } from '../src/renderer/src/lib/unified'
import { progressLine } from '../src/renderer/src/lib/rowProgress'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)

function download(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'download-1',
    gid: 'gid-1',
    url: 'https://example.com/files/archive.zip',
    filename: 'archive.zip',
    dir: 'Downloads/DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 0,
    completedBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    completedAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 4,
    blockReason: null,
    ...overrides
  }
}

describe('details pane progress line', () => {
  it('does not claim a failed download is waiting to start', () => {
    const row = downloadToRow(
      download({ status: 'error', errorMessage: 'Connection reset' })
    )
    expect(progressLine(row, NOW)).toBe('Connection reset')
  })

  it('falls back to "Failed" when a failed download has no message', () => {
    const row = downloadToRow(download({ status: 'error' }))
    expect(progressLine(row, NOW)).toBe('Failed')
  })

  it('shows the live retry countdown for a pending retry', () => {
    const row = downloadToRow(
      download({
        status: 'error',
        errorMessage: 'Connection reset',
        retryAt: NOW + 8_000
      })
    )
    expect(progressLine(row, NOW)).toBe('Retrying in 8s…')
    expect(progressLine(row, NOW + 3_000)).toBe('Retrying in 5s…')
    expect(progressLine(row, NOW + 9_000)).toBe('Retrying now…')
  })

  it('keeps the byte range for failed rows that already transferred data', () => {
    const row = downloadToRow(
      download({
        status: 'error',
        errorMessage: 'Connection reset',
        totalBytes: 1_000,
        completedBytes: 250
      })
    )
    expect(progressLine(row, NOW)).toBe('Connection reset · 250 B of 1000 B')
  })

  it('leaves other statuses unchanged', () => {
    const queued = downloadToRow(download({ status: 'queued' }))
    expect(progressLine(queued, NOW)).toBe('Waiting to start')
    const active = downloadToRow(
      download({ status: 'active', totalBytes: 1_000, completedBytes: 250 })
    )
    expect(progressLine(active, NOW)).toBe('250 B of 1000 B')
  })
})
