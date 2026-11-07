import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../src/shared/types'
import {
  downloadToRow,
  filterRows,
  matchesSearch,
  searchKeyFor,
  type UnifiedRow
} from '../src/renderer/src/lib/unified'

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)

function download(index: number, overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: `download-${index}`,
    gid: `gid-${index}`,
    url: `https://example.com/files/archive-${index}.zip`,
    filename: `archive-${index}.zip`,
    dir: 'Downloads/DonDownload',
    filePath: null,
    status: 'active',
    totalBytes: 1_000,
    completedBytes: 250,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW - index,
    updatedAt: NOW - 1_000,
    completedAt: null,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 4,
    blockReason: null,
    ...overrides
  }
}

/**
 * Replace a field with a counting getter so the test can see whether the row
 * was lower-cased again. The row object itself stays a normal UnifiedRow.
 */
function countingField(row: UnifiedRow, field: 'title' | 'url' | 'host' | 'subtitle') {
  const reads = { count: 0 }
  const value = row[field]
  Object.defineProperty(row, field, {
    configurable: true,
    get() {
      reads.count += 1
      return value
    }
  })
  return reads
}

describe('search key cache', () => {
  it('lower-cases a row once and reuses the key for later queries', () => {
    const row = downloadToRow(download(1))
    const titleReads = countingField(row, 'title')
    const urlReads = countingField(row, 'url')
    const hostReads = countingField(row, 'host')
    const subtitleReads = countingField(row, 'subtitle')

    expect(matchesSearch(row, 'archive-1')).toBe(true)
    expect(matchesSearch(row, 'EXAMPLE.COM')).toBe(true)
    expect(matchesSearch(row, 'nothing')).toBe(false)

    expect(titleReads.count).toBe(1)
    expect(urlReads.count).toBe(1)
    expect(hostReads.count).toBe(1)
    expect(subtitleReads.count).toBe(1)
    expect(searchKeyFor(row)).toContain('archive-1.zip')
  })

  it('reuses cached keys while filtering a long list repeatedly', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      downloadToRow(download(index))
    )
    const probe = countingField(rows[4_321]!, 'title')

    const filter = { category: 'all', status: 'all', query: 'archive-4321' } as const
    expect(filterRows(rows, filter)).toHaveLength(1)
    expect(filterRows(rows, filter)).toHaveLength(1)
    expect(filterRows(rows, { ...filter, query: 'archive' }).length).toBe(10_000)

    // Three full passes, one lower-case build for this row.
    expect(probe.count).toBe(1)
  })

  it('does not let a match span two fields', () => {
    const row = downloadToRow(
      download(2, {
        filename: 'foo',
        url: 'https://example.com/bar'
      })
    )
    // The title ends in "foo" and the URL starts with "bar"; a naive
    // concatenation would falsely match "oobar".
    expect(matchesSearch(row, 'oobar')).toBe(false)
    expect(matchesSearch(row, 'foo')).toBe(true)
    expect(matchesSearch(row, 'bar')).toBe(true)
  })

  it('treats a blank query as match-all without building a key', () => {
    const row = downloadToRow(download(3))
    const probe = countingField(row, 'title')
    expect(matchesSearch(row, '   ')).toBe(true)
    expect(probe.count).toBe(0)
  })
})
