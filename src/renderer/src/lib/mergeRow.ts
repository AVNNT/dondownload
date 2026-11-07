import type { MediaJob } from '@shared/media'
import { formatMergeProgressLabel, mergePercent } from '@shared/format'

/**
 * Presentation of one merging media row.
 *
 * The merge phase is the only part of a media job where yt-dlp reports no
 * progress of its own, so the row shows either the measured merge output size
 * or an honest indeterminate phase label — never a fake partial bar.
 */
export interface MergingRowView {
  /** Determinate percent (never 100), or null while the size is unknown. */
  percent: number | null
  /** Text after the bold "Merging" prefix; null renders as "Merging…". */
  suffix: string | null
  /** Right-aligned detail; the percent when the bar is determinate. */
  detail: string | null
}

export function mergingRowView(job: MediaJob): MergingRowView {
  const progress = job.mergeProgress
  if (!progress || progress.totalBytes <= 0) {
    return { percent: null, suffix: null, detail: null }
  }

  const percent = mergePercent(progress.completedBytes, progress.totalBytes)
  return {
    percent,
    suffix: formatMergeProgressLabel(progress.completedBytes, progress.totalBytes),
    detail: `${percent}%`
  }
}
