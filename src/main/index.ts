import { app, BrowserWindow, clipboard, dialog } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { promises as fsPromises } from 'node:fs'
import { spawn } from 'node:child_process'
import { IPC } from '@shared/ipc'
import { APP_USER_MODEL_ID } from '@shared/appIdentity'
import { isAllowedAt } from '@shared/schedule'
import { typeFolderDirectory } from '@shared/typeFolders'
import { DEFAULT_THEME, type AppTheme } from '@shared/settings'
import {
  START_HIDDEN_ARG,
  nextInterfaceSize,
  zoomFactorFor,
  type DesktopSettings,
  type InterfaceSize
} from '@shared/desktopSettings'
import type { AppSnapshot, Aria2State, DownloadItem } from '@shared/types'
import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type { MediaJob, MediaToolState } from '@shared/media'
import type { Batch } from '@shared/batches'
import {
  batchRowVersion,
  downloadRowVersion,
  mediaRowVersion
} from '@shared/snapshotDelta'
import { Aria2Service, defaultDownloadDir } from './aria2/service'
import { BatchManager } from './batches/manager'
import { ChecksumService } from './checksum/service'
import { openDownloadDatabase, resolveDownloadDatabasePath } from './db/database'
import { DownloadManager } from './downloads/manager'
import { HistoryCleanupService } from './history/cleanup'
import { createPixeldrainAdapter } from './hosts/pixeldrain'
import { createMegaAdapter } from './hosts/mega'
import { createMediaEngine } from './media/engine'
import { createYtdlpUpdater, type YtdlpUpdater } from './media/updater'
import {
  createAppUpdateChecker,
  type AppUpdateChecker
} from './appUpdate/checker'
import {
  DEFAULT_MAX_ACTIVE_MEDIA_JOBS,
  MediaJobsManager
} from './mediaJobs/manager'
import { registerIpc } from './ipc'
import { SettingsManager } from './settings/manager'
import { DesktopSettingsManager } from './settings/desktopManager'
import { ClipboardWatcher } from './clipboard/watcher'
import { AppError } from './errors'
import { createElectronHost } from './electronHost'
import { CompletionNotificationService } from './notifications/service'
import { detectInstalledBrowsers } from './browsers/detect'
import { buildWelcomeInfo } from './welcome/info'
import { loginItemSettings, shouldManageLoginItem } from './desktop/loginItem'
import {
  decideBeforeQuit,
  decideWindowClose,
  decideWindowShow,
  isCleanupRunning,
  shouldQuitWhenAllWindowsClosed
} from './lifecycle'
import { startNativeBridge, type NativeBridge } from './nativeBridge/server'
import { createHandoffDownloadStatus } from './nativeBridge/handoffStatus'
import { ScanSessionManager } from './scanner/session'
import { ScanQueueService } from './scanner/queue'
import {
  ManualMatchService,
  ManualMatchStore
} from './scanner/manualMatch'
import { BrowserMatchService } from './scanner/browserMatch'
import {
  createNativeHostRegistrar,
  createNodeFileSystem,
  createRegExeRegistry,
  unregisterNativeHost,
  type NativeHostRegistrar
} from './nativeHost/registration'
import { createAppTray, type AppTray } from './tray'
import {
  decideIdleStubHandOff,
  dismissLeftoverStub,
  idleStubEnvPolicy,
  idleStubShowArgs,
  resolveIdleStubGraceMs,
  spawnIdleStub,
  IDLE_STUB_ENV,
  IDLE_STUB_GRACE_ENV
} from './idleStub'
import {
  createIdleStubController,
  type IdleStubController
} from './idleStub/controller'
import {
  createTaskbarProgress,
  TASKBAR_ACTIVE_PROGRESS_EMPTY,
  type TaskbarProgressController
} from './taskbar/progress'
import { createMainWindow } from './window'
import { SnapshotDeltaPublisher } from './snapshotDeltaPublisher'
import { startupNow, traceStartup } from './startupTrace'
import { loadSmokeTestConfig, type SmokeTestConfigEnabled } from './smoke/config'
import {
  attachSmokeDiagnostics,
  SmokeDiagnosticsCollector
} from './smoke/diagnostics'
import {
  createSmokeFixtureLookup,
  createSmokeFixturePreflight
} from './smoke/smokeFixture'
import {
  createSmokeResult,
  safeDetail,
  writeSmokeResultSync,
  type SmokeCheckResult
} from './smoke/report'
import { runSmokeTest } from './smoke/run'
import { memoryBenchOutPath } from './memoryBench/report'
import { startMemoryBench } from './memoryBench/runner'
import { mergeFeatureList } from './commandLine/features'
import {
  closeLogger,
  configureLogger,
  defaultSecretValues,
  defaultUserPaths,
  getLogger,
  logDebug,
  logError,
  logInfo,
  logWarn,
  logDirectory,
  recentLogLines
} from './logging'
import { buildDiagnostics, DIAGNOSTICS_LOG_LINES } from './diagnostics'

// The UI is a plain list: no video, no 3D, no canvas. Chromium's GPU process
// costs roughly 60 MB of RAM and buys nothing for it, so software rendering is
// the default. DONDOWNLOAD_GPU=1 restores hardware acceleration when a
// rendering problem has to be ruled out. Must run before `ready`.
if (process.env.DONDOWNLOAD_GPU !== '1') {
  app.disableHardwareAcceleration()
  // Keeps the separate software GPU process inside the browser process instead
  // of paying for one: −47 MB total (bench:memory median of 3; the GPU process
  // falls from 68 MB to 0 and the main process absorbs its work).
  app.commandLine.appendSwitch('in-process-gpu')
  // Runs Chromium's network service inside the browser process instead of a
  // ~55 MB utility process: −51 MB total. Downloads still go through aria2; the
  // renderer's asset loads and the app-update checks use this in-process net.
  // Merged with any existing list, never overwritten, so other features survive.
  app.commandLine.appendSwitch(
    'enable-features',
    mergeFeatureList(app.commandLine.getSwitchValue('enable-features'), [
      'NetworkServiceInProcess2'
    ])
  )
}

let mainWindow: BrowserWindow | null = null
/** A clipboard link seen while no window existed, offered on the next show. */
let pendingClipboardLink: string | null = null
let appTray: AppTray | null = null
let aria2: Aria2Service | null = null
let manager: DownloadManager | null = null
let mediaJobs: MediaJobsManager | null = null
let batches: BatchManager | null = null
let historyCleanup: HistoryCleanupService | null = null
let settingsManager: SettingsManager | null = null
let desktopSettingsManager: DesktopSettingsManager | null = null
let clipboardWatcher: ClipboardWatcher | null = null
let notifications: CompletionNotificationService | null = null
let mediaUpdater: YtdlpUpdater | null = null
let appUpdate: AppUpdateChecker | null = null
let nativeBridge: NativeBridge | null = null
let nativeHostRegistrar: NativeHostRegistrar | null = null
let scanner: ScanSessionManager | null = null
let scanQueue: ScanQueueService | null = null
let taskbarProgress: TaskbarProgressController | null = null
let downloadPublisher: SnapshotDeltaPublisher<
  DownloadItem,
  { aria2: Aria2State }
> | null = null
let mediaPublisher: SnapshotDeltaPublisher<
  MediaJob,
  { tool: MediaToolState }
> | null = null
let batchPublisher: SnapshotDeltaPublisher<Batch, Record<string, never>> | null =
  null
/** Hands the idle app over to the native tray stub, or null when ineligible. */
let idleStub: IdleStubController | null = null

/** True only when the renderer can actually show a progress update. */
function snapshotWindowVisible(): boolean {
  const window = mainWindow
  return (
    window !== null &&
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized()
  )
}

function refreshSnapshotDelivery(): void {
  const visible = snapshotWindowVisible()
  downloadPublisher?.setVisible(visible)
  mediaPublisher?.setVisible(visible)
  batchPublisher?.setVisible(visible)
}

function requestSnapshotResync(): void {
  downloadPublisher?.requestFull()
  mediaPublisher?.requestFull()
  batchPublisher?.requestFull()
}

/**
 * Drop every per-window delta baseline. A destroyed window's renderer state is
 * gone, so the next window must receive a full snapshot instead of a patch
 * against rows it never received.
 */
function resetSnapshotDelivery(): void {
  downloadPublisher?.reset()
  mediaPublisher?.reset()
  batchPublisher?.reset()
}

