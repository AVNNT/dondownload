import { describe, expect, it } from 'vitest'
import type { MediaJob } from '../src/shared/media'
import { mergingRowView } from '../src/renderer/src/lib/mergeRow'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

function mergingJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: 'job-merging',
    analysisId: 'analysis-1',
    optionId: 'option-1',
    kind: 'video',
    title: 'Design systems in practice',
    label: '1080p · MP4 · video + audio',
    status: 'merging',
    completedBytes: 10_200,
    totalBytes: 10_200,
    speedBps: 0,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    ...overrides
  }
}

describe('merging row view', () => {
  it('shows a determinate bar with the percent and byte detail', () => {
    const view = mergingRowView(
      mergingJob({
        mergeProgress: {
          completedBytes: 4.1 * GIB,
          totalBytes: 10.2 * GIB
        }
      })
    )

    expect(view.percent).toBe(40)
    expect(view.suffix).toBe('4.1 of 10.2 GB')
    expect(view.detail).toBe('40%')
  })

  it('never claims 100% while the merge is still running', () => {
    const view = mergingRowView(
      mergingJob({
        mergeProgress: { completedBytes: 10.2 * GIB, totalBytes: 10.2 * GIB }
      })
    )

    expect(view.percent).toBe(99)
    expect(view.detail).toBe('99%')
  })

  it('falls back to the honest indeterminate phase label', () => {
    const view = mergingRowView(mergingJob())

    expect(view.percent).toBeNull()
    expect(view.suffix).toBeNull()
    expect(view.detail).toBeNull()
  })

  it('ignores a zero total instead of dividing by it', () => {
    const view = mergingRowView(
      mergingJob({ mergeProgress: { completedBytes: 0, totalBytes: 0 } })
    )

    expect(view.percent).toBeNull()
    expect(view.detail).toBeNull()
  })
})
