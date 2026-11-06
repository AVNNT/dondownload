import type { Batch } from '@shared/batches'
import type { SniffedMediaInput } from '@shared/sniffedMedia'
import type { ScanSessionManager } from './session'

/**
 * Browser hand-off auto-match.
 *
 * The extension already sends the page URL with its detected media. If the
 * user previously opened a browser-only card and chose a script set, main
 * remembers that pairing for ~30 minutes. A matching normalized page URL
 * consumes it once and creates one scanner batch containing the detected video
 * and the scripts. With no match this service returns false and the existing
 * hand-off path runs untouched.
 */

export interface BrowserMatchBatchesPort {
  createBrowserMatchBatch(input: {
    title: string
    video: SniffedMediaInput
    scripts: readonly {
      url: string
      title: string
      filename: string
      requestHeaders?: { cookie: string }
      scanItemId: string
    }[]
    pairing: {
      setId: string
      scriptItemIds: string[]
      primaryVariant: string | null
      rename: boolean
    }
  }): Promise<Batch>
}

export interface BrowserMatchServiceOptions {
  sessions: ScanSessionManager
  batches: BrowserMatchBatchesPort
}

export class BrowserMatchService {
  private readonly sessions: ScanSessionManager
  private readonly batches: BrowserMatchBatchesPort

  constructor(options: BrowserMatchServiceOptions) {
    this.sessions = options.sessions
    this.batches = options.batches
  }

  /** Returns true when a pending pairing was consumed and queued. */
  async handleSniffed(input: SniffedMediaInput): Promise<boolean> {
    const pending = this.sessions.consumeBrowserMatch(input.pageUrl)
    if (pending === null) return false
    await this.batches.createBrowserMatchBatch({
      title: `Scan: ${pending.videoTitle}`,
      video: input,
      scripts: pending.scripts.map((script) => ({
        url: script.url,
        title: script.filename,
        filename: script.filename,
        ...(script.cookie === undefined
          ? {}
          : { requestHeaders: { cookie: script.cookie } }),
        scanItemId: script.itemId
      })),
      pairing: {
        setId: pending.setId,
        scriptItemIds: pending.scriptItemIds,
        primaryVariant: pending.primaryVariant,
        rename: pending.rename
      }
    })
    return true
  }
}
