import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CHROME_NATIVE_HOST_REGISTRY_KEY,
  DONDOWNLOAD_NATIVE_HOST_ADDON,
  EDGE_NATIVE_HOST_REGISTRY_KEY,
  FIREFOX_NATIVE_HOST_REGISTRY_KEY,
  NATIVE_HOST_NAME,
  type BrowserExtensionBrowserStatus,
  type BrowserExtensionStatus
} from '@shared/browserExtension'
import {
  DONDOWNLOAD_EXTENSION_ID,
  isFirefoxAddonId
} from '@shared/extensionId'

/**
 * Zero-config current-user native messaging registration.
 *
 * Everything that touches Windows is behind two small injectable interfaces so
 * unit tests never read or write the real registry. Manifest file access is
 * injectable too, which keeps the idempotence tests hermetic.
 */

export interface NativeHostRegistry {
  /** Read a key's default (unnamed) value, or null when it does not exist. */
  readDefault(key: string): Promise<string | null>
  /** Write a key's default value, creating the key if needed. */
  writeDefault(key: string, value: string): Promise<void>
  /** Remove a key tree. A missing key is not an error. */
  removeKey(key: string): Promise<void>
}

export interface RegistrationFileSystem {
  readFile(filePath: string): Promise<string | null>
  /** Atomically replace `filePath` with `contents` (temp file + rename). */
  writeFileAtomic(filePath: string, contents: string): Promise<void>
  removeFile(filePath: string): Promise<void>
  exists(filePath: string): Promise<boolean>
}

export interface RegistrationDependencies {
  appDataPath: string
  /** Packaged uses resourcesPath; dev uses appPath (the repository root). */
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  /** `process.execPath`; its directory is the installed application folder. */
  execPath: string
  registry: NativeHostRegistry
  fileSystem: RegistrationFileSystem
  platform?: NodeJS.Platform
  logger?: (message: string) => void
}

export interface UnregisterResult {
  removed: boolean
  reason: 'removed' | 'no-manifest' | 'outside-install-dir' | 'failed'
  lastError: string | null
}

interface NativeManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

interface FirefoxNativeManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_extensions: string[]
}

const EXACT_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/$/
const HOST_EXE_NAME = 'dondownload-native-host.exe'
const MANIFEST_DESCRIPTION =
  'DonDownload native messaging bridge (manual HTTP(S) capture only)'

export function nativeManifestPath(appDataPath: string): string {
  return path.join(
    appDataPath,
    'DonDownload',
    'native-messaging',
    `${NATIVE_HOST_NAME}.json`
  )
}

/**
 * Firefox app manifests use `allowed_extensions` (add-on IDs) instead of
 * Chromium's `allowed_origins`, and must live in a separate file because the
 * same host name cannot be registered with both keys.
 */
export function firefoxManifestPath(appDataPath: string): string {
  return path.join(
    appDataPath,
    'DonDownload',
    'native-messaging',
    `${NATIVE_HOST_NAME}.firefox.json`
  )
}

export function extensionFolderPath(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'extension')
    : path.join(options.appPath, 'extension')
}

export function packagedNativeHostPath(resourcesPath: string): string {
  return path.join(resourcesPath, 'native', HOST_EXE_NAME)
}

export function developmentNativeHostPath(appPath: string): string {
  return path.join(appPath, 'native', HOST_EXE_NAME)
}

export function isValidNativeOrigin(value: unknown): value is string {
  return typeof value === 'string' && EXACT_ORIGIN_PATTERN.test(value)
}

/** Path containment that respects Windows' case-insensitive filesystem. */
export function isPathInsideDirectory(
  directory: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(api.resolve(directory), api.resolve(candidate))
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  )
}

function sanitizedOrigins(existing: unknown, extensionOrigin: string): string[] {
  const origins: string[] = []
  if (Array.isArray(existing)) {
    for (const value of existing) {
      if (!isValidNativeOrigin(value) || origins.includes(value)) continue
      origins.push(value)
    }
  }
  if (!origins.includes(extensionOrigin)) origins.push(extensionOrigin)
  return origins
}

