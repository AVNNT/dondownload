import { describe, expect, it } from 'vitest'
import {
  decideBeforeQuit,
  decideWindowClose,
  decideWindowShow,
  isCleanupRunning,
  shouldQuitWhenAllWindowsClosed,
  trayMenuLabel
} from '../src/main/lifecycle'

describe('window close policy', () => {
  it.each([
    [false, true, 'hide-to-tray'],
    [false, false, 'close'],
    [true, true, 'close'],
    [true, false, 'close']
  ] as const)(
    'isQuitting=%s trayAvailable=%s -> %s',
    (isQuitting, trayAvailable, expected) => {
      expect(decideWindowClose({ isQuitting, trayAvailable })).toBe(expected)
    }
  )

  it('never hides a window during an explicit quit', () => {
    expect(decideWindowClose({ isQuitting: true, trayAvailable: true })).toBe(
      'close'
    )
  })

  it('falls back to closing when no tray is available', () => {
    expect(
      decideWindowClose({ isQuitting: false, trayAvailable: false })
    ).toBe('close')
  })
})

describe('window show policy', () => {
  it('creates a window when none exists or it was destroyed', () => {
    expect(decideWindowShow({ windowExists: false, windowDestroyed: false })).toBe('create')
    expect(decideWindowShow({ windowExists: true, windowDestroyed: true })).toBe('create')
  })

  it('focuses a live window', () => {
    expect(decideWindowShow({ windowExists: true, windowDestroyed: false })).toBe('focus-existing')
  })
})

describe('tray menu labels', () => {
  it('offers Hide while the window is visible and Show while hidden', () => {
    expect(trayMenuLabel(true)).toBe('Hide DonDownload')
    expect(trayMenuLabel(false)).toBe('Show DonDownload')
  })
})

describe('last window closed policy', () => {
  it.each([
    ['win32', false, true, false],
    ['win32', false, false, true],
    ['linux', false, true, false],
    ['linux', false, false, true],
    ['darwin', false, true, false],
    ['darwin', false, false, false],
    ['win32', true, true, true],
    ['darwin', true, false, true]
  ] as const)(
    'platform=%s quitting=%s trayAvailable=%s -> quit=%s',
    (platform, isQuitting, trayAvailable, expected) => {
      expect(
        shouldQuitWhenAllWindowsClosed({
          platform,
          isQuitting,
          trayAvailable,
          cleanupRunning: false
        })
      ).toBe(expected)
    }
  )

  it('keeps aria2 alive when a tray can restore the app', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'win32',
        isQuitting: false,
        trayAvailable: true,
        cleanupRunning: false
      })
    ).toBe(false)
  })

  it('never starts a parallel quit while cleanup is still running', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'win32',
        isQuitting: true,
        trayAvailable: true,
        cleanupRunning: true
      })
    ).toBe(false)
  })
})

describe('quit reentrancy policy', () => {
  it('starts cleanup once services are ready', () => {
    expect(
      decideBeforeQuit({
        cleanup: { started: false, finished: false },
        servicesReady: true
      })
    ).toBe('start-cleanup')
  })

  it('allows quitting before services exist', () => {
    expect(
      decideBeforeQuit({
        cleanup: { started: false, finished: false },
        servicesReady: false
      })
    ).toBe('allow')
  })

  it('blocks a second quit while cleanup is running', () => {
    expect(
      decideBeforeQuit({
        cleanup: { started: true, finished: false },
        servicesReady: true
      })
    ).toBe('block')
  })

  it('allows only the final quit after cleanup has finished', () => {
    expect(
      decideBeforeQuit({
        cleanup: { started: true, finished: true },
        servicesReady: true
      })
    ).toBe('allow')
  })

  it('treats cleanup as running only between start and finish', () => {
    expect(isCleanupRunning({ started: false, finished: false })).toBe(false)
    expect(isCleanupRunning({ started: true, finished: false })).toBe(true)
    expect(isCleanupRunning({ started: true, finished: true })).toBe(false)
  })

  it('regression: a window-close quit during cleanup is cancelled, not allowed to bypass cleanup', () => {
    const cleanup = { started: true, finished: false }

    // window-all-closed must not call app.quit again, and if some other quit
    // request still arrives, before-quit must preventDefault.
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'win32',
        isQuitting: true,
        trayAvailable: true,
        cleanupRunning: isCleanupRunning(cleanup)
      })
    ).toBe(false)
    expect(decideBeforeQuit({ cleanup, servicesReady: true })).toBe('block')

    // Only the internal quit after cleanup finishes is allowed through.
    const finished = { started: true, finished: true }
    expect(decideBeforeQuit({ cleanup: finished, servicesReady: true })).toBe(
      'allow'
    )
  })
})
