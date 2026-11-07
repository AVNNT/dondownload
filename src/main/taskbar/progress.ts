/**
 * Windows taskbar progress for the main window.
 *
 * The aggregate is derived only from downloads that are actually transferring,
 * so a paused, queued or finished row never keeps the taskbar bar alive. The
 * pure computation lives in `computeTaskbarProgress`; `createTaskbarProgress`
 * owns the throttled `BrowserWindow.setProgressBar` calls.
 */

/** The subset of a download row the taskbar needs. */
export interface TaskbarDownload {
  status: string
  completedBytes: number
  totalBytes: number
}

/** The subset of a media job the taskbar needs (same shape as downloads). */
export interface TaskbarMediaJob {
  status: string
  completedBytes: number
  totalBytes: number | null
}

export type TaskbarProgressMode = 'normal' | 'indeterminate' | 'none'

export interface TaskbarProgress {
  mode: TaskbarProgressMode
  /** 0..1, only meaningful for `normal`. */
  fraction: number
  /** How many rows contributed to this aggregate. */
  activeCount: number
}

export interface TaskbarProgressInput {
  downloads: readonly TaskbarDownload[]
  mediaJobs?: readonly TaskbarMediaJob[]
}

/**
 * Aggregate a manager already computed from its active rows. Building this
 * summary is O(active), so a publish never has to materialize and sort the
 * whole download/media history just to move the taskbar bar.
 */
export interface TaskbarActiveProgress {
  activeCount: number
  /** Active rows that reported a known total size. */
  sizedCount: number
  completedBytes: number
  totalBytes: number
}

export const TASKBAR_ACTIVE_PROGRESS_EMPTY: TaskbarActiveProgress =
  Object.freeze({
    activeCount: 0,
    sizedCount: 0,
    completedBytes: 0,
    totalBytes: 0
  })

const DOWNLOAD_ACTIVE_STATUSES = new Set(['active'])
const MEDIA_ACTIVE_STATUSES = new Set(['downloading'])

export const TASKBAR_PROGRESS_IDLE: TaskbarProgress = {
  mode: 'none',
  fraction: 0,
  activeCount: 0
}