function sanitizedExtensions(
  existing: unknown,
  addonId: string
): string[] {
  const extensions: string[] = []
  if (Array.isArray(existing)) {
    for (const value of existing) {
      if (!isFirefoxAddonId(value) || value.includes('*') || extensions.includes(value)) {
        continue
      }
      extensions.push(value)
    }
  }
  if (!extensions.includes(addonId)) extensions.push(addonId)
  return extensions
}

type ParsedNativeManifest = Partial<
  NativeManifest & { allowed_extensions: string[] }
>

function parseManifest(raw: string | null): ParsedNativeManifest | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ParsedNativeManifest)
      : null
  } catch {
    return null
  }
}

async function resolveHostPath(
  deps: RegistrationDependencies,
  existing: ParsedNativeManifest | null
): Promise<string> {
  const existingPath =
    existing && typeof existing.path === 'string' ? existing.path : null
  if (
    existingPath !== null &&
    path.basename(existingPath).toLowerCase() === HOST_EXE_NAME &&
    (await deps.fileSystem.exists(existingPath))
  ) {
    return existingPath
  }

  return deps.isPackaged
    ? packagedNativeHostPath(deps.resourcesPath)
    : developmentNativeHostPath(deps.appPath)
}

function buildManifest(hostPath: string, allowedOrigins: string[]): NativeManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: MANIFEST_DESCRIPTION,
    path: hostPath,
    type: 'stdio',
    allowed_origins: allowedOrigins
  }
}

function buildFirefoxManifest(
  hostPath: string,
  allowedExtensions: string[]
): FirefoxNativeManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: MANIFEST_DESCRIPTION,
    path: hostPath,
    type: 'stdio',
    allowed_extensions: allowedExtensions
  }
}

