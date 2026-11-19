import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreHost } from '../src/main/host'
import { DownloadDestinationStore } from '../src/main/downloads/destination'
import {
  FEATURES_VERIFY_ENV,
  FEATURES_VERIFY_GLOBAL,
  TrayMenuProbe,
  applySeededHistory,
  checkHistoryLookups,
  createDestinationProbe,
  createRecordingHost,
  featuresVerificationEnabled,
  historySeedPath,
  installFeaturesVerification,
  probeHistoryLookups,
  probeWelcomeGuideSeen,
  shouldApplySeed,
  summarizeHistoryRows,
  writeSeedHistory,
  type FeaturesVerificationHooks,
  type HistoryLookupExpectation,
  type HistoryProbeSource,
  type TrayMenuProbePorts
} from '../src/main/smoke/featuresVerification'
import { defaultDesktopSettings } from '../src/shared/desktopSettings'
import type { TrayMenuActions } from '../src/main/trayMenu'

const tempDirs: string[] = []

async function makeFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-verify-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function fakeHost(): CoreHost {
  return {
    openPath: vi.fn(async () => 'real-open'),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    isPackaged: () => true,
    getAppPath: () => 'C:\\app',
    getResourcesPath: () => 'C:\\app\\resources',
    getPath: () => 'C:\\profile',
    isNotificationSupported: () => true,
    createNotification: () => ({
      on: () => undefined,
      onAction: () => undefined,
      show: () => undefined
    })
  }
}

function fakeActions(): TrayMenuActions & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    showWindow: () => calls.push('show'),
    hideWindow: () => calls.push('hide'),
    openSettings: () => calls.push('settings'),
    pauseAll: () => calls.push('pause'),
    resumeAll: () => calls.push('resume'),
    setSpeedLimitBps: (bps) => calls.push(`limit:${bps}`),
    openDownload: (id) => calls.push(`open:${id}`),
    showDownloadInFolder: (id) => calls.push(`show:${id}`),
    addFromClipboard: (url) => calls.push(`clipboard:${url}`),
    quit: () => calls.push('quit')
  }
}

describe('features verification gate', () => {
  it('is inert unless smoke mode and the explicit opt-in are both present', () => {
    expect(
      featuresVerificationEnabled({ smokeEnabled: false, env: {} })
    ).toBe(false)
    expect(
      featuresVerificationEnabled({
        smokeEnabled: false,
        env: { [FEATURES_VERIFY_ENV]: '1' }
      })
    ).toBe(false)
    expect(
      featuresVerificationEnabled({ smokeEnabled: true, env: {} })
    ).toBe(false)
    expect(
      featuresVerificationEnabled({
        smokeEnabled: true,
        env: { [FEATURES_VERIFY_ENV]: '0' }
      })
    ).toBe(false)
    expect(
      featuresVerificationEnabled({
        smokeEnabled: true,
        env: { [FEATURES_VERIFY_ENV]: '1' }
      })
    ).toBe(true)
  })

  it('never publishes hooks when disabled', () => {
    const globalObject: Record<string, unknown> = {}
    const hooks = {
      appVersion: '1.3.3',
      seededHistory: vi.fn(),
      databaseErrorCode: vi.fn(),
      historyRows: vi.fn(),
      writeSeededHistory: vi.fn(),
      tray: vi.fn(),
      windowState: vi.fn(),
      registerDestination: vi.fn(),
      resolveDestination: vi.fn(),
      notificationActivate: vi.fn(),
      probeLog: vi.fn(),
      historyLookups: vi.fn(),
      verifyHistory: vi.fn(),
      hostCalls: vi.fn(),
      clearHostCalls: vi.fn()
    } as unknown as FeaturesVerificationHooks

    expect(
      installFeaturesVerification({ enabled: false, hooks, globalObject })
    ).toBe(false)
    expect(globalObject[FEATURES_VERIFY_GLOBAL]).toBeUndefined()
    expect(
      (globalThis as Record<string, unknown>)[FEATURES_VERIFY_GLOBAL]
    ).toBeUndefined()
    expect(hooks.tray).not.toHaveBeenCalled()
  })

  it('publishes hooks only when enabled', () => {
    const globalObject: Record<string, unknown> = {}
    const hooks = { appVersion: '1.3.3' } as unknown as FeaturesVerificationHooks
    expect(
      installFeaturesVerification({ enabled: true, hooks, globalObject })
    ).toBe(true)
    expect(globalObject[FEATURES_VERIFY_GLOBAL]).toBe(hooks)
  })
})

