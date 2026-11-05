import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_YTDLP_DOWNLOAD_BYTES,
  YTDLP_RELEASE_API,
  createYtdlpUpdater,
  isAllowedGithubUrl,
  looksLikeExtractorFailure,
  parseSha256Sums,
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
        name: 'yt-dlp.exe',
        browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp.exe`
      },
      {
        name: 'SHA2-256SUMS',
        browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/SHA2-256SUMS`
      }
    ]
  })
}

interface HarnessOptions {
  currentVersion?: string
  latestVersion?: string
  binary?: Uint8Array
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
  const binary =
    options.binary ?? new TextEncoder().encode('verified-yt-dlp-binary')
  const expectedHash = options.sumsHash ?? sha256(binary)

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
      return response(`${expectedHash}  yt-dlp.exe\n`)
    }
    if (url.endsWith('/yt-dlp.exe')) {
      return response(binary)
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
          return path.basename(path.dirname(binaryPath))
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

  it('parses the SHA2-256SUMS entry for yt-dlp.exe', () => {
    const hash = 'a'.repeat(64)
    expect(parseSha256Sums(`${hash}  yt-dlp.exe\n`)).toBe(hash)
    expect(parseSha256Sums(`${hash} *yt-dlp.exe\n`)).toBe(hash)
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
      harness.fetchCalls.filter((url) => url.endsWith('/yt-dlp.exe'))
    ).toHaveLength(0)
  })

  it('downloads, verifies and activates a newer managed version', async () => {
    const store = memoryStore()
    const harness = await makeHarness({ store })
    const state = await harness.updater.check({ force: true })

    expect(state.status).toBe('updated')
    expect(state.currentVersion).toBe('2026.11.05')
    const finalPath = path.join(harness.toolsDir, '2026.11.05', 'yt-dlp.exe')
    expect(await readFile(finalPath, 'utf8')).toBe('verified-yt-dlp-binary')
    expect(store.saved.lastYtdlpCheckAt).not.toBeNull()
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

    const { readdir } = await import('node:fs/promises')
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
