import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc'
import { isAllowedAt } from '@shared/schedule'
import { DEFAULT_THEME, type AppTheme } from '@shared/settings'
import type { AppSnapshot } from '@shared/types'
import { Aria2Service, defaultDownloadDir } from './aria2/service'
import { BatchManager } from './batches/manager'
import { openDownloadDatabase, resolveDownloadDatabasePath } from './db/database'
import { DownloadManager } from './downloads/manager'
import { createPixeldrainAdapter } from './hosts/pixeldrain'
import { createMediaEngine } from './media/engine'
import { createYtdlpUpdater, type YtdlpUpdater } from './media/updater'
import { MediaJobsManager } from './mediaJobs/manager'
import { registerIpc } from './ipc'
import { SettingsManager } from './settings/manager'
import {
  decideBeforeQuit,
  decideWindowClose,
  isCleanupRunning,
  shouldQuitWhenAllWindowsClosed
} from './lifecycle'
import { startNativeBridge, type NativeBridge } from './nativeBridge/server'
import { createAppTray, type AppTray } from './tray'
import { createMainWindow } from './window'
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
let mediaUpdater: YtdlpUpdater | null = null
let nativeBridge: NativeBridge | null = null
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

function isMainWindowVisible(): boolean {
  return Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
  )
}

function refreshTray(): void {
  appTray?.refresh()
}

function openMainWindow(
  show = true,
  offscreen = false,
  theme: AppTheme = settingsManager?.getSettings().theme ?? DEFAULT_THEME
): BrowserWindow {
  const window = createMainWindow({ show, offscreen, theme })

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
  window.on('show', refreshTray)
  window.on('hide', refreshTray)
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

if (!smokeConfig.enabled || smokeConfig.ok) {
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
      // aria2 transfers are never paused by a settings change.
      onChanged: () => {
        void manager?.refreshPolicy()
      }
    })
    settingsManager = settings
    aria2.onBeforeReady = (client) => settings.applyStartup(client)

    manager = new DownloadManager(
      aria2,
      downloadDir,
      (snapshot: AppSnapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.snapshotChanged, snapshot)
        }
      },
      database,
      { settings: () => settings.getSettings() }
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
      ...(mediaFixtureLookup === undefined
        ? {}
        : { lookup: mediaFixtureLookup })
    })
    mediaJobs = new MediaJobsManager({
      engine: mediaEngine,
      mediaDir,
      database,
      startAllowed: (now) => isAllowedAt(settings.getSettings(), now),
      onExtractorFailure: () => mediaUpdater?.notifyExtractorFailure() ?? Promise.resolve(false),
      onUpdate: (snapshot) => {
        // A deferred verified update becomes visible only after every active
        // media job has settled; no executable is swapped mid-run.
        mediaUpdater?.onJobsChanged()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.mediaSnapshotChanged, snapshot)
        }
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
      database,
      onUpdate: (snapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.batchSnapshotChanged, snapshot)
        }
      }
    })

    registerIpc({
      manager,
      aria2,
      mediaJobs,
      batches,
      settings,
      mediaUpdater,
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
        isWindowVisible: isMainWindowVisible
      })
    }

    const window = openMainWindow(smoke === null, interactiveSmoke)
    mainWindow = window

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
      manager?.publish()
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

    // At most one background check per 24 hours. It never delays the window
    // and is disabled entirely in smoke mode by the updater option above.
    void mediaUpdater.autoCheck()

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
        appTray?.destroy()
      } catch {
        // The tray may already be gone.
      }
      appTray = null
      // Mark the sequence complete immediately before the final internal
      // quit, so that this one request is allowed through.
      cleanupFinished = true
      app.quit()
    })()
  })
  }
}
