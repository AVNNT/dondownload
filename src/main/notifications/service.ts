import type { AppSnapshot } from '@shared/types'
import type { MediaSnapshot } from '@shared/media'
import type { NotificationActivation } from '@shared/notifications'
import { createNoopHost, type CoreHost } from '../host'
import {
  decideCompletionNotification,
  type NotificationJobKind
} from './decide'
import {
  TOAST_ACTION_OPEN,
  TOAST_ACTION_SHOW,
  buildCompletionToastXml,
  notificationTag
} from './toast'

export interface CompletionNotificationOptions {
  isEnabled: () => boolean
  /** Injectable for tests; production asks the host. */
  isSupported?: () => boolean
  /** Show/select the finished row when the notification is activated. */
  onActivate?: (
    kind: NotificationJobKind,
    id: string,
    action: NotificationActivation
  ) => void
  /** Desktop shell port for notifications; Electron wires it in main. */
  host?: CoreHost
  /** Injectable for tests; defaults to the running platform. */
  platform?: NodeJS.Platform
}

/** Unique, alphanumeric Windows toast tags for this process. */
let notificationSequence = 0

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
  private readonly platform: NodeJS.Platform
  private readonly onActivate:
    | ((
        kind: NotificationJobKind,
        id: string,
        action: NotificationActivation
      ) => void)
    | null
  /** Non-terminal statuses only, keyed by the opaque job id. */
  private readonly downloadStatuses = new Map<string, string>()
  private readonly mediaStatuses = new Map<string, string>()

  constructor(options: CompletionNotificationOptions) {
    this.isEnabled = options.isEnabled
    this.host = options.host ?? createNoopHost()
    this.isSupported =
      options.isSupported ?? (() => this.host.isNotificationSupported())
    this.platform = options.platform ?? process.platform
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

  /**
   * "Already downloaded" notice for a browser hand-off the desktop answered
   * with existing history instead of a fresh transfer. It reuses the same
   * clickable toast XML as a completion, but never affects the completion
   * baseline map. Body text is the display file name only, never a path.
   */
  notifyDuplicate(input: {
    id: string
    filename: string
  }): void {
    if (!this.isEnabled() || !this.isSupported()) return
    try {
      const notificationId =
        this.platform === 'win32'
          ? notificationTag(
              (notificationSequence += 1),
              Date.now().toString(36)
            )
          : null
      const toastXml =
        notificationId === null
          ? undefined
          : buildCompletionToastXml({
              title: 'Already downloaded',
              body: input.filename,
              notificationId
            })
      const notification = this.host.createNotification({
        title: 'Already downloaded',
        body: input.filename,
        ...(toastXml === undefined ? {} : { toastXml }),
        ...(notificationId === null ? {} : { id: notificationId })
      })
      notification.on('click', () => {
        this.activate('download', input.id, 'activate')
      })
      if (toastXml !== undefined) {
        notification.onAction((actionIndex) => {
          const action =
            actionIndex === TOAST_ACTION_OPEN
              ? 'open'
              : actionIndex === TOAST_ACTION_SHOW
                ? 'show'
                : 'activate'
          this.activate('download', input.id, action)
        })
      }
      notification.show()
    } catch {
      // The browser card already reports the accepted hand-off.
    }
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
      // Windows completion toasts get "Open" / "Show in folder" buttons. The
      // XML carries only the transient notification tag; the opaque job id
      // stays in this closure and is never parsed back from toast arguments.
      const notificationId =
        this.platform === 'win32' && nextStatus === 'complete'
          ? notificationTag(
              (notificationSequence += 1),
              Date.now().toString(36)
            )
          : null
      const toastXml =
        notificationId === null
          ? undefined
          : buildCompletionToastXml({
              title: decision.title,
              body: decision.body,
              notificationId
            })

      const notification = this.host.createNotification({
        title: decision.title,
        body: decision.body,
        ...(toastXml === undefined ? {} : { toastXml }),
        ...(notificationId === null ? {} : { id: notificationId })
      })
      notification.on('click', () => {
        this.activate(kind, id, 'activate')
      })
      if (toastXml !== undefined) {
        notification.onAction((actionIndex) => {
          // Only the two indices this XML defines are acted on. Anything else
          // just reveals the row, so an unexpected activation never opens a
          // file on its own.
          const action =
            actionIndex === TOAST_ACTION_OPEN
              ? 'open'
              : actionIndex === TOAST_ACTION_SHOW
                ? 'show'
                : 'activate'
          this.activate(kind, id, action)
        })
      }
      notification.show()
    } catch {
      // Notifications are a non-critical convenience.
    }
  }

  private activate(
    kind: NotificationJobKind,
    id: string,
    action: NotificationActivation
  ): void {
    try {
      this.onActivate?.(kind, id, action)
    } catch {
      // A missing window must not break notification handling.
    }
  }
}
