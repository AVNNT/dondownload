import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ZIP_LIMITS,
  MAX_YTDLP_DOWNLOAD_BYTES,
  YTDLP_ASSET_NAME,
  YTDLP_RELEASE_API,
  createYtdlpUpdater,
  extractZipArchive,
  isAllowedGithubUrl,
  looksLikeExtractorFailure,
  parseSha256Sums,
  sanitizeZipEntryName,
  type MediaToolSettingsStore,
  type UpdaterFetch,
  type UpdaterHttpResponse
} from '../src/main/media/updater'
import {
  compareYtdlpVersions,
  isYtdlpVersion
} from '../src/shared/ytdlpVersion'
import { defaultMediaToolSettings } from '../src/shared/mediaTools'
import { openDownloadDatabase } from '../src/main/db/database'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function response(
  body: string | Uint8Array,
  overrides: Partial<UpdaterHttpResponse> = {}
): UpdaterHttpResponse {
  const bytes =
    typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    ok: true,
    status: 200,
    url: 'https://github.com/',
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    ...overrides
  }
}

function releaseJson(version: string): string {
  return JSON.stringify({
    tag_name: version,
    assets: [
      {
        name: YTDLP_ASSET_NAME,
        browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${YTDLP_ASSET_NAME}`
      },
      {
        name: 'SHA2-256SUMS',
        browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/SHA2-256SUMS`
      }
    ]
  })
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

interface TestZipEntry {
  name: string
  data?: Uint8Array
  directory?: boolean
  /** Declare a different uncompressed size to exercise the size caps. */
  declaredUncompressedSize?: number
}

/** Build a stored (uncompressed) ZIP archive for tests. */
function buildZip(entries: TestZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = entry.directory
      ? new Uint8Array()
      : (entry.data ?? new Uint8Array())
    const uncompressed = entry.declaredUncompressedSize ?? data.length

    const local = new Uint8Array(30 + name.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x800, true)
    localView.setUint16(8, 0, true)
    localView.setUint32(14, crc32(data), true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, uncompressed, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint32(4, 20, true)
    centralView.setUint32(6, 20, true)
    centralView.setUint16(8, 0x800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(16, crc32(data), true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, uncompressed, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const archive = new Uint8Array(total)
  let cursor = 0
  for (const part of [...locals, ...centrals, eocd]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}

function onedirArchive(
  exe = 'verified-yt-dlp-binary',
  extra: TestZipEntry[] = []
): Uint8Array {
  const encoder = new TextEncoder()
  return buildZip([
    { name: 'yt-dlp.exe', data: encoder.encode(exe) },
    { name: '_internal/', directory: true },
    { name: '_internal/pyinstaller.pyc', data: encoder.encode('runtime') },
    ...extra
  ])
}

interface HarnessOptions {
  currentVersion?: string
  latestVersion?: string
  archive?: Uint8Array
  sumsHash?: string
  fetch?: UpdaterFetch
  isJobActive?: () => boolean
  runVersion?: (binaryPath: string) => Promise<string | null>
  store?: MediaToolSettingsStore
  managedVersion?: string
}

interface Harness {
  root: string
  userData: string
  toolsDir: string
  updater: ReturnType<typeof createYtdlpUpdater>
  fetchCalls: string[]
  clock: { now: number }
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await makeTemp('dondownload-ytdlp-updater-')
  const userData = path.join(root, 'userData')
  const cwd = path.join(root, 'app')
  const currentVersion = options.currentVersion ?? '2026.10.26'
  const latestVersion = options.latestVersion ?? '2026.11.05'
  const archive = options.archive ?? onedirArchive()
  const expectedHash = options.sumsHash ?? sha256(archive)

  await mkdir(path.join(cwd, 'vendor', 'yt-dlp'), { recursive: true })
  await writeFile(path.join(cwd, 'vendor', 'yt-dlp', 'yt-dlp.exe'), 'bundled')
  await writeFile(
    path.join(cwd, 'vendor', 'manifest.json'),
    JSON.stringify({
      tools: [{ name: 'yt-dlp', version: currentVersion }]
    })
  )

  if (options.managedVersion) {
    const managedDir = path.join(userData, 'tools', 'yt-dlp', options.managedVersion)
    await mkdir(managedDir, { recursive: true })
    await writeFile(path.join(managedDir, 'yt-dlp.exe'), 'managed')
  }

  const fetchCalls: string[] = []
  const defaultFetch: UpdaterFetch = async (url) => {
    fetchCalls.push(url)
    if (url === YTDLP_RELEASE_API) {
      return response(releaseJson(latestVersion))
    }
    if (url.endsWith('/SHA2-256SUMS')) {
      return response(`${expectedHash}  ${YTDLP_ASSET_NAME}\n`)
    }
    if (url.endsWith(`/${YTDLP_ASSET_NAME}`)) {
      return response(archive)
    }
    return response('not found', { ok: false, status: 404 })
  }

  const clock = { now: Date.UTC(2026, 10, 5, 12, 0, 0) }
  const toolsDir = path.join(userData, 'tools', 'yt-dlp')
  const updater = createYtdlpUpdater({
    userDataPath: userData,
    appVersion: '0.1.0-test',
    store: options.store ?? null,
    cwd,
    env: { PATH: '' },
    platform: 'win32',
    now: () => clock.now,
    fetchImpl: options.fetch ?? defaultFetch,
    isJobActive: options.isJobActive ?? (() => false),
    runVersion:
      options.runVersion ??
      (async (binaryPath) => {
        const managedRoot = path.join(userData, 'tools', 'yt-dlp')
        if (binaryPath.startsWith(managedRoot + path.sep)) {
          const directory = path.basename(path.dirname(binaryPath))
          // Temporary extraction directories are not version-named.
          return isYtdlpVersion(directory) ? directory : latestVersion
        }
        return currentVersion
      })
  })

  return {
    root,
    userData,
    toolsDir,
    updater,
    fetchCalls,
    clock
  }
}

function memoryStore(
  initial = defaultMediaToolSettings()
): MediaToolSettingsStore & { saved: ReturnType<typeof defaultMediaToolSettings> } {
  let current = { ...initial }
  const store = {
    saved: current,
    loadMediaToolSettings: () => ({ ...current }),
    saveMediaToolSettings: (next: typeof current) => {
      current = { ...next }
      store.saved = next
    }
  }
  return store
}

describe('yt-dlp version helpers', () => {
  it('accepts calendar versions with an optional build suffix', () => {
    expect(isYtdlpVersion('2026.10.26')).toBe(true)
    expect(isYtdlpVersion('2026.10.26.12')).toBe(true)
    expect(isYtdlpVersion('2026.13.01')).toBe(false)
    expect(isYtdlpVersion('latest')).toBe(false)
    expect(isYtdlpVersion('2026.10.26.1234')).toBe(false)
  })

  it('orders versions numerically, including the build suffix', () => {
    expect(compareYtdlpVersions('2026.10.26', '2026.10.27')).toBeLessThan(0)
    expect(compareYtdlpVersions('2026.11.01', '2026.10.31')).toBeGreaterThan(0)
    expect(compareYtdlpVersions('2026.11.01', '2026.11.01.0')).toBe(0)
    expect(compareYtdlpVersions('2026.11.01.2', '2026.11.01.10')).toBeLessThan(0)
    expect(compareYtdlpVersions('not-a-version', '2026.11.01')).toBeLessThan(0)
  })

  it('only allows the approved HTTPS GitHub hosts', () => {
    expect(
      isAllowedGithubUrl('https://github.com/yt-dlp/yt-dlp/releases/download/1/x')
    ).toBe(true)
    expect(isAllowedGithubUrl('https://objects.githubusercontent.com/x')).toBe(
      true
    )
    expect(
      isAllowedGithubUrl('https://release-assets.githubusercontent.com/x')
    ).toBe(true)
    expect(isAllowedGithubUrl('http://github.com/x')).toBe(false)
    expect(isAllowedGithubUrl('https://evil.example/x')).toBe(false)
    expect(isAllowedGithubUrl('https://github.com.evil.example/x')).toBe(false)
    expect(isAllowedGithubUrl('https://user:pass@github.com/x')).toBe(false)
  })

  it('parses the SHA2-256SUMS entry for the requested asset', () => {
    const hash = 'a'.repeat(64)
    expect(parseSha256Sums(`${hash}  ${YTDLP_ASSET_NAME}\n`)).toBe(hash)
    expect(parseSha256Sums(`${hash} *${YTDLP_ASSET_NAME}\n`)).toBe(hash)
    // Legacy one-file entries remain parseable for the compatibility path.
    expect(parseSha256Sums(`${hash}  yt-dlp.exe\n`, 'yt-dlp.exe')).toBe(hash)
    expect(parseSha256Sums(`${hash}  ${YTDLP_ASSET_NAME}\n`, 'yt-dlp.exe')).toBeNull()
    expect(parseSha256Sums(`${hash}  other.exe\n`)).toBeNull()
    expect(parseSha256Sums('not a sums file')).toBeNull()
  })

  it('recognises extractor-style yt-dlp failures', () => {
    expect(looksLikeExtractorFailure('ERROR: Unable to extract player response')).toBe(true)
    expect(looksLikeExtractorFailure('nsig extraction failed')).toBe(true)
    expect(looksLikeExtractorFailure('ERROR: Video unavailable')).toBe(false)
  })
})

describe('managed yt-dlp update check', () => {
  it('reports up to date without downloading an asset', async () => {
    const harness = await makeHarness({
      currentVersion: '2026.11.05',
      latestVersion: '2026.11.05'
    })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('up-to-date')
    expect(state.currentVersion).toBe('2026.11.05')
    expect(
      harness.fetchCalls.filter((url) => url.endsWith(`/${YTDLP_ASSET_NAME}`))
    ).toHaveLength(0)
  })

  it('downloads, verifies and activates the newer one-folder build', async () => {
    const store = memoryStore()
    const harness = await makeHarness({ store })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('updated')
    expect(state.currentVersion).toBe('2026.11.05')
    const versionDir = path.join(harness.toolsDir, '2026.11.05')
    expect(await readFile(path.join(versionDir, 'yt-dlp.exe'), 'utf8')).toBe(
      'verified-yt-dlp-binary'
    )
    // The one-folder runtime is extracted next to the executable.
    expect(
      await readFile(path.join(versionDir, '_internal', 'pyinstaller.pyc'), 'utf8')
    ).toBe('runtime')
    expect(
      (await readdir(harness.toolsDir)).some((name) =>
        name.startsWith('.yt-dlp-')
      )
    ).toBe(false)
    expect(store.saved.lastYtdlpCheckAt).not.toBeNull()
  })

  it('keeps an already-installed one-file managed executable usable', async () => {
    // A one-file layout written by an older DonDownload release is still a
    // valid managed version: only `<version>/yt-dlp.exe` matters to the locator.
    const harness = await makeHarness({ managedVersion: '2026.11.01' })
    expect(
      await readFile(
        path.join(harness.toolsDir, '2026.11.01', 'yt-dlp.exe'),
        'utf8'
      )
    ).toBe('managed')

    const state = await harness.updater.check({ force: true })
    expect(state.status).toBe('updated')
    expect(state.currentVersion).toBe('2026.11.05')
    // The superseded one-file directory is retained by the two-version policy.
    expect(
      await readFile(
        path.join(harness.toolsDir, '2026.11.01', 'yt-dlp.exe'),
        'utf8'
      )
    ).toBe('managed')
  })

  it('rejects a checksum mismatch and keeps the current binary', async () => {
    const harness = await makeHarness({ sumsHash: '0'.repeat(64) })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/checksum/i)
    await expect(
      readFile(path.join(harness.toolsDir, '2026.11.05', 'yt-dlp.exe'))
    ).rejects.toThrow()
  })

  it('rejects a binary that does not print the expected version', async () => {
    const harness = await makeHarness({
      runVersion: async (binaryPath) =>
        binaryPath.includes('vendor')
          ? '2026.10.26'
          : '2026.10.26'
    })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/expected version/i)
    await expect(
      readFile(path.join(harness.toolsDir, '2026.11.05', 'yt-dlp.exe'))
    ).rejects.toThrow()
  })

  it('refuses a redirect outside the approved hosts', async () => {
    const harness = await makeHarness({
      fetch: async (url) => {
        if (url === YTDLP_RELEASE_API) {
          return response('', {
            ok: false,
            status: 302,
            headers: { get: (name) => (name === 'location' ? 'https://evil.example/x' : null) }
          })
        }
        return response('unexpected')
      }
    })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/unapproved host/i)
  })

  it('rejects a download larger than the size cap by content length', async () => {
    const harness = await makeHarness({
      fetch: async (url) => {
        if (url === YTDLP_RELEASE_API) return response(releaseJson('2026.11.05'))
        return response('x', {
          headers: {
            get: (name) =>
              name === 'content-length'
                ? String(MAX_YTDLP_DOWNLOAD_BYTES + 1)
                : null
          }
        })
      }
    })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/safety limit/i)
  })
})

describe('verified archive extraction', () => {
  it('extracts the one-folder layout from a valid archive', () => {
    const entries = extractZipArchive(onedirArchive())
    const paths = entries.map((entry) => entry.relativePath).sort()
    expect(paths).toContain('yt-dlp.exe')
    expect(paths).toContain(path.join('_internal', 'pyinstaller.pyc'))
  })

  it('rejects traversal, absolute and drive-qualified entry names', () => {
    expect(sanitizeZipEntryName('../evil.exe')).toBeNull()
    expect(sanitizeZipEntryName('a/../../evil.exe')).toBeNull()
    expect(sanitizeZipEntryName('/evil.exe')).toBeNull()
    expect(sanitizeZipEntryName('C:/evil.exe')).toBeNull()
    expect(sanitizeZipEntryName('C:\\evil.exe')).toBeNull()
    expect(sanitizeZipEntryName('a\\..\\evil.exe')).toBeNull()
    expect(sanitizeZipEntryName('_internal\\python313.dll')).toBe(
      path.join('_internal', 'python313.dll')
    )

    const traversal = buildZip([
      { name: 'yt-dlp.exe', data: new TextEncoder().encode('binary') },
      { name: '../escape.txt', data: new TextEncoder().encode('nope') }
    ])
    expect(() => extractZipArchive(traversal)).toThrow(/unsafe file path/i)
  })

  it('rejects an archive that expands beyond the size cap', () => {
    const archive = onedirArchive()
    expect(() =>
      extractZipArchive(archive, {
        maxEntries: 100,
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 4
      })
    ).toThrow(/extraction size limit/i)
    expect(() =>
      extractZipArchive(archive, {
        maxEntries: 100,
        maxEntryBytes: 2,
        maxTotalBytes: 1024 * 1024
      })
    ).toThrow(/extraction size limit/i)
  })

  it('rejects an archive with too many entries', () => {
    const archive = onedirArchive()
    expect(() =>
      extractZipArchive(archive, {
        ...DEFAULT_ZIP_LIMITS,
        maxEntries: 2
      })
    ).toThrow(/too many entries/i)
  })

  it('rejects a truncated archive instead of reading out of bounds', () => {
    const archive = onedirArchive().subarray(0, 20)
    expect(() => extractZipArchive(archive)).toThrow(/empty|ZIP|truncated/i)
  })

  it('fails the update without writing outside the tools directory', async () => {
    const unsafe = buildZip([
      { name: 'yt-dlp.exe', data: new TextEncoder().encode('binary') },
      { name: '_internal/', directory: true },
      { name: '_internal/x', data: new TextEncoder().encode('x') },
      { name: '../../escape.txt', data: new TextEncoder().encode('nope') }
    ])
    const harness = await makeHarness({ archive: unsafe })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/unsafe file path/i)
    await expect(
      readFile(path.join(harness.root, 'escape.txt'), 'utf8')
    ).rejects.toThrow()
  })
})

