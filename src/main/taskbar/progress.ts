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
  /**
   * Re-apply the current aggregate to whatever window `getWindow` returns now.
   *
   * Call this after the window was recreated (the app destroys the renderer
   * while in the tray): a new `BrowserWindow` starts with no bar, so the cached
   * "last applied" value must not suppress the update. Also resets the throttle
   * so the new window gets the bar right away.
   */
  sync: () => void
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
   * a getter because the window is created after the download manager, and
   * because the window is destroyed and recreated when the app hides to the
   * tray and is shown again.
   */
  getWindow: () => TaskbarWindow | null
  /** Cheap aggregate readers for `refresh()` and `sync()`. */
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

/** The subset of `BrowserWindow` the controller touches. */
export interface TaskbarWindow {
  isDestroyed: () => boolean
  setProgressBar: (value: number) => void
}

const DEFAULT_THROTTLE_MS = 500

/**
 * Throttled taskbar driver. The first update after an idle period applies
 * immediately; later ones are coalesced so a fast aria2 poll cannot flood the
 * shell with `setProgressBar` calls. Identical values are not re-sent to the
 * same window; a recreated window always gets the current value, because its
 * bar starts empty.
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
  /** The window `applied` was sent to; a new identity invalidates the cache. */
  let appliedWindow: TaskbarWindow | null = null
  let applied: number | null = null
  let pending: number | null = null
  let timer: unknown = null
  let disposed = false

  /**
   * Returns the usable window, or null when there is none. Never merge the two
   * checks into one: a `BrowserWindow` destroyed between the getter and the
   * call would still be handed to `setProgressBar`, which throws.
   */
  const liveWindow = (): TaskbarWindow | null => {
    const window = options.getWindow()
    if (window === null || window.isDestroyed()) return null
    return window
  }

  /** True when `value` still has to be sent to `window`. */
  const needsApply = (window: TaskbarWindow, value: number): boolean =>
    appliedWindow !== window || applied !== value

  const apply = (value: number): void => {
    const window = liveWindow()
    if (window === null) return
    try {
      window.setProgressBar(value)
      appliedWindow = window
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
    const window = liveWindow()
    if (window === null) return
    // A recreated window always gets the current value, even if the number is
    // the same one the previous window already showed.
    if (!needsApply(window, value)) return
    lastAppliedAt = now()
    apply(value)
  }

  const schedule = (value: number): void => {
    pending = value
    if (timer !== null) return
    const window = liveWindow()
    // Same value already shown on this window: nothing to do.
    if (window !== null && !needsApply(window, value)) {
      pending = null
      return
    }
    const elapsed = now() - lastAppliedAt
    // A window created since the last apply must show the bar immediately.
    // Its progress bar starts empty and hiding the app stops publishes, so
    // waiting would leave the taskbar blank for up to one throttle window.
    // The same window keeps the ordinary throttle.
    const recreated = window !== null && appliedWindow !== window
    if (recreated || elapsed >= throttleMs) {
      flush()
      return
    }
    // No window at all: remember the newest value and retry shortly.
    timer = setTimer(() => {
      timer = null
      flush()
    }, Math.max(1, throttleMs - elapsed))
  }

  const currentValue = (): number | null => {
    if (options.read === undefined) return null
    return taskbarProgressValue(
      computeTaskbarProgressFromTotals(
        options.read.downloads(),
        options.read.mediaJobs?.()
      )
    )
  }

  const update = (input: TaskbarProgressInput): void => {
    if (!enabled || disposed) return
    schedule(taskbarProgressValue(computeTaskbarProgress(input)))
  }

  const refresh = (): void => {
    if (!enabled || disposed) return
    const value = currentValue()
    if (value === null) return
    schedule(value)
  }

  const sync = (): void => {
    if (!enabled || disposed) return
    // A window that is gone (or was never there) has nothing to show yet; the
    // next window creation triggers another `sync()`.
    const window = liveWindow()
    if (window === null) return
    clearPendingTimer()
    const value = currentValue() ?? pending
    if (value === null) {
      // Nothing known yet (no readers): forget the cache so the next publish
      // is applied to this window even if the number is unchanged.
      applied = null
      appliedWindow = null
      return
    }
    // The window identity changed, so the applied cache no longer describes
    // it and the throttle must not delay the very first paint of the bar.
    if (!needsApply(window, value)) return
    pending = null
    lastAppliedAt = now()
    apply(value)
  }

  return {
    update,
    refresh,
    flush,
    sync,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearPendingTimer()
      pending = null
      if (enabled && applied !== -1) apply(-1)
      applied = null
      appliedWindow = null
    }
  }
}
