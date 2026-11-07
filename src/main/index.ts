import { app, BrowserWindow, clipboard, dialog } from 'electron'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { IPC } from '@shared/ipc'
import { mapDownloadStatus } from '@shared/downloadStatus'
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
import type { MediaJob, MediaToolState } from '@shared/media'
import type { Batch } from '@shared/batches'
import {
  batchRowVersion,
  downloadRowVersion,
  mediaRowVersion
} from '@shared/snapshotDelta'
import { Aria2Service, defaultDownloadDir } from './aria2/service'
import { BatchManager } from './batches/manager'
import { openDownloadDatabase, resolveDownloadDatabasePath } from './db/database'
import { DownloadManager } from './downloads/manager'
import { createPixeldrainAdapter } from './hosts/pixeldrain'
import { createMegaAdapter } from './hosts/mega'
import { createMediaEngine } from './media/engine'
import { createYtdlpUpdater, type YtdlpUpdater } from './media/updater'
import {
  createAppUpdateChecker,
  type AppUpdateChecker
} from './appUpdate/checker'
import { MediaJobsManager } from './mediaJobs/manager'
import { registerIpc } from './ipc'
import { SettingsManager } from './settings/manager'
import { DesktopSettingsManager } from './settings/desktopManager'
import { ClipboardWatcher } from './clipboard/watcher'
import { CompletionNotificationService } from './notifications/service'
import { loginItemSettings, shouldManageLoginItem } from './desktop/loginItem'
import {
  decideBeforeQuit,
  decideWindowClose,
  isCleanupRunning,
  shouldQuitWhenAllWindowsClosed
} from './lifecycle'
import { startNativeBridge, type NativeBridge } from './nativeBridge/server'
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
  createTaskbarProgress,
  type TaskbarProgressController
} from './taskbar/progress'
import { createMainWindow } from './window'
import { SnapshotDeltaPublisher } from './snapshotDeltaPublisher'
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

let mainWindow: BrowserWindow | null = null
let appTray: AppTray | null = null
let aria2: Aria2Service | null = null
let manager: DownloadManager | null = null
let mediaJobs: MediaJobsManager | null = null
let batches: BatchManager | null = null
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
    logger: (message: string) => console.error(message)
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
      // Keep the renderer, aria2 and polling alive in the background.
      event.preventDefault()
      window.hide()
      refreshTray()
    }
  })
  window.on('show', () => {
    refreshTray()
    refreshSnapshotDelivery()
  })
  window.on('hide', () => {
    refreshTray()
    refreshSnapshotDelivery()
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
  })

  return window
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = openMainWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  refreshTray()
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  refreshTray()
}

