import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_STATUS_CHANNEL,
  DOWNLOAD_STATUS_ROUTE,
  HANDOFF_DOWNLOAD_STATUSES,
  MAX_HANDOFF_STATUS_FILENAME_LENGTH,
  SHOW_DOWNLOAD_CHANNEL,
  SHOW_DOWNLOAD_ROUTE,
  mapDownloadStatus,
  parseHandoffDownloadRequest,
  parseHandoffDownloadStatus,
  safeDownloadErrorMessage,
  safeDownloadFilename
} from '../src/shared/downloadStatus'
import { ValidationError } from '../src/shared/validation'
import type { DownloadStatus } from '../src/shared/types'

const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'running',
    completedBytes: 1_200_000,
    totalBytes: 2_600_000,
    filename: 'report.zip',
    ...overrides
  }
}

describe('download status contract', () => {
  it('names the two additive routes and channels', () => {
    expect(DOWNLOAD_STATUS_CHANNEL).toBe('download-status')
    expect(DOWNLOAD_STATUS_ROUTE).toBe('/download-status')
    expect(SHOW_DOWNLOAD_CHANNEL).toBe('show-download')
    expect(SHOW_DOWNLOAD_ROUTE).toBe('/show-download')
    expect([...HANDOFF_DOWNLOAD_STATUSES]).toEqual([
      'queued',
      'running',
      'paused',
      'done',
      'error'
    ])
  })

  it('maps every desktop status onto the five browser-facing values', () => {
    const expected: Record<DownloadStatus, string> = {
      queued: 'queued',
      waiting: 'queued',
      active: 'running',
      paused: 'paused',
      complete: 'done',
      error: 'error',
      cancelled: 'error',
      interrupted: 'error'
    }
    for (const [desktop, browser] of Object.entries(expected)) {
      expect(mapDownloadStatus(desktop as DownloadStatus)).toBe(browser)
    }
  })

  it('accepts exactly one validated download id', () => {
    expect(parseHandoffDownloadRequest({ downloadId: DOWNLOAD_ID })).toEqual({
      downloadId: DOWNLOAD_ID
    })
    for (const value of [
      null,
      [],
      'download',
      {},
      { downloadId: 'not-a-uuid' },
      { downloadId: 42 },
      { downloadId: DOWNLOAD_ID, url: 'https://example.com/files/report.zip' },
      { downloadId: DOWNLOAD_ID, extra: true }
    ]) {
      expect(() => parseHandoffDownloadRequest(value)).toThrow(ValidationError)
    }
  })

  it('validates the desktop answer strictly', () => {
    expect(parseHandoffDownloadStatus(status())).toEqual({
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    })
    expect(
      parseHandoffDownloadStatus(status({ status: 'error', errorMessage: 'Disk full' }))
    ).toEqual({
      status: 'error',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip',
      errorMessage: 'Disk full'
    })
    // An unknown size is reported as zero, never as a negative number.
    expect(
      parseHandoffDownloadStatus(status({ totalBytes: 0, completedBytes: 0 }))
    ).toMatchObject({ totalBytes: 0, completedBytes: 0 })

    const badCases: unknown[] = [
      null,
      [],
      {},
      status({ status: 'downloading' }),
      status({ status: 1 }),
      status({ completedBytes: -1 }),
      status({ completedBytes: 1.5 }),
      status({ totalBytes: '1024' }),
      status({ filename: '' }),
      status({ filename: 'a'.repeat(MAX_HANDOFF_STATUS_FILENAME_LENGTH + 1) }),
      status({ url: 'https://example.com/files/report.zip' }),
      status({ filePath: 'C:\\Downloads\\report.zip' })
    ]
    for (const [index, value] of badCases.entries()) {
      let thrown: unknown = null
      try {
        parseHandoffDownloadStatus(value)
      } catch (error) {
        thrown = error
      }
      if (!(thrown instanceof ValidationError)) {
        throw new Error(
          `case ${index} did not throw a ValidationError: ${String(thrown)}`
        )
      }
    }
  })

  it('drops a directory prefix instead of rejecting the file name', () => {
    expect(safeDownloadFilename('C:\\Downloads\\report.zip')).toBe('report.zip')
    expect(safeDownloadFilename('/home/user/report.zip')).toBe('report.zip')
    expect(safeDownloadFilename('  report.zip  ')).toBe('report.zip')
    expect(safeDownloadFilename('')).toBe('')
    expect(safeDownloadFilename(undefined)).toBe('')
  })

  it('never forwards a URL or a path as an error message', () => {
    expect(safeDownloadErrorMessage('Disk full')).toBe('Disk full')
    expect(safeDownloadErrorMessage('  Disk full  ')).toBe('Disk full')
    expect(
      safeDownloadErrorMessage('Failed: https://example.com/files/report.zip')
    ).toBeUndefined()
    expect(safeDownloadErrorMessage('Failed at C:\\Downloads\\report.zip')).toBeUndefined()
    expect(safeDownloadErrorMessage('')).toBeUndefined()
    expect(safeDownloadErrorMessage('x'.repeat(201))).toBeUndefined()
    expect(safeDownloadErrorMessage(42)).toBeUndefined()
  })
})
