import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_APP_UPDATE_BYTES,
  MAX_RELEASE_NOTES_BYTES,
  defaultAppUpdateSettings,
  truncateReleaseNotes,
  type AppUpdateSettings
} from '../src/shared/appUpdate'
import {
  compareAppVersions,
  normalizeAppVersion
} from '../src/shared/appVersion'
import {
  createAppUpdateChecker,
  type AppUpdateCheckerOptions
} from '../src/main/appUpdate/checker'
import { openDownloadDatabase } from '../src/main/db/database'
import type {
  UpdaterFetch,
  UpdaterHttpResponse
} from '../src/main/media/updater'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-app-update-'))
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

function redirect(location: string): UpdaterHttpResponse {
  return response('', {
    ok: false,
    status: 302,
    url: 'https://github.com/',
    headers: {
      get: (name) => (name.toLowerCase() === 'location' ? location : null)
    }
  })
}

interface ReleaseOptions {
  tag?: string
  draft?: boolean
  prerelease?: boolean
  body?: string | null
  includeInstaller?: boolean
  includeSums?: boolean
  installerSize?: number
  installerBytes?: Uint8Array
  installerName?: string
  installerUrl?: string
  sumsUrl?: string
}

function releaseJson(
  version: string,
  options: ReleaseOptions = {}
): string {
  const tag = options.tag ?? `v${version}`
  const installerName =
    options.installerName ?? `DonDownload-${version}-x64-setup.exe`
  const bytes = options.installerBytes ?? new TextEncoder().encode('installer')
  const assets: unknown[] = []
  if (options.includeInstaller !== false) {
    assets.push({
      name: installerName,
      browser_download_url:
        options.installerUrl ??
        `https://github.com/acme/dondownload/releases/download/${tag}/${installerName}`,
      size: options.installerSize ?? bytes.byteLength
    })
  }
  if (options.includeSums !== false) {
    assets.push({
      name: 'SHA256SUMS.txt',
      browser_download_url:
        options.sumsUrl ??
        `https://github.com/acme/dondownload/releases/download/${tag}/SHA256SUMS.txt`
    })
  }
  return JSON.stringify({
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    body: options.body ?? null,
    assets
  })
}

interface FetchScript {
  api?: () => UpdaterHttpResponse
  sums?: () => UpdaterHttpResponse
  installer?: () => UpdaterHttpResponse
}

function createFetch(script: FetchScript): {
  fetchImpl: UpdaterFetch
  calls: { url: string; init: unknown }[]
} {
  const calls: { url: string; init: unknown }[] = []
  const fetchImpl: UpdaterFetch = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('/releases/latest')) {
      return script.api ? script.api() : response('{}')
    }
    if (url.endsWith('SHA256SUMS.txt')) {
      return script.sums ? script.sums() : response('')
    }
    return script.installer ? script.installer() : response('')
  }
  return { fetchImpl, calls }
}

const REPO = { owner: 'acme', repo: 'dondownload' }

function makeChecker(
  userDataPath: string,
  overrides: Partial<AppUpdateCheckerOptions> = {}
) {
  return createAppUpdateChecker({
    userDataPath,
    appVersion: '0.1.0',
    repo: REPO,
    ...overrides
  })
}

function sumsFor(bytes: Uint8Array, name: string): string {
  return `${sha256(bytes)}  ${name}\n`
}