/** A user or OS quit request has been accepted; windows may now close. */
let quitRequested = false
/** The orderly flush/stop/close sequence is running; never run it twice. */
let cleanupStarted = false
/** Cleanup completed; only then may the final internal app.quit proceed. */
let cleanupFinished = false

function writeFatalSmokeConfiguration(config: SmokeTestConfigEnabled): void {
  const detail = config.errors.join(' | ') || 'Invalid smoke-test configuration.'
  const check: SmokeCheckResult = {
    name: 'config.valid',
    status: 'FAIL',
    detail,
    durationMs: 0
  }
  const result = createSmokeResult({
    environment: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      userDataPath: config.userDataDir ?? '<unset>',
      resourcesPath: process.resourcesPath ?? '<unset>'
    },
    checks: [check],
    logs: [`Smoke-test configuration rejected: ${detail}`]
  })
  if (config.resultPath !== null) {
    try {
      writeSmokeResultSync(config.resultPath, result)
    } catch {
      // The result path itself may be unusable; stderr still carries the reason.
    }
  }
  console.error(`[dondownload-smoke] FAIL config.valid: ${detail}`)
  console.error(JSON.stringify(result))
}

const smokeConfig = loadSmokeTestConfig({
  argv: process.argv,
  env: process.env,
  defaultUserDataPath: path.join(app.getPath('appData'), app.getName()),
  cwd: process.cwd()
})

let smoke: SmokeTestConfigEnabled | null = null
if (smokeConfig.enabled) {
  if (!smokeConfig.ok) {
    // Never fall through to normal startup with a rejected smoke request: that
    // could open the real profile or desktop UI.
    writeFatalSmokeConfiguration(smokeConfig)
    app.exit(2)
  } else {
    smoke = smokeConfig
    // Apply the isolated directory before ready so every Electron path (session
    // data, caches, SQLite and the bridge state file) stays inside it.
    app.setPath('userData', smokeConfig.userDataDir as string)
    app.setPath('sessionData', smokeConfig.userDataDir as string)
    app.setPath(
      'crashDumps',
      path.join(smokeConfig.userDataDir as string, 'crashDumps')
    )
  }
}

/** Optional RAM benchmark outfile; null for every normal launch. */
const memoryBenchPath = memoryBenchOutPath(process.env)

traceStartup('main bundle evaluated; smoke configuration resolved')

/**
 * The one log file for this process: `%APPDATA%\dondownload\logs\main.log`.
 * It is configured after the single-instance check below, so a second launch
 * never appends to a file the running app owns. A configuration failure must
 * never stop the app from starting.
 */
function startFileLogging(): void {
  try {
    configureLogger({
      directory: path.join(app.getPath('logs')),
      userPaths: defaultUserPaths()
    })
  } catch {
    // Logging is a diagnostic aid; the app works without it.
  }
}

/**
 * One uncaught exception or unhandled rejection, recorded and then shown.
 * The original behaviour (a crash on an uncaught exception) is kept: the log
 * only adds the redacted reason for the next bug report.
 */
function installCrashLogging(): void {
  process.on('uncaughtException', (error) => {
    logError('Uncaught exception: %s', error)
  })
  process.on('unhandledRejection', (reason) => {
    // A rejected promise is reported, not fatal: most come from a cancelled
    // native request or a bridge call whose reply no longer matters.
    logWarn('Unhandled promise rejection: %s', reason)
  })
}

/** Facts about this machine that a bug report needs and that are not personal. */
function logStartup(): void {
  logInfo(
    'Starting DonDownload %s (%s, Windows build %s, %s)',
    app.getVersion(),
    app.isPackaged ? 'packaged' : 'development',
    os.release(),
    process.arch
  )
  logInfo(
    'Runtime: Electron %s, Chromium %s, Node %s',
    process.versions.electron ?? 'unknown',
    process.versions.chrome ?? 'unknown',
    process.versions.node
  )
  logInfo('Log folder: %s', logDirectory() ?? 'unavailable')
  if (process.env.DONDOWNLOAD_DEBUG_LOG === '1') {
    logDebug('Debug logging is enabled (DONDOWNLOAD_DEBUG_LOG=1).')
  }
}

/**
 * Paths for zero-config native messaging registration. Evaluated only after
 * Electron is ready, so appData/appPath are final (including dev vs packaged).
 */
function createRegistrationDependencies() {
  return {
    appDataPath: app.getPath('appData'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    platform: process.platform,
    registry: createRegExeRegistry(),
    fileSystem: createNodeFileSystem(),
    logger: (message: string) => {
      logWarn(message)
      if (!app.isPackaged) console.error(message)
    }
  }
}

const unregisterRequested = process.argv.includes('--unregister-native-host')

function isMainWindowVisible(): boolean {
  return Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
  )
}

/**
 * True while a download is queued, waiting for the policy gate or actively
 * transferring. A paused, completed or failed download does not block an app
 * update install.
 */
function hasActiveDownloadJobs(): boolean {
  return manager?.hasPendingDownloads() ?? false
}

/**
 * A browser/native hand-off arrived recently; keep the full engine awake so the
 * extension bridge can answer it instead of input passing to a sleeping app.
 */
const RECENT_HAND_OFF_MS = 120_000
let recentHandOffUntil = 0
function markRecentHandOff(): void {
  recentHandOffUntil = Date.now() + RECENT_HAND_OFF_MS
}

/**
 * True whenever the full engine has work that the tiny tray stub cannot do:
 * active/queued/waiting downloads, media jobs (analyzing, downloading, merging,
 * or held back by the allowed-hours gate), batches with active items, running
 * scans, a verified app update waiting to install, and clipboard watching.
 *
 * Clipboard watching counts because the stub is only a tray icon: if the app
 * handed over while watching, copied links would silently stop being offered.
 * An active browser hand-off also counts, so the stub cannot wake the app right
 * after replacing it.
 */
function isIdleStubBusy(): boolean {
  if (desktopSettingsManager?.getSettings().watchClipboard ?? false) return true
  if (recentHandOffUntil > Date.now()) return true
  if (manager?.hasPendingDownloads() ?? false) return true
  if ((manager?.getActiveProgress().activeCount ?? 0) > 0) return true
  if (mediaJobs?.hasActiveJobs() ?? false) return true
  if (mediaJobs?.hasPendingPolicyWork() ?? false) return true
  if ((mediaJobs?.getActiveProgress().activeCount ?? 0) > 0) return true
  if (batches?.hasActiveBatchWork() ?? false) return true
  if (scanner?.hasActiveScans() ?? false) return true
  if (appUpdate?.getState().canInstall ?? false) return true
  return false
}

/**
 * "Free memory when idle in the tray" is enabled by the setting, unless
 * `DONDOWNLOAD_IDLE_STUB=0` turns it off. Development builds never hand over
 * on their own: the packaged stub executable and a packaged app path do not
 * exist there. `DONDOWNLOAD_IDLE_STUB=1` opts a development build in so the
 * spawn path can be exercised by hand.
 */
function isIdleStubEnabled(): boolean {
  const policy = idleStubEnvPolicy(process.env[IDLE_STUB_ENV])
  if (!policy.enabled) return false
  if (!(desktopSettingsManager?.getSettings().exitToTrayStubWhenIdle ?? false)) {
    return false
  }
  return app.isPackaged || policy.forceInDev
}

/** Re-evaluate the hand-over after anything that may change its inputs. */
function refreshIdleStub(): void {
  idleStub?.evaluate()
}

/**
 * Replace this process with the tiny native tray stub.
 *
 * Only a packaged run may do this, never smoke or the memory benchmark, and
 * only when the stub actually shipped. The stub is spawned detached first, so
 * the tray icon never blinks out, then the ordinary quit path runs: aria2, the
 * media children and the database are shut down exactly as for the tray's
 * "Quit" item. A cancelled or failed quit disposes and clears the controller.
 */
function exitToStub(): boolean {
  const decision = decideIdleStubHandOff({
    isPackaged: app.isPackaged,
    isSmoke: smoke !== null || process.env.DONDOWNLOAD_SMOKE_TEST === '1',
    isMemoryBench: memoryBenchPath !== null,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env: process.env[IDLE_STUB_ENV],
    hasRecentHandOff: isIdleStubBusy()
  })
  if (decision.action !== 'hand-off') {
    traceStartup(`idle stub hand-off refused: ${decision.reason}`)
    return false
  }
  traceStartup('idle stub hand-off: starting native tray stub')
  logInfo('Idle: handing the tray to the native stub')
  spawnIdleStub(
    decision.executable,
    idleStubShowArgs(process.execPath, decision.icon),
    spawn
  )
  idleStub?.dispose()
  idleStub = null
  quitRequested = true
  app.quit()
  return true
}

