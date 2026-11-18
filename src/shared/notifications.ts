/**
 * Shared notification vocabulary.
 *
 * Main captures the opaque job id and kind in the notification closure; the
 * renderer only ever receives those values back from main. Toast XML arguments
 * are never forwarded, so a forged activation argument cannot name a path.
 */

export type NotificationJobKind = 'download' | 'media'

/** What a toast activation asked for. `activate` is a body click. */
export type NotificationActivation = 'activate' | 'open' | 'show'

export interface NotificationActionRequest {
  kind: NotificationJobKind
  /** Opaque download or media job id captured from the completion event. */
  id: string
  action: 'open' | 'show'
}
