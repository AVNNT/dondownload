import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { NATIVE_BRIDGE_STATE_FILE } from '@shared/nativeBridge'
import type { Aria2Service } from '../aria2/service'
import { SCHEMA_VERSION, type DownloadDatabase } from '../db/database'
import type { DownloadManager } from '../downloads/manager'
import { locateMediaTool, type MediaToolName } from '../media/locator'
import { defaultMediaSpawn, runCapturedProcess } from '../media/process'
import type { MediaJobsManager } from '../mediaJobs/manager'
import {
  createSmokeResult,
  safeDetail,
  writeSmokeResult,
  type SmokeCheckResult,
  type SmokeEnvironmentInfo,
  type SmokeTestResult
} from './report'

const RENDERER_TIMEOUT_MS = 20_000
const TOOL_PROBE_TIMEOUT_MS = 8_000
const CHECK_POLL_INTERVAL_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function firstVersionLine(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line === undefined ? 'unknown' : safeDetail(line, 120)
}

async function waitForRenderer(window: BrowserWindow): Promise<string> {
  const deadline = Date.now() + RENDERER_TIMEOUT_MS
  let lastState = 'renderer did not respond'

  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error('The hidden main window was destroyed.')
    try {
      const state = (await window.webContents.executeJavaScript(
        `(() => {
          const root = document.getElementById('root')
          return {
            ready: document.readyState,
            rendered: Boolean(root && root.childElementCount > 0),
            title: document.title
          }
        })()`,
        true
      )) as { ready?: unknown; rendered?: unknown; title?: unknown }

      lastState = `readyState=${String(state.ready)} rendered=${String(
        state.rendered
      )} title=${safeDetail(state.title, 80)}`
      if (state.ready === 'complete' && state.rendered === true) {
        return lastState
      }
    } catch (error) {
      lastState = safeDetail(error)
    }
    await delay(CHECK_POLL_INTERVAL_MS)
  }

  throw new Error(`Renderer did not finish loading: ${lastState}`)
}

async function probeMediaTool(
  tool: MediaToolName
): Promise<{ detail: string; path: string; version: string }> {
  const location = await locateMediaTool(tool, {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd()
  })
  if (location.path === null) {
    throw new Error(
      location.missingExplicit
        ? 'The configured explicit path does not exist.'
        : 'The executable was not found in bundled, app-local or PATH locations.'
    )
  }

  const argumentsForTool =
    tool === 'ytdlp'
      ? ['--ignore-config', '--version']
      : tool === 'ffmpeg'
        ? ['-version']
        : ['--version']

  const result = await runCapturedProcess(location.path, argumentsForTool, {
    spawn: defaultMediaSpawn,
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: TOOL_PROBE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  })

  if (result.code !== 0) {
    throw new Error(
      `${tool} exited with code ${result.code === null ? 'null' : result.code}.`
    )
  }

  const version = firstVersionLine(result.stdout)
  return {
    path: location.path,
    version,
    detail: `${version}; path=${location.path}; source=${
      location.explicit ? 'explicit-override' : 'bundled-or-path'
    }`
  }
}

export interface RunSmokeTestOptions {
  window: BrowserWindow
  database: DownloadDatabase | null
  manager: DownloadManager
  aria2: Aria2Service
  mediaJobs: MediaJobsManager
  userDataDir: string
  downloadDir: string
  resultPath: string
  environment: Omit<SmokeEnvironmentInfo, 'userDataPath'>
}

/**
 * Exercise the real packaged/unpacked main-process startup without showing a
 * window, creating a tray, starting the browser bridge or touching the normal
 * user profile. Every check is reported individually so the caller can see
 * exactly which production component initialized.
 */
