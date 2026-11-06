/**
 * Pure completion-notification policy.
 *
 * Kept free of Electron imports so the decision can be unit-tested without a
 * desktop session. Only a transition into `complete` or `error` is announced;
 * `cancelled` (and any user-cancelled job) is intentionally silent.
 */
export type NotificationJobKind = 'download' | 'media'

export interface NotificationDecisionInput {
  enabled: boolean
  supported: boolean
  kind: NotificationJobKind
  previousStatus: string
  nextStatus: string
  /** Safe display title/filename; never a URL or path. */
  title: string
  cancelledByUser?: boolean
}

export interface NotificationDecision {
  notify: boolean
  title: string
  body: string
}

const SILENT: NotificationDecision = { notify: false, title: '', body: '' }

export function decideCompletionNotification(
  input: NotificationDecisionInput
): NotificationDecision {
  if (!input.enabled || !input.supported) return SILENT
  if (input.cancelledByUser === true) return SILENT
  if (input.previousStatus === input.nextStatus) return SILENT

  const subject = input.kind === 'media' ? 'Media download' : 'Download'
  const title = input.title.trim()
  if (input.nextStatus === 'complete') {
    return {
      notify: true,
      title: `${subject} complete`,
      body: title.length > 0 ? title : `${subject} finished.`
    }
  }
  if (input.nextStatus === 'error') {
    return {
      notify: true,
      title: `${subject} failed`,
      body: title.length > 0 ? title : `${subject} could not be completed.`
    }
  }
  return SILENT
}
