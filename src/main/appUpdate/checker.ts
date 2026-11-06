import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject
} from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import {
  APP_UPDATE_SUMS_NAME,
  MAX_APP_UPDATE_BYTES,
  parseAppUpdateSettings,
  parseAppUpdateSettingsPatch,
  truncateReleaseNotes,
  type AppUpdateSettings,
  type AppUpdateState
} from '@shared/appUpdate'
import {
  normalizeAppVersion,
  compareAppVersions
} from '@shared/appVersion'
import {
  requireValidUpdateRepo,
  UPDATE_REPO,
  UPDATE_SIGNING_KEY_NOT_CONFIGURED,
  UPDATE_SIGNING_PUBLIC_KEY,
  type UpdateRepo
} from '@shared/release'
import {
  parseSha256Sums,
  type UpdaterFetch,
  type UpdaterHttpResponse
} from '../media/updater'

/**
 * Safe application self-updater backed by GitHub Releases.
 *
 * Security properties:
 * - When `UPDATE_REPO` is null no request is made at all.
 * - Only the fixed GitHub API endpoint and HTTPS assets on github.com,
 *   objects.githubusercontent.com or release-assets.githubusercontent.com are
 *   requested. Every redirect hop is validated, no cookies or credentials are
 *   sent, and the release JSON is capped at 1 MiB.
 * - Draft and prerelease releases are ignored. The tag must be a strict
 *   `vX.Y.Z`/`X.Y.Z` semver and the asset version must equal the tag.
 * - The installer is downloaded into `<userData>/updates/<version>/` through a
 *   `.partial` sibling, capped at 600 MiB and required to match the asset's
 *   declared size and the published `SHA256SUMS.txt` entry. A mismatch removes
 *   the file and reports a safe failure.
 * - Installing requires an explicit user action, is refused while a download or
 *   media job is active, re-verifies the hash immediately before launch, and
 *   spawns the per-user NSIS installer detached with no shell.
 * - Release notes are plain text only, truncated to 4 KiB, and are never
 *   interpreted as HTML.
 *
 * Network, filesystem, clock and process launching are injectable so tests
 * never touch the network or run an installer.
 */

export const GITHUB_API_HOSTS = new Set(['api.github.com'])
export const GITHUB_ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])

export const MAX_APP_UPDATE_JSON_BYTES = 1024 * 1024
export const MAX_APP_UPDATE_SUMS_BYTES = 1024 * 1024
export const MAX_APP_UPDATE_SIGNATURE_BYTES = 4 * 1024
export const APP_UPDATE_SIGNATURE_NAME = 'SHA256SUMS.txt.sig'
export const UPDATE_SIGNATURE_INVALID = 'Update signing key is not valid'
export const APP_UPDATE_REQUEST_TIMEOUT_MS = 15_000
export const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 5
const INSTALLER_PATTERN =
  /^DonDownload-(\d+\.\d+\.\d+)-x64-setup\.exe$/

export interface AppUpdateFs {
  mkdir(directory: string, options: { recursive: true }): Promise<void>
  writeFile(filePath: string, data: Uint8Array): Promise<void>
  readFile(filePath: string): Promise<Uint8Array>
  rename(from: string, to: string): Promise<void>
  rm(
    target: string,
    options: { recursive?: boolean; force?: boolean }
  ): Promise<void>
  readdir(directory: string): Promise<Dirent[]>
  stat(target: string): Promise<{ isFile(): boolean; size: number }>
}

export interface AppUpdateSettingsStore {
  loadAppUpdateSettings(): AppUpdateSettings
  saveAppUpdateSettings(settings: AppUpdateSettings): void
}

export type AppUpdateSpawn = (
  filePath: string,
  args: string[]
) => { unref?: () => void }

export interface AppUpdateCheckerOptions {
  userDataPath: string
  appVersion: string
  /** Defaults to the shared `UPDATE_REPO`; null means no source configured. */
  repo?: UpdateRepo | null
  /**
   * Defaults to the shared `UPDATE_SIGNING_PUBLIC_KEY`. A configured repository
   * without a key never offers an update.
   */
  signingPublicKey?: string | null
  store?: AppUpdateSettingsStore | null
  fetchImpl?: UpdaterFetch
  fs?: AppUpdateFs
  now?: () => number
  /** True while any download or media job is active. */
  isJobActive?: () => boolean
  /** False in smoke/test modes so startup never performs network work. */
  autoCheckAllowed?: boolean
  spawn?: AppUpdateSpawn
  quit?: () => void
  onStateChanged?: (state: AppUpdateState) => void
}

