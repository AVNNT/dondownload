import { describe, expect, it, vi } from 'vitest'
import {
  computeTaskbarProgress,
  computeTaskbarProgressFromTotals,
  createTaskbarProgress,
  taskbarProgressValue,
  TASKBAR_ACTIVE_PROGRESS_EMPTY,
  TASKBAR_PROGRESS_IDLE,
  type TaskbarActiveProgress,
  type TaskbarProgressReader,
  type TaskbarWindow,
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

describe('computeTaskbarProgressFromTotals', () => {
  function totals(
    overrides: Partial<TaskbarActiveProgress> = {}
  ): TaskbarActiveProgress {
    return {
      activeCount: 1,
      sizedCount: 1,
      completedBytes: 250,
      totalBytes: 1_000,
      ...overrides
    }
  }

  it('matches the row-based aggregate for downloads and media jobs', () => {
    const downloads: TaskbarDownload[] = [
      download({ completedBytes: 100, totalBytes: 200 }),
      download({ totalBytes: 0 }),
      download({ status: 'complete' })
    ]
    const jobs: TaskbarMediaJob[] = [
      mediaJob({ completedBytes: 300, totalBytes: 800 }),
      mediaJob({ status: 'merging' })
    ]
    const rows = computeTaskbarProgress({ downloads, mediaJobs: jobs })
    const sums = computeTaskbarProgressFromTotals(
      { activeCount: 2, sizedCount: 1, completedBytes: 100, totalBytes: 200 },
      { activeCount: 1, sizedCount: 1, completedBytes: 300, totalBytes: 800 }
    )
    expect(sums).toEqual(rows)
    expect(sums.fraction).toBeCloseTo(0.4)
  })

  it('reports none without active rows and indeterminate without sizes', () => {
    expect(
      computeTaskbarProgressFromTotals(TASKBAR_ACTIVE_PROGRESS_EMPTY)
    ).toEqual(TASKBAR_PROGRESS_IDLE)
    expect(
      computeTaskbarProgressFromTotals(
        totals({ sizedCount: 0, totalBytes: 0 })
      ).mode
    ).toBe('indeterminate')
  })

  it('clamps hostile byte counts', () => {
    const progress = computeTaskbarProgressFromTotals(
      totals({ completedBytes: 5_000, totalBytes: 1_000 })
    )
    expect(progress.fraction).toBe(1)
    expect(
      computeTaskbarProgressFromTotals(
        totals({ completedBytes: -100, totalBytes: 1_000 })
      ).fraction
    ).toBe(0)
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
  function harness(
    options: { enabled?: boolean; read?: TaskbarProgressReader } = {}
  ) {
    const calls: number[] = []
    const window = {
      isDestroyed: () => false,
      setProgressBar: (value: number) => {
        calls.push(value)
      }
    }
    // Mirrors `mainWindow`: the app destroys it in the tray and creates a new
    // one when the window is shown again.
    let current: typeof window | null = window
    let clock = 0
    const timers: Array<{ at: number; callback: () => void }> = []
    const controller = createTaskbarProgress({
      enabled: options.enabled ?? true,
      getWindow: () => current,
      ...(options.read === undefined ? {} : { read: options.read }),
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
    /** Destroy the current window (hiding to the tray) and forget it. */
    const destroyWindow = (): void => {
      current = null
    }
    /** Create the replacement window (showing it again). */
    const createWindow = (): typeof window => {
      const next = {
        isDestroyed: () => false,
        setProgressBar: (value: number) => {
          calls.push(value)
        }
      }
      current = next
      return next
    }
    return {
      calls,
      controller,
      advance,
      window,
      destroyWindow,
      createWindow,
      currentWindow: () => current
    }
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

  it('refreshes from aggregate readers and coalesces rapid publishes', () => {
    let reads = 0
    const read: TaskbarProgressReader = {
      downloads: () => {
        reads += 1
        return {
          activeCount: 1,
          sizedCount: 1,
          completedBytes: reads * 100,
          totalBytes: 1_000
        }
      }
    }
    const { calls, controller, advance } = harness({ read })

    controller.refresh()
    expect(calls).toEqual([0.1])
    controller.refresh()
    controller.refresh()
    controller.refresh()
    controller.refresh()
    // Five publishes in one throttle window still apply at most twice per
    // second: the first immediately and the newest once the window opens.
    expect(calls).toEqual([0.1])
    advance(500)
    expect(calls).toEqual([0.1, 0.5])
    expect(reads).toBe(5)
  })

  it('refresh is a no-op without readers or when disabled', () => {
    const disabledRead = vi.fn(() => TASKBAR_ACTIVE_PROGRESS_EMPTY)
    const disabled = harness({
      enabled: false,
      read: { downloads: disabledRead }
    })
    disabled.controller.refresh()
    expect(disabledRead).not.toHaveBeenCalled()
    expect(disabled.calls).toEqual([])

    const noReader = harness()
    expect(() => noReader.controller.refresh()).not.toThrow()
    expect(noReader.calls).toEqual([])
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

  describe('after the window is recreated', () => {
    function aggregate(completedBytes: number, totalBytes: number) {
      return {
        activeCount: 1,
        sizedCount: 1,
        completedBytes,
        totalBytes
      }
    }

    it('re-applies the current value to the new window immediately', () => {
      const read: TaskbarProgressReader = {
        downloads: () => aggregate(250, 1_000)
      }
      const { controller, calls, destroyWindow, createWindow } = harness({
        read
      })

      controller.refresh()
      expect(calls).toEqual([0.25])

      // Hide to the tray: the controller keeps running, the window goes away.
      destroyWindow()
      controller.refresh()
      expect(calls).toEqual([0.25])

      // Show again: a new window with an empty taskbar bar must be re-applied
      // even though the value did not change.
      createWindow()
      controller.sync()
      expect(calls).toEqual([0.25, 0.25])
    })

    it('applies only to the new window and never the destroyed one', () => {
      const oldCalls: number[] = []
      const newCalls: number[] = []
      let current: TaskbarWindow | null = {
        isDestroyed: () => false,
        setProgressBar: (value) => oldCalls.push(value)
      }
      const destroyed = current
      const controller = createTaskbarProgress({
        getWindow: () => current,
        read: { downloads: () => aggregate(500, 1_000) }
      })
      controller.refresh()
      expect(oldCalls).toEqual([0.5])

      // The window is destroyed for real: any call would throw.
      destroyed.isDestroyed = () => true
      destroyed.setProgressBar = () => {
        throw new Error('Object has been destroyed')
      }
      current = null
      expect(() => controller.sync()).not.toThrow()

      current = {
        isDestroyed: () => false,
        setProgressBar: (value) => newCalls.push(value)
      }
      controller.sync()
      expect(newCalls).toEqual([0.5])
      expect(oldCalls).toEqual([0.5])
    })

    it('does not wait for the throttle window on a recreated window', () => {
      const { controller, calls, advance, destroyWindow, createWindow } =
        harness({
          read: { downloads: () => aggregate(100, 1_000) }
        })
      controller.refresh()
      advance(100)
      controller.refresh()
      // Coalesced: still inside the 500 ms throttle.
      expect(calls).toEqual([0.1])

      destroyWindow()
      createWindow()
      controller.sync()
      expect(calls).toEqual([0.1, 0.1])
      // `sync()` also discards the pending timer, so no duplicate later.
      advance(1_000)
      expect(calls).toEqual([0.1, 0.1])
    })

    it('drops the cache when no window exists yet', () => {
      const { controller, calls, destroyWindow, createWindow } = harness({
        read: { downloads: () => aggregate(100, 1_000) }
      })
      controller.refresh()
      expect(calls).toEqual([0.1])

      destroyWindow()
      controller.sync()
      expect(calls).toEqual([0.1])

      createWindow()
      controller.refresh()
      expect(calls).toEqual([0.1, 0.1])
    })

    it('syncs a recreated window back to idle when nothing is active', () => {
      let active = aggregate(100, 1_000)
      const { controller, calls, destroyWindow, createWindow } = harness({
        read: { downloads: () => active }
      })
      controller.refresh()
      expect(calls).toEqual([0.1])

      // The last transfer finished while the window was gone.
      destroyWindow()
      active = TASKBAR_ACTIVE_PROGRESS_EMPTY
      createWindow()
      controller.sync()
      expect(calls).toEqual([0.1, -1])
    })
  })

  it('uses real timers by default', () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const window = {
        isDestroyed: () => false,
        setProgressBar: (value: number) => calls.push(value)
      }
      const controller = createTaskbarProgress({
        getWindow: () => window
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
