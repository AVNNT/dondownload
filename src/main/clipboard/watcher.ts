import { detectClipboardUrl } from './filter'

export const CLIPBOARD_POLL_INTERVAL_MS = 1_500
/**
 * Slower cadence while no window exists (the app sits in the tray). Nothing is
 * on screen to react to, so twice the interval halves the wakeups while a
 * copied link is still offered within a few seconds.
 */
export const CLIPBOARD_TRAY_POLL_INTERVAL_MS = CLIPBOARD_POLL_INTERVAL_MS * 2
/** How long an app-originated copy is ignored if it appears on the clipboard. */
const SELF_COPY_IGNORE_MS = 60_000
const MAX_SELF_COPIES = 32

export interface ClipboardWatcherOptions {
  /** Electron 45 returns a Promise; tests may return a string synchronously. */
  readText: () => string | Promise<string>
  isEnabled: () => boolean
  /** Receives one validated http(s) URL; never logged by this module. */
  onUrl: (url: string) => void
  /** False while the app is hidden to the tray; polling then backs off. */
  hasWindow?: () => boolean
  intervalMs?: number
  trayIntervalMs?: number
  now?: () => number
}

/**
 * Polls the clipboard only while the user enabled "Watch clipboard for links".
 * It never starts a download; the renderer shows an explicit prompt. The last
 * observed raw text is kept so an unchanged clipboard is not offered again.
 */
export class ClipboardWatcher {
  private readonly readText: () => string | Promise<string>
  private readonly isEnabled: () => boolean
  private readonly onUrl: (url: string) => void
  private readonly hasWindow: () => boolean
  private readonly intervalMs: number
  private readonly trayIntervalMs: number
  private readonly now: () => number
  private readonly selfCopies = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastText: string | null = null
  private polling = false
  private running = false

  constructor(options: ClipboardWatcherOptions) {
    this.readText = options.readText
    this.isEnabled = options.isEnabled
    this.onUrl = options.onUrl
    this.hasWindow = options.hasWindow ?? (() => true)
    this.intervalMs = options.intervalMs ?? CLIPBOARD_POLL_INTERVAL_MS
    this.trayIntervalMs =
      options.trayIntervalMs ?? CLIPBOARD_TRAY_POLL_INTERVAL_MS
    this.now = options.now ?? Date.now
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.start()
    else this.stop()
  }

  start(): void {
    if (this.running) return
    // Watching disabled in settings means no timer at all, not an idle one:
    // a timer that fires only to bail still wakes the main process.
    if (!this.isEnabled()) return
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * One self-scheduling timeout instead of a fixed interval: the delay is
   * re-read on every tick, so the watcher backs off while the app is hidden to
   * the tray and speeds back up once a window exists, without an outside caller
   * having to restart it.
   */
  private scheduleNext(): void {
    if (!this.running || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      // The setting can be flipped without a `setEnabled` call reaching this
      // watcher (e.g. a store write elsewhere); drop the chain instead of
      // re-arming a timer that would only bail out.
      if (!this.isEnabled()) {
        this.running = false
        return
      }
      try {
        this.poll()
      } finally {
        this.scheduleNext()
      }
    }, this.hasWindow() ? this.intervalMs : this.trayIntervalMs)
    // Clipboard polling must never keep the main process alive.
    this.timer.unref?.()
  }

  /** Remember a link this app wrote so its own copy is never offered back. */
  rememberSelfCopied(text: string): void {
    const value = text.trim()
    if (value.length === 0) return
    this.selfCopies.set(value, this.now())
    while (this.selfCopies.size > MAX_SELF_COPIES) {
      const oldest = this.selfCopies.keys().next().value
      if (oldest === undefined) break
      this.selfCopies.delete(oldest)
    }
  }

  poll(): void {
    if (!this.isEnabled() || this.polling) return
    let result: string | Promise<string>
    try {
      result = this.readText()
    } catch {
      // A transient clipboard failure must not affect the app.
      return
    }
    if (typeof result === 'string') {
      this.handleText(result)
      return
    }
    this.polling = true
    void Promise.resolve(result)
      .then((text) => this.handleText(text))
      .catch(() => undefined)
      .finally(() => {
        this.polling = false
      })
  }

  private handleText(text: string): void {
    if (!this.isEnabled()) return
    const url = detectClipboardUrl(text, this.lastText, (candidate) =>
      this.isRecentSelfCopy(candidate)
    )
    this.lastText = text
    if (url !== null) {
      try {
        this.onUrl(url)
      } catch {
        // A renderer/window failure must never break polling.
      }
    }
  }

  private isRecentSelfCopy(url: string): boolean {
    const copiedAt = this.selfCopies.get(url)
    if (copiedAt === undefined) return false
    if (this.now() - copiedAt <= SELF_COPY_IGNORE_MS) return true
    this.selfCopies.delete(url)
    return false
  }
}
