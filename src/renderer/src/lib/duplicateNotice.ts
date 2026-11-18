import type { DuplicateWarning } from '@shared/duplicates'

/**
 * Presentation model for the inline duplicate notice. Kept pure so the copy
 * and the safe-action defaults can be tested without a DOM.
 */
export type DuplicateNoticeAction = 'open' | 'show' | 'again' | 'reveal'

export interface DuplicateNoticeModel {
  title: string
  detail: string | null
  actions: readonly DuplicateNoticeAction[]
  /** Finished duplicate with a file that is still on disk. */
  canOpen: boolean
}

/** Stable, human date for "Already downloaded on …". */
export function formatDuplicateDate(
  epochMs: number,
  locale?: string
): string {
  const date = new Date(epochMs)
  if (!Number.isFinite(date.getTime())) return 'an earlier date'
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * A finished duplicate offers Open / Show in folder / Download again; a
 * missing file keeps only the safe Download again action. An active duplicate
 * offers only "Show it", so the default focus never starts a second transfer.
 */
export function duplicateNotice(
  warning: DuplicateWarning,
  locale?: string
): DuplicateNoticeModel {
  if (warning.state === 'active') {
    return {
      title: 'Already in your list',
      detail: warning.filename,
      actions: ['reveal'],
      canOpen: false
    }
  }

  return {
    title: `Already downloaded on ${formatDuplicateDate(warning.date, locale)} · ${warning.filename}`,
    detail: warning.fileExists
      ? null
      : 'Its file is no longer at the recorded location.',
    actions: warning.fileExists ? ['open', 'show', 'again'] : ['again'],
    canOpen: warning.fileExists
  }
}