describe('destination probe', () => {
  it('registers a usable folder and refuses missing, relative and UNC paths', async () => {
    const folder = await makeFolder()
    const store = new DownloadDestinationStore()
    const probe = createDestinationProbe(store)

    const accepted = probe.registerDestination(folder)
    expect(accepted.ok).toBe(true)
    expect(accepted.path).toBe(path.resolve(folder))
    expect(probe.resolveDestination(accepted.token)).toBe(path.resolve(folder))

    for (const invalid of [
      path.join(os.tmpdir(), 'missing-verify-folder'),
      'relative-folder',
      '\\\\server\\share',
      '\\\\?\\C:\\Windows'
    ]) {
      const refused = probe.registerDestination(invalid)
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('DOWNLOAD_FOLDER_INVALID')
      expect(refused.token).toBeNull()
    }
    expect(probe.resolveDestination('unknown-token-value')).toBeNull()
  })
})

describe('recording host', () => {
  it('records the exact target and never reaches the real shell', async () => {
    const inner = fakeHost()
    const recorder = createRecordingHost(inner, () => 42)

    await expect(recorder.host.openPath('C:\\chosen\\file.zip')).resolves.toBe('')
    recorder.host.showItemInFolder('C:\\chosen\\file.zip')

    expect(recorder.calls).toEqual([
      { method: 'openPath', target: 'C:\\chosen\\file.zip', at: 42 },
      { method: 'showItemInFolder', target: 'C:\\chosen\\file.zip', at: 42 }
    ])
    expect(inner.openPath).not.toHaveBeenCalled()
    expect(inner.showItemInFolder).not.toHaveBeenCalled()

    recorder.clear()
    expect(recorder.calls).toEqual([])
  })
})

describe('tray menu probe', () => {
  function ports(
    overrides: Partial<TrayMenuProbePorts> = {}
  ): TrayMenuProbePorts & { actions: TrayMenuActions & { calls: string[] } } {
    const actions = fakeActions()
    return {
      windowVisible: () => false,
      downloads: () => [],
      mediaJobs: () => [],
      speedLimitBps: () => 0,
      readClipboardText: () => 'https://example.com/file.zip',
      actions,
      ...overrides
    } as TrayMenuProbePorts & { actions: TrayMenuActions & { calls: string[] } }
  }

  it('builds the real menu and enables Pause all only with active work', () => {
    const idle = new TrayMenuProbe(ports())
    const idleMenu = idle.build(null)
    expect(idleMenu.state.statusLine).toBe('Nothing downloading')
    expect(idleMenu.state.canPauseAll).toBe(false)
    const pauseLabel = idleMenu.items[2]
    expect(pauseLabel?.label).toBe('Resume all')
    expect(pauseLabel?.enabled).toBe(false)
    expect(idleMenu.items[0]?.enabled).toBe(false)

    const busy = new TrayMenuProbe(
      ports({
        downloads: () => [
          {
            id: 'dl-1',
            filename: 'file.zip',
            status: 'active',
            filePath: null,
            speedBps: 2_000_000,
            totalBytes: 10,
            completedBytes: 1,
            createdAt: 1,
            completedAt: null
          }
        ]
      })
    )
    const busyMenu = busy.build(null)
    expect(busyMenu.state.canPauseAll).toBe(true)
    expect(busyMenu.state.statusLine).toContain('1 downloading')
    expect(busyMenu.items[2]?.label).toBe('Pause all')
    expect(busyMenu.items[2]?.enabled).toBe(true)
    expect(busyMenu.items.find((item) => item.label === 'Add from clipboard')?.enabled).toBe(false)
  })

  it('invokes the real action through the template and honours disabled items', () => {
    const actions = fakeActions()
    const probe = new TrayMenuProbe(
      ports({
        actions,
        downloads: () => [
          {
            id: 'dl-1',
            filename: 'file.zip',
            status: 'active',
            filePath: null,
            speedBps: 1,
            totalBytes: 10,
            completedBytes: 1
          }
        ]
      })
    )
    probe.build('https://example.com/file.zip')

    const pause = probe.invoke([2])
    expect(pause).toEqual({ invoked: true, label: 'Pause all', reason: null })
    expect(actions.calls).toContain('pause')

    // "Add from clipboard" is enabled with a validated URL and passes it on.
    const add = probe.invoke([7])
    expect(add.invoked).toBe(true)
    expect(actions.calls).toContain('clipboard:https://example.com/file.zip')

    expect(probe.invoke([99])).toEqual({
      invoked: false,
      label: '',
      reason: 'item-not-found'
    })
  })

  it('keeps the status item non-clickable and Recent ordered newest first', () => {
    const probe = new TrayMenuProbe(
      ports({
        downloads: () => [
          {
            id: 'old',
            filename: 'old.zip',
            status: 'complete',
            filePath: 'C:\\chosen\\old.zip',
            speedBps: 0,
            totalBytes: 1,
            completedBytes: 1,
            createdAt: 1,
            completedAt: 1
          },
          {
            id: 'new',
            filename: 'new.zip',
            status: 'complete',
            filePath: 'C:\\chosen\\new.zip',
            speedBps: 0,
            totalBytes: 1,
            completedBytes: 1,
            createdAt: 2,
            completedAt: 2
          }
        ]
      })
    )
    const menu = probe.build(null)
    expect(menu.items[0]?.clickable).toBe(false)
    const recent = menu.items.find((item) => item.label === 'Recent')
    expect(
      (recent?.submenu ?? [])
        .filter((item) => item.type !== 'separator')
        .map((item) => item.label)
    ).toEqual(['new.zip', 'old.zip', 'Show in folder'])
  })
})

