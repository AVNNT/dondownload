import type { MenuItemConstructorOptions } from 'electron'
import {
  SPEED_LIMIT_PRESETS,
  isSpeedLimitPreset,
  speedLimitMenuLabel
} from '@shared/speedLimits'
import { formatPercent, formatSpeed } from '@shared/format'

/**
 * Build the tray's "Speed limit" radio submenu.
 *
 * The checked item reflects the current global download limit exactly. A value
 * that is not one of the shared presets (for example a custom number typed in
 * Settings) adds one checked, non-clickable `Custom (<value>)` item so the
 * menu never claims a preset is active when it is not.
 */
export function buildSpeedLimitSubmenu(
  currentBps: number,
  onSelect: (bps: number) => void
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = SPEED_LIMIT_PRESETS.map(
    (preset) => ({
      label: preset.label,
      type: 'radio',
      checked: currentBps === preset.bps,
      click: () => onSelect(preset.bps)
    })
  )

  if (!isSpeedLimitPreset(currentBps)) {
    items.push({
      label: speedLimitMenuLabel(currentBps),
      type: 'radio',
      checked: true,
      enabled: false
    })
  }

  return items
}

/* ------------------------------------------------------------------------- *
 * Tray menu model (pure)
 *
 * `tray.ts` owns the Electron Tray; everything the menu says is derived here
 * from one plain state object so it can be tested without Electron. The
 * template builder never reads the clock, the clipboard or the filesystem: the
 * caller samples those when the menu is about to open.
 * ------------------------------------------------------------------------- */

export interface TrayDownloadLike {
  id: string
  filename: string
  status: string
  filePath: string | null
  speedBps: number
  totalBytes: number
  completedBytes: number
  createdAt?: number
  completedAt?: number | null
}

export interface TrayMediaJobLike {
  id: string
  status: string
  createdAt?: number
  completedAt?: number | null
}

export interface TrayMenuState {
  windowVisible: boolean
  downloads: readonly TrayDownloadLike[]
  /** Media (yt-dlp/FFmpeg) jobs share the same pause/resume-all actions. */
  mediaJobs?: readonly TrayMediaJobLike[]
  /** Current global speed limit in bytes per second; `0` is unlimited. */
  speedLimitBps: number
  /** A validated http(s) URL currently on the clipboard, if any. */
  clipboardUrl: string | null
}

export interface TrayMenuActions {
  showWindow: () => void
  hideWindow: () => void
  openSettings: () => void
  pauseAll: () => void
  resumeAll: () => void
  setSpeedLimitBps: (bps: number) => void
  /** Open one finished download through the validated id → path path. */
  openDownload: (id: string) => void
  /** Reveal one finished download in Explorer (path re-validated in main). */
  showDownloadInFolder: (id: string) => void
  /** Start the Add dialog for the URL that was checked when the menu opened. */
  addFromClipboard: (url: string) => void
  quit: () => void
}

/** The same wording the toolbar and row menus use. */
export const TRAY_PAUSE_ALL_LABEL = 'Pause all'
export const TRAY_RESUME_ALL_LABEL = 'Resume all'
export const TRAY_SETTINGS_LABEL = 'Settings'
export const TRAY_QUIT_LABEL = 'Quit DonDownload'
export const TRAY_SHOW_IN_FOLDER_LABEL = 'Show in folder'
export const TRAY_ADD_FROM_CLIPBOARD_LABEL = 'Add from clipboard'
export const TRAY_RECENT_LABEL = 'Recent'
export const TRAY_SPEED_LIMIT_LABEL = 'Speed limit'
export const TRAY_NOTHING_DOWNLOADING = 'Nothing downloading'

/** The "Recent" submenu keeps this many finished downloads. */
export const TRAY_RECENT_LIMIT = 5
/** Long names are elided so the native menu stays one line high. */
export const TRAY_RECENT_NAME_MAX = 40