describe('semver handling', () => {
  it('normalises tags and compares prereleases as older', () => {
    expect(normalizeAppVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeAppVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1')
    expect(normalizeAppVersion('1.2')).toBeNull()
    expect(compareAppVersions('1.2.3', '1.2.2')).toBeGreaterThan(0)
    expect(compareAppVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareAppVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0)
    expect(compareAppVersions('1.2.3-beta.1', '1.2.3-beta.2')).toBeLessThan(0)
  })

  it('truncates release notes to 4 KiB of plain text', () => {
    const long = 'a'.repeat(MAX_RELEASE_NOTES_BYTES + 100)
    expect(truncateReleaseNotes(long)).toHaveLength(MAX_RELEASE_NOTES_BYTES)
    expect(truncateReleaseNotes('<b>text</b>')).toBe('<b>text</b>')
    expect(truncateReleaseNotes(null)).toBeNull()
  })
})

describe('app update checker', () => {
  it('never fetches when no update source is configured', async () => {
    const dir = await makeTemp()
    const fetchImpl = vi.fn() as unknown as UpdaterFetch
    const checker = makeChecker(dir, { repo: null, fetchImpl })

    const state = await checker.check({ force: true })
    expect(state.status).toBe('not-configured')
    expect(state.configured).toBe(false)
    expect(state.message).toBe('Update source not configured')
    expect(fetchImpl).not.toHaveBeenCalled()

    const automatic = await checker.autoCheck()
    expect(automatic.status).toBe('not-configured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('ignores older, equal and prerelease releases', async () => {
    const dir = await makeTemp()

    for (const tag of ['v0.0.9', 'v0.1.0', 'v0.1.0-beta.1']) {
      const { fetchImpl, calls } = createFetch({
        api: () => response(releaseJson('0.1.0', { tag }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        })
      })
      const checker = makeChecker(dir, { fetchImpl })
      const state = await checker.check({ force: true })
      expect(state.status).toBe('up-to-date')
      expect(calls.filter((call) => call.url.endsWith('SHA256SUMS.txt'))).toHaveLength(0)
    }

    const bytes = new TextEncoder().encode('installer')
    const { fetchImpl, calls } = createFetch({
      api: () =>
        response(releaseJson('0.2.0', { installerBytes: bytes }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        }),
      sums: () =>
        response(
          sumsFor(bytes, 'DonDownload-0.2.0-x64-setup.exe')
        ),
      installer: () => response(bytes)
    })
    const checker = makeChecker(dir, { fetchImpl })
    const state = await checker.check({ force: true })
    expect(state.status).toBe('ready')
    expect(state.latestVersion).toBe('0.2.0')
    expect(calls.some((call) => call.url.includes('setup.exe'))).toBe(true)
  })

  it('ignores a release flagged as prerelease', async () => {
    const dir = await makeTemp()
    const { fetchImpl, calls } = createFetch({
      api: () =>
        response(releaseJson('0.2.0', { prerelease: true }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        })
    })
    const checker = makeChecker(dir, { fetchImpl })
    const state = await checker.check({ force: true })
    expect(state.status).toBe('up-to-date')
    expect(calls).toHaveLength(1)
  })

  it('fails when the required assets are missing', async () => {
    const dir = await makeTemp()
    const { fetchImpl } = createFetch({
      api: () =>
        response(
          releaseJson('0.2.0', { includeInstaller: false }),
          { url: 'https://api.github.com/repos/acme/dondownload/releases/latest' }
        )
    })
    const checker = makeChecker(dir, { fetchImpl })
    const state = await checker.check({ force: true })
    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/missing/i)
  })

  it('rejects an asset redirect to an unapproved host', async () => {
    const dir = await makeTemp()
    const bytes = new TextEncoder().encode('installer')
    const installerUrl =
      'https://github.com/acme/dondownload/releases/download/v0.2.0/DonDownload-0.2.0-x64-setup.exe'
    const { fetchImpl, calls } = createFetch({
      api: () =>
        response(releaseJson('0.2.0', { installerBytes: bytes }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        }),
      sums: () =>
        response(sumsFor(bytes, 'DonDownload-0.2.0-x64-setup.exe')),
      installer: () => redirect('https://evil.example/installer.exe')
    })
    const checker = makeChecker(dir, { fetchImpl })
    const state = await checker.check({ force: true })
    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/unapproved host/i)
    expect(calls.some((call) => call.url === installerUrl)).toBe(true)
    expect(calls.some((call) => call.url.includes('evil.example'))).toBe(false)
  })

  it('enforces the size cap and the declared size', async () => {
    const dir = await makeTemp()

    const capped = createFetch({
      api: () =>
        response(
          releaseJson('0.2.0', {
            installerSize: MAX_APP_UPDATE_BYTES + 1
          }),
          { url: 'https://api.github.com/repos/acme/dondownload/releases/latest' }
        ),
      sums: () => response(''),
      installer: () => response('')
    })
    const cappedState = await makeChecker(dir, {
      fetchImpl: capped.fetchImpl
    }).check({ force: true })
    expect(cappedState.status).toBe('failed')
    expect(cappedState.message).toMatch(/larger than the safety limit/i)
    expect(
      capped.calls.filter((call) => call.url.includes('setup.exe'))
    ).toHaveLength(0)

    const bytes = new TextEncoder().encode('installer')
    const mismatch = createFetch({
      api: () =>
        response(
          releaseJson('0.3.0', {
            installerBytes: bytes,
            installerSize: bytes.byteLength + 1
          }),
          { url: 'https://api.github.com/repos/acme/dondownload/releases/latest' }
        ),
      sums: () =>
        response(sumsFor(bytes, 'DonDownload-0.3.0-x64-setup.exe')),
      installer: () => response(bytes)
    })
    const mismatchState = await makeChecker(await makeTemp(), {
      fetchImpl: mismatch.fetchImpl
    }).check({ force: true })
    expect(mismatchState.status).toBe('failed')
    expect(mismatchState.message).toMatch(/declared size/i)
  })

  it('deletes the installer when its hash does not match the sums', async () => {
    const dir = await makeTemp()
    const bytes = new TextEncoder().encode('tampered')
    const { fetchImpl } = createFetch({
      api: () =>
        response(releaseJson('0.2.0', { installerBytes: bytes }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        }),
      sums: () =>
        response(
          `${'0'.repeat(64)}  DonDownload-0.2.0-x64-setup.exe\n`
        ),
      installer: () => response(bytes)
    })
    const checker = makeChecker(dir, { fetchImpl })
    const state = await checker.check({ force: true })
    expect(state.status).toBe('failed')
    expect(state.message).toMatch(/SHA-256/i)
    expect(state.canInstall).toBe(false)

    const updateDir = path.join(dir, 'updates', '0.2.0')
    const entries = await readdir(updateDir).catch(() => [] as string[])
    expect(entries.filter((name) => name.includes('setup.exe'))).toHaveLength(0)
  })

  it('downloads, verifies and exposes a ready installer', async () => {
    const dir = await makeTemp()
    const bytes = new TextEncoder().encode('verified installer')
    const name = 'DonDownload-0.2.0-x64-setup.exe'
    const { fetchImpl, calls } = createFetch({
      api: () =>
        response(
          releaseJson('0.2.0', {
            installerBytes: bytes,
            body: 'Fixes and improvements.\nSecond line.'
          }),
          { url: 'https://api.github.com/repos/acme/dondownload/releases/latest' }
        ),
      sums: () => response(sumsFor(bytes, name)),
      installer: () => response(bytes)
    })
    const checker = makeChecker(dir, { fetchImpl })
    const state = await checker.check({ force: true })
    expect(state.status).toBe('ready')
    expect(state.canInstall).toBe(true)
    expect(state.releaseNotes).toBe('Fixes and improvements.\nSecond line.')

    const filePath = path.join(dir, 'updates', '0.2.0', name)
    expect(await readFile(filePath)).toEqual(Buffer.from(bytes))

    for (const call of calls) {
      const init = call.init as {
        redirect: string
        headers: Record<string, string>
      }
      expect(init.redirect).toBe('manual')
      expect(init.headers.Cookie).toBeUndefined()
      expect(init.headers.Authorization).toBeUndefined()
      expect(init.headers['User-Agent']).toBe('DonDownload/0.1.0')
    }
  })

  it('refuses to install while a job is active, then verifies and launches', async () => {
    const dir = await makeTemp()
    const bytes = new TextEncoder().encode('verified installer')
    const name = 'DonDownload-0.2.0-x64-setup.exe'
    const { fetchImpl } = createFetch({
      api: () =>
        response(releaseJson('0.2.0', { installerBytes: bytes }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        }),
      sums: () => response(sumsFor(bytes, name)),
      installer: () => response(bytes)
    })
    let active = true
    const spawn = vi.fn(() => ({ unref: vi.fn() }))
    const quit = vi.fn()
    const checker = makeChecker(dir, {
      fetchImpl,
      isJobActive: () => active,
      spawn,
      quit
    })

    expect((await checker.check({ force: true })).status).toBe('ready')
    const refused = await checker.install()
    expect(refused.status).toBe('ready')
    expect(refused.message).toMatch(/active download/i)
    expect(spawn).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()

    active = false
    const installed = await checker.install()
    expect(installed.status).toBe('installing')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      path.join(dir, 'updates', '0.2.0', name),
      []
    )
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('throttles automatic checks for 24 hours', async () => {
    const dir = await makeTemp()
    const now = Date.UTC(2026, 10, 6, 12, 0, 0)
    const settings: AppUpdateSettings = {
      ...defaultAppUpdateSettings(),
      lastCheckedAt: now - 60 * 60 * 1000
    }
    const store = {
      loadAppUpdateSettings: () => settings,
      saveAppUpdateSettings: (next: AppUpdateSettings) => {
        Object.assign(settings, next)
      }
    }
    const fetchImpl = vi.fn() as unknown as UpdaterFetch
    const recent = makeChecker(dir, {
      fetchImpl,
      store,
      now: () => now
    })
    const throttled = await recent.autoCheck()
    expect(throttled.status).toBe('throttled')
    expect(fetchImpl).not.toHaveBeenCalled()

    const bytes = new TextEncoder().encode('installer')
    const { fetchImpl: laterFetch } = createFetch({
      api: () =>
        response(releaseJson('0.2.0', { installerBytes: bytes }), {
          url: 'https://api.github.com/repos/acme/dondownload/releases/latest'
        }),
      sums: () =>
        response(sumsFor(bytes, 'DonDownload-0.2.0-x64-setup.exe')),
      installer: () => response(bytes)
    })
    const oldStore = {
      loadAppUpdateSettings: (): AppUpdateSettings => ({
        ...defaultAppUpdateSettings(),
        lastCheckedAt: now - 25 * 60 * 60 * 1000
      }),
      saveAppUpdateSettings: () => undefined
    }
    const later = makeChecker(await makeTemp(), {
      fetchImpl: laterFetch,
      store: oldStore,
      now: () => now
    })
    const checked = await later.autoCheck()
    expect(checked.status).toBe('ready')
  })

  it('does not fetch when automatic checks are turned off', async () => {
    const dir = await makeTemp()
    const fetchImpl = vi.fn() as unknown as UpdaterFetch
    const checker = makeChecker(dir, {
      fetchImpl,
      store: {
        loadAppUpdateSettings: () => ({
          autoCheck: false,
          lastCheckedAt: null
        }),
        saveAppUpdateSettings: () => undefined
      }
    })
    const state = await checker.autoCheck()
    expect(state.status).toBe('disabled')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(checker.setAutoCheck({ autoCheck: true }).autoCheck).toBe(true)
  })

  it('persists the app update setting and last check time', async () => {
    const dir = await makeTemp()
    const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
    try {
      expect(database.loadAppUpdateSettings()).toEqual({
        autoCheck: true,
        lastCheckedAt: null
      })
      database.saveAppUpdateSettings({
        autoCheck: false,
        lastCheckedAt: 1_760_000_000_000
      })
      expect(database.loadAppUpdateSettings()).toEqual({
        autoCheck: false,
        lastCheckedAt: 1_760_000_000_000
      })
    } finally {
      database.close()
    }
  })
})
