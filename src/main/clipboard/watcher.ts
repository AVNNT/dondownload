import { detectClipboardUrl } from './filter'

export const CLIPBOARD_POLL_INTERVAL_MS = 1_500
/** How long an app-originated copy is ignored if it appears on the clipboard. */
const SELF_COPY_IGNORE_MS = 60_000
const MAX_SELF_COPIES = 32

export interface ClipboardWatcherOptions {
  /** Electron 45 returns a Promise; tests may return a string synchronously. */
  readText: () => string | Promise<string>
  isEnabled: () => boolean
  /** Receives one validated http(s) URL; never logged by this module. */
  onUrl: (url: string) => void
  intervalMs?: number
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
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly selfCopies = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastText: string | null = null
  private polling = false

  constructor(options: ClipboardWatcherOptions) {
    this.readText = options.readText
    this.isEnabled = options.isEnabled
    this.onUrl = options.onUrl
    this.intervalMs = options.intervalMs ?? CLIPBOARD_POLL_INTERVAL_MS
    this.now = options.now ?? Date.now
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.start()
    else this.stop()
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.poll(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
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
