import type {
  ApiResult,
  AppErrorInfo,
  AppSnapshot
} from '@shared/types'
import type { MediaSnapshot } from '@shared/media'
import type { UnifiedRow } from './unified'

export type RowActionId =
  | 'open'
  | 'show-in-folder'
  | 'copy-link'
  | 'pause'
  | 'resume'
  | 'start-now'
  | 'retry'
  | 'analyze-again'
  | 'remove'

export interface ContextAction {
  id: RowActionId
  label: string
  enabled: boolean
  danger: boolean
  /** Keyboard shortcut hint rendered on the right of the menu item. */
  hint?: string
}

export type BulkActionId = 'pause-all' | 'resume-all' | 'clear-completed'

export function canPauseRow(row: UnifiedRow): boolean {
  return (
    row.download !== null &&
    (row.download.status === 'active' ||
      row.download.status === 'queued' ||
      row.download.status === 'waiting')
  )
}

export function canResumeRow(row: UnifiedRow): boolean {
  return row.download?.status === 'paused'
}

export function canStartNowRow(row: UnifiedRow): boolean {
  return (
    row.download?.status === 'waiting' &&
    (row.download.blockReason === 'scheduled' ||
      row.download.blockReason === 'allowed-hours')
  )
}

export function canRetryRow(row: UnifiedRow): boolean {
  return (
    row.download?.status === 'error' ||
    row.download?.status === 'interrupted'
  )
}

/** Media jobs have no re-queue IPC yet, so a failed job is re-analyzed. */
export function canAnalyzeAgainRow(row: UnifiedRow): boolean {
  return (
    row.media?.status === 'error' || row.media?.status === 'interrupted'
  )
}

export function canOpenRow(row: UnifiedRow): boolean {
  if (row.source === 'download') {
    return row.download?.status === 'complete' && row.download.filePath !== null
  }
  return row.media?.status === 'complete'
}

export function canShowRow(row: UnifiedRow): boolean {
  return (
    (row.source === 'download' && row.download?.status === 'complete') ||
    (row.source === 'media' && row.media?.status === 'complete')
  )
}

export function canCopyLink(row: UnifiedRow): boolean {
  return row.source === 'download' && row.url !== null
}

/**
 * Context-menu definition for the current selection. Multiple selected rows
 * enable every action that applies to at least one of them; the plan below
 * filters per row so bulk actions never hit an incompatible job.
 */
export function buildContextActions(rows: readonly UnifiedRow[]): ContextAction[] {
  const single = rows.length === 1
  const first = rows[0]
  const some = (predicate: (row: UnifiedRow) => boolean): boolean =>
    rows.some(predicate)

  return [
    {
      id: 'open',
      label: 'Open file',
      enabled: single && first !== undefined && canOpenRow(first),
      danger: false,
      hint: 'Enter'
    },
    {
      id: 'show-in-folder',
      label: 'Show in folder',
      enabled: single && first !== undefined && canShowRow(first),
      danger: false
    },
    {
      id: 'copy-link',
      label: 'Copy link',
      enabled: some(canCopyLink),
      danger: false,
      hint: 'Ctrl+C'
    },
    {
      id: 'pause',
      label: rows.length > 1 ? 'Pause selected' : 'Pause',
      enabled: some(canPauseRow),
      danger: false
    },
    {
      id: 'resume',
      label: rows.length > 1 ? 'Resume selected' : 'Resume',
      enabled: some(canResumeRow),
      danger: false
    },
    {
      id: 'start-now',
      label: 'Start now',
      enabled: some(canStartNowRow),
      danger: false
    },
    {
      id: 'retry',
      label: rows.length > 1 ? 'Retry selected' : 'Retry',
      enabled: some(canRetryRow),
      danger: false
    },
    {
      id: 'analyze-again',
      label: 'Analyze again',
      enabled: some(canAnalyzeAgainRow),
      danger: false
    },
    {
      id: 'remove',
      label: rows.length > 1 ? 'Remove selected' : 'Remove from list',
      enabled: rows.length > 0,
      danger: true,
      hint: 'Delete'
    }
  ]
}

export type PlannedAction =
  | 'pause'
  | 'resume'
  | 'start-now'
  | 'retry'
  | 'remove'
  | 'open'
  | 'show'
  | 'copy'
  | 'analyze-again'

export interface ActionPlanEntry {
  action: PlannedAction
  row: UnifiedRow
}

function planForRow(
  action: PlannedAction,
  rows: readonly UnifiedRow[],
  predicate: (row: UnifiedRow) => boolean
): ActionPlanEntry[] {
  return rows.filter(predicate).map((row) => ({ action, row }))
}

/**
 * Pure mapping from a UI action to concrete per-row operations. No IPC is
 * touched here, which makes the mapping directly unit-testable.
 */