function refreshTray(): void {
  appTray?.refresh()
}

function applyInterfaceZoom(size: InterfaceSize): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.setZoomFactor(zoomFactorFor(size))
  } catch {
    // A closing/hidden window must never block a settings save.
  }
}

function applyLoginItem(settings: DesktopSettings): void {
  if (
    !shouldManageLoginItem({
      isPackaged: app.isPackaged,
      platform: process.platform
    })
  ) {
    return
  }
  try {
    app.setLoginItemSettings(
      loginItemSettings(process.execPath, settings.launchAtLogin)
    )
  } catch {
    // A locked-down policy may refuse login-item changes; the app still works.
  }
}

function applyDesktopSettings(settings: DesktopSettings): void {
  applyInterfaceZoom(settings.interfaceSizePercent)
  applyLoginItem(settings)
  clipboardWatcher?.setEnabled(settings.watchClipboard)
  // Watching the clipboard makes the app busy for the idle hand-off, and the
  // setting itself can arm or disarm it, so both changes re-evaluate.
  refreshIdleStub()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.desktopSettingsChanged, settings)
  }
}

/** Ctrl+= / Ctrl+- step the persisted zoom; Ctrl+0 resets to 100%. */
async function changeInterfaceSize(direction: -1 | 0 | 1): Promise<void> {
  if (!desktopSettingsManager) return
  const current = desktopSettingsManager.getSettings()
  const next = nextInterfaceSize(current.interfaceSizePercent, direction)
  if (next === current.interfaceSizePercent) return
  try {
    await desktopSettingsManager.update({
      ...current,
      interfaceSizePercent: next
    })
  } catch {
    // Keep the previous zoom; the next keypress can retry.
  }
}

function openMainWindow(
  show = true,
  offscreen = false,
  theme: AppTheme = settingsManager?.getSettings().theme ?? DEFAULT_THEME
): BrowserWindow {
  const window = createMainWindow({ show, offscreen, theme })
  if (!offscreen) {
    try {
      window.webContents.setZoomFactor(
        zoomFactorFor(
          desktopSettingsManager?.getSettings().interfaceSizePercent ?? 100
        )
      )
    } catch {
      // Zoom is a preference; the window is still usable with the default.
    }
    window.webContents.on('before-input-event', (event, input) => {
      if (!input.control || input.alt || input.meta) return
      const key = input.key
      let direction: -1 | 0 | 1 | null = null
      if (key === '=' || key === '+') direction = 1
      else if (key === '-' || key === '_') direction = -1
      else if (key === '0') direction = 0
      if (direction === null) return
      event.preventDefault()
      void changeInterfaceSize(direction)
    })
  }

  window.on('close', (event) => {
    const action = decideWindowClose({
      isQuitting: quitRequested || cleanupStarted,
      trayAvailable: appTray !== null
    })
    if (action === 'hide-to-tray') {
      // aria2, the download manager and the browser bridge keep running without
      // a window; the renderer does not. Destroy it after the close event has
      // unwound so the next show can build a fresh one.
      event.preventDefault()
      window.hide()
      refreshTray()
      setImmediate(() => destroyMainWindow(window))
    }
  })
  window.on('show', () => {
    refreshTray()
    refreshSnapshotDelivery()
    // A shown window cancels a pending hand-off; `show` is initial too.
    refreshIdleStub()
  })
  window.on('hide', () => {
    refreshTray()
    refreshSnapshotDelivery()
    refreshIdleStub()
  })
  window.on('minimize', refreshSnapshotDelivery)
  window.on('restore', refreshSnapshotDelivery)
  window.webContents.on('did-finish-load', () => {
    // A freshly loaded renderer has no revision baseline. One full delta gives
    // it a clean starting point and reclaims any hidden-window catch-up.
    refreshSnapshotDelivery()
    requestSnapshotResync()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    refreshTray()
    refreshIdleStub()
  })

  return window
}

/**
 * Tear the window down for real. The renderer process, its JavaScript heap and
 * its compositor surfaces are the largest memory consumers in the app, so a
 * hidden app keeps only the main process resident. Everything that must survive
 * (aria2, the download manager, the browser bridge, notifications, the tray and
 * taskbar progress) reads the window through a null-tolerant getter.
 */
function destroyMainWindow(window: BrowserWindow): void {
  if (mainWindow === window) {
    mainWindow = null
    resetSnapshotDelivery()
  }
  if (!window.isDestroyed()) {
    try {
      window.destroy()
    } catch {
      // A window already tearing down must not break the tray action.
    }
  }
  refreshTray()
  refreshIdleStub()
}

function showMainWindow(): void {
  const action = decideWindowShow({
    windowExists: mainWindow !== null,
    windowDestroyed: mainWindow?.isDestroyed() ?? false
  })
  if (action === 'create') {
    // A destroyed window cannot be shown again. The fresh renderer loads from
    // scratch, and `ready-to-show` shows it as soon as it has painted.
    mainWindow = openMainWindow()
    // The new window's taskbar bar is empty: re-apply the current aggregate
    // right away (a download or media job may still be running while hidden).
    taskbarProgress?.sync()
    const zoomPercent =
      desktopSettingsManager?.getSettings().interfaceSizePercent
    if (zoomPercent !== undefined) applyInterfaceZoom(zoomPercent)
    const clipboardLink = pendingClipboardLink
    pendingClipboardLink = null
    if (clipboardLink !== null) {
      sendToMainWindow((window) =>
        window.webContents.send(IPC.clipboardLink, clipboardLink)
      )
    }
    refreshTray()
    return
  }
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  refreshTray()
}

function hideMainWindow(): void {
  const window = mainWindow
  if (window !== null && !window.isDestroyed()) {
    window.hide()
    destroyMainWindow(window)
  }
  refreshTray()
}

/* ------------------------------------------------------------------------- *
 * Tray menu actions
 *
 * The menu only ever names rows by id; opening and revealing a finished file
 * go through the download manager's own validated id → record → path methods,
 * exactly like the renderer's "Open" and "Show in folder" actions.
 * ------------------------------------------------------------------------- */

/** Pause-all through the same per-row manager calls the toolbar uses. */
async function pauseAllDownloads(): Promise<void> {
  const current = manager
  if (current !== null) {
    const rows = current
      .getSnapshot()
      .downloads.filter(
        (item) =>
          item.status === 'active' ||
          item.status === 'queued' ||
          item.status === 'waiting'
      )
    for (const row of rows) {
      try {
        await current.pause(row.id)
      } catch (error) {
        logTrayActionError('A download could not be paused', error)
      }
    }
  }
  for (const job of mediaJobs?.getMediaSnapshot().jobs ?? []) {
    if (
      job.status !== 'queued' &&
      job.status !== 'analyzing' &&
      job.status !== 'downloading' &&
      job.status !== 'merging'
    ) {
      continue
    }
    try {
      await mediaJobs?.pauseMedia(job.id)
    } catch (error) {
      logTrayActionError('A media job could not be paused', error)
    }
  }
  refreshTray()
}

/** Resume-all through the same per-row manager calls the toolbar uses. */
async function resumeAllDownloads(): Promise<void> {
  const current = manager
  if (current !== null) {
    const rows = current
      .getSnapshot()
      .downloads.filter((item) => item.status === 'paused')
    for (const row of rows) {
      try {
        await current.resume(row.id)
      } catch (error) {
        logTrayActionError('A download could not be resumed', error)
      }
    }
  }
  for (const job of mediaJobs?.getMediaSnapshot().jobs ?? []) {
    if (job.status !== 'paused') continue
    try {
      await mediaJobs?.resumeMedia(job.id)
    } catch (error) {
      logTrayActionError('A media job could not be resumed', error)
    }
  }
  refreshTray()
}

function openTrayDownload(id: string): void {
  void manager?.openFile(id).catch((error) => {
    logTrayActionError('A finished file could not be opened', error)
  })
}

function showTrayDownloadInFolder(id: string): void {
  void manager?.showInFolder(id).catch((error) => {
    logTrayActionError('A finished file could not be revealed', error)
  })
}

/** "Settings" in the tray shows the window on the Settings page. */
function openSettingsFromTray(): void {
  showMainWindow()
  sendToMainWindow((window) => window.webContents.send(IPC.openSettings))
}

