import { Notification } from 'electron'
import type { AppSnapshot } from '@shared/types'
import type { MediaSnapshot } from '@shared/media'
import {
  decideCompletionNotification,
  type NotificationJobKind
} from './decide'

export interface CompletionNotificationOptions {
  isEnabled: () => boolean
  /** Injectable for tests; production uses `Notification.isSupported()`. */
  isSupported?: () => boolean
  /** Show/select the finished row when the notification is clicked. */
  onActivate?: (kind: NotificationJobKind, id: string) => void
}

/**
 * Turns terminal job transitions into Windows notifications.
 *
 * The first observation of a job is only a baseline, so loading persisted
 * history at startup never floods the user. Cancelled jobs (including the
 * shutdown transition to `interrupted`) are silent because only `complete` and
 * `error` produce a decision.
 */
export class CompletionNotificationService {
  private readonly isEnabled: () => boolean
  private readonly isSupported: () => boolean
  private readonly onActivate:
    | ((kind: NotificationJobKind, id: string) => void)
    | null
  private readonly statuses = new Map<string, string>()

  constructor(options: CompletionNotificationOptions) {
    this.isEnabled = options.isEnabled
    this.isSupported = options.isSupported ?? (() => Notification.isSupported())
    this.onActivate = options.onActivate ?? null
  }

  observeDownloads(snapshot: AppSnapshot): void {
    const seen = new Set<string>()
    for (const item of snapshot.downloads) {
      const key = `download:${item.id}`
      seen.add(key)
      this.observe('download', item.id, item.status, item.filename)
    }
    this.prune(seen, 'download:')
  }

  observeMedia(snapshot: MediaSnapshot): void {
    const seen = new Set<string>()
    for (const job of snapshot.jobs) {
      const key = `media:${job.id}`
      seen.add(key)
      this.observe('media', job.id, job.status, job.title)
    }
    this.prune(seen, 'media:')
  }

  private observe(
    kind: NotificationJobKind,
    id: string,
    status: string,
    title: string
  ): void {
    const key = `${kind}:${id}`
    const previousStatus = this.statuses.get(key)
    this.statuses.set(key, status)
    if (previousStatus === undefined) return

    const decision = decideCompletionNotification({
      enabled: this.isEnabled(),
      supported: this.isSupported(),
      kind,
      previousStatus,
      nextStatus: status,
      title
    })
    if (!decision.notify) return

    try {
      const notification = new Notification({
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

  private prune(seen: Set<string>, prefix: string): void {
    for (const key of this.statuses.keys()) {
      if (!key.startsWith(prefix)) continue
      if (!seen.has(key)) this.statuses.delete(key)
    }
  }
}