const MANUAL_PAUSE_STATUSES = new Set(['paused'])
const PAUSABLE_DOWNLOAD_STATUSES = new Set(['active', 'queued', 'waiting'])
const PAUSABLE_MEDIA_STATUSES = new Set([
  'queued',
  'analyzing',
  'downloading',
  'merging'
])

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * True when aria2 reports at least one transfer it is actually moving bytes
 * for. Queued and waiting jobs do not count: the speed in the status line is
 * measured, not promised.
 */
export function hasActiveDownloads(
  downloads: readonly TrayDownloadLike[]
): boolean {
  return downloads.some(
    (item) =>
      item.status === 'active' && Number.isFinite(item.speedBps) && item.speedBps >= 0
  )
}

export interface TrayDownloadSummary {
  active: number
  speedBps: number
  percent: number | null
}

/**
 * Count active transfers, sum their measured speed and derive one aggregate
 * percent (completed bytes / known total bytes across unfinished rows).
 * `percent` is null when no unfinished row has a known size, so the tooltip
 * can omit it instead of claiming 0%.
 */
export function summarizeDownloads(
  downloads: readonly TrayDownloadLike[]
): TrayDownloadSummary {
  let active = 0
  let speedBps = 0
  let completed = 0
  let total = 0
  for (const item of downloads) {
    if (item.status === 'complete' || item.status === 'cancelled') continue
    if (item.status === 'active') {
      active += 1
      speedBps += finiteNumber(item.speedBps)
    }
    const itemTotal = finiteNumber(item.totalBytes)
    if (itemTotal > 0) {
      total += itemTotal
      completed += Math.min(itemTotal, finiteNumber(item.completedBytes))
    }
  }
  return {
    active,
    speedBps,
    percent: total > 0 ? Math.round(formatPercent(completed, total)) : null
  }
}

/** First status line: "3 downloading · 4.2 MB/s" or "Nothing downloading". */
export function trayStatusLine(downloads: readonly TrayDownloadLike[]): string {
  const summary = summarizeDownloads(downloads)
  if (summary.active === 0) return TRAY_NOTHING_DOWNLOADING
  const count = summary.active === 1 ? '1 downloading' : `${summary.active} downloading`
  if (summary.speedBps <= 0) return count
  return `${count} · ${formatSpeed(summary.speedBps)}`
}

/**
 * Hover tooltip: "DonDownload · 3 downloading · 42%". Only meaningful while
 * something is downloading; the caller throttles how often it is applied.
 */
export function trayTooltip(
  downloads: readonly TrayDownloadLike[]
): string | null {
  const summary = summarizeDownloads(downloads)
  if (summary.active === 0) return null
  const count = summary.active === 1 ? '1 downloading' : `${summary.active} downloading`
  return summary.percent === null
    ? `DonDownload · ${count}`
    : `DonDownload · ${count} · ${summary.percent}%`
}

/** Elide a file name to `max` characters with a single trailing ellipsis. */
export function truncateTrayName(name: string, max = TRAY_RECENT_NAME_MAX): string {
  const trimmed = name.trim()
  if (trimmed.length <= max) return trimmed
  if (max <= 1) return trimmed.slice(0, max)
  return `${trimmed.slice(0, max - 1)}…`
}

/** One finished download, in menu order. */
export interface TrayRecentEntry {
  id: string
  label: string
  /** Main re-validates the path for this id before revealing the file. */
  pathKnown: boolean
}

/** True when the row is a completed download whose output still has a path. */
export function isFinishedDownload(item: TrayDownloadLike): boolean {
  return item.status === 'complete' && item.filePath !== null && item.filePath !== ''
}

/**
 * The last finished downloads, newest first, capped at `limit`. Oldest files
 * are trimmed away by the idle-history cleanup, so a row that survived it but
 * lost its path is skipped rather than shown as a dead menu entry.
 */