function manifestContents(
  manifest: NativeManifest | FirefoxNativeManifest
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function browserRows(
  chromeRegistered: boolean,
  edgeRegistered: boolean,
  firefoxRegistered: boolean
): BrowserExtensionBrowserStatus[] {
  return [
    {
      browser: 'Chrome',
      registered: chromeRegistered,
      registryKey: CHROME_NATIVE_HOST_REGISTRY_KEY,
      shared: true
    },
    {
      browser: 'Helium',
      registered: chromeRegistered,
      registryKey: CHROME_NATIVE_HOST_REGISTRY_KEY,
      shared: true
    },
    {
      browser: 'Edge',
      registered: edgeRegistered,
      registryKey: EDGE_NATIVE_HOST_REGISTRY_KEY,
      shared: false
    },
    {
      browser: 'Firefox',
      registered: firefoxRegistered,
      registryKey: FIREFOX_NATIVE_HOST_REGISTRY_KEY,
      shared: false
    }
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown registration error.'
}

/**
 * Register (or repair) the host for the current Windows user. Never throws:
 * failures are returned in `lastError` so application startup stays alive.
 */
export async function registerNativeHost(
  deps: RegistrationDependencies
): Promise<BrowserExtensionStatus> {
  const manifestPath = nativeManifestPath(deps.appDataPath)
  const firefoxManifest = firefoxManifestPath(deps.appDataPath)
  const extensionFolder = extensionFolderPath(deps)
  const extensionOrigin = `chrome-extension://${DONDOWNLOAD_EXTENSION_ID}/`
  const errors: string[] = []

  let hostPath = deps.isPackaged
    ? packagedNativeHostPath(deps.resourcesPath)
    : developmentNativeHostPath(deps.appPath)
  let allowedOrigins: string[] = [extensionOrigin]
  let allowedExtensions: string[] = [DONDOWNLOAD_NATIVE_HOST_ADDON]

  try {
    const raw = await deps.fileSystem.readFile(manifestPath)
    const rawFirefox = await deps.fileSystem.readFile(firefoxManifest)
    const existing = parseManifest(raw)
    const existingFirefox = parseManifest(rawFirefox)
    hostPath = await resolveHostPath(deps, existing ?? existingFirefox)
    allowedOrigins = sanitizedOrigins(existing?.allowed_origins, extensionOrigin)
    allowedExtensions = sanitizedExtensions(
      existingFirefox?.allowed_extensions,
      DONDOWNLOAD_NATIVE_HOST_ADDON
    )

    const desired = manifestContents(buildManifest(hostPath, allowedOrigins))
    if (raw !== desired) {
      await deps.fileSystem.writeFileAtomic(manifestPath, desired)
    }
    const desiredFirefox = manifestContents(
      buildFirefoxManifest(hostPath, allowedExtensions)
    )
    if (rawFirefox !== desiredFirefox) {
      await deps.fileSystem.writeFileAtomic(firefoxManifest, desiredFirefox)
    }
  } catch (error) {
    errors.push(`Manifest: ${errorMessage(error)}`)
  }

  let chromeRegistered = false
  let edgeRegistered = false
  let firefoxRegistered = false
  for (const [key, assign] of [
    [CHROME_NATIVE_HOST_REGISTRY_KEY, (value: boolean) => (chromeRegistered = value)],
    [EDGE_NATIVE_HOST_REGISTRY_KEY, (value: boolean) => (edgeRegistered = value)],
    [FIREFOX_NATIVE_HOST_REGISTRY_KEY, (value: boolean) => (firefoxRegistered = value)]
  ] as const) {
    try {
      // Firefox's registry key points at the allowed_extensions manifest; the
      // Chromium-compatible browsers share the allowed_origins manifest.
      const target =
        key === FIREFOX_NATIVE_HOST_REGISTRY_KEY ? firefoxManifest : manifestPath
      const current = await deps.registry.readDefault(key)
      if (current !== target) {
        await deps.registry.writeDefault(key, target)
      }
      assign(true)
    } catch (error) {
      assign(false)
      errors.push(`Registry: ${errorMessage(error)}`)
    }
  }

  const status: BrowserExtensionStatus = {
    registered: chromeRegistered && edgeRegistered && firefoxRegistered,
    browsers: browserRows(chromeRegistered, edgeRegistered, firefoxRegistered),
    hostPath,
    manifestPath,
    allowedOrigins,
    firefoxManifestPath: firefoxManifest,
    firefoxAddonId: DONDOWNLOAD_NATIVE_HOST_ADDON,
    allowedExtensions,
    extensionFolder,
    extensionId: DONDOWNLOAD_EXTENSION_ID,
    lastError: errors.length > 0 ? errors.join(' | ') : null
  }
  if (status.lastError !== null) {
    deps.logger?.(`Browser extension registration: ${status.lastError}`)
  }
  return status
}

/**
 * Remove the manifest and both current-user keys, but only when the manifest
 * points inside this installation. A dev registration pointing at the
 * repository is deliberately left alone.
 */
export async function unregisterNativeHost(
  deps: RegistrationDependencies
): Promise<UnregisterResult> {
  const manifestPath = nativeManifestPath(deps.appDataPath)
  const firefoxManifest = firefoxManifestPath(deps.appDataPath)
  const installDirectory = path.dirname(deps.execPath)

  try {
    const raw = await deps.fileSystem.readFile(manifestPath)
    const rawFirefox = await deps.fileSystem.readFile(firefoxManifest)
    const manifest = parseManifest(raw)
    const firefox = parseManifest(rawFirefox)
    const manifestHostPath =
      manifest && typeof manifest.path === 'string'
        ? manifest.path
        : firefox && typeof firefox.path === 'string'
          ? firefox.path
          : null
    if (manifestHostPath === null) {
      return { removed: false, reason: 'no-manifest', lastError: null }
    }
    if (
      !isPathInsideDirectory(
        installDirectory,
        manifestHostPath,
        deps.platform ?? process.platform
      )
    ) {
      return {
        removed: false,
        reason: 'outside-install-dir',
        lastError: null
      }
    }

    const errors: string[] = []
    for (const key of [
      CHROME_NATIVE_HOST_REGISTRY_KEY,
      EDGE_NATIVE_HOST_REGISTRY_KEY,
      FIREFOX_NATIVE_HOST_REGISTRY_KEY
    ]) {
      try {
        await deps.registry.removeKey(key)
      } catch (error) {
        errors.push(`Registry: ${errorMessage(error)}`)
      }
    }
    for (const file of [manifestPath, firefoxManifest]) {
      try {
        await deps.fileSystem.removeFile(file)
      } catch (error) {
        errors.push(`Manifest: ${errorMessage(error)}`)
      }
    }

    const lastError = errors.length > 0 ? errors.join(' | ') : null
    if (lastError !== null) deps.logger?.(`Browser extension cleanup: ${lastError}`)
    return {
      removed: lastError === null,
      reason: lastError === null ? 'removed' : 'failed',
      lastError
    }
  } catch (error) {
    return { removed: false, reason: 'failed', lastError: errorMessage(error) }
  }
}

/* -------------------------------------------------------------------------- *
 * Production adapters
 * -------------------------------------------------------------------------- */

export type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string
) => void

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean; encoding: 'utf8'; maxBuffer: number },
  callback: ExecFileCallback
) => void