export function planRowAction(
  action: RowActionId,
  rows: readonly UnifiedRow[]
): ActionPlanEntry[] {
  switch (action) {
    case 'pause':
      return planForRow('pause', rows, canPauseRow)
    case 'resume':
      return planForRow('resume', rows, canResumeRow)
    case 'start-now':
      return planForRow('start-now', rows, canStartNowRow)
    case 'retry':
      return planForRow('retry', rows, canRetryRow)
    case 'analyze-again':
      return planForRow('analyze-again', rows, canAnalyzeAgainRow)
    case 'remove':
      return rows.map((row) => ({ action: 'remove', row }))
    case 'copy-link': {
      const withLinks = rows.filter(canCopyLink)
      return withLinks.map((row) => ({ action: 'copy' as const, row }))
    }
    case 'open': {
      const target = rows.length === 1 ? rows[0] : undefined
      return target && canOpenRow(target)
        ? [{ action: 'open', row: target }]
        : []
    }
    case 'show-in-folder': {
      const target = rows.length === 1 ? rows[0] : undefined
      return target && canShowRow(target)
        ? [{ action: 'show', row: target }]
        : []
    }
  }
}

export function planBulkAction(
  action: BulkActionId,
  rows: readonly UnifiedRow[]
): ActionPlanEntry[] {
  switch (action) {
    case 'pause-all':
      return planRowAction('pause', rows)
    case 'resume-all':
      return planRowAction('resume', rows)
    case 'clear-completed':
      // History entries only. The main process never deletes downloaded files
      // from a remove call, so this cannot touch disk contents.
      return rows
        .filter((row) => row.statusGroup === 'completed')
        .map((row) => ({ action: 'remove', row }))
  }
}

export interface ConfirmationCopy {
  title: string
  message: string
  confirmLabel: string
}

/** Copy shared by the clear-completed confirm dialog and its tests. */
export function clearCompletedConfirmation(count: number): ConfirmationCopy {
  return {
    title: `Clear ${count} completed ${count === 1 ? 'item' : 'items'}?`,
    message:
      'This removes only the completed history entries. Downloaded files stay on disk.',
    confirmLabel: 'Clear completed'
  }
}

export function removeConfirmation(count: number): ConfirmationCopy {
  return {
    title: `Remove ${count} items?`,
    message:
      'Only the history entries are removed. Files that already finished downloading stay on disk.',
    confirmLabel: `Remove ${count} items`
  }
}

export interface ActionApi {
  pauseDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  resumeDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  startDownloadNow: (id: string) => Promise<ApiResult<AppSnapshot>>
  retryDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  removeDownload: (id: string) => Promise<ApiResult<AppSnapshot>>
  removeMedia: (id: string) => Promise<ApiResult<MediaSnapshot>>
  openFile: (id: string) => Promise<ApiResult<null>>
  openMediaFile: (id: string) => Promise<ApiResult<null>>
  showInFolder: (id: string) => Promise<ApiResult<null>>
  showMediaInFolder: (id: string) => Promise<ApiResult<null>>
}

export interface ActionExecution {
  errors: AppErrorInfo[]
  analyzeAgain: UnifiedRow[]
  copyUrls: string[]
}

/**
 * Execute a plan through the existing download/media IPC methods only.
 * `analyze-again` intentionally performs no backend call: it asks the caller
 * to open the Add dialog's media analyzer, because a failed media job exposes
 * no re-queue IPC and no safe page URL to prefill.
 */
export async function executeActionPlan(
  plan: readonly ActionPlanEntry[],
  api: ActionApi
): Promise<ActionExecution> {
  const errors: AppErrorInfo[] = []
  const analyzeAgain: UnifiedRow[] = []
  const copyUrls: string[] = []

  for (const entry of plan) {
    const row = entry.row
    try {
      switch (entry.action) {
        case 'pause':
          collect(await api.pauseDownload(row.id), errors)
          break
        case 'resume':
          collect(await api.resumeDownload(row.id), errors)
          break
        case 'start-now':
          collect(await api.startDownloadNow(row.id), errors)
          break
        case 'retry':
          collect(await api.retryDownload(row.id), errors)
          break
        case 'remove':
          collect(
            row.source === 'download'
              ? await api.removeDownload(row.id)
              : await api.removeMedia(row.id),
            errors
          )
          break
        case 'open':
          collect(
            row.source === 'download'
              ? await api.openFile(row.id)
              : await api.openMediaFile(row.id),
            errors
          )
          break
        case 'show':
          collect(
            row.source === 'download'
              ? await api.showInFolder(row.id)
              : await api.showMediaInFolder(row.id),
            errors
          )
          break
        case 'copy':
          if (row.url) copyUrls.push(row.url)
          break
        case 'analyze-again':
          analyzeAgain.push(row)
          break
      }
    } catch (error) {
      errors.push({
        code: 'ACTION_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'The action could not be completed.'
      })
    }
  }

  return { errors, analyzeAgain, copyUrls }
}

function collect(
  result: ApiResult<unknown>,
  errors: AppErrorInfo[]
): void {
  if (!result.ok) errors.push(result.error)
}