/** "Add from clipboard" hands the checked URL to the renderer's Add dialog. */
function addFromClipboardFromTray(url: string): void {
  showMainWindow()
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  sendToMainWindow((target) => target.webContents.send(IPC.clipboardLink, url))
}

function logTrayActionError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : 'unknown error'
  logError('%s: %s', message, detail)
  if (!app.isPackaged) console.error(`${message}: ${detail}`)
}

/** Feed one published download/media state to the tray's tooltip throttle. */
function refreshTrayDownloads(): void {
  appTray?.onDownloadStateChanged()
}

/**
 * Deliver one message to the current window, waiting for a freshly created
 * renderer to finish loading. A window recreated after close-to-tray has no
 * listeners yet, so a direct send would be dropped.
 */
function sendToMainWindow(send: (window: BrowserWindow) => void): void {
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  if (window.webContents.isLoading()) {
    // React subscribes in an effect that can run just after did-finish-load
    // (see the scan handoff below), so give it a moment before sending.
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (window.isDestroyed()) return
        send(window)
      }, 750).unref?.()
    })
    return
  }
  send(window)
}

/**
 * Run startup work that is not needed for the first frame only after the
 * renderer has produced its first paint. `ready-to-show` is Electron's
 * first-frame signal; the bounded fallback keeps the work from being skipped
 * entirely when the window never shows (for example, a failed renderer load or
 * a hidden start with no window at all). The task runs exactly once and never
 * blocks the caller.
 */
function scheduleAfterFirstPaint(
  window: BrowserWindow | null,
  task: () => void
): void {
  let started = false
  const run = (): void => {
    if (started) return
    started = true
    const handle = setImmediate(() => task())
    handle.unref?.()
  }
  if (window === null || window.isDestroyed()) {
    run()
    return
  }
  window.once('ready-to-show', run)
  const fallback = setTimeout(run, 3_000)
  fallback.unref?.()
}

