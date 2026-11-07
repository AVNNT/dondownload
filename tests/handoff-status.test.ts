import { describe, expect, it, vi } from 'vitest'
import { createHandoffDownloadStatus } from '../src/main/nativeBridge/handoffStatus'
import type { DownloadItem } from '../src/shared/types'

function item(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    gid: '0000000000000001',
    url: 'https://example.com/report.zip',
    filename: 'report.zip',
    dir: 'C:\\Downloads',
    filePath: null,
    status: 'active',
    totalBytes: 2_600_000,
    completedBytes: 1_200_000,
    speedBps: 1_000,
    etaSeconds: 2,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    ...overrides
  }
}

describe('handoff download status lookup', () => {
  it('reads one record with getItem and never rebuilds a snapshot', () => {
    const record = item()
    const getItem = vi.fn(() => record)
    const getSnapshot = vi.fn(() => {
      throw new Error('getSnapshot must not be called by the handoff poll')
    })

    const source = { getItem, getSnapshot }
    const lookup = createHandoffDownloadStatus(source)
    expect(lookup(record.id)).toEqual({
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    })
    expect(getItem).toHaveBeenCalledWith(record.id)
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('answers null for an unknown id without a snapshot', () => {
    const getSnapshot = vi.fn()
    const source = { getItem: () => null, getSnapshot }
    const lookup = createHandoffDownloadStatus(source)
    expect(lookup('00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('keeps the short safe error message and maps an exhausted failure', () => {
    const lookup = createHandoffDownloadStatus({
      getItem: () =>
        item({
          status: 'error',
          errorMessage: 'The server refused the connection.'
        })
    })
    expect(lookup('id')).toMatchObject({
      status: 'error',
      errorMessage: 'The server refused the connection.'
    })
  })

  it('works without a manager', () => {
    expect(createHandoffDownloadStatus(null)('id')).toBeNull()
  })
})
