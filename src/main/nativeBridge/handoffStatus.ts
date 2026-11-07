import {
  mapDownloadStatus,
  type HandoffDownloadStatus
} from '@shared/downloadStatus'
import type { DownloadItem } from '@shared/types'

/** The small read-only manager surface the handoff card poll uses. */
export interface HandoffStatusSource {
  getItem(id: string): DownloadItem | null
}

/**
 * Answer the extension's 2 s hand-off poll from one record lookup.
 *
 * The old handler called `getSnapshot()` and searched its downloads, which
 * rebuilt and sorted the entire history for a single row. `getItem` is O(1)
 * and returns exactly the same public fields.
 */
export function createHandoffDownloadStatus(
  manager: HandoffStatusSource | null
): (downloadId: string) => HandoffDownloadStatus | null {
  return (downloadId) => {
    const record = manager?.getItem(downloadId) ?? null
    if (!record) return null
    return {
      status: mapDownloadStatus(record.status),
      completedBytes: record.completedBytes,
      totalBytes: record.totalBytes,
      filename: record.filename,
      ...(record.errorMessage === null
        ? {}
        : { errorMessage: record.errorMessage })
    }
  }
}