export interface AppUpdateChecker {
  readonly updatesDir: string
  getState(): AppUpdateState
  getSettings(): AppUpdateSettings
  setAutoCheck(input: unknown): AppUpdateState
  check(options?: { force?: boolean }): Promise<AppUpdateState>
  autoCheck(): Promise<AppUpdateState>
  /** Verify and launch the ready installer, then quit. */
  install(): Promise<AppUpdateState>
}

interface LatestRelease {
  version: string
  installerName: string
  installerUrl: string
  installerSize: number
  sumsUrl: string
  signatureUrl: string
  releaseNotes: string | null
}

interface ParsedReleaseInfo {
  version: string
  record: Record<string, unknown>
}

interface ReadyInstall {
  version: string
  filePath: string
  fileName: string
  expectedSha: string
  expectedSize: number
}

class AppUpdateFailure extends Error {}

const defaultFs: AppUpdateFs = {
  mkdir: async (directory, options) => {
    await fsPromises.mkdir(directory, options)
  },
  writeFile: (filePath, data) => fsPromises.writeFile(filePath, data),
  readFile: async (filePath) => new Uint8Array(await fsPromises.readFile(filePath)),
  rename: (from, to) => fsPromises.rename(from, to),
  rm: (target, options) => fsPromises.rm(target, options),
  readdir: (directory) => fsPromises.readdir(directory, { withFileTypes: true }),
  stat: (target) => fsPromises.stat(target)
}

const defaultFetch: UpdaterFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<UpdaterHttpResponse>

const defaultSpawn: AppUpdateSpawn = (filePath, args) =>
  nodeSpawn(filePath, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false
  })

function fail(message: string): never {
  throw new AppUpdateFailure(message)
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AppUpdateFailure) return error.message
  return 'The application update could not be completed. Try again later.'
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Parse an SPKI PEM or base64 SPKI DER Ed25519 public key. */
function loadUpdateSigningKey(value: string): KeyObject {
  const text = value.trim()
  if (text.length === 0) throw new Error('empty update signing key')
  const key = text.startsWith('-----BEGIN')
    ? createPublicKey(text)
    : createPublicKey({
        key: Buffer.from(text, 'base64'),
        format: 'der',
        type: 'spki'
      })
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('update signing key is not Ed25519')
  }
  return key
}

/**
 * Decode the release signature strictly. It must be a base64 encoding of
 * exactly one raw 64-byte Ed25519 signature.
 */
export function decodeUpdateSignature(value: string): Buffer | null {
  const text = value.trim()
  if (text.length === 0 || text.length > MAX_APP_UPDATE_SIGNATURE_BYTES) {
    return null
  }
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return null
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(text, 'base64')
  } catch {
    return null
  }
  return bytes.byteLength === 64 ? bytes : null
}

function signatureVerifies(
  publicKey: KeyObject,
  data: Uint8Array,
  signature: Uint8Array
): boolean {
  try {
    return verify(null, data, publicKey, signature) === true
  } catch {
    return false
  }
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data)
}

function urlIsAllowed(
  value: string,
  hosts: ReadonlySet<string>
): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  return hosts.has(parsed.hostname.toLowerCase())
}

/** True for the only HTTPS hosts allowed to serve update assets. */
export function isAllowedAppAssetUrl(value: string): boolean {
  return urlIsAllowed(value, GITHUB_ASSET_HOSTS)
}