export function recentDownloads<T extends TrayDownloadLike>(
  downloads: readonly T[],
  limit = TRAY_RECENT_LIMIT
): T[] {
  if (limit <= 0) return []
  return downloads
    .filter(isFinishedDownload)
    .sort(
      (left, right) =>
        (right.completedAt ?? right.createdAt ?? 0) -
        (left.completedAt ?? left.createdAt ?? 0)
    )
    .slice(0, limit)
}

export function buildRecentSubmenu(
  downloads: readonly TrayDownloadLike[],
  actions: Pick<TrayMenuActions, 'openDownload' | 'showDownloadInFolder'>
): MenuItemConstructorOptions[] {
  const recent = recentDownloads(downloads, TRAY_RECENT_LIMIT)
  const items: MenuItemConstructorOptions[] = []
  for (const item of recent) {
    items.push({
      label: truncateTrayName(item.filename),
      click: () => actions.openDownload(item.id)
    })
  }
  const newest = recent[0]
  if (newest !== undefined) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({
      label: TRAY_SHOW_IN_FOLDER_LABEL,
      click: () => actions.showDownloadInFolder(newest.id)
    })
  }
  return items
}

/**
 * True when the aggregate toolbar "Resume all" would have work to do: a
 * manually paused row of either kind. A paused download is resumed through the
 * same manager path the toolbar uses.
 */
export function canResumeAll(state: TrayMenuState): boolean {
  return (
    state.downloads.some((item) => MANUAL_PAUSE_STATUSES.has(item.status)) ||
    (state.mediaJobs ?? []).some((job) =>
      MANUAL_PAUSE_STATUSES.has(job.status)
    )
  )
}

/** True when the toolbar "Pause all" would have work to do. */
export function canPauseAll(state: TrayMenuState): boolean {
  return (
    state.downloads.some((item) => PAUSABLE_DOWNLOAD_STATUSES.has(item.status)) ||
    (state.mediaJobs ?? []).some((job) =>
      PAUSABLE_MEDIA_STATUSES.has(job.status)
    )
  )
}

/**
 * Pure template for the tray's context menu, top to bottom:
 *
 *   status · Show/Hide · Pause all | Resume all · Speed limit · Recent ·
 *   Add from clipboard · Open DonDownload | Settings · Quit DonDownload
 *
 * "Pause all" is shown while anything can be paused; once only paused rows
 * remain it flips to "Resume all". The clipboard URL is fixed when the menu is
 * built, so a click always adds exactly the link the user saw.
 */
export function buildTrayMenuTemplate(
  state: TrayMenuState,
  actions: TrayMenuActions
): MenuItemConstructorOptions[] {
  const visible = state.windowVisible
  const clipboardUrl = state.clipboardUrl
  const template: MenuItemConstructorOptions[] = [
    { label: trayStatusLine(state.downloads), enabled: false },
    {
      label: visible ? 'Hide DonDownload' : 'Show DonDownload',
      click: () => {
        if (visible) actions.hideWindow()
        else actions.showWindow()
      }
    },
    {
      label: canPauseAll(state) ? TRAY_PAUSE_ALL_LABEL : TRAY_RESUME_ALL_LABEL,
      enabled: canPauseAll(state) ? true : canResumeAll(state),
      click: () => {
        if (canPauseAll(state)) actions.pauseAll()
        else actions.resumeAll()
      }
    },
    { type: 'separator' },
    {
      label: TRAY_SPEED_LIMIT_LABEL,
      submenu: buildSpeedLimitSubmenu(
        state.speedLimitBps,
        actions.setSpeedLimitBps
      )
    },
    {
      label: TRAY_RECENT_LABEL,
      submenu: buildRecentSubmenu(state.downloads, actions)
    },
    { type: 'separator' },
    {
      label: TRAY_ADD_FROM_CLIPBOARD_LABEL,
      enabled: clipboardUrl !== null,
      click: () => {
        if (clipboardUrl !== null) actions.addFromClipboard(clipboardUrl)
      }
    },
    { type: 'separator' },
    {
      label: TRAY_SETTINGS_LABEL,
      click: () => actions.openSettings()
    },
    {
      label: TRAY_QUIT_LABEL,
      click: () => actions.quit()
    }
  ]
  return template
}