if (unregisterRequested) {
  // Installer cleanup mode. This runs before any single-instance lock, window,
  // tray or bridge so it can never be swallowed by an already-running app.
  // The helper leaves dev registrations pointing at the repository alone.
  app.whenReady().then(async () => {
    const result = await unregisterNativeHost(createRegistrationDependencies())
    if (result.lastError !== null) {
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
    if (smoke === null) {
      app.on('second-instance', () => {
        // A second launch focuses the existing app, including after close-to-tray.
        showMainWindow()
      })
    }

    app.whenReady().then(async () => {
      if (smoke === null) app.setAppUserModelId('com.dondownload.app')
      const downloadDir =
        smoke !== null
          ? path.join(app.getPath('userData'), 'smoke-downloads')
          : defaultDownloadDir(app.getPath('downloads'))

    aria2 = new Aria2Service(() => downloadDir)

    // History uses the SQLite runtime bundled with Electron's Node (node:sqlite),
    // in a dedicated file under Electron's userData directory.
    let database: ReturnType<typeof openDownloadDatabase> | null = null
    try {
      database = openDownloadDatabase(
        resolveDownloadDatabasePath(app.getPath('userData'))
      )
    } catch (error) {
      // Keep the app usable if storage is unavailable; downloads still work but
      // history will not survive a relaunch. Do not log URLs or payloads.
      const detail = error instanceof Error ? error.message : 'unknown error'
      console.error(`Download history is unavailable: ${detail}`)
    }

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
      onUrl: (url) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.clipboardLink, url)
        }
      }
    })
    clipboardWatcher.setEnabled(
      desktopSettingsManager.getSettings().watchClipboard
    )
    applyLoginItem(desktopSettingsManager.getSettings())

    notifications = new CompletionNotificationService({
      // Off by default (opt-in), and never shown in smoke or E2E harness runs.
      isEnabled: () =>
        smoke === null &&
        process.env.DONDOWNLOAD_INTERACTIVE_SMOKE !== '1' &&
        process.env.DONDOWNLOAD_SMOKE_TEST !== '1' &&
        (desktopSettingsManager?.getSettings().showNotifications ?? false),
      onActivate: (kind, id) => {
        showMainWindow()
        mainWindow?.webContents.send(IPC.revealRow, `${kind}:${id}`)
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
      getWindow: () => (mainWindow === null ? null : mainWindow)
    })
    const updateTaskbarProgress = (): void => {
      if (taskbarProgress === null) return
      taskbarProgress.update({
        downloads: manager?.getSnapshot().downloads ?? [],
        mediaJobs: mediaJobs?.getMediaSnapshot().jobs ?? []
      })
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
      },
      database,
      {
        settings: () => settings.getSettings(),
        autoResume: () =>
          desktopSettingsManager?.getSettings().resumeInterruptedOnStartup ??
          false,
        resolvePairingFolder: (token) =>
          manualMatchStore.resolveFolder(token)
      }
    )

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
      }
    })

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
    // GitHub Releases application updater. `UPDATE_REPO` is null until a
    // public repository exists, so ordinary builds make no network request.
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

    registerIpc({
      manager,
      aria2,
      mediaJobs,
      batches,
      settings,
      desktopSettings: desktopSettingsManager,
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
      getWindow: () => mainWindow
    })

    // Probe external media tools without delaying the first window. The media
    // job manager publishes the verified state when the probe settles. Smoke
    // verification awaits the same production probe below.
    const interactiveSmoke =
      smoke !== null && process.env.DONDOWNLOAD_INTERACTIVE_SMOKE === '1'
    const initialMediaProbe =
      smoke === null || interactiveSmoke
        ? mediaJobs.refreshToolState()
        : null
    if (initialMediaProbe !== null) void initialMediaProbe

    // The browser bridge is intentionally started without touching the
    // window. It keeps working while the app lives only in the tray and only
    // forwards validated URLs to the same DownloadManager/aria2 instance.
    // Ordinary smoke verification must not open a loopback port or write a
    // state file. An explicitly opted-in interactive smoke session may start
    // the bridge with the same isolated paths so a real browser can exercise
    // native messaging end to end.
    const interactiveBridge =
      interactiveSmoke && process.env.DONDOWNLOAD_INTERACTIVE_BRIDGE === '1'
    if (smoke === null || interactiveBridge) {
      const fixtureHost = process.env.DONDOWNLOAD_SMOKE_FIXTURE_HOST?.trim()
      const fixtureAddress = process.env.DONDOWNLOAD_SMOKE_FIXTURE_ADDRESS?.trim()
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
        nativeBridge = await startNativeBridge({
          manager,
          mediaBridge: mediaJobs,
          userDataPath: app.getPath('userData'),
          logger: (message) => console.error(message),
          ...(scanner === null ? {} : { scanner }),
          ...(browserMatchService === null
            ? {}
            : { browserMatch: (input) => browserMatchService.handleSniffed(input) }),
          // The in-page card polls the progress of the one download the
          // extension took over. Only the mapped status, two byte counts and a
          // display-only file name leave the desktop.
          downloadStatus: (downloadId) => {
            const record = manager
              ?.getSnapshot()
              .downloads.find((download) => download.id === downloadId)
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
          },
          onShowDownload: (downloadId) => {
            showMainWindow()
            mainWindow?.webContents.send(IPC.revealRow, `download:${downloadId}`)
          },
          onScanRequested: (session) => {
            // Signed-in pages are scanned from the browser tab. Bringing the
            // window forward makes the progressive result visible immediately.
            showMainWindow()
            const window = mainWindow
            if (!window || window.isDestroyed()) return
            const send = (): void => {
              if (!mainWindow || mainWindow.isDestroyed()) return
              const current = scanner?.getSession(session.sessionId) ?? session
              mainWindow.webContents.send(IPC.scanUpdated, current)
            }
            if (window.webContents.isLoading()) {
              window.webContents.once('did-finish-load', () => {
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
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error'
        console.error(`Browser bridge is unavailable: ${detail}`)
      }
    }

    // Create the tray before the window so a close always has a safe target.
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
        getSpeedLimitBps: () =>
          settingsManager?.getSettings().globalSpeedLimitBps ?? 0,
        setSpeedLimitBps: (bps) => {
          void settingsManager?.setGlobalSpeedLimit(bps).catch((error) => {
            const detail =
              error instanceof Error ? error.message : 'unknown error'
            console.error(`Speed limit could not be changed: ${detail}`)
          })
        }
      })
    }

    // The login item passes --hidden so signing in does not focus the app; the
    // tray remains available and a second launch focuses the same window.
    const startHidden =
      process.argv.includes(START_HIDDEN_ARG) && appTray !== null
    const window = openMainWindow(smoke === null && !startHidden, interactiveSmoke)
    mainWindow = window
    applyInterfaceZoom(
      desktopSettingsManager.getSettings().interfaceSizePercent
    )

    // Diagnostics exist only in smoke mode. They observe the real hidden
    // window before startup work continues, so early renderer failures are
    // retained. Normal desktop startup attaches nothing.
    const smokeDiagnostics =
      smoke === null ? null : new SmokeDiagnosticsCollector()
    const disposeSmokeDiagnostics =
      smokeDiagnostics === null
        ? null
        : attachSmokeDiagnostics(window.webContents, smokeDiagnostics)

    aria2.onStateChange = () => {
      manager?.publish(true)
    }

    // Start eagerly so the top bar can explain a missing/broken aria2, then
    // reconcile persisted records once we know whether aria2 is available.
    const startServices = async (): Promise<void> => {
      try {
        await aria2?.start()
      } catch {
        manager?.publish(true)
      }
      try {
        await manager?.reconcileDownloads()
      } catch {
        // Recovery is best-effort; persisted rows are never deleted here.
      }
    }

    if (smoke !== null) {
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
        if (smokeDiagnostics === null) {
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

    void startServices()

    // At most one background check per 24 hours. Neither check delays the
    // window; both are disabled in smoke mode by their updater options.
    void mediaUpdater.autoCheck()
    void appUpdate.autoCheck()

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
      // Mark the sequence complete immediately before the final internal
      // quit, so that this one request is allowed through.
      cleanupFinished = true
      app.quit()
    })()
  })
  }
}
