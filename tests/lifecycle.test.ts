import { describe, expect, it } from 'vitest'
import {
  decideWindowClose,
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
        shouldQuitWhenAllWindowsClosed({ platform, isQuitting, trayAvailable })
      ).toBe(expected)
    }
  )

  it('keeps aria2 alive when a tray can restore the app', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'win32',
        isQuitting: false,
        trayAvailable: true
      })
    ).toBe(false)
  })
})