export async function runSmokeTest(
  options: RunSmokeTestOptions
): Promise<SmokeTestResult> {
  const startedAt = new Date().toISOString()
  const checks: SmokeCheckResult[] = []
  const logs: string[] = []

  const log = (message: string): void => {
    const safe = safeDetail(message)
    logs.push(safe)
    console.error(`[dondownload-smoke] ${safe}`)
  }

  const check = async (
    name: string,
    run: () => string | Promise<string>
  ): Promise<void> => {
    const start = Date.now()
    try {
      const detail = await run()
      checks.push({
        name,
        status: 'PASS',
        detail: safeDetail(detail),
        durationMs: Date.now() - start
      })
      log(`PASS ${name}: ${detail}`)
    } catch (error) {
      checks.push({
        name,
        status: 'FAIL',
        detail: safeDetail(error),
        durationMs: Date.now() - start
      })
      log(`FAIL ${name}: ${safeDetail(error)}`)
    }
  }

  const userDataPath = options.userDataDir
  const stateFile = path.join(userDataPath, NATIVE_BRIDGE_STATE_FILE)

  await check('config.isolated-user-data', () => {
    if (!path.isAbsolute(userDataPath)) {
      throw new Error('userData path is not absolute.')
    }
    if (!isInside(userDataPath, options.resultPath)) {
      throw new Error('The result file is outside the isolated userData directory.')
    }
    if (!isInside(userDataPath, options.downloadDir)) {
      throw new Error('The download directory is outside isolated userData.')
    }
    return `userData=${userDataPath}; downloadDir=${options.downloadDir}`
  })

  await check('desktop-ui.suppressed', async () => {
    if (options.window.isDestroyed()) throw new Error('The hidden window is destroyed.')
    if (options.window.isVisible()) throw new Error('The main window is visible.')
    if (options.window.isFocused()) throw new Error('The main window is focused.')
    try {
      await fs.access(stateFile)
      throw new Error('The native bridge endpoint file exists.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return 'window hidden and unfocused; no tray or native bridge was created'
  })

  await check('renderer.loaded', async () => {
    const renderer = await waitForRenderer(options.window)
    const url = options.window.webContents.getURL()
    if (!url.startsWith('file:')) {
      throw new Error(`Unexpected renderer URL scheme: ${url.slice(0, 40)}`)
    }
    return `${renderer}; urlScheme=file`
  })

  await check('sqlite.ready', () => {
    if (options.database === null) {
      throw new Error('The SQLite database did not open.')
    }
    if (!isInside(userDataPath, options.database.path)) {
      throw new Error('The SQLite database is outside isolated userData.')
    }
    if (options.database.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `Expected schema ${SCHEMA_VERSION}, got ${options.database.schemaVersion}.`
      )
    }
    const downloads = options.database.loadAll()
    const settings = options.database.loadSettings()
    return `schema=${options.database.schemaVersion}; downloads=${downloads.length}; maxConcurrent=${settings.maxConcurrentDownloads}; path=${options.database.path}`
  })

  await check('aria2.ready', async () => {
    const state = options.aria2.getState()
    if (state.status !== 'ready') {
      throw new Error(
        `aria2 status is ${state.status}${
          state.message === null ? '' : `: ${state.message}`
        }`
      )
    }
    if (state.binaryPath === null) throw new Error('aria2 binary path is missing.')
    await fs.access(state.binaryPath)
    return `version=${state.version ?? 'unknown'}; path=${state.binaryPath}`
  })

  await check('download-manager.ready', () => {
    const snapshot = options.manager.getSnapshot()
    if (!Array.isArray(snapshot.downloads)) {
      throw new Error('The download snapshot is malformed.')
    }
    if (snapshot.aria2.status !== 'ready') {
      throw new Error(`aria2 attached to the manager is ${snapshot.aria2.status}.`)
    }
    return `downloads=${snapshot.downloads.length}; aria2=${snapshot.aria2.status}`
  })

  await check('media-manager.tool-state', async () => {
    const state = await options.mediaJobs.refreshToolState()
    if (state.status !== 'ready') {
      throw new Error(
        `Media tool state is ${state.status}${
          state.message === null ? '' : `: ${state.message}`
        }`
      )
    }
    return `version=${state.version ?? 'unknown'}`
  })

  for (const tool of ['ytdlp', 'ffmpeg', 'deno'] as const) {
    await check(`media-tool.${tool}`, async () => {
      const probed = await probeMediaTool(tool)
      return probed.detail
    })
  }

  const result = createSmokeResult({
    startedAt,
    environment: {
      ...options.environment,
      userDataPath
    },
    checks,
    logs
  })

  await writeSmokeResult(options.resultPath, result)
  console.log(JSON.stringify(result))
  log(`RESULT ${result.status}; ${options.resultPath}`)
  return result
}
