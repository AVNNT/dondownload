import { describe, expect, it, vi } from 'vitest'
import * as logger from '../src/main/logging'
import {
  createIdleStubController,
  type IdleStubControllerOptions
} from '../src/main/idleStub/controller'
import {
  DEFAULT_IDLE_STUB_GRACE_MS,
  idleStubEnvPolicy,
  resolveIdleStubGraceMs
} from '../src/main/idleStub/env'
import {
  IDLE_STUB_EXIT_ARGS,
  decideIdleStubHandOff,
  dismissLeftoverStub,
  idleStubExecutablePath,
  idleStubIconPath,
  idleStubShowArgs,
  spawnIdleStub
} from '../src/main/idleStub/stub'
import {
  DEFAULT_EXIT_TO_TRAY_STUB_WHEN_IDLE,
  defaultDesktopSettings,
  parseDesktopSettings
} from '../src/shared/desktopSettings'

const GRACE_MS = 60_000

/** A controllable clock: no real timers run inside the controller. */
function createHarness(overrides: Partial<IdleStubControllerOptions> = {}) {
  let windowOpen = false
  let windowVisible = false
  let busy = false
  let enabled = true
  const exitToStub = vi.fn()

  const timers = new Map<number, { at: number; callback: () => void }>()
  let nextId = 1
  let now = 0

  const setTimer = (callback: () => void, delayMs: number): unknown => {
    const id = nextId
    nextId += 1
    timers.set(id, { at: now + delayMs, callback })
    return id
  }
  const clearTimer = (handle: unknown): void => {
    timers.delete(handle as number)
  }
  const advance = (ms: number): void => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.callback()
      }
    }
  }

  const controller = createIdleStubController({
    isWindowOpen: () => windowOpen,
    isWindowVisible: () => windowVisible,
    isBusy: () => busy,
    isEnabled: () => enabled,
    graceMs: GRACE_MS,
    exitToStub,
    setTimer,
    clearTimer,
    ...overrides
  })

  return {
    controller,
    exitToStub,
    advance,
    pendingTimers: () => timers.size,
    setWindowOpen: (value: boolean) => {
      windowOpen = value
    },
    setWindowVisible: (value: boolean) => {
      windowVisible = value
    },
    setBusy: (value: boolean) => {
      busy = value
    },
    setEnabled: (value: boolean) => {
      enabled = value
    }
  }
}

describe('idle tray stub controller', () => {
  it('never hands off while the engine has work', () => {
    const harness = createHarness()
    harness.setBusy(true)
    harness.controller.evaluate()
    expect(harness.controller.isArmed()).toBe(false)
    expect(harness.pendingTimers()).toBe(0)

    harness.advance(GRACE_MS * 10)
    expect(harness.exitToStub).not.toHaveBeenCalled()
  })

  it('hands off exactly once after the grace period when idle in the tray', () => {
    const harness = createHarness()
    harness.controller.evaluate()
    expect(harness.controller.isArmed()).toBe(true)

    harness.advance(GRACE_MS - 1)
    expect(harness.exitToStub).not.toHaveBeenCalled()

    harness.advance(1)
    expect(harness.exitToStub).toHaveBeenCalledTimes(1)
    expect(harness.controller.isArmed()).toBe(false)

    // Later evaluations (publishes, tray refreshes) never fire a second time.
    harness.controller.evaluate()
    harness.advance(GRACE_MS * 2)
    expect(harness.exitToStub).toHaveBeenCalledTimes(1)
  })

  it('cancels the grace period when the window is shown', () => {
    const harness = createHarness()
    harness.controller.evaluate()
    harness.advance(GRACE_MS / 2)

    // A fresh window is visible immediately; that alone must cancel.
    harness.setWindowVisible(true)
    harness.controller.evaluate()

    expect(harness.controller.isArmed()).toBe(false)
    harness.advance(GRACE_MS * 2)
    expect(harness.exitToStub).not.toHaveBeenCalled()
  })

  it('keeps counting while a window exists, so a hidden but live window never hands off', () => {
    const harness = createHarness()
    harness.setWindowOpen(true)
    harness.controller.evaluate()
    harness.advance(GRACE_MS * 2)
    expect(harness.exitToStub).not.toHaveBeenCalled()
  })

  it('cancels the grace period when activity starts during it', () => {
    const harness = createHarness()
    harness.controller.evaluate()
    harness.advance(GRACE_MS / 2)

    harness.setBusy(true)
    harness.controller.evaluate()
    expect(harness.controller.isArmed()).toBe(false)

    harness.advance(GRACE_MS * 2)
    expect(harness.exitToStub).not.toHaveBeenCalled()

    // Activity ended: a full fresh grace period is required again.
    harness.setBusy(false)
    harness.controller.evaluate()
    expect(harness.controller.isArmed()).toBe(true)
    harness.advance(GRACE_MS - 1)
    expect(harness.exitToStub).not.toHaveBeenCalled()
    harness.advance(1)
    expect(harness.exitToStub).toHaveBeenCalledTimes(1)
  })

  it('re-checks the state when the timer fires', () => {
    const harness = createHarness()
    harness.controller.evaluate()
    harness.advance(GRACE_MS / 2)
    // Activity starts, but no publish reaches the controller before the timer.
    harness.setBusy(true)
    harness.advance(GRACE_MS)

    expect(harness.exitToStub).not.toHaveBeenCalled()
    expect(harness.controller.isArmed()).toBe(false)
  })

  it('never hands off while the setting disables it', () => {
    const harness = createHarness()
    harness.setEnabled(false)
    harness.controller.evaluate()
    expect(harness.controller.isArmed()).toBe(false)

    harness.advance(GRACE_MS * 5)
    expect(harness.exitToStub).not.toHaveBeenCalled()

    // Turning the setting off mid-grace also cancels the pending hand-off.
    harness.setEnabled(true)
    harness.controller.evaluate()
    harness.setEnabled(false)
    harness.controller.evaluate()
    harness.advance(GRACE_MS * 5)
    expect(harness.exitToStub).not.toHaveBeenCalled()
  })

  it('stops for good once disposed by a real quit', () => {
    const harness = createHarness()
    harness.controller.evaluate()
    harness.controller.dispose()
    expect(harness.controller.isArmed()).toBe(false)
    expect(harness.pendingTimers()).toBe(0)

    harness.controller.evaluate()
    harness.advance(GRACE_MS * 2)
    expect(harness.exitToStub).not.toHaveBeenCalled()
  })

  it('keeps the app running when the hand-off itself fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logged = vi.spyOn(logger, 'logError').mockImplementation(() => undefined)
    try {
      const harness = createHarness({
        exitToStub: () => {
          throw new Error('spawn failed')
        }
      })
      harness.controller.evaluate()
      expect(() => harness.advance(GRACE_MS)).not.toThrow()
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]?.[0])).toContain(
        'Tray stub could not be started'
      )

      // A later idle period may try again rather than giving up for good.
      harness.controller.evaluate()
      harness.advance(GRACE_MS)
      expect(logged).toHaveBeenCalledTimes(2)
    } finally {
      logged.mockRestore()
      error.mockRestore()
    }
  })
})