describe('stability regression probes', () => {
  const SEEDED_ROWS = [
    {
      id: 'v23-mega-one',
      url: 'https://mega.nz/file/abc#key-one',
      filename: 'key-one.zip',
      normalizedUrl: 'https://mega.nz/file/abc',
      createdAt: 1000
    },
    {
      id: 'v23-mega-two',
      url: 'https://mega.nz/file/abc#key-two',
      filename: 'key-two.zip',
      normalizedUrl: 'https://mega.nz/file/abc',
      createdAt: 3000
    },
    {
      id: 'v23-normal',
      url: 'https://example.com/files/legacy.zip',
      filename: 'legacy.zip',
      normalizedUrl: 'https://example.com/files/legacy.zip',
      createdAt: 2000
    }
  ]

  function history(
    matches: Record<string, { state: string; filename: string }> = {}
  ): HistoryProbeSource {
    const source = {
      schemaVersion: 24,
      loadAll: () => [{ id: 'a' }, { id: 'b' }],
      findDuplicate: (url: string) => matches[url] ?? null
    }
    return source
  }

  it('reports schema, row count and each duplicate result in order', () => {
    const database = history({
      'https://mega.nz/file/abc#key-one': { state: 'finished', filename: 'one.zip' }
    })
    const result = probeHistoryLookups({
      urls: ['https://mega.nz/file/abc#key-one', 'https://mega.nz/file/abc#key-two'],
      database
    })

    expect(result.schemaVersion).toBe(24)
    expect(result.rows).toBe(2)
    expect(result.lookups.map((entry) => entry.matched)).toEqual([true, false])
    expect(result.lookups[0]).toMatchObject({ state: 'finished', filename: 'one.zip' })
    expect(result.lookups[1]).toMatchObject({ state: null, filename: null })
  })

  it('reports each history expectation separately and never throws on a mismatch', () => {
    const database = history({
      'https://mega.nz/file/abc#key-one': { state: 'finished', filename: 'key-one.zip' },
      'https://mega.nz/file/abc#key-two': { state: 'finished', filename: 'key-one.zip' }
    })
    const expectations = [
      { url: 'https://mega.nz/file/abc#key-one', matched: true, filename: 'key-one.zip' },
      { url: 'https://mega.nz/file/abc#key-two', matched: false }
    ]

    const first: HistoryLookupExpectation = {
      url: expectations[0]!.url,
      matched: true,
      filename: 'key-one.zip'
    }
    const exact = checkHistoryLookups(
      { urls: expectations.map((item) => item.url), database },
      [first],
      2
    )
    expect(exact).toMatchObject({ passed: true, schemaVersion: 24, rows: 2 })
    expect(exact.failures).toEqual([])

    const collapsed = checkHistoryLookups(
      { urls: expectations.map((item) => item.url), database },
      expectations,
      3
    )
    expect(collapsed.passed).toBe(false)
    expect(collapsed.failures).toHaveLength(2)
    expect(collapsed.failures[0]).toContain('expected 3 history rows')
    expect(collapsed.failures[1]).toContain('key-two')
  })

  it('refuses a non-string lookup instead of guessing', () => {
    expect(() => probeHistoryLookups({ urls: [42], database: history() })).toThrow(
      /expects URLs/
    )
  })

  it('dismisses the guide and reports both settings snapshots unchanged otherwise', () => {
    // The real app and harness drive this through the actual guide UI; this
    // pins the settings-manager contract the check relies on.
    let current = { ...defaultDesktopSettings(), welcomeGuideSeen: false, showNotifications: false }
    const result = probeWelcomeGuideSeen({
      getSettings: () => ({ ...current }),
      markWelcomeGuideSeen: () => {
        current = { ...current, welcomeGuideSeen: true }
        return { ...current }
      }
    })

    expect(result.before.welcomeGuideSeen).toBe(false)
    expect(result.after.welcomeGuideSeen).toBe(true)
    expect(result.after.showNotifications).toBe(false)
    expect(result.after).toEqual({ ...result.before, welcomeGuideSeen: true })
  })

  it('uses a seeded history file once', async () => {
    const folder = await makeFolder()
    const seed = historySeedPath(path.join(folder, 'nested'))
    await writeFile(seed, 'seeded-v23')
    const databasePath = path.join(folder, 'downloads.sqlite3')
    await writeFile(databasePath, 'live-v24')

    expect(applySeededHistory(seed, databasePath)).toBe(true)
    expect(await readFile(databasePath, 'utf8')).toBe('seeded-v23')
    expect(existsSync(seed)).toBe(false)

    // A different seed may follow a first one (restart 2 of the harness).
    const second = historySeedPath(path.join(folder, 'nested'))
    await writeFile(second, 'seeded-again')
    expect(applySeededHistory(second, databasePath)).toBe(true)
    expect(await readFile(databasePath, 'utf8')).toBe('seeded-again')

    // A missing seed leaves the live file untouched.
    expect(applySeededHistory(second, databasePath)).toBe(false)
    expect(await readFile(databasePath, 'utf8')).toBe('seeded-again')
  })

  it('writes a real v23 seed through the production migrator and adds rows', async () => {
    const folder = await makeFolder()
    const seedPath = path.join(folder, 'history', 'seed-history.sqlite3')
    let builtAt: number | null = null
    const written = writeSeedHistory({
      seedPath,
      upTo: 23,
      rows: SEEDED_ROWS,
      buildAtVersion: (filePath, upTo) => {
        builtAt = upTo
        mkdirSync(path.dirname(filePath), { recursive: true })
        // Same contract as `buildHistoryAtVersion` for the columns this test
        // reads: a v23 file with the downloads table and its normalized index.
        const db = new DatabaseSync(filePath)
        db.exec(`
          CREATE TABLE downloads (
            id TEXT PRIMARY KEY NOT NULL, gid TEXT NOT NULL, url TEXT NOT NULL,
            filename TEXT NOT NULL, dir TEXT NOT NULL, status TEXT NOT NULL,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            completed_bytes INTEGER NOT NULL DEFAULT 0,
            error_message TEXT, attempts INTEGER NOT NULL DEFAULT 1,
            max_attempts INTEGER NOT NULL DEFAULT 3, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, completed_at INTEGER,
            normalized_url TEXT
          );
          PRAGMA user_version = 23;
        `)
        db.close()
      }
    })

    expect(written).toBe(seedPath)
    expect(builtAt).toBe(23)
    const raw = new DatabaseSync(seedPath)
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 23 })
      const rows = raw
        .prepare('SELECT id, url, normalized_url, created_at FROM downloads ORDER BY created_at')
        .all()
      expect(rows).toEqual(
        SEEDED_ROWS.map((row) => ({
          id: row.id,
          url: row.url,
          normalized_url: row.normalizedUrl,
          created_at: row.createdAt
        })).sort((a, b) => a.created_at - b.created_at)
      )
    } finally {
      raw.close()
    }
  })

  it('summarizes the live history without exposing ids', () => {
    expect(
      summarizeHistoryRows([
        { createdAt: 30, url: 'https://mega.nz/file/abc#key-two' },
        { createdAt: 10, url: 'https://mega.nz/file/abc#key-one' },
        { createdAt: 20, url: 'https://example.com/files/legacy.zip' }
      ])
    ).toEqual({
      rows: 3,
      createdAt: [10, 20, 30],
      megaKeyed: [
        'https://mega.nz/file/abc#key-two',
        'https://mega.nz/file/abc#key-one'
      ]
    })
  })

  it('only applies a real seed path, never an empty value or the database itself', () => {
    const databasePath = path.resolve('C:\\profile\\downloads.sqlite3')
    expect(shouldApplySeed(undefined, databasePath)).toBe(false)
    expect(shouldApplySeed('', databasePath)).toBe(false)
    expect(shouldApplySeed('   ', databasePath)).toBe(false)
    expect(shouldApplySeed(databasePath, databasePath)).toBe(false)
    expect(shouldApplySeed('C:\\profile\\seed-history.sqlite3', databasePath)).toBe(true)
  })
})