if (unregisterRequested) {
  // Installer cleanup mode. This runs before any single-instance lock, window,
  // tray or bridge so it can never be swallowed by an already-running app.
  // The helper leaves dev registrations pointing at the repository alone.
  app.whenReady().then(async () => {
    const result = await unregisterNativeHost(createRegistrationDependencies())
    if (result.lastError !== null) {
      // Installer cleanup runs before the app is ready, so there is no log file
      // to own; stderr is the only channel and the installer shows it.
      console.error(`Browser extension cleanup failed: ${result.lastError}`)
    }
    app.exit(0)
  })
} else if (!smokeConfig.enabled || smokeConfig.ok) {
  // Smoke verification uses an isolated userData directory, so it must not
  // compete with (or focus) an already-running normal desktop instance.
  const hasSingleInstanceLock =
    smoke !== null ? true : app.requestSingleInstanceLock()

  if (!hasSingleInstanceLock) {
    app.quit()
  } else {
    // One writer per profile: the lock above guarantees no other instance of
    // this app is appending to the same file.
    startFileLogging()
    installCrashLogging()
    if (smoke === null) {
      app.on('second-instance', () => {
        // A second launch focuses the existing app, including after close-to-tray.
        showMainWindow()
      })
    }

    app.whenReady().then(async () => {
      traceStartup('app ready')
      logStartup()
      if (smoke === null) {
        // Windows toast buttons activate through this id. It must match the
        // NSIS shortcut created from electron-builder's appId
        // (see src/shared/appIdentity.ts and tests/app-identity.test.ts).
        app.setAppUserModelId(APP_USER_MODEL_ID)
      }
      const downloadDir =
        smoke !== null
          ? path.join(app.getPath('userData'), 'smoke-downloads')
          : defaultDownloadDir(app.getPath('downloads'))

    const host = createElectronHost()

    aria2 = new Aria2Service(() => downloadDir, host)

    // History uses the SQLite runtime bundled with Electron's Node (node:sqlite),
    // in a dedicated file under Electron's userData directory.
    let database: ReturnType<typeof openDownloadDatabase> | null = null
    // A tray stub left over from a previous run must go before this process
    // creates its own tray, so two icons never coexist. Fire and forget: a
    // missing stub simply means nothing is running.
    dismissLeftoverStub(
      {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        env: process.env[IDLE_STUB_ENV]
      },
      spawn
    )
    const databaseStartedAt = startupNow()
    try {
      database = openDownloadDatabase(
        resolveDownloadDatabasePath(app.getPath('userData'))
      )
    } catch (error) {
      // Keep the app usable if storage is unavailable; downloads still work but
      // history will not survive a relaunch. Do not log URLs or payloads.
      const detail = error instanceof Error ? error.message : 'unknown error'
      logError('Download history is unavailable: %s', detail)
      if (!app.isPackaged) console.error(`Download history is unavailable: ${detail}`)
    }
    traceStartup(
      'history database opened and migrated',
      startupNow() - databaseStartedAt
    )

    // Runtime download settings are loaded once before aria2 starts. The
    // service applies the persisted limits after aria2 answers but before it
    // reports ready, and live updates use aria2.changeGlobalOption without
    // restarting aria2 or touching active downloads.
    const settings = new SettingsManager({
      store: database,
      aria2,
      // Allowed-hours edits take effect on the existing policy timer; active
      // aria2 transfers are never paused by a settings change. The tray menu
      // and every renderer surface also refresh from the same committed
      // snapshot, so a tray/toolbar preset never leaves another view stale.
      onChanged: (next) => {
        // The retention choice takes effect immediately; "Never" makes this a
        // no-op. Running transfers are never touched.
        historyCleanup?.runNow()
        void manager?.refreshPolicy()
        refreshTray()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.settingsChanged, next)
        }
      }
    })
    settingsManager = settings
    aria2.onBeforeReady = (client) => settings.applyStartup(client)

    // Desktop preferences are separate from the aria2 settings above. Their
    // side effects are applied here so a save through IPC takes effect at once.
    desktopSettingsManager = new DesktopSettingsManager({
      store: database,
      onChanged: (next) => applyDesktopSettings(next)
    })
    clipboardWatcher = new ClipboardWatcher({
      readText: () => clipboard.readText(),
      isEnabled: () => desktopSettingsManager?.getSettings().watchClipboard ?? false,
      // Hidden to the tray means no window to react in: poll less often.
      hasWindow: () => mainWindow !== null && !mainWindow.isDestroyed(),
      onUrl: (url) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.clipboardLink, url)
        } else {
          // No renderer while hidden to the tray: keep the newest link and
          // offer it when the window is next created.
          pendingClipboardLink = url
        }
      }
    })
    clipboardWatcher.setEnabled(
      desktopSettingsManager.getSettings().watchClipboard
    )
    applyLoginItem(desktopSettingsManager.getSettings())

    notifications = new CompletionNotificationService({
      host,
      // Off by default (opt-in), and never shown in smoke or E2E harness runs.
      isEnabled: () =>
        smoke === null &&
        process.env.DONDOWNLOAD_INTERACTIVE_SMOKE !== '1' &&
        process.env.DONDOWNLOAD_SMOKE_TEST !== '1' &&
        (desktopSettingsManager?.getSettings().showNotifications ?? false),
      onActivate: (kind, id, action) => {
        showMainWindow()
        sendToMainWindow((window) => {
          window.webContents.send(IPC.revealRow, `${kind}:${id}`)
          // The toast button runs through the same validated open/show IPC the
          // renderer already uses, so a file that moved or was deleted shows
          // the existing "file missing" banner instead of failing silently.
          if (action !== 'activate') {
            window.webContents.send(IPC.notificationAction, {
              kind,
              id,
              action
            })
          }
        })
      }
    })

    // Main-only token store for "Match to video file…". A picked path never
    // crosses IPC; both the download manager and batch renames resolve it here.
    const manualMatchStore = new ManualMatchStore()

    // Windows taskbar progress. The window is created further below, so the
    // controller reads it through a getter; smoke/E2E runs never touch the
    // shell taskbar. Updates are throttled inside the controller.
    taskbarProgress = createTaskbarProgress({
      enabled: smoke === null,
      getWindow: () => (mainWindow === null ? null : mainWindow),
      // Cheap aggregate readers; no snapshot is built for a publish.
      read: {
        downloads: () => manager?.getActiveProgress() ?? TASKBAR_ACTIVE_PROGRESS_EMPTY,
        mediaJobs: () =>
          mediaJobs?.getActiveProgress() ?? TASKBAR_ACTIVE_PROGRESS_EMPTY
      }
    })
    const updateTaskbarProgress = (): void => {
      taskbarProgress?.refresh()
    }

    // Snapshot streams are revisioned deltas: one full snapshot when the
    // renderer loads, then patches. Suppressed while the window is hidden and
    // caught up with one delta when it is shown again.
    downloadPublisher = new SnapshotDeltaPublisher<
      DownloadItem,
      { aria2: Aria2State }
    >({
      send: (delta) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.snapshotChanged, delta)
        }
      },
      isVisible: snapshotWindowVisible,
      rowVersion: downloadRowVersion
    })
    mediaPublisher = new SnapshotDeltaPublisher<
      MediaJob,
      { tool: MediaToolState }
    >({
      send: (delta) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.mediaSnapshotChanged, delta)
        }
      },
      isVisible: snapshotWindowVisible,
      rowVersion: mediaRowVersion
    })
    batchPublisher = new SnapshotDeltaPublisher<Batch, Record<string, never>>({
      send: (delta) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.batchSnapshotChanged, delta)
        }
      },
      isVisible: snapshotWindowVisible,
      rowVersion: batchRowVersion
    })

    manager = new DownloadManager(
      aria2,
      downloadDir,
      (snapshot: AppSnapshot) => {
        notifications?.observeDownloads(snapshot)
        downloadPublisher?.publish({
          fields: { aria2: snapshot.aria2 },
          rows: snapshot.downloads
        })
        updateTaskbarProgress()
        // Tooltip only, at most every two seconds; the menu builds on open.
        refreshTrayDownloads()
        // A download starting, finishing or queueing changes whether the app
        // may hand over to the idle tray stub.
        refreshIdleStub()
      },
      database,
      {
        host,
        settings: () => settings.getSettings(),
        autoResume: () =>
          desktopSettingsManager?.getSettings().resumeInterruptedOnStartup ??
          false,
        resolvePairingFolder: (token) =>
          manualMatchStore.resolveFolder(token)
      }
    )

    // Streaming hash jobs read only the download's own recorded file. Progress
    // is pushed about four times a second; the finished result is persisted by
    // the download manager and published through the normal snapshot.
    const checksums = new ChecksumService({
      resolveTarget: (downloadId) => {
        if (manager === null) {
          throw new AppError(
            'CHECKSUM_UNAVAILABLE',
            'Checksum verification is not available.'
          )
        }
        return manager.checksumTarget(downloadId)
      },
      saveResult: (downloadId, result) => {
        manager?.saveChecksumResult(downloadId, result)
      },
      onProgress: (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.checksumProgress, progress)
        }
      }
    })

    const mediaDir = path.join(downloadDir, 'Media')
    const managedToolsDir = path.join(
      app.getPath('userData'),
      'tools',
      'yt-dlp'
    )
    mediaUpdater = createYtdlpUpdater({
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      store: database,
      // Ordinary smoke verification must never perform background network
      // work. A manual check remains available in the normal desktop app.
      autoUpdateAllowed: smoke === null,
      isJobActive: () => mediaJobs?.hasActiveJobs() ?? false
    })
    // An explicitly opted-in interactive smoke session may pin the isolated
    // fixture host to its public placeholder so the normal public-target check
    // still runs while yt-dlp can reach the local HLS fixture. No environment
    // value means no change to production behaviour.
    const mediaFixtureHost = process.env.DONDOWNLOAD_SMOKE_FIXTURE_HOST?.trim()
    const mediaFixtureAddress =
      process.env.DONDOWNLOAD_SMOKE_FIXTURE_ADDRESS?.trim()
    const mediaFixturePublicAddress =
      process.env.DONDOWNLOAD_SMOKE_FIXTURE_PUBLIC_ADDRESS?.trim()
    const mediaFixtureLookup =
      process.env.DONDOWNLOAD_SMOKE_TEST === '1' &&
      mediaFixtureHost !== undefined &&
      mediaFixtureHost.length > 0 &&
      mediaFixtureAddress !== undefined &&
      mediaFixtureAddress.length > 0 &&
      mediaFixturePublicAddress !== undefined &&
      mediaFixturePublicAddress.length > 0
        ? createSmokeFixtureLookup([
            {
              hostname: mediaFixtureHost,
              address: mediaFixtureAddress,
              publicAddress: mediaFixturePublicAddress,
              family: 4
            }
          ])
        : undefined
    const mediaEngine = createMediaEngine({
      managedToolsDir,
      userDataPath: app.getPath('userData'),
      ...(mediaFixtureLookup === undefined
        ? {}
        : { lookup: mediaFixtureLookup })
    })
    mediaJobs = new MediaJobsManager({
      host,
      engine: mediaEngine,
      mediaDir,
      // With sorting enabled, media output joins the same Video/Audio folders
      // as ordinary downloads. Off keeps the existing Media folder.
      outputDirFor: (kind) =>
        settings.getSettings().sortDownloadsByType
          ? typeFolderDirectory(downloadDir, kind === 'audio' ? 'Audio' : 'Video')
          : mediaDir,
      outputRootDir: downloadDir,
      database,
      startAllowed: (now) => isAllowedAt(settings.getSettings(), now),
      // Never more media jobs than the download limit, and at most two
      // yt-dlp/ffmpeg pairs: they are the heaviest processes the app starts.
      maxActiveJobs: () =>
        Math.min(
          settings.getSettings().maxConcurrentDownloads,
          DEFAULT_MAX_ACTIVE_MEDIA_JOBS
        ),
      onExtractorFailure: () => mediaUpdater?.notifyExtractorFailure() ?? Promise.resolve(false),
      onUpdate: (snapshot) => {
        // A deferred verified update becomes visible only after every active
        // media job has settled; no executable is swapped mid-run.
        mediaUpdater?.onJobsChanged()
        notifications?.observeMedia(snapshot)
        mediaPublisher?.publish({
          fields: { tool: snapshot.tool },
          rows: snapshot.jobs
        })
        updateTaskbarProgress()
        // Media jobs share the tray's pause/resume-all and status counts.
        refreshTrayDownloads()
        refreshIdleStub()
      }
    })

    // The download manager's existing poll timer also wakes media jobs that
    // were queued while the allowed-hours gate was closed. There is no second
    // scheduler.
    manager.setMediaPolicyPort({
      hasPendingPolicyWork: () => mediaJobs?.hasPendingPolicyWork() ?? false,
      pumpPolicy: (now) => mediaJobs?.pumpPolicy(now)
    })

    // Milestone 3B: the batch manager reuses the existing download and media
    // managers as ports, so duplicate policy and child lifecycles stay owned by
    // those systems. It loads persisted batches and marks any active work
    // interrupted instead of auto-resuming it.
    batches = new BatchManager({
      host,
      downloads: manager,
      mediaJobs,
      collectionEngine: mediaEngine,
      pixeldrain: createPixeldrainAdapter(),
      mega: createMegaAdapter(),
      database,
      scanMediaDir: mediaDir,
      scanRootDir: downloadDir,
      resolvePairingFolder: (token) => manualMatchStore.resolveFolder(token),
      onUpdate: (snapshot) => {
        batchPublisher?.publish({
          fields: {},
          rows: snapshot.batches
        })
        refreshIdleStub()
      }
    })

    // Automatic history cleanup. It starts only after a short delay so the
    // first window paints first, then sweeps every six hours. Only list rows
    // are removed; downloaded files always stay on disk. A settings change
    // calls runNow() directly (see `onChanged` above).
    historyCleanup = new HistoryCleanupService({
      downloads: manager,
      mediaJobs,
      batches,
      store: database,
      settings: () => settings.getSettings()
    })
    historyCleanup.start()

    // Smart Link Scanner. Discovery and probing only; the queue service is the
    // single explicit selection path and revalidates every item first.
    scanner = new ScanSessionManager({
      pixeldrain: createPixeldrainAdapter(),
      mega: createMegaAdapter(),
      ...(mediaJobs === null
        ? {}
        : {
            analyzeMedia: (url, analyzeOptions) =>
              mediaJobs!.analyzeMedia(
                {
                  url,
                  ...(analyzeOptions?.cookie === undefined
                    ? {}
                    : { cookie: analyzeOptions.cookie })
                },
                analyzeOptions?.signal === undefined
                  ? {}
                  : { signal: analyzeOptions.signal }
              )
          }),
      onUpdate: (session) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.scanUpdated, session)
        }
        // A scan starting or settling changes the busy state.
        refreshIdleStub()
      }
    })
    if (batches !== null) {
      scanQueue = new ScanQueueService({
        sessions: scanner,
        batches,
        ...(mediaJobs === null ? {} : { mediaJobs })
      })
    }

    const manualMatchService =
      batches === null
        ? null
        : new ManualMatchService({
            sessions: scanner,
            batches,
            store: manualMatchStore,
            pickFile: async () => {
              const options: Electron.OpenDialogOptions = {
                title: 'Choose the video file to match these scripts',
                properties: ['openFile'],
                filters: [
                  {
                    name: 'Video files',
                    extensions: [
                      'mp4',
                      'mkv',
                      'webm',
                      'mov',
                      'm4v',
                      'avi',
                      'wmv',
                      'flv',
                      'ogv',
                      'mpeg',
                      'mpg',
                      '3gp',
                      'ts'
                    ]
                  }
                ]
              }
              const owner =
                mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
              const result =
                owner === null
                  ? await dialog.showOpenDialog(options)
                  : await dialog.showOpenDialog(owner, options)
              if (result.canceled || result.filePaths.length === 0) return null
              return result.filePaths[0] ?? null
            }
          })
    const browserMatchService =
      batches === null
        ? null
        : new BrowserMatchService({ sessions: scanner, batches })

    // Native messaging registration is zero-config for the packaged and dev
    // apps. Ordinary and interactive smoke sessions skip it so they never write
    // the real per-user manifest or registry.
    const skipBrowserRegistration =
      smoke !== null ||
      process.env.DONDOWNLOAD_INTERACTIVE_SMOKE === '1' ||
      process.env.DONDOWNLOAD_SMOKE_TEST === '1'
    if (!skipBrowserRegistration) {
      nativeHostRegistrar = createNativeHostRegistrar(createRegistrationDependencies())
      void nativeHostRegistrar.repair()
    }

    // Facts for the diagnostics copy; see diagnosticsInput below.
    /** Re-read the browser registration state; null when registration is off. */
    const currentExtensionStatus = async (): Promise<BrowserExtensionStatus | null> => {
      if (nativeHostRegistrar === null) return null
      try {
        return await nativeHostRegistrar.getStatus()
      } catch {
        return null
      }
    }

    const diagnosticsBlock = async (): Promise<string> =>
      buildDiagnostics({
        ...diagnosticsInput(),
        extension: await currentExtensionStatus()
      })

    /**
     * Facts for the diagnostics copy. Every value is renderer-safe already;
     * the log tail is redacted once more as a backstop, and no history,
     * settings path or tool path is read. Evaluated on demand so the copy
     * always describes the current state.
     */
    const diagnosticsInput = (): Parameters<typeof buildDiagnostics>[0] => {
      const aria2State = aria2?.getState()
      const mediaTool = mediaJobs?.getMediaSnapshot().tool
      const currentSettings = settings.getSettings()
      const currentDesktop = desktopSettingsManager?.getSettings()
      return {
        appVersion: app.getVersion(),
        windowsVersion: os.version(),
        windowsBuild: os.release(),
        arch: process.arch,
        packaged: app.isPackaged,
        runtime: {
          electron: process.versions.electron ?? 'unknown',
          chrome: process.versions.chrome ?? 'unknown',
          node: process.versions.node
        },
        tools: {
          aria2: {
            version: aria2State?.version ?? null,
            status: aria2State?.status ?? 'stopped'
          },
          media: {
            version: mediaTool?.version ?? null,
            status: mediaTool?.status ?? 'unknown'
          }
        },
        ytdlpUpdate: mediaUpdater?.getState() ?? null,
        appUpdate: appUpdate?.getState() ?? null,
        downloadSettings: {
          maxConcurrentDownloads: currentSettings.maxConcurrentDownloads,
          perHostConnections: currentSettings.perHostConnections,
          theme: currentSettings.theme
        },
        desktopSettings: {
          exitToTrayStubWhenIdle: currentDesktop?.exitToTrayStubWhenIdle ?? false,
          watchClipboard: currentDesktop?.watchClipboard ?? false
        },
        dbSchemaVersion: database?.schemaVersion ?? null,
        debugLogging: getLogger()?.enabled('debug') ?? false,
        logLines: recentLogLines(DIAGNOSTICS_LOG_LINES),
        redactOptions: {
          userPaths: defaultUserPaths(),
          secretValues: defaultSecretValues()
        }
      }
    }

    // GitHub Releases application updater. The source and signing key come from
    // src/shared/release.ts; a build with either missing makes no network
    // request and reports the source as not configured.
    appUpdate = createAppUpdateChecker({
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      store: database,
      // Ordinary smoke verification must never perform background network
      // work. A manual check remains available in the normal desktop app.
      autoCheckAllowed: smoke === null,
      isJobActive: () =>
        (mediaJobs?.hasActiveJobs() ?? false) || hasActiveDownloadJobs(),
      spawn: (filePath, args) =>
        spawn(filePath, args, {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: false
        }),
      quit: () => app.quit(),
      onStateChanged: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.appUpdateStateChanged, state)
        }
      }
    })

    // First-start guide data is built on demand, never at startup: detecting
    // browsers is a handful of synchronous file probes, and the native-host
    // status is the same cached value Settings → Browser extension reads.
    let welcomeBrowsers: ReturnType<typeof detectInstalledBrowsers> | null =
      null
    const welcome = {
      getInfo: async () => {
        if (welcomeBrowsers === null) {
          welcomeBrowsers = detectInstalledBrowsers({
            platform: process.platform,
            env: process.env
          })
        }
        let extension: Awaited<
          ReturnType<NativeHostRegistrar['getStatus']>
        > | null = null
        if (nativeHostRegistrar !== null) {
          try {
            extension = await nativeHostRegistrar.getStatus()
          } catch {
            extension = nativeHostRegistrar.peekStatus()
          }
        }
        return buildWelcomeInfo({
          downloadDir,
          browsers: welcomeBrowsers,
          extension
        })
      }
    }

    registerIpc({
      manager,
      aria2,
      mediaJobs,
      batches,
      checksums,
      settings,
      desktopSettings: desktopSettingsManager,
      welcome,
      clipboardWriter: {
        writeText: (text: string) => {
          clipboard.writeText(text)
          clipboardWatcher?.rememberSelfCopied(text)
        }
      },
      mediaUpdater,
      browserExtension: nativeHostRegistrar ?? undefined,
      appUpdate,
      ...(scanner === null ? {} : { scanner }),
      ...(scanQueue === null ? {} : { scanQueue }),
      ...(manualMatchService === null ? {} : { manualMatch: manualMatchService }),
      requestSnapshotResync,
      // The log folder is main's own path (app data under the user profile);
      // the renderer never supplies one.
      openLogFolder: async () => {
        const directory = logDirectory() ?? path.join(app.getPath('logs'))
        await fsPromises.mkdir(directory, { recursive: true })
        return directory
      },
      buildDiagnostics: diagnosticsBlock,
      getWindow: () => mainWindow
    })
    traceStartup('IPC registered; managers ready')

    const interactiveSmoke =
      smoke !== null && process.env.DONDOWNLOAD_INTERACTIVE_SMOKE === '1'
    const interactiveBridge =
      interactiveSmoke && process.env.DONDOWNLOAD_INTERACTIVE_BRIDGE === '1'

    // The login item passes --hidden so signing in does not focus the app; the
    // tray remains available and a second launch focuses the same window.
    const startHidden =
      process.argv.includes(START_HIDDEN_ARG) && smoke === null

    // Idle tray stub. A lazy start that finds nothing to do (`--hidden` from a
    // browser hand-off, or the login item after a reboot) starts with no window,
    // so the grace period begins here and a genuinely unused engine hands the
    // tray back to the stub instead of lingering in the background.
    idleStub = createIdleStubController({
      isWindowOpen: () => mainWindow !== null,
      isWindowVisible: () => snapshotWindowVisible(),
      isBusy: isIdleStubBusy,
      isEnabled: isIdleStubEnabled,
      graceMs: resolveIdleStubGraceMs(process.env[IDLE_STUB_GRACE_ENV]),
      exitToStub: () => {
        exitToStub()
      },
      log: (message) => traceStartup(message)
    })

    // Create (and start loading) the window before the tray, aria2, the browser
    // bridge, tool probes and update checks. The renderer already renders a
    // "starting" engine state from the first snapshot, so the first paint no
    // longer waits for the download engine or browser integration to be ready.
    // A hidden start creates no window at all: the tray is the only surface, and
    // the renderer and its GPU work are not started until the user shows it.
    const window = startHidden
      ? null
      : openMainWindow(smoke === null, interactiveSmoke)
    if (window !== null) {
      mainWindow = window
      applyInterfaceZoom(
        desktopSettingsManager.getSettings().interfaceSizePercent
      )
    }

    // Create the tray immediately after the window; this still happens long
    // before the first frame, so closing the window always has a safe target.
    // If tray creation fails, the policy falls back to close-and-quit.
    // Smoke verification never creates a tray, so no desktop UI surface exists.
    if (smoke === null) {
      appTray = createAppTray({
        showWindow: showMainWindow,
        hideWindow: hideMainWindow,
        quit: () => {
          quitRequested = true
          app.quit()
        },
        isWindowVisible: isMainWindowVisible,
        openSettings: openSettingsFromTray,
        pauseAll: () => {
          void pauseAllDownloads()
        },
        resumeAll: () => {
          void resumeAllDownloads()
        },
        getSpeedLimitBps: () =>
          settingsManager?.getSettings().globalSpeedLimitBps ?? 0,
        setSpeedLimitBps: (bps) => {
          void settingsManager?.setGlobalSpeedLimit(bps).catch((error) => {
            const detail =
              error instanceof Error ? error.message : 'unknown error'
            logError('Speed limit could not be changed: %s', detail)
            if (!app.isPackaged) {
              console.error(`Speed limit could not be changed: ${detail}`)
            }
          })
        },
        // Read through the live managers; the tray never caches a snapshot.
        getDownloads: () => manager?.getSnapshot().downloads ?? [],
        getMediaJobs: () => mediaJobs?.getMediaSnapshot().jobs ?? [],
        openDownload: openTrayDownload,
        showDownloadInFolder: showTrayDownloadInFolder,
        addFromClipboard: addFromClipboardFromTray,
        // One clipboard read per menu open; never a timer of its own. The tray
        // host already tolerates a rejected/locked clipboard read.
        readClipboardText: () => clipboard.readText()
      })
      if (startHidden && appTray === null) {
        // Hidden-start was requested but the tray is unavailable; showing the
        // window is the only way to keep the app reachable.
        showMainWindow()
      }
    }

    // Begin counting idle time only once the tray exists: without a tray the
    // app has no surface the stub could hand back to.
    if (appTray !== null) refreshIdleStub()

    // Diagnostics exist only in smoke mode. They observe the real hidden
    // window before startup work continues, so early renderer failures are
    // retained. Normal desktop startup attaches nothing.
    const smokeDiagnostics =
      smoke === null ? null : new SmokeDiagnosticsCollector()
    const disposeSmokeDiagnostics =
      smokeDiagnostics === null || window === null
        ? null
        : attachSmokeDiagnostics(window.webContents, smokeDiagnostics)

    aria2.onStateChange = () => {
      manager?.publish(true)
    }

    // Start eagerly so the top bar can explain a missing/broken aria2, then
    // reconcile persisted records once we know whether aria2 is available.
    // This runs in parallel with the renderer's first load and paint.
    const startServices = async (): Promise<void> => {
      const aria2StartedAt = startupNow()
      try {
        await aria2?.start()
      } catch {
        manager?.publish(true)
      }
      traceStartup('aria2 spawn + ready', startupNow() - aria2StartedAt)
      const reconcileStartedAt = startupNow()
      try {
        await manager?.reconcileDownloads()
      } catch {
        // Recovery is best-effort; persisted rows are never deleted here.
      }
      traceStartup(
        'download recovery reconcile',
        startupNow() - reconcileStartedAt
      )
    }

    // The browser bridge keeps working while the app lives only in the tray and
    // only forwards validated URLs to the same DownloadManager/aria2 instance.
    // Ordinary smoke verification must not open a loopback port or write a
    // state file. An explicitly opted-in interactive smoke session may start
    // the bridge with the same isolated paths so a real browser can exercise
    // native messaging end to end.
    const startBrowserBridge = async (): Promise<void> => {
      const bridgeStartedAt = startupNow()
      // Capture the managers once so the closures below keep their non-null
      // types even though the module-level bindings are nullable.
      const bridgeManager = manager
      const bridgeMediaJobs = mediaJobs
      if (bridgeManager === null || bridgeMediaJobs === null) return
      const fixtureHost = process.env.DONDOWNLOAD_SMOKE_FIXTURE_HOST?.trim()
      const fixtureAddress =
        process.env.DONDOWNLOAD_SMOKE_FIXTURE_ADDRESS?.trim()
      const fixturePublicAddress =
        process.env.DONDOWNLOAD_SMOKE_FIXTURE_PUBLIC_ADDRESS?.trim()
      const fixtureTargets =
        interactiveBridge &&
        fixtureHost !== undefined &&
        fixtureHost.length > 0 &&
        fixtureAddress !== undefined &&
        fixtureAddress.length > 0 &&
        fixturePublicAddress !== undefined &&
        fixturePublicAddress.length > 0
          ? [
              {
                hostname: fixtureHost,
                address: fixtureAddress,
                publicAddress: fixturePublicAddress,
                family: 4
              }
            ]
          : []
      const fixtureLookup =
        fixtureTargets.length > 0
          ? createSmokeFixtureLookup(fixtureTargets)
          : undefined
      const fixturePreflight =
        fixtureTargets.length > 0
          ? createSmokeFixturePreflight(fixtureTargets)
          : undefined
      if (interactiveBridge) {
        console.error(
          `[dondownload-smoke] interactive bridge enabled; fixtureTargetLookup=${fixtureLookup !== undefined}`
        )
      }
      try {
        const bridge = await startNativeBridge({
          manager: bridgeManager,
          mediaBridge: bridgeMediaJobs,
          userDataPath: app.getPath('userData'),
          logger: (message) => {
            logDebug(message)
            if (!app.isPackaged) console.error(message)
          },
          ...(scanner === null ? {} : { scanner }),
          ...(browserMatchService === null
            ? {}
            : { browserMatch: (input) => browserMatchService.handleSniffed(input) }),
          // The in-page card polls the progress of the one download the
          // extension took over. Only the mapped status, two byte counts and a
          // display-only file name leave the desktop. One record lookup keeps
          // the 2 s poll independent of the download history size.
          downloadStatus: (downloadId) => {
            markRecentHandOff()
            return createHandoffDownloadStatus(bridgeManager)(downloadId)
          },
          onShowDownload: (downloadId) => {
            showMainWindow()
            sendToMainWindow((window) =>
              window.webContents.send(IPC.revealRow, `download:${downloadId}`)
            )
          },
          onScanRequested: (session) => {
            // Signed-in pages are scanned from the browser tab. Bringing the
            // window forward makes the progressive result visible immediately.
            showMainWindow()
            const requestWindow = mainWindow
            if (!requestWindow || requestWindow.isDestroyed()) return
            const send = (): void => {
              if (!mainWindow || mainWindow.isDestroyed()) return
              const current = scanner?.getSession(session.sessionId) ?? session
              mainWindow.webContents.send(IPC.scanUpdated, current)
            }
            if (requestWindow.webContents.isLoading()) {
              requestWindow.webContents.once('did-finish-load', () => {
                send()
                // A freshly created renderer may not have subscribed to
                // scan:updated at did-finish-load yet. The repeat is harmless
                // (the renderer opens one dialog per session ID) and makes the
                // extension-launched result reliable.
                setTimeout(send, 750).unref?.()
              })
            } else {
              send()
            }
          },
          ...(fixtureLookup === undefined
            ? {}
            : { publicTargetLookup: fixtureLookup }),
          ...(fixturePreflight === undefined
            ? {}
            : { publicResourcePreflight: fixturePreflight })
        })
        // A quit may have completed while the bridge was starting; never leave
        // a listening server or endpoint file behind.
        if (quitRequested || cleanupStarted) {
          await bridge.close()
          return
        }
        nativeBridge = bridge
        traceStartup('native bridge ready', startupNow() - bridgeStartedAt)
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error'
        logError('Browser bridge is unavailable: %s', detail)
        if (!app.isPackaged) {
          console.error(`Browser bridge is unavailable: ${detail}`)
        }
      }
    }

    if (smoke !== null) {
      if (interactiveBridge) await startBrowserBridge()
      await startServices()
      // An opt-in, isolated interactive smoke session keeps the actual
      // production renderer/preload/IPC alive for CDP-driven verification.
      // It still uses the smoke-only userData/download paths and never creates
      // the tray or browser bridge. The window remains hidden/offscreen to
      // avoid desktop interference; CDP drives its actual production renderer.
      if (process.env.DONDOWNLOAD_INTERACTIVE_SMOKE === '1') {
        console.error(
          `[dondownload-smoke] INTERACTIVE_READY userData=${app.getPath('userData')} downloadDir=${downloadDir}`
        )
        return
      }
      try {
        if (smokeDiagnostics === null || window === null) {
          throw new Error('Smoke renderer diagnostics were not initialized.')
        }
        const result = await runSmokeTest({
          window,
          database,
          manager,
          aria2,
          mediaJobs,
          diagnostics: smokeDiagnostics,
          userDataDir: app.getPath('userData'),
          downloadDir,
          resultPath: smoke.resultPath as string,
          environment: {
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron ?? 'unknown',
            chromeVersion: process.versions.chrome ?? 'unknown',
            nodeVersion: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            packaged: app.isPackaged,
            resourcesPath: process.resourcesPath ?? '<unset>'
          }
        })

        disposeSmokeDiagnostics?.()
        process.exitCode = result.status === 'PASS' ? 0 : 1

        // The normal cleanup path is bounded by its own child timeouts. This
        // last-resort timer only exits this Electron process; the harness also
        // kills this process tree if the app cannot finish shutting down.
        const shutdownWatchdog = setTimeout(() => app.exit(3), 30_000)
        shutdownWatchdog.unref()
        quitRequested = true
        app.quit()
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error'
        const diagnostics = smokeDiagnostics?.snapshot()
        disposeSmokeDiagnostics?.()
        const result = createSmokeResult({
          environment: {
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron ?? 'unknown',
            chromeVersion: process.versions.chrome ?? 'unknown',
            nodeVersion: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            packaged: app.isPackaged,
            userDataPath: app.getPath('userData'),
            resourcesPath: process.resourcesPath ?? '<unset>'
          },
          checks: [
            {
              name: 'smoke.runner',
              status: 'FAIL',
              detail: safeDetail(detail),
              durationMs: 0
            }
          ],
          diagnostics,
          logs: ['The smoke runner failed before it could complete its checks.']
        })
        try {
          writeSmokeResultSync(smoke.resultPath as string, result)
        } catch {
          // stderr remains available when the isolated result file cannot be written.
        }
        console.error(`[dondownload-smoke] FAIL smoke.runner: ${detail}`)
        console.error(JSON.stringify(result))
        app.exit(2)
      }
      return
    }

    // aria2 starts in parallel with the renderer load; never await it here.
    void startServices()

    // Browser integration is not needed for the first frame. Starting it
    // without awaiting keeps the loopback listener and endpoint-file write off
    // the critical path; it still overlaps the renderer load, so extension
    // hand-offs arriving a few milliseconds later succeed.
    void startBrowserBridge()

    // Opt-in RAM benchmark: measures the real memory phases, then quits.
    if (memoryBenchPath !== null) {
      startMemoryBench({
        outPath: memoryBenchPath,
        hideToTray: hideMainWindow,
        showWindow: showMainWindow,
        quit: () => {
          quitRequested = true
          app.quit()
        }
      })
    }

    // Everything below is useful but not needed for the first frame. Run it
    // after the window has painted (with a bounded fallback if it never shows)
    // so yt-dlp/ffmpeg probes, native-host registry checks and update checks
    // never compete with the first paint. Results and side effects are exactly
    // the same as when they ran during startup.
    scheduleAfterFirstPaint(window, () => {
      // A quit that began while the window was loading owns the shutdown; do
      // not start background probes or registry work behind it.
      if (quitRequested || cleanupStarted) {
        logDebug('startup probes skipped: a quit already owns the process')
        return
      }
      traceStartup('deferred startup work started')
      if (nativeHostRegistrar !== null) {
        const registrationStartedAt = startupNow()
        void nativeHostRegistrar.repair().finally(() => {
          traceStartup(
            'native host registration checked',
            startupNow() - registrationStartedAt
          )
        })
      }
      // At most one background check per 24 hours. Both are disabled in smoke
      // mode by their updater options, and neither can delay the window now.
      // The probe and both checks only run outside smoke: a smoke run quits as
      // soon as its checks pass, so their log lines would race the quit.
      if (smoke === null) {
        const probeStartedAt = startupNow()
        void mediaJobs?.refreshToolState().then((state) => {
          logInfo('Media tools: %s (%s)', state.version ?? 'unavailable', state.status)
        }).finally(() => {
          traceStartup('media tool probe', startupNow() - probeStartedAt)
        })
        void mediaUpdater?.autoCheck().then((state) => {
          logInfo('yt-dlp update check: %s', state.status)
        })
        void appUpdate?.autoCheck().then((state) => {
          logInfo(
            'App update check: %s (%s)',
            state.status,
            state.configured ? `current ${state.currentVersion}` : 'no update source'
          )
        })
      }
    })

    app.on('activate', () => {
      // macOS Dock activation and Windows taskbar relaunches restore the same
      // hidden window instead of creating a duplicate.
      showMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (
      shouldQuitWhenAllWindowsClosed({
        platform: process.platform,
        isQuitting: quitRequested || cleanupStarted,
        trayAvailable: appTray !== null,
        // Closing the window during cleanup fires this event; the pending
        // internal quit owns the shutdown, so do not start a parallel one.
        cleanupRunning: isCleanupRunning({
          started: cleanupStarted,
          finished: cleanupFinished
        })
      })
    ) {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    quitRequested = true
    // A shutdown of any kind owns the process: never race it with the hand-off
    // timer, which would spawn a stub that then has nothing running to hand to.
    idleStub?.dispose()
    idleStub = null

    const action = decideBeforeQuit({
      cleanup: { started: cleanupStarted, finished: cleanupFinished },
      servicesReady: aria2 !== null
    })
    if (action === 'allow') {
      // Startup never reached the services, or cleanup already finished and
      // this is the final internal quit.
      return
    }
    // Cancel every request that arrives while cleanup is still running so it
    // cannot jump ahead of the flush/stop/close sequence.
    event.preventDefault()
    if (action === 'block') return

    cleanupStarted = true
    void (async () => {
      // Stop the history timer before the database closes.
      historyCleanup?.stop()
      historyCleanup = null
      // Stop accepting browser requests before stopping aria2, so a late
      // native message cannot restart the engine during shutdown.
      try {
        await nativeBridge?.close()
      } catch {
        // Never block quitting on bridge cleanup.
      }
      nativeBridge = null

      // Persist batch recovery state first: active parents/items become
      // interrupted and are never auto-resumed. Child cancellation remains the
      // media/download managers' responsibility below.
      try {
        batches?.close()
      } catch {
        // Batch recovery state is best effort; quitting must still proceed.
      }
      batches = null

      try {
        scanner?.close()
      } catch {
        // Scanner sessions are memory-only; quitting must still proceed.
      }
      scanner = null
      scanQueue = null

      // Persist the last known lifecycle/progress state, stop aria2 cleanly,
      // then close the database. Crash recovery can still rely on the bounded
      // progress snapshots written while the app was running.
      try {
        await mediaJobs?.close()
      } catch {
        // Media children are cancelled best-effort; the process must still quit.
      }
      mediaJobs = null
      try {
        mediaUpdater?.close()
      } catch {
        // Never block quitting on updater cleanup.
      }
      mediaUpdater = null
      try {
        manager?.flushPersistence()
      } catch {
        // Never block quitting on a history flush.
      }
      try {
        await aria2?.stop()
      } catch {
        // The process may already be gone.
      }
      try {
        manager?.close()
      } catch {
        // Never block quitting on a database close.
      }
      try {
        clipboardWatcher?.stop()
      } catch {
        // Never block quitting on clipboard polling.
      }
      clipboardWatcher = null
      try {
        appTray?.destroy()
      } catch {
        // The tray may already be gone.
      }
      appTray = null
      // Clear any taskbar progress before the window goes away.
      try {
        taskbarProgress?.dispose()
      } catch {
        // The window may already be destroyed.
      }
      taskbarProgress = null
      // Record the orderly shutdown, then write every buffered line and stop
      // the flush timer before the process exits.
      logInfo('Shutting down')
      try {
        await closeLogger()
      } catch {
        // The log file must never block quitting.
      }
      // Mark the sequence complete immediately before the final internal
      // quit, so that this one request is allowed through.
      cleanupFinished = true
      app.quit()
    })()
  })
  }
}
