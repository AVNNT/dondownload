import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_POLL_INTERVAL_MS,
  CLIPBOARD_TRAY_POLL_INTERVAL_MS,
  ClipboardWatcher
} from '../src/main/clipboard/watcher'

interface Harness {
  watcher: ClipboardWatcher
  readText: ReturnType<typeof vi.fn>
  onUrl: ReturnType<typeof vi.fn>
  state: { enabled: boolean; hasWindow: boolean }
}

function createWatcher(): Harness {
  const state = { enabled: true, hasWindow: true }
  const readText = vi.fn(() => '')
  const onUrl = vi.fn()
  const watcher = new ClipboardWatcher({
    readText,
    isEnabled: () => state.enabled,
    hasWindow: () => state.hasWindow,
    onUrl
  })
  return { watcher, readText, onUrl, state }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('clipboard watcher scheduling', () => {
  it('runs no timer at all while clipboard watching is disabled', () => {
    vi.useFakeTimers()
    const { watcher, readText, state } = createWatcher()

    state.enabled = false
    watcher.setEnabled(false)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(60_000)
    expect(readText).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('arms no timer when started while watching is already disabled', () => {
    vi.useFakeTimers()
    const state = { enabled: false, hasWindow: true }
    const readText = vi.fn(() => '')
    const watcher = new ClipboardWatcher({
      readText,
      isEnabled: () => state.enabled,
      onUrl: () => undefined
    })

    // Startup path: the persisted setting is off, so no timer may exist at all.
    watcher.start()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(readText).not.toHaveBeenCalled()

    state.enabled = true
    watcher.setEnabled(true)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(CLIPBOARD_POLL_INTERVAL_MS)
    expect(readText).toHaveBeenCalledTimes(1)

    watcher.stop()
  })

  it('drops its timer when the setting turns off without a setEnabled call', () => {
    vi.useFakeTimers()
    const { watcher, readText, state } = createWatcher()

    state.hasWindow = false
    watcher.setEnabled(true)
    expect(vi.getTimerCount()).toBe(1)

    // Flipped behind the watcher's back: the next tick must not re-arm.
    state.enabled = false
    vi.advanceTimersByTime(CLIPBOARD_TRAY_POLL_INTERVAL_MS)
    expect(readText).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBe(0)

    watcher.stop()
  })

  it('polls at the normal cadence while a window exists', () => {
    vi.useFakeTimers()
    const { watcher, readText } = createWatcher()

    watcher.setEnabled(true)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(CLIPBOARD_POLL_INTERVAL_MS - 1)
    expect(readText).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(readText).toHaveBeenCalledTimes(1)

    // A self-scheduling timer keeps exactly one pending timer at all times.
    expect(vi.getTimerCount()).toBe(1)
    watcher.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off while the app sits in the tray and speeds up again on show', () => {
    vi.useFakeTimers()
    const { watcher, readText, state } = createWatcher()

    state.hasWindow = false
    watcher.setEnabled(true)

    // The tray interval is longer than the windowed one.
    expect(CLIPBOARD_TRAY_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(
      CLIPBOARD_POLL_INTERVAL_MS * 1.5
    )
    expect(CLIPBOARD_TRAY_POLL_INTERVAL_MS).toBeLessThanOrEqual(
      CLIPBOARD_POLL_INTERVAL_MS * 2
    )

    // The windowed cadence no longer fires while hidden.
    vi.advanceTimersByTime(CLIPBOARD_POLL_INTERVAL_MS)
    expect(readText).not.toHaveBeenCalled()

    vi.advanceTimersByTime(
      CLIPBOARD_TRAY_POLL_INTERVAL_MS - CLIPBOARD_POLL_INTERVAL_MS
    )
    expect(readText).toHaveBeenCalledTimes(1)

    // The window comes back: the very next tick is fast again.
    state.hasWindow = true
    vi.advanceTimersByTime(CLIPBOARD_TRAY_POLL_INTERVAL_MS)
    expect(readText).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(CLIPBOARD_POLL_INTERVAL_MS)
    expect(readText).toHaveBeenCalledTimes(3)

    watcher.stop()
  })

  it('stops polling when the setting is turned off and resumes when it is on', () => {
    vi.useFakeTimers()
    const { watcher, readText, state } = createWatcher()

    watcher.setEnabled(true)
    vi.advanceTimersByTime(CLIPBOARD_POLL_INTERVAL_MS)
    expect(readText).toHaveBeenCalledTimes(1)

    state.enabled = false
    watcher.setEnabled(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(readText).toHaveBeenCalledTimes(1)

    state.enabled = true
    watcher.setEnabled(true)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(CLIPBOARD_POLL_INTERVAL_MS)
    expect(readText).toHaveBeenCalledTimes(2)

    watcher.stop()
  })

  it('unrefs its timer so clipboard polling never holds the process open', () => {
    const unref = vi.fn()
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((() => ({ unref })) as never)

    const watcher = new ClipboardWatcher({
      readText: () => '',
      isEnabled: () => true,
      onUrl: () => undefined
    })
    watcher.setEnabled(true)
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(unref).toHaveBeenCalledTimes(1)

    watcher.stop()
    timeoutSpy.mockRestore()
  })
})
