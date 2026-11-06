import { describe, expect, it, vi } from 'vitest'
import {
  computeTaskbarProgress,
  createTaskbarProgress,
  taskbarProgressValue,
  TASKBAR_PROGRESS_IDLE,
  type TaskbarMediaJob,
  type TaskbarDownload
} from '../src/main/taskbar/progress'

function download(
  overrides: Partial<TaskbarDownload> = {}
): TaskbarDownload {
  return { status: 'active', completedBytes: 0, totalBytes: 1_000, ...overrides }
}

function mediaJob(overrides: Partial<TaskbarMediaJob> = {}): TaskbarMediaJob {
  return {
    status: 'downloading',
    completedBytes: 0,
    totalBytes: 1_000,
    ...overrides
  }
}

describe('computeTaskbarProgress', () => {
  it('reports none when nothing is transferring', () => {
    expect(computeTaskbarProgress({ downloads: [] })).toEqual(
      TASKBAR_PROGRESS_IDLE
    )
    expect(
      computeTaskbarProgress({
        downloads: [
          download({ status: 'complete' }),
          download({ status: 'paused' }),
          download({ status: 'queued' }),
          download({ status: 'error' }),
          download({ status: 'waiting' })
        ]
      }).mode
    ).toBe('none')
  })

  it('aggregates completed over total bytes across active downloads', () => {
    const progress = computeTaskbarProgress({
      downloads: [
        download({ completedBytes: 250, totalBytes: 1_000 }),
        download({ completedBytes: 750, totalBytes: 1_000 }),
        // Finished rows never contribute.
        download({ status: 'complete', completedBytes: 9_000, totalBytes: 9_000 })
      ]
    })
    expect(progress.mode).toBe('normal')
    expect(progress.fraction).toBeCloseTo(0.5)
    expect(progress.activeCount).toBe(2)
  })

  it('is indeterminate when active rows have no known size', () => {
    const progress = computeTaskbarProgress({
      downloads: [
        download({ totalBytes: 0 }),
        download({ totalBytes: Number.NaN })
      ]
    })
    expect(progress.mode).toBe('indeterminate')
    expect(progress.activeCount).toBe(2)
  })

  it('uses only sized rows when some active rows are unknown', () => {
    const progress = computeTaskbarProgress({
      downloads: [
        download({ completedBytes: 500, totalBytes: 1_000 }),
        download({ totalBytes: 0 })
      ]
    })
    expect(progress.mode).toBe('normal')
    expect(progress.fraction).toBeCloseTo(0.5)
    expect(progress.activeCount).toBe(2)
  })

  it('clamps out-of-range byte counts', () => {
    const progress = computeTaskbarProgress({
      downloads: [
        download({ completedBytes: 5_000, totalBytes: 1_000 }),
        download({ completedBytes: -50, totalBytes: 1_000 })
      ]
    })
    expect(progress.fraction).toBeGreaterThanOrEqual(0)
    expect(progress.fraction).toBeLessThanOrEqual(1)
  })

  it('includes downloading media jobs', () => {
    const progress = computeTaskbarProgress({
      downloads: [download({ completedBytes: 100, totalBytes: 200 })],
      mediaJobs: [
        mediaJob({ completedBytes: 300, totalBytes: 800 }),
        mediaJob({ status: 'queued', completedBytes: 0, totalBytes: 1_000 })
      ]
    })
    expect(progress.mode).toBe('normal')
    expect(progress.fraction).toBeCloseTo(400 / 1_000)
    expect(progress.activeCount).toBe(2)
  })

  it('is indeterminate when only an unsized media job is active', () => {
    expect(
      computeTaskbarProgress({
        downloads: [],
        mediaJobs: [mediaJob({ totalBytes: null })]
      }).mode
    ).toBe('indeterminate')
  })
})

describe('taskbarProgressValue', () => {
  it('maps modes to BrowserWindow.setProgressBar values', () => {
    expect(taskbarProgressValue(TASKBAR_PROGRESS_IDLE)).toBe(-1)
    expect(
      taskbarProgressValue({ mode: 'indeterminate', fraction: 0, activeCount: 1 })
    ).toBe(2)
    expect(
      taskbarProgressValue({ mode: 'normal', fraction: 0.25, activeCount: 1 })
    ).toBe(0.25)
  })
})

