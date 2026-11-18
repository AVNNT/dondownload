import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreHost } from '../src/main/host'
import { DownloadDestinationStore } from '../src/main/downloads/destination'
import {
  FEATURES_VERIFY_ENV,
  FEATURES_VERIFY_GLOBAL,
  TrayMenuProbe,
  createDestinationProbe,
  createRecordingHost,
  featuresVerificationEnabled,
  installFeaturesVerification,
  type FeaturesVerificationHooks,
  type TrayMenuProbePorts
} from '../src/main/smoke/featuresVerification'
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
      appVersion: '1.2.0',
      tray: vi.fn(),
      windowState: vi.fn(),
      registerDestination: vi.fn(),
      resolveDestination: vi.fn(),
      notificationActivate: vi.fn(),
      probeLog: vi.fn(),
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
    const hooks = { appVersion: '1.2.0' } as unknown as FeaturesVerificationHooks
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
