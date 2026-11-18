/**
 * Process plumbing for the native idle tray stub.
 *
 * The stub (`dondownload-tray.exe`) is built by the parallel native lane and
 * shipped as `resources/native/dondownload-tray.exe`:
 *
 *   dondownload-tray.exe --app "<DonDownload.exe>" [--icon "<tray.ico>"]
 *   dondownload-tray.exe --exit
 *
 * The first form shows the tray icon; a click or "Open" starts the app with no
 * arguments and the stub exits. The second form tells a running stub to remove
 * its icon and exit. The stub is single-instance.
 *
 * Everything here is pure or takes its dependencies as arguments, so the
 * wiring policy is unit tested without Electron.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { idleStubEnvPolicy } from './env'

/** Environment variable that turns the hand-off off (`0`) or on in dev (`1`). */
export const IDLE_STUB_ENV = 'DONDOWNLOAD_IDLE_STUB'
/** Environment variable overriding the grace period, in milliseconds. */
export const IDLE_STUB_GRACE_ENV = 'DONDOWNLOAD_IDLE_STUB_GRACE_MS'

/**
 * Packaged location of the stub. `extraResources` copies it beside the
 * application's own resources, next to the native messaging host.
 */
export function idleStubExecutablePath(resourcesPath: string): string {
  return path.join(resourcesPath, 'native', 'dondownload-tray.exe')
}

/**
 * Packaged location of the tray icon. electron-vite copies the `?asset`
 * import beside the main bundle (`out/main/assets/tray.ico`), which becomes
 * `app.asar/out/main/assets/tray.ico` in a packaged build.
 */
export function idleStubIconPath(appPath: string): string {
  return path.join(appPath, 'out', 'main', 'assets', 'tray.ico')
}

export interface IdleStubHandOffInput {
  /** `app.isPackaged`. Development builds always keep the Electron tray. */
  isPackaged: boolean
  /** Ordinary, interactive or harness smoke sessions never spawn the stub. */
  isSmoke: boolean
  /** The opt-in memory benchmark measures the real app and must keep running. */
  isMemoryBench: boolean
  /** `process.execPath`: the DonDownload.exe the stub must start. */
  execPath: string
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** `app.getAppPath()`; used to locate the packaged tray icon. */
  appPath: string
  /** `DONDOWNLOAD_IDLE_STUB`. */
  env: string | undefined
  /** True only when the last known IPC message was a browser/native hand-off. */
  hasRecentHandOff: boolean
  exists?: (filePath: string) => boolean
}

export type IdleStubHandOffDecision =
  | { action: 'hand-off'; executable: string; icon: string | null }
  | { action: 'refuse'; reason: string }

/**
 * Decide whether this process may be replaced by the stub. Only a packaged
 * build outside smoke/benchmark runs, with the stub actually on disk and a
 * browser hand-off waiting in the tray, is eligible: the stub cannot serve the
 * bridge, so waking the app right back would only thrash.
 */
export function decideIdleStubHandOff(
  input: IdleStubHandOffInput
): IdleStubHandOffDecision {
  if (idleStubEnvPolicy(input.env).enabled === false) {
    return { action: 'refuse', reason: 'disabled by environment' }
  }
  if (!input.isPackaged) return { action: 'refuse', reason: 'not packaged' }
  if (input.isSmoke) return { action: 'refuse', reason: 'smoke session' }
  if (input.isMemoryBench) {
    return { action: 'refuse', reason: 'memory benchmark' }
  }
  if (input.hasRecentHandOff) {
    return { action: 'refuse', reason: 'pending browser hand-off' }
  }
  const exists = input.exists ?? existsSync
  const executable = idleStubExecutablePath(input.resourcesPath)
  if (!safeExists(executable, exists)) {
    return { action: 'refuse', reason: 'stub not installed' }
  }
  const icon = idleStubIconPath(input.appPath)
  return {
    action: 'hand-off',
    executable,
    icon: safeExists(icon, exists) ? icon : null
  }
}

function safeExists(filePath: string, exists: (path: string) => boolean): boolean {
  try {
    return exists(filePath)
  } catch {
    return false
  }
}

/** Arguments that show the tray icon and reopen the app on click. */
export function idleStubShowArgs(
  execPath: string,
  iconPath: string | null
): string[] {
  const args = ['--app', execPath]
  if (iconPath !== null) args.push('--icon', iconPath)
  return args
}

/** Argument that tells a running stub to remove its icon and exit. */
export const IDLE_STUB_EXIT_ARGS: readonly string[] = ['--exit']

export type IdleStubSpawn = (
  filePath: string,
  args: readonly string[]
) => void

type NodeSpawn = typeof import('node:child_process').spawn

/**
 * Spawn the stub detached from this process: it must outlive the app's quit and
 * never hold inheritance of our handles, and its output is discarded.
 */
export function spawnIdleStub(
  filePath: string,
  args: readonly string[],
  spawn: NodeSpawn
): void {
  try {
    const child = spawn(filePath, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    })
    child.on?.('error', () => {
      // The stub is optional: a refused spawn must never crash the app.
    })
    child.unref()
  } catch {
    // A missing or blocked executable leaves the current tray in place.
  }
}

/**
 * Ask a stub left over from a previous run to remove its icon, fire and forget.
 * Run on every packaged startup, before the real tray is created, so the app
 * owns the icon again without ever showing two.
 */
export function dismissLeftoverStub(
  input: {
    isPackaged: boolean
    resourcesPath: string
    env: string | undefined
    exists?: (filePath: string) => boolean
  },
  spawn: NodeSpawn
): boolean {
  if (!input.isPackaged) return false
  if (!idleStubEnvPolicy(input.env).enabled) return false
  const executable = idleStubExecutablePath(input.resourcesPath)
  if (!safeExists(executable, input.exists ?? existsSync)) return false
  spawnIdleStub(executable, IDLE_STUB_EXIT_ARGS, spawn)
  return true
}