/* ------------------------------------------------------------------------- *
 * Lazy rebuild policy
 * ------------------------------------------------------------------------- */

/** Never rebuild the native menu more often than this on download changes. */
export const TRAY_MENU_DEBOUNCE_MS = 3_000
/** Tooltip updates are throttled to this cadence while downloads are active. */
export const TRAY_TOOLTIP_INTERVAL_MS = 2_000

/**
 * Decides when the tray menu template is rebuilt. The menu is popped up by a
 * click, so it can be built exactly then; download progress updates only arm a
 * debounced rebuild so a change that lands while the menu is closed still
 * shows up without a rebuild per progress tick.
 *
 * No timer exists while nothing changes: the debounce is armed only by a
 * signature change worth showing, and the tooltip throttle only while active.
 */
export class TrayMenuScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastBuildAt = Number.NEGATIVE_INFINITY
  private signature: string | null = null

  constructor(
    private readonly build: () => void,
    private readonly now: () => number = Date.now,
    private readonly debounceMs: number = TRAY_MENU_DEBOUNCE_MS
  ) {}

  /** Menu about to open: build now with fresh state, cancelling any pending build. */
  requestNow(): void {
    this.cancel()
    this.buildNow()
  }

  /** Remember a signature without arming anything (used by `requestNow`). */
  observe(signature: string): void {
    this.signature = signature
  }

  /**
   * A download/media state or visibility change. Only a change in the
   * menu-relevant signature arms the debounce; identical progress does nothing.
   */
  onStateChanged(signature: string): void {
    if (signature === this.signature) return
    this.signature = signature
    if (this.timer !== null) return
    const elapsed = this.now() - this.lastBuildAt
    const delay = Math.max(0, this.debounceMs - elapsed)
    if (delay === 0) {
      this.buildNow()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.buildNow()
    }, delay)
    this.timer.unref?.()
  }

  /** Drop any armed rebuild (quit, or a menu that is being rebuilt now). */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.cancel()
  }

  private buildNow(): void {
    this.lastBuildAt = this.now()
    this.build()
  }
}

/** A cheap, stable signature of everything the menu template would show. */
export function trayMenuSignature(state: TrayMenuState): string {
  const recent = recentDownloads(state.downloads, TRAY_RECENT_LIMIT)
    .map((item) => `${item.id}:${item.filename}:${item.filePath !== null}`)
    .join('|')
  return [
    state.windowVisible ? 'v' : 'h',
    // Exactly the rendered status line: identical text is no change at all.
    trayStatusLine(state.downloads),
    canPauseAll(state) ? 'p' : canResumeAll(state) ? 'r' : '-',
    state.speedLimitBps,
    recent,
    state.clipboardUrl === null ? '' : 'c'
  ].join('\u0001')
}

/* ------------------------------------------------------------------------- *
 * Clipboard URL
 * ------------------------------------------------------------------------- */

const MAX_TRAY_CLIPBOARD_URL_LENGTH = 2_048

/**
 * The single http(s) URL on the clipboard, or null. This is the same shape the
 * clipboard watcher accepts, minus its "new text" bookkeeping: the menu only
 * needs to know whether "Add from clipboard" can do anything. It is called
 * when the menu opens, never on a timer.
 */
export function clipboardUrlForMenu(rawText: unknown): string | null {
  if (typeof rawText !== 'string') return null
  const text = rawText.trim()
  if (text.length === 0) return null
  if (text.length > MAX_TRAY_CLIPBOARD_URL_LENGTH) return null
  if (/\s/.test(text)) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username.length > 0 || url.password.length > 0) return null
  return text
}