function isKnownSize(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Aggregate every transferring row into one taskbar value.
 *
 * - No active rows → `none` (the caller clears the bar).
 * - Active rows but no known total size → `indeterminate`.
 * - Otherwise the summed completed/total ratio, clamped to 0..1.
 *
 * Rows with an unknown size still count as active, but they cannot contribute
 * to the ratio; if every active row is unknown the bar is indeterminate.
 */
export function computeTaskbarProgress(
  input: TaskbarProgressInput
): TaskbarProgress {
  let activeCount = 0
  let completed = 0
  let total = 0
  let sizedCount = 0

  for (const download of input.downloads) {
    if (!DOWNLOAD_ACTIVE_STATUSES.has(download.status)) continue
    activeCount += 1
    if (!isKnownSize(download.totalBytes)) continue
    sizedCount += 1
    total += download.totalBytes
    completed += Number.isFinite(download.completedBytes)
      ? Math.max(0, download.completedBytes)
      : 0
  }

  for (const job of input.mediaJobs ?? []) {
    if (!MEDIA_ACTIVE_STATUSES.has(job.status)) continue
    activeCount += 1
    if (!isKnownSize(job.totalBytes)) continue
    sizedCount += 1
    total += job.totalBytes
    completed += Number.isFinite(job.completedBytes)
      ? Math.max(0, job.completedBytes)
      : 0
  }

  if (activeCount === 0) return TASKBAR_PROGRESS_IDLE
  if (sizedCount === 0 || total <= 0) {
    return { mode: 'indeterminate', fraction: 0, activeCount }
  }

  return {
    mode: 'normal',
    fraction: Math.min(1, Math.max(0, completed / total)),
    activeCount
  }
}

/**
 * Same aggregate as `computeTaskbarProgress`, from two cheap summaries. The
 * managers keep these up to date as statuses change, so this is O(1).
 */
export function computeTaskbarProgressFromTotals(
  downloads: TaskbarActiveProgress,
  mediaJobs: TaskbarActiveProgress = TASKBAR_ACTIVE_PROGRESS_EMPTY
): TaskbarProgress {
  const activeCount = downloads.activeCount + mediaJobs.activeCount
  if (activeCount === 0) return TASKBAR_PROGRESS_IDLE

  const sizedCount = downloads.sizedCount + mediaJobs.sizedCount
  const total = downloads.totalBytes + mediaJobs.totalBytes
  if (sizedCount === 0 || total <= 0) {
    return { mode: 'indeterminate', fraction: 0, activeCount }
  }

  const completed =
    Math.max(0, downloads.completedBytes) + Math.max(0, mediaJobs.completedBytes)
  return {
    mode: 'normal',
    fraction: Math.min(1, Math.max(0, completed / total)),
    activeCount
  }
}

/**
 * Convert a taskbar value into the exact argument `setProgressBar` expects.
 * `-1` removes the bar; a number below zero never means "indeterminate".
 */
export function taskbarProgressValue(progress: TaskbarProgress): number {
  if (progress.mode === 'none') return -1
  if (progress.mode === 'indeterminate') return 2
  return progress.fraction
}

export interface TaskbarProgressController {
  /** Recompute from the latest rows and schedule a throttled update. */
  update: (input: TaskbarProgressInput) => void
  /**
   * Recompute from the cheap active-row summaries configured through `read`.
   * This is the path used on every publish; it never builds a full snapshot.
   */
  refresh: () => void
  /** Apply the pending value immediately (used on teardown). */
  flush: () => void
  /** Stop timers and clear the bar. */
  dispose: () => void
}

export interface TaskbarProgressReader {
  downloads: () => TaskbarActiveProgress
  mediaJobs?: () => TaskbarActiveProgress
}

export interface TaskbarProgressOptions {
  /**
   * Returns the live window or null when none exists / it was destroyed. It is
   * a getter because the window is created after the download manager.
   */
  getWindow: () => {
    isDestroyed: () => boolean
    setProgressBar: (value: number) => void
  } | null
  /** Cheap aggregate readers for `refresh()`. */
  read?: TaskbarProgressReader
  /**
   * Minimum delay between two `setProgressBar` calls. Default 500 ms, i.e. at
   * most two shell updates per second no matter how often a publish fires.
   */
  throttleMs?: number
  /** Disable everything (smoke/E2E runs). */
  enabled?: boolean
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const DEFAULT_THROTTLE_MS = 500

/**
 * Throttled taskbar driver. The first update after an idle period applies
 * immediately; later ones are coalesced so a fast aria2 poll cannot flood the
 * shell with `setProgressBar` calls. Identical values are not re-sent.
 */
export function createTaskbarProgress(
  options: TaskbarProgressOptions
): TaskbarProgressController {
  const enabled = options.enabled ?? true
  const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS)
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay)
      // Never keep the process alive just for a taskbar refresh.
      ;(timer as { unref?: () => void }).unref?.()
      return timer
    })
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })

  let lastAppliedAt = Number.NEGATIVE_INFINITY
  let applied: number | null = null
  let pending: number | null = null
  let timer: unknown = null
  let disposed = false

  const apply = (value: number): void => {
    const window = options.getWindow()
    if (window === null || window.isDestroyed()) return
    try {
      window.setProgressBar(value)
      applied = value
    } catch {
      // A window can be destroyed between the check and the call.
    }
  }

  const clearPendingTimer = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const flush = (): void => {
    clearPendingTimer()
    if (disposed || pending === null) return
    const value = pending
    pending = null
    if (value === applied) return
    lastAppliedAt = now()
    apply(value)
  }

  const schedule = (value: number): void => {
    pending = value
    if (timer !== null) return
    const elapsed = now() - lastAppliedAt
    if (elapsed >= throttleMs) {
      flush()
      return
    }
    timer = setTimer(() => {
      timer = null
      flush()
    }, throttleMs - elapsed)
  }

  const update = (input: TaskbarProgressInput): void => {
    if (!enabled || disposed) return
    schedule(taskbarProgressValue(computeTaskbarProgress(input)))
  }

  const refresh = (): void => {
    if (!enabled || disposed || options.read === undefined) return
    schedule(
      taskbarProgressValue(
        computeTaskbarProgressFromTotals(
          options.read.downloads(),
          options.read.mediaJobs?.()
        )
      )
    )
  }

  return {
    update,
    refresh,
    flush,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearPendingTimer()
      pending = null
      if (enabled && applied !== -1) apply(-1)
      applied = null
    }
  }
}