describe('managed version retention', () => {
  it('keeps only the two newest managed versions', async () => {
    const harness = await makeHarness({ managedVersion: '2026.11.01' })
    for (const version of ['2026.10.30', '2026.10.29']) {
      const dir = path.join(harness.toolsDir, version)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'yt-dlp.exe'), 'old')
    }

    const state = await harness.updater.check({ force: true })
    expect(state.status).toBe('updated')

    const versions = (await readdir(harness.toolsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(versions).toEqual(['2026.11.01', '2026.11.05'])
  })
})

describe('startup and extractor throttles', () => {
  it('checks at most once per 24 hours unless forced', async () => {
    const harness = await makeHarness({
      currentVersion: '2026.11.05',
      latestVersion: '2026.11.05'
    })

    expect((await harness.updater.check()).status).toBe('up-to-date')
    const callsAfterFirst = harness.fetchCalls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    expect((await harness.updater.check()).status).toBe('throttled')
    expect(harness.fetchCalls).toHaveLength(callsAfterFirst)

    harness.clock.now += 24 * 60 * 60 * 1000 + 1
    expect((await harness.updater.check()).status).toBe('up-to-date')
    expect(harness.fetchCalls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('skips automatic checks in smoke mode and when the preference is off', async () => {
    const harness = await makeHarness({
      currentVersion: '2026.11.05',
      latestVersion: '2026.11.05'
    })
    const disabled = createYtdlpUpdater({
      userDataPath: harness.userData,
      appVersion: 'test',
      autoUpdateAllowed: false,
      fetchImpl: async () => {
        throw new Error('must not fetch')
      }
    })
    expect((await disabled.autoCheck()).status).toBe('disabled')
    expect(harness.fetchCalls).toHaveLength(0)

    harness.updater.updateSettings({ autoUpdateYtdlp: false })
    expect((await harness.updater.autoCheck()).status).toBe('disabled')
    expect(harness.fetchCalls).toHaveLength(0)
  })

  it('does not check again within an hour after an extractor failure', async () => {
    const harness = await makeHarness({
      currentVersion: '2026.11.05',
      latestVersion: '2026.11.05'
    })
    await harness.updater.check()
    const calls = harness.fetchCalls.length

    await expect(harness.updater.notifyExtractorFailure()).resolves.toBe(false)
    expect(harness.fetchCalls).toHaveLength(calls)
  })
})

describe('media tool settings persistence', () => {
  it('defaults to automatic updates and persists the toggle and last check', async () => {
    const dir = await makeTemp('dondownload-media-tool-settings-')
    const filePath = path.join(dir, 'downloads.sqlite3')

    const first = openDownloadDatabase(filePath)
    expect(first.loadMediaToolSettings()).toEqual(defaultMediaToolSettings())
    first.saveMediaToolSettings({
      autoUpdateYtdlp: false,
      lastYtdlpCheckAt: 1_760_000_000_000
    })
    first.close()

    const second = openDownloadDatabase(filePath)
    expect(second.loadMediaToolSettings()).toEqual({
      autoUpdateYtdlp: false,
      lastYtdlpCheckAt: 1_760_000_000_000
    })
    second.close()
  })
})

describe('activation safety', () => {
  it('does not re-download a verified release that is already waiting', async () => {
    const harness = await makeHarness({ isJobActive: () => true })
    expect((await harness.updater.check({ force: true })).status).toBe('deferred')
    const assetDownloads = () =>
      harness.fetchCalls.filter((url) => url.endsWith(`/${YTDLP_ASSET_NAME}`))
        .length
    expect(assetDownloads()).toBe(1)

    expect((await harness.updater.check({ force: true })).status).toBe('deferred')
    expect(assetDownloads()).toBe(1)
  })

  it('does not swap the binary while a media job is active', async () => {
    let active = true
    const harness = await makeHarness({ isJobActive: () => active })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('deferred')
    const finalPath = path.join(harness.toolsDir, '2026.11.05', 'yt-dlp.exe')
    await expect(readFile(finalPath)).rejects.toThrow()

    active = false
    harness.updater.onJobsChanged()
    await vi.waitFor(async () => {
      await expect(readFile(finalPath, 'utf8')).resolves.toBe(
        'verified-yt-dlp-binary'
      )
    })
    expect(harness.updater.getState().status).toBe('updated')
  })
})