describe('idle tray stub environment policy', () => {
  it('uses one minute by default and honours a testing override', () => {
    expect(DEFAULT_IDLE_STUB_GRACE_MS).toBe(60_000)
    expect(resolveIdleStubGraceMs(undefined)).toBe(60_000)
    expect(resolveIdleStubGraceMs('2500')).toBe(2_500)
    expect(resolveIdleStubGraceMs(' 1500 ')).toBe(1_500)
    for (const invalid of ['', '   ', '0', '-5', 'nan', 'abc']) {
      expect(resolveIdleStubGraceMs(invalid)).toBe(DEFAULT_IDLE_STUB_GRACE_MS)
    }
  })

  it('treats 0 as off, 1 as opt-in for development, anything else as default', () => {
    expect(idleStubEnvPolicy('0')).toEqual({ enabled: false, forceInDev: false })
    expect(idleStubEnvPolicy('1')).toEqual({ enabled: true, forceInDev: true })
    expect(idleStubEnvPolicy(undefined)).toEqual({
      enabled: true,
      forceInDev: false
    })
    expect(idleStubEnvPolicy('yes')).toEqual({ enabled: true, forceInDev: false })
  })
})

describe('idle tray stub process wiring', () => {
  const base = {
    isPackaged: true,
    isSmoke: false,
    isMemoryBench: false,
    execPath: 'C:\\Apps\\DonDownload.exe',
    resourcesPath: 'C:\\Apps\\resources',
    appPath: 'C:\\Apps\\resources\\app.asar',
    env: undefined,
    hasRecentHandOff: false,
    exists: (filePath: string) =>
      filePath.endsWith('dondownload-tray.exe') || filePath.endsWith('tray.ico')
  } as const

  it('resolves the packaged stub and tray icon beside the app bundle', () => {
    expect(idleStubExecutablePath('C:\\Apps\\resources')).toBe(
      'C:\\Apps\\resources\\native\\dondownload-tray.exe'
    )
    expect(idleStubIconPath('C:\\Apps\\resources\\app.asar')).toBe(
      'C:\\Apps\\resources\\app.asar\\out\\main\\assets\\tray.ico'
    )
  })

  it('hands off only from a packaged, installed, idle run', () => {
    const decision = decideIdleStubHandOff(base)
    expect(decision).toEqual({
      action: 'hand-off',
      executable: 'C:\\Apps\\resources\\native\\dondownload-tray.exe',
      icon: 'C:\\Apps\\resources\\app.asar\\out\\main\\assets\\tray.ico'
    })
  })

  it('refuses in development, smoke, benchmark, disabled-env and busy states', () => {
    for (const patch of [
      { isPackaged: false },
      { isSmoke: true },
      { isMemoryBench: true },
      { env: '0' },
      { hasRecentHandOff: true },
      { exists: () => false }
    ]) {
      expect(decideIdleStubHandOff({ ...base, ...patch }).action).toBe('refuse')
    }
  })

  it('never hands off for a smoke run, including the host --hidden wake path', () => {
    // The native host starts the app with --hidden and a smoke session uses the
    // same launch paths; smoke must always keep the real app and its tray.
    const decision = decideIdleStubHandOff({
      ...base,
      isSmoke: true,
      env: '1'
    })
    expect(decision.action).toBe('refuse')
    expect(decision.action === 'refuse' && decision.reason).toBe('smoke session')
  })

  it('omits the icon argument when the packaged icon is missing', () => {
    const decision = decideIdleStubHandOff({
      ...base,
      exists: (filePath) => filePath.endsWith('dondownload-tray.exe')
    })
    expect(decision.action === 'hand-off' && decision.icon).toBeNull()
    expect(idleStubShowArgs('C:\\Apps\\DonDownload.exe', null)).toEqual([
      '--app',
      'C:\\Apps\\DonDownload.exe'
    ])
    expect(idleStubShowArgs('C:\\Apps\\DonDownload.exe', 'C:\\tray.ico')).toEqual(
      ['--app', 'C:\\Apps\\DonDownload.exe', '--icon', 'C:\\tray.ico']
    )
  })

  it('spawns detached with no inherited handles and ignores failures', () => {
    const spawned: { file: string; args: readonly string[]; options: unknown }[] =
      []
    const unref = vi.fn()
    const on = vi.fn()
    const spawn = ((file: string, args: readonly string[], options: unknown) => {
      spawned.push({ file, args, options })
      return { unref, on }
    }) as never

    spawnIdleStub('C:\\stub.exe', ['--exit'], spawn)
    expect(spawned).toEqual([
      {
        file: 'C:\\stub.exe',
        args: ['--exit'],
        options: expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: false
        })
      }
    ])
    expect(unref).toHaveBeenCalledTimes(1)
    // An async spawn error (missing/broken exe) is swallowed.
    expect(on).toHaveBeenCalledWith('error', expect.any(Function))
    const onError = on.mock.calls[0]?.[1] as (() => void) | undefined
    expect(() => onError?.()).not.toThrow()
  })

  it('survives a spawn that throws synchronously', () => {
    const spawn = (() => {
      throw new Error('ENOENT')
    }) as never
    expect(() => spawnIdleStub('C:\\stub.exe', ['--exit'], spawn)).not.toThrow()
  })

  it('dismisses a leftover stub only from a packaged, installed build', () => {
    const spawn = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })) as never
    const installed = {
      isPackaged: true,
      resourcesPath: 'C:\\Apps\\resources',
      env: undefined,
      exists: () => true
    }
    expect(dismissLeftoverStub(installed, spawn)).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Apps\\resources\\native\\dondownload-tray.exe',
      [...IDLE_STUB_EXIT_ARGS],
      expect.anything()
    )

    const otherSpawn = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })) as never
    expect(dismissLeftoverStub({ ...installed, isPackaged: false }, otherSpawn)).toBe(
      false
    )
    expect(dismissLeftoverStub({ ...installed, env: '0' }, otherSpawn)).toBe(false)
    expect(dismissLeftoverStub({ ...installed, exists: () => false }, otherSpawn)).toBe(
      false
    )
    expect(otherSpawn).not.toHaveBeenCalled()
  })
})

describe('exitToTrayStubWhenIdle desktop setting', () => {
  it('defaults on and is part of the validated payload', () => {
    expect(DEFAULT_EXIT_TO_TRAY_STUB_WHEN_IDLE).toBe(true)
    const settings = defaultDesktopSettings()
    expect(settings.exitToTrayStubWhenIdle).toBe(true)
    expect(parseDesktopSettings(settings)).toEqual(settings)

    const off = { ...settings, exitToTrayStubWhenIdle: false }
    expect(parseDesktopSettings(off).exitToTrayStubWhenIdle).toBe(false)

    expect(() =>
      parseDesktopSettings({ ...settings, exitToTrayStubWhenIdle: 'yes' })
    ).toThrow(/invalid flag/)

    // Older payloads and hand-built objects without the field are rejected
    // loudly rather than silently defaulting, like every other desktop key.
    const { exitToTrayStubWhenIdle: _omitted, ...rest } = settings
    void _omitted
    expect(() => parseDesktopSettings(rest)).toThrow(/missing required fields/)

    expect(() =>
      parseDesktopSettings({ ...settings, exitToTrayStubWhenIdleWhenIdle: true })
    ).toThrow(/unsupported fields/)
  })
})
