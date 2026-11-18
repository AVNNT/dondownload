import type { AppSnapshot } from '@shared/types'
import type { MediaSnapshot } from '@shared/media'
import { createNoopHost, type CoreHost } from '../host'
import {
  decideCompletionNotification,
  type NotificationJobKind
} from './decide'

export interface CompletionNotificationOptions {
  isEnabled: () => boolean
  /** Injectable for tests; production asks the host. */
  isSupported?: () => boolean
  /** Show/select the finished row when the notification is clicked. */
  onActivate?: (kind: NotificationJobKind, id: string) => void
  /** Desktop shell port for notifications; Electron wires it in main. */
  host?: CoreHost
}

/** A status that can never move again without a new explicit user action. */
const TERMINAL_STATUSES = new Set([
  'complete',
  'error',
  'cancelled',
  'interrupted'
])

/**
 * Turns terminal job transitions into Windows notifications.
 *
 * The first observation of a job is only a baseline, so loading persisted
 * history at startup never floods the user. Cancelled jobs (including the
 * shutdown transition to `interrupted`) are silent because only `complete` and
 * `error` produce a decision.
 *
 * Only non-terminal rows are remembered: once a job settles there is nothing
 * left to announce, so the map never grows with download history. A publish
 * visits every row, but the map work and the prune are bounded by the number
 * of active jobs instead of the whole list.
 */
export class CompletionNotificationService {
  private readonly isEnabled: () => boolean
  private readonly host: CoreHost
  private readonly isSupported: () => boolean
  private readonly onActivate:
    | ((kind: NotificationJobKind, id: string) => void)
    | null
  /** Non-terminal statuses only, keyed by the opaque job id. */
  private readonly downloadStatuses = new Map<string, string>()
  private readonly mediaStatuses = new Map<string, string>()

  constructor(options: CompletionNotificationOptions) {
    this.isEnabled = options.isEnabled
    this.host = options.host ?? createNoopHost()
    this.isSupported =
      options.isSupported ?? (() => this.host.isNotificationSupported())
    this.onActivate = options.onActivate ?? null
  }

  observeDownloads(snapshot: AppSnapshot): void {
    this.observeAll(
      'download',
      this.downloadStatuses,
      snapshot.downloads,
      (item) => item.filename
    )
  }

  observeMedia(snapshot: MediaSnapshot): void {
    this.observeAll(
      'media',
      this.mediaStatuses,
      snapshot.jobs,
      (job) => job.title
    )
  }

  private observeAll<T extends { id: string; status: string }>(
    kind: NotificationJobKind,
    statuses: Map<string, string>,
    rows: readonly T[],
    titleOf: (row: T) => string
  ): void {
    let seen: Set<string> | null = null

    for (const row of rows) {
      if (TERMINAL_STATUSES.has(row.status)) {
        const previousStatus = statuses.get(row.id)
        if (previousStatus === undefined) continue
        statuses.delete(row.id)
        this.announce(kind, row.id, previousStatus, row.status, titleOf(row))
        continue
      }

      if (seen === null) seen = new Set()
      seen.add(row.id)
      const previousStatus = statuses.get(row.id)
      if (previousStatus === row.status) continue
      statuses.set(row.id, row.status)
      if (previousStatus === undefined) continue
      this.announce(kind, row.id, previousStatus, row.status, titleOf(row))
    }

    // Removed non-terminal rows are the only keys that can go stale.
    if (statuses.size === 0) return
    if (seen === null) {
      statuses.clear()
      return
    }
    if (statuses.size === seen.size) return
    for (const id of statuses.keys()) {
      if (!seen.has(id)) statuses.delete(id)
    }
  }

  private announce(
    kind: NotificationJobKind,
    id: string,
    previousStatus: string,
    nextStatus: string,
    title: string
  ): void {
    const decision = decideCompletionNotification({
      enabled: this.isEnabled(),
      supported: this.isSupported(),
      kind,
      previousStatus,
      nextStatus,
      title
    })
    if (!decision.notify) return

    try {
      const notification = this.host.createNotification({
        title: decision.title,
        body: decision.body
      })
      notification.on('click', () => {
        try {
          this.onActivate?.(kind, id)
        } catch {
          // A missing window must not break notification handling.
        }
      })
      notification.show()
    } catch {
      // Notifications are a non-critical convenience.
    }
  }
}