describe('createTaskbarProgress', () => {
  function harness(options: { enabled?: boolean } = {}) {
    const calls: number[] = []
    const window = {
      isDestroyed: () => false,
      setProgressBar: (value: number) => {
        calls.push(value)
      }
    }
    let clock = 0
    const timers: Array<{ at: number; callback: () => void }> = []
    const controller = createTaskbarProgress({
      enabled: options.enabled ?? true,
      getWindow: () => window,
      now: () => clock,
      setTimer: (callback, delay) => {
        const timer = { at: clock + delay, callback }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        const index = timers.indexOf(handle as (typeof timers)[number])
        if (index >= 0) timers.splice(index, 1)
      }
    })
    const advance = (ms: number): void => {
      clock += ms
      for (const timer of [...timers]) {
        if (timer.at <= clock) {
          timers.splice(timers.indexOf(timer), 1)
          timer.callback()
        }
      }
    }
    return { calls, controller, advance, window }
  }

  it('applies the first value immediately and throttles the rest', () => {
    const { calls, controller, advance } = harness()
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    expect(calls).toEqual([0.1])

    controller.update({ downloads: [download({ completedBytes: 200 })] })
    controller.update({ downloads: [download({ completedBytes: 300 })] })
    expect(calls).toEqual([0.1])

    advance(500)
    expect(calls).toEqual([0.1, 0.3])
  })

  it('clears the bar with -1 when nothing is active', () => {
    const { calls, controller, advance } = harness()
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    advance(500)
    controller.update({ downloads: [download({ status: 'complete' })] })
    expect(calls).toEqual([0.1, -1])
  })

  it('sends 2 for indeterminate progress', () => {
    const { calls, controller } = harness()
    controller.update({ downloads: [download({ totalBytes: 0 })] })
    expect(calls).toEqual([2])
  })

  it('does not resend an unchanged value', () => {
    const { calls, controller, advance } = harness()
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    advance(500)
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    expect(calls).toEqual([0.1])
  })

  it('is a no-op when disabled', () => {
    const { calls, controller, advance } = harness({ enabled: false })
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    advance(1_000)
    controller.dispose()
    expect(calls).toEqual([])
  })

  it('skips a destroyed window', () => {
    const calls: number[] = []
    const controller = createTaskbarProgress({
      getWindow: () => ({
        isDestroyed: () => true,
        setProgressBar: (value: number) => calls.push(value)
      })
    })
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    expect(calls).toEqual([])
  })

  it('tolerates a missing window', () => {
    const controller = createTaskbarProgress({ getWindow: () => null })
    expect(() =>
      controller.update({ downloads: [download({ completedBytes: 100 })] })
    ).not.toThrow()
  })

  it('clears the bar on dispose and stops accepting updates', () => {
    const { calls, controller } = harness()
    controller.update({ downloads: [download({ completedBytes: 100 })] })
    controller.dispose()
    controller.update({ downloads: [download({ completedBytes: 900 })] })
    expect(calls).toEqual([0.1, -1])
  })

  it('tolerates a window destroyed between the check and the call', () => {
    const controller = createTaskbarProgress({
      getWindow: () => ({
        isDestroyed: () => false,
        setProgressBar: () => {
          throw new Error('Object has been destroyed')
        }
      })
    })
    expect(() =>
      controller.update({ downloads: [download({ completedBytes: 100 })] })
    ).not.toThrow()
  })

  it('uses real timers by default', () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const controller = createTaskbarProgress({
        getWindow: () => ({
          isDestroyed: () => false,
          setProgressBar: (value: number) => calls.push(value)
        })
      })
      controller.update({ downloads: [download({ completedBytes: 100 })] })
      controller.update({ downloads: [download({ completedBytes: 400 })] })
      expect(calls).toEqual([0.1])
      vi.advanceTimersByTime(500)
      expect(calls).toEqual([0.1, 0.4])
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
