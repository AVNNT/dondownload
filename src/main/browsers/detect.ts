import { existsSync } from 'node:fs'
import type {
  BrowserEngine,
  DetectedBrowserId,
  WelcomeConnectionRow
} from '@shared/welcome'

/**
 * Read-only browser detection for the first-start guide.
 *
 * Detection only checks the conventional install folders for each browser. It
 * never starts a browser, reads a browser profile, or spawns a helper: a missing
 * file is simply a false result. The file and path readers are injectable so
 * unit tests never touch the real disk.
 *
 * Windows App Paths (HKCU/HKLM `Software\Microsoft\Windows\CurrentVersion\
 * App Paths`) would also cover custom install folders, but reading them from
 * this process needs `reg.exe`, which would break the no-process-spawn rule.
 * `registry` is therefore an optional read-only hook: production leaves it
 * unset, while tests (and a future in-process registry reader) can supply one.
 */

export interface AppPathReader {
  /** Absolute executable path registered for `executable`, or null. */
  readAppPath(executable: string): string | null
}

export interface BrowserDetectorOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  /** File probe; defaults to `fs.existsSync`. */
  fileExists?: (candidate: string) => boolean
  /** Optional App Paths reader. Absent by default; never spawned by this module. */
  registry?: AppPathReader
}

export interface DetectedBrowser {
  id: DetectedBrowserId
  label: string
  engine: BrowserEngine
  /** Settings → Browser extension row whose connection state applies. */
  connectionRow: WelcomeConnectionRow
  /** First path that existed, retained for tests and diagnostics only. */
  executablePath: string
}

interface BrowserDefinition {
  id: DetectedBrowserId
  label: string
  engine: BrowserEngine
  connectionRow: WelcomeConnectionRow
  /** `%VAR%`-relative install paths, checked in order. */
  paths: readonly string[]
  /** Executable name used for an optional App Paths lookup. */
  appPathExecutable: string
}

/** Display order is stable and independent of which path matched. */
export const WINDOWS_BROWSERS: readonly BrowserDefinition[] = [
  {
    id: 'chrome',
    label: 'Chrome',
    engine: 'chromium',
    connectionRow: 'Chrome',
    appPathExecutable: 'chrome.exe',
    paths: [
      '%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe',
      '%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'
    ]
  },
  {
    id: 'edge',
    label: 'Edge',
    engine: 'chromium',
    connectionRow: 'Edge',
    appPathExecutable: 'msedge.exe',
    paths: [
      '%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  },
  {
    id: 'brave',
    label: 'Brave',
    engine: 'chromium',
    connectionRow: 'Chrome',
    appPathExecutable: 'brave.exe',
    paths: [
      '%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%PROGRAMFILES(X86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ]
  },
  {
    id: 'helium',
    label: 'Helium',
    engine: 'chromium',
    connectionRow: 'Helium',
    appPathExecutable: 'chrome.exe',
    paths: [
      '%LOCALAPPDATA%\\imput\\Helium\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Helium\\Application\\chrome.exe',
      '%PROGRAMFILES%\\Helium\\Application\\chrome.exe'
    ]
  },
  {
    id: 'firefox',
    label: 'Firefox',
    engine: 'gecko',
    connectionRow: 'Firefox',
    appPathExecutable: 'firefox.exe',
    paths: [
      '%PROGRAMFILES%\\Mozilla Firefox\\firefox.exe',
      '%PROGRAMFILES(X86)%\\Mozilla Firefox\\firefox.exe',
      '%LOCALAPPDATA%\\Mozilla Firefox\\firefox.exe'
    ]
  },
  {
    id: 'zen',
    label: 'Zen',
    engine: 'gecko',
    connectionRow: 'Firefox',
    appPathExecutable: 'zen.exe',
    paths: [
      '%LOCALAPPDATA%\\Zen Browser\\zen.exe',
      '%PROGRAMFILES%\\Zen Browser\\zen.exe',
      '%PROGRAMFILES(X86)%\\Zen Browser\\zen.exe'
    ]
  }
]

function lookupEnv(
  env: Record<string, string | undefined>,
  name: string
): string | undefined {
  if (env[name] !== undefined) return env[name]
  const wanted = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key]
  }
  return undefined
}

/**
 * Expand `%VAR%` segments from an environment object. A missing or empty
 * variable produces null so the caller skips that candidate instead of probing
 * a path relative to the process working directory.
 */
export function expandWindowsPath(
  template: string,
  env: Record<string, string | undefined>
): string | null {
  let missing = false
  const expanded = template.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = lookupEnv(env, name)
    if (value === undefined || value.length === 0) {
      missing = true
      return ''
    }
    return value
  })
  return missing || expanded.length === 0 ? null : expanded
}

/** True when the path names an existing file (injectable for tests). */
export function detectInstalledBrowsers(
  options: BrowserDetectorOptions = {}
): DetectedBrowser[] {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return []

  const env = options.env ?? process.env
  const fileExists = options.fileExists ?? existsSync
  const registry = options.registry
  const found: DetectedBrowser[] = []

  for (const definition of WINDOWS_BROWSERS) {
    let executablePath: string | null = null

    for (const template of definition.paths) {
      const candidate = expandWindowsPath(template, env)
      if (candidate === null) continue
      if (fileExists(candidate)) {
        executablePath = candidate
        break
      }
    }

    if (executablePath === null && registry) {
      try {
        const registered = registry.readAppPath(definition.appPathExecutable)
        if (registered !== null && fileExists(registered)) {
          executablePath = registered
        }
      } catch {
        // A registry read failure is the same as an uninstalled browser.
      }
    }

    if (executablePath === null) continue
    found.push({
      id: definition.id,
      label: definition.label,
      engine: definition.engine,
      connectionRow: definition.connectionRow,
      executablePath
    })
  }

  return found
}