function buildReleaseApiUrl(repo: UpdateRepo): string {
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`
}

function parseReleaseInfo(value: unknown): ParsedReleaseInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('GitHub returned an unreadable application release.')
  }
  const record = value as Record<string, unknown>
  // `releases/latest` normally excludes these, but never trust the response.
  if (record.draft === true || record.prerelease === true) return null

  const version = normalizeAppVersion(record.tag_name)
  if (version === null) {
    fail('The latest application release has an unsupported version tag.')
  }
  return { version, record }
}

/**
 * Validate the assets only after the caller knows the release is actually
 * newer. An older release without assets is simply "up to date", not an error.
 */
function parseLatestRelease(info: ParsedReleaseInfo): LatestRelease {
  const { version, record } = info
  if (!Array.isArray(record.assets)) {
    fail('The latest application release has no downloadable assets.')
  }

  let installerName: string | null = null
  let installerUrl: string | null = null
  let installerSize: number | null = null
  let sumsUrl: string | null = null
  let signatureUrl: string | null = null

  for (const asset of record.assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const entry = asset as Record<string, unknown>
    if (typeof entry.name !== 'string') continue
    const installerMatch = INSTALLER_PATTERN.exec(entry.name)
    if (
      installerMatch !== null &&
      installerMatch[1] === version &&
      typeof entry.browser_download_url === 'string'
    ) {
      installerName = entry.name
      installerUrl = entry.browser_download_url
      if (
        typeof entry.size === 'number' &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0
      ) {
        installerSize = entry.size
      }
    } else if (
      entry.name === APP_UPDATE_SUMS_NAME &&
      typeof entry.browser_download_url === 'string'
    ) {
      sumsUrl = entry.browser_download_url
    } else if (
      entry.name === APP_UPDATE_SIGNATURE_NAME &&
      typeof entry.browser_download_url === 'string'
    ) {
      signatureUrl = entry.browser_download_url
    }
  }

  if (
    installerName === null ||
    installerUrl === null ||
    sumsUrl === null ||
    signatureUrl === null
  ) {
    fail(
      `The latest application release is missing the ${version} installer, its checksum file or its signature file.`
    )
  }
  if (installerSize === null) {
    fail('The application installer did not declare a valid size.')
  }
  if (installerSize > MAX_APP_UPDATE_BYTES) {
    fail('The application installer was larger than the safety limit.')
  }
  if (
    !isAllowedAppAssetUrl(installerUrl) ||
    !isAllowedAppAssetUrl(sumsUrl) ||
    !isAllowedAppAssetUrl(signatureUrl)
  ) {
    fail('The latest application release points outside the approved GitHub hosts.')
  }

  return {
    version,
    installerName,
    installerUrl,
    installerSize,
    sumsUrl,
    signatureUrl,
    releaseNotes: truncateReleaseNotes(record.body)
  }
}

export function createAppUpdateChecker(
  options: AppUpdateCheckerOptions
): AppUpdateChecker {
  const userDataPath = options.userDataPath
  const appVersion = options.appVersion
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const fs = options.fs ?? defaultFs
  const isJobActive = options.isJobActive ?? (() => false)
  const autoCheckAllowed = options.autoCheckAllowed ?? true
  const spawnInstaller = options.spawn ?? defaultSpawn
  const quit = options.quit ?? (() => undefined)
  const updatesDir = path.join(userDataPath, 'updates')

  let repo: UpdateRepo | null
  try {
    repo =
      options.repo === undefined
        ? requireValidUpdateRepo(UPDATE_REPO)
        : requireValidUpdateRepo(options.repo)
  } catch {
    repo = null
  }

  const signingKeyValue =
    options.signingPublicKey === undefined
      ? UPDATE_SIGNING_PUBLIC_KEY
      : options.signingPublicKey
  let signingKey: KeyObject | null = null
  let signingKeyProblem: string | null = null
  if (signingKeyValue !== null) {
    try {
      signingKey = loadUpdateSigningKey(signingKeyValue)
    } catch {
      signingKeyProblem = UPDATE_SIGNATURE_INVALID
    }
  }
  const signingKeyMissing = repo !== null && signingKeyValue === null
  const unavailableMessage =
    repo === null
      ? 'Update source not configured'
      : signingKeyMissing
        ? UPDATE_SIGNING_KEY_NOT_CONFIGURED
        : signingKeyProblem

  let settings: AppUpdateSettings
  try {
    settings = options.store
      ? parseAppUpdateSettings(options.store.loadAppUpdateSettings())
      : { autoCheck: true, lastCheckedAt: null }
  } catch {
    settings = { autoCheck: true, lastCheckedAt: null }
  }

  let ready: ReadyInstall | null = null
  let inFlight: Promise<AppUpdateState> | null = null

  let state: AppUpdateState = {
    status: unavailableMessage === null ? 'idle' : 'not-configured',
    configured: repo !== null && signingKey !== null,
    currentVersion: appVersion,
    latestVersion: null,
    progressPercent: null,
    message: unavailableMessage,
    releaseNotes: null,
    lastCheckedAt: settings.lastCheckedAt,
    autoCheck: settings.autoCheck,
    canInstall: false
  }

  function publish(patch: Partial<AppUpdateState>): AppUpdateState {
    state = { ...state, ...patch }
    try {
      options.onStateChanged?.({ ...state })
    } catch {
      // A UI listener must never break the updater.
    }
    return { ...state }
  }

  function saveSettings(next: AppUpdateSettings): void {
    settings = next
    if (!options.store) return
    try {
      options.store.saveAppUpdateSettings(next)
    } catch {
      // Keep the in-memory value; a later check will try to persist again.
    }
  }

  function recordCheckTime(): void {
    saveSettings({ ...settings, lastCheckedAt: now() })
    publish({ lastCheckedAt: settings.lastCheckedAt })
  }

  function notConfigured(): AppUpdateState {
    return publish({
      status: 'not-configured',
      configured: false,
      message: 'Update source not configured',
      progressPercent: null,
      canInstall: false
    })
  }

  /**
   * Refuse every update action before any request when the repository is
   * missing or the configured repository has no valid Ed25519 public key.
   */
  function updateSourceUnavailable(): AppUpdateState {
    return publish({
      status: 'not-configured',
      configured: false,
      message: unavailableMessage ?? UPDATE_SIGNING_KEY_NOT_CONFIGURED,
      progressPercent: null,
      canInstall: false
    })
  }

  async function request(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    hosts: ReadonlySet<string>
  ): Promise<UpdaterHttpResponse> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!urlIsAllowed(current, hosts)) {
        fail('The application update redirected to an unapproved host.')
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      let response: UpdaterHttpResponse
      try {
        response = await fetchImpl(current, {
          redirect: 'manual',
          headers,
          signal: controller.signal
        })
      } catch {
        fail('GitHub could not be reached for the application update.')
      } finally {
        clearTimeout(timer)
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location.length === 0) {
          fail('GitHub returned an incomplete application download redirect.')
        }
        let next: string
        try {
          next = new URL(location, current).href
        } catch {
          fail('GitHub returned an invalid application download redirect.')
        }
        if (!urlIsAllowed(next, hosts)) {
          fail('The application update redirected to an unapproved host.')
        }
        current = next
        continue
      }

      if (response.url && !urlIsAllowed(response.url, hosts)) {
        fail('The application update redirected to an unapproved host.')
      }
      return response
    }
    fail('The application update redirected too many times.')
  }

  async function readBody(
    response: UpdaterHttpResponse,
    maximum: number
  ): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maximum) {
      fail('The application update download was larger than the safety limit.')
    }
    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch {
      fail('The application update download could not be read.')
    }
    const bytes = new Uint8Array(buffer)
    if (bytes.byteLength > maximum) {
      fail('The application update download was larger than the safety limit.')
    }
    return bytes
  }

  async function fetchLatestRelease(): Promise<ParsedReleaseInfo | null> {
    if (repo === null) return null
    const response = await request(
      buildReleaseApiUrl(repo),
      {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DonDownload/${appVersion}`
      },
      APP_UPDATE_REQUEST_TIMEOUT_MS,
      GITHUB_API_HOSTS
    )
    if (!response.ok) {
      fail(`GitHub returned HTTP ${response.status} for the application release.`)
    }
    const raw = await readBody(response, MAX_APP_UPDATE_JSON_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(decodeUtf8(raw))
    } catch {
      fail('GitHub returned an unreadable application release.')
    }
    return parseReleaseInfo(parsed)
  }

  async function downloadSums(url: string): Promise<Uint8Array> {
    const response = await request(
      url,
      { 'User-Agent': `DonDownload/${appVersion}` },
      APP_UPDATE_REQUEST_TIMEOUT_MS,
      GITHUB_ASSET_HOSTS
    )
    if (!response.ok) {
      fail(`GitHub returned HTTP ${response.status} for the checksum file.`)
    }
    return readBody(response, MAX_APP_UPDATE_SUMS_BYTES)
  }

  async function downloadSignature(url: string): Promise<string> {
    const response = await request(
      url,
      { 'User-Agent': `DonDownload/${appVersion}` },
      APP_UPDATE_REQUEST_TIMEOUT_MS,
      GITHUB_ASSET_HOSTS
    )
    if (!response.ok) {
      fail(`GitHub returned HTTP ${response.status} for the checksum signature.`)
    }
    const bytes = await readBody(response, MAX_APP_UPDATE_SIGNATURE_BYTES)
    return decodeUtf8(bytes)
  }

  function updateDirectory(version: string): string {
    return path.join(updatesDir, version)
  }

  function installerPath(release: LatestRelease): string {
    return path.join(updateDirectory(release.version), release.installerName)
  }

  async function verifyExistingRelease(
    release: LatestRelease,
    expectedSha: string
  ): Promise<string | null> {
    const filePath = installerPath(release)
    if (!isInsideDirectory(updatesDir, filePath)) return null
    try {
      const info = await fs.stat(filePath)
      if (!info.isFile() || info.size !== release.installerSize) return null
      const bytes = await fs.readFile(filePath)
      if (bytes.byteLength !== release.installerSize) return null
      if (sha256(bytes) !== expectedSha) return null
      return filePath
    } catch {
      return null
    }
  }

  async function downloadInstaller(
    release: LatestRelease,
    expectedSha: string
  ): Promise<string> {
    if (release.installerSize > MAX_APP_UPDATE_BYTES) {
      fail('The application installer was larger than the safety limit.')
    }

    publish({
      status: 'downloading',
      progressPercent: 0,
      canInstall: false,
      message: `Downloading DonDownload ${release.version}…`
    })

    const response = await request(
      release.installerUrl,
      {
        Accept: 'application/octet-stream',
        'User-Agent': `DonDownload/${appVersion}`
      },
      APP_UPDATE_DOWNLOAD_TIMEOUT_MS,
      GITHUB_ASSET_HOSTS
    )
    if (!response.ok) {
      fail(`GitHub returned HTTP ${response.status} for the application installer.`)
    }

    const rawDeclared = response.headers.get('content-length')
    const declaredHeader =
      rawDeclared === null ? null : Number(rawDeclared)
    if (
      declaredHeader !== null &&
      Number.isFinite(declaredHeader)
    ) {
      if (declaredHeader > MAX_APP_UPDATE_BYTES) {
        fail('The application installer was larger than the safety limit.')
      }
      if (declaredHeader !== release.installerSize) {
        fail('The application installer did not match its declared size.')
      }
    }

    const bytes = await readBody(response, MAX_APP_UPDATE_BYTES)
    if (bytes.byteLength !== release.installerSize) {
      fail('The application installer did not match its declared size.')
    }

    publish({ progressPercent: 100 })

    const directory = updateDirectory(release.version)
    if (!isInsideDirectory(updatesDir, directory)) {
      fail('The application update path was not inside the updates directory.')
    }
    await fs.mkdir(directory, { recursive: true })
    const finalPath = installerPath(release)
    if (!isInsideDirectory(updatesDir, finalPath)) {
      fail('The application update path was not inside the updates directory.')
    }
    const partialPath = `${finalPath}.partial`

    try {
      await fs.writeFile(partialPath, bytes)
      if (sha256(bytes) !== expectedSha) {
        fail('The downloaded application installer did not match the published SHA-256 sums.')
      }
      await fs.rm(finalPath, { force: true })
      await fs.rename(partialPath, finalPath)
    } catch (error) {
      await fs.rm(partialPath, { force: true }).catch(() => undefined)
      throw error
    }

    return finalPath
  }

  /** Remove update directories for every version other than the active one. */
  async function pruneOlderUpdates(keepVersion: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(updatesDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.name)) continue
      if (entry.name === keepVersion) continue
      const candidate = path.join(updatesDir, entry.name)
      if (!isInsideDirectory(updatesDir, candidate)) continue
      try {
        await fs.rm(candidate, { recursive: true, force: true })
      } catch {
        // Retention is best effort; the verified installer stays usable.
      }
    }
  }

  function readyState(version: string): AppUpdateState {
    return publish({
      status: 'ready',
      latestVersion: version,
      progressPercent: null,
      canInstall: true,
      message: `DonDownload ${version} is ready to install.`
    })
  }

  async function runCheck(force: boolean): Promise<AppUpdateState> {
    if (repo === null) return notConfigured()
    if (signingKey === null) return updateSourceUnavailable()

    if (!force) {
      const last = settings.lastCheckedAt
      if (last !== null && now() - last < 24 * 60 * 60 * 1000) {
        if (ready !== null) return readyState(ready.version)
        return publish({
          status: 'throttled',
          message: 'The application was checked recently.'
        })
      }
    }

    publish({ status: 'checking', message: null, progressPercent: null })
    recordCheckTime()

    try {
      const info = await fetchLatestRelease()
      if (info === null) {
        return publish({
          status: 'up-to-date',
          latestVersion: null,
          releaseNotes: null,
          message: 'Up to date.'
        })
      }
      publish({ latestVersion: info.version })

      if (compareAppVersions(info.version, appVersion) <= 0) {
        ready = null
        return publish({
          status: 'up-to-date',
          progressPercent: null,
          canInstall: false,
          releaseNotes: null,
          message: 'Up to date.'
        })
      }

      const release = parseLatestRelease(info)
      publish({ releaseNotes: release.releaseNotes })

      const sums = await downloadSums(release.sumsUrl)
      const signatureText = await downloadSignature(release.signatureUrl)
      const signature = decodeUpdateSignature(signatureText)
      if (signature === null || !signatureVerifies(signingKey, sums, signature)) {
        fail('The application checksum file signature could not be verified.')
      }
      const expectedSha = parseSha256Sums(
        decodeUtf8(sums),
        release.installerName
      )
      if (expectedSha === null) {
        fail(
          `The application checksum file did not contain ${release.installerName}.`
        )
      }

      const existing = await verifyExistingRelease(release, expectedSha)
      if (existing !== null) {
        ready = {
          version: release.version,
          filePath: existing,
          fileName: release.installerName,
          expectedSha,
          expectedSize: release.installerSize
        }
        return readyState(release.version)
      }

      const filePath = await downloadInstaller(release, expectedSha)
      ready = {
        version: release.version,
        filePath,
        fileName: release.installerName,
        expectedSha,
        expectedSize: release.installerSize
      }
      await pruneOlderUpdates(release.version)
      return readyState(release.version)
    } catch (error) {
      ready = null
      return publish({
        status: 'failed',
        progressPercent: null,
        canInstall: false,
        releaseNotes: null,
        message: safeErrorMessage(error)
      })
    }
  }

  const checker: AppUpdateChecker = {
    updatesDir,

    getState(): AppUpdateState {
      return { ...state }
    },

    getSettings(): AppUpdateSettings {
      return { ...settings }
    },

    setAutoCheck(input: unknown): AppUpdateState {
      const patch = parseAppUpdateSettingsPatch(input)
      saveSettings({ ...settings, autoCheck: patch.autoCheck })
      return publish({ autoCheck: patch.autoCheck })
    },

    check(optionsInput = {}): Promise<AppUpdateState> {
      if (inFlight !== null) return inFlight
      const run = runCheck(optionsInput.force === true).finally(() => {
        if (inFlight === run) inFlight = null
      })
      inFlight = run
      return run
    },

    autoCheck(): Promise<AppUpdateState> {
      if (repo === null) return Promise.resolve(notConfigured())
      if (signingKey === null) {
        return Promise.resolve(updateSourceUnavailable())
      }
      if (!autoCheckAllowed) {
        return Promise.resolve(
          publish({
            status: 'disabled',
            message: 'Automatic application updates are disabled in this mode.'
          })
        )
      }
      if (!settings.autoCheck) {
        return Promise.resolve(
          publish({
            status: 'disabled',
            message: 'Automatic application update checks are turned off.'
          })
        )
      }
      return checker.check({ force: false })
    },

    async install(): Promise<AppUpdateState> {
      if (repo === null) return notConfigured()
      if (signingKey === null) return updateSourceUnavailable()

      if (ready === null) {
        return publish({
          status: 'failed',
          message: 'No verified application update is ready to install.'
        })
      }

      if (isJobActive()) {
        return publish({
          status: 'ready',
          message:
            'Finish or pause every active download and media job before restarting to install.'
        })
      }

      const install = ready
      if (!isInsideDirectory(updatesDir, install.filePath)) {
        return publish({
          status: 'failed',
          canInstall: false,
          message: 'The downloaded application update was not in the updates directory.'
        })
      }

      let bytes: Uint8Array
      try {
        bytes = await fs.readFile(install.filePath)
      } catch {
        ready = null
        return publish({
          status: 'failed',
          canInstall: false,
          message: 'The downloaded application update is no longer available.'
        })
      }

      if (
        bytes.byteLength !== install.expectedSize ||
        sha256(bytes) !== install.expectedSha
      ) {
        await fs.rm(install.filePath, { force: true }).catch(() => undefined)
        ready = null
        return publish({
          status: 'failed',
          canInstall: false,
          message:
            'The downloaded application installer failed verification and was removed.'
        })
      }

      publish({
        status: 'installing',
        canInstall: false,
        message: 'Launching the DonDownload installer…'
      })

      try {
        const child = spawnInstaller(install.filePath, [])
        child.unref?.()
      } catch {
        ready = null
        return publish({
          status: 'failed',
          canInstall: false,
          message: 'The DonDownload installer could not be started.'
        })
      }

      ready = null
      try {
        quit()
      } catch {
        // The installer is already running; a quit failure must not mask it.
      }
      return { ...state }
    }
  }

  return checker
}