function runReg(
  exec: ExecFileLike,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    try {
      exec(
        'reg.exe',
        args,
        { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr })
            return
          }
          const rawCode = (error as { code?: unknown }).code
          const code = typeof rawCode === 'number' ? rawCode : Number(rawCode)
          // reg.exe exits with 1 for a missing key. Keep that distinguishable
          // from a thrown spawn failure so reads can report "missing".
          if (code === 1) {
            resolve({ code, stdout, stderr })
            return
          }
          reject(error)
        }
      )
    } catch (error) {
      reject(error)
    }
  })
}

/** Production registry access. Uses `reg.exe` with an argument array, no shell. */
export function createRegExeRegistry(
  exec: ExecFileLike = execFile as unknown as ExecFileLike
): NativeHostRegistry {
  return {
    async readDefault(key: string): Promise<string | null> {
      const result = await runReg(exec, ['query', key, '/ve'])
      if (result.code !== 0) return null
      const match = /^\s*(?:\(Default\)|Default)\s+REG_SZ\s+(.+?)\s*$/im.exec(
        result.stdout
      )
      return match?.[1] ?? null
    },
    async writeDefault(key: string, value: string): Promise<void> {
      const result = await runReg(exec, [
        'add',
        key,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        value,
        '/f'
      ])
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `reg.exe add failed (${result.code}).`)
      }
    },
    async removeKey(key: string): Promise<void> {
      const result = await runReg(exec, ['delete', key, '/f'])
      if (result.code !== 0) {
        // A key that no longer exists is already in the desired state.
        if (/unable to find|not find|cannot find/i.test(result.stderr)) return
        throw new Error(
          result.stderr.trim() || `reg.exe delete failed (${result.code}).`
        )
      }
    }
  }
}

let tempCounter = 0

/** Production file access with an atomic temp-file + rename manifest write. */
export function createNodeFileSystem(): RegistrationFileSystem {
  return {
    async readFile(filePath: string): Promise<string | null> {
      try {
        return await fs.readFile(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async writeFileAtomic(filePath: string, contents: string): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      tempCounter += 1
      const temporary = `${filePath}.${process.pid}.${tempCounter}.tmp`
      await fs.writeFile(temporary, contents, 'utf8')
      try {
        await fs.rename(temporary, filePath)
      } catch (error) {
        await fs.rm(temporary, { force: true })
        throw error
      }
    },
    async removeFile(filePath: string): Promise<void> {
      await fs.rm(filePath, { force: true })
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(filePath)
        return true
      } catch {
        return false
      }
    }
  }
}

export interface NativeHostRegistrar {
  getStatus(): Promise<BrowserExtensionStatus>
  repair(): Promise<BrowserExtensionStatus>
  /** Cached status; null until the first registration finishes. */
  peekStatus(): BrowserExtensionStatus | null
  extensionFolder(): string
}

/**
 * Serializes registration runs so startup and an explicit Repair click cannot
 * interleave their manifest/registry writes.
 */
export function createNativeHostRegistrar(
  deps: RegistrationDependencies
): NativeHostRegistrar {
  let cached: BrowserExtensionStatus | null = null
  let running: Promise<BrowserExtensionStatus> | null = null

  const run = (): Promise<BrowserExtensionStatus> => {
    if (running !== null) return running
    running = registerNativeHost(deps)
      .then((status) => {
        cached = status
        return status
      })
      .finally(() => {
        running = null
      })
    return running
  }

  return {
    async getStatus(): Promise<BrowserExtensionStatus> {
      if (cached !== null) return cached
      return run()
    },
    repair: run,
    peekStatus: () => cached,
    extensionFolder: () => extensionFolderPath(deps)
  }
}
