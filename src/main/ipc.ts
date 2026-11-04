import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  MediaAnalysis,
  MediaJob,
  MediaSnapshot
} from '@shared/media'
import type {
  Batch,
  CollectionPreview
} from '@shared/batches'
import type {
  ApiResult,
  AppSnapshot,
  BatchSnapshot,
  SmartBatchSubmitResult
} from '@shared/types'
import type { Aria2Service } from './aria2/service'
import type { BatchManager } from './batches/manager'
import type { DownloadManager } from './downloads/manager'
import { AppError, toErrorInfo } from './errors'
import type { MediaJobsManager } from './mediaJobs/manager'

export interface IpcContext {
  manager: DownloadManager
  aria2: Aria2Service
  /**
   * Optional until the orchestrator wires the manager in `index.ts`. Existing
   * download channels are unchanged; media channels report a safe error while
   * the property is absent.
   */
  mediaJobs?: MediaJobsManager
  /** Additive Milestone 3B batch orchestration. */
  batches?: BatchManager
  getWindow: () => BrowserWindow | null
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null
): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    throw new AppError('UNTRUSTED_SENDER', 'No application window is available.')
  }
  if (event.sender !== window.webContents) {
    throw new AppError('UNTRUSTED_SENDER', 'The IPC sender is not the application window.')
  }
  if (event.senderFrame !== window.webContents.mainFrame) {
    throw new AppError('UNTRUSTED_SENDER', 'IPC is only accepted from the top-level frame.')
  }
  if (event.senderFrame.url !== window.webContents.getURL()) {
    throw new AppError('UNTRUSTED_SENDER', 'The IPC sender frame is not trusted.')
  }
}

export function registerIpc(context: IpcContext): void {
  const invoke = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>
  ): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<ApiResult<T>> => {
      try {
        assertTrustedSender(event, context.getWindow)
        return { ok: true, value: await handler(event, ...args) }
      } catch (error) {
        return { ok: false, error: toErrorInfo(error) }
      }
    })
  }

  invoke<AppSnapshot>(IPC.getSnapshot, () => context.manager.getSnapshot())

  invoke<AppSnapshot>(IPC.restartAria2, async () => {
    await context.aria2.restart()
    // A new aria2 process has no prior GIDs. Reconcile explicitly so in-flight
    // records become interrupted instead of looking live forever.
    await context.manager.reconcileDownloads()
    context.manager.publish(true)
    return context.manager.getSnapshot()
  })

  invoke<AppSnapshot>(IPC.addDownload, (_event, input) =>
    context.manager.add(input)
  )
  invoke<AppSnapshot>(IPC.pauseDownload, (_event, id) =>
    context.manager.pause(id)
  )
  invoke<AppSnapshot>(IPC.resumeDownload, (_event, id) =>
    context.manager.resume(id)
  )
  invoke<AppSnapshot>(IPC.retryDownload, (_event, id) =>
    context.manager.retry(id)
  )
  invoke<AppSnapshot>(IPC.removeDownload, (_event, id) =>
    context.manager.remove(id)
  )
  invoke<null>(IPC.showInFolder, (_event, id) =>
    context.manager.showInFolder(id)
  )

  // Additive media channels. They reuse the same trusted-sender wrapper and
  // never widen the existing download capabilities.
  const media = (): MediaJobsManager => {
    if (!context.mediaJobs) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media support is not available.')
    }
    return context.mediaJobs
  }

  invoke<MediaAnalysis>(IPC.analyzeMedia, (_event, input) =>
    media().analyzeMedia(input)
  )

  invoke<MediaSnapshot>(IPC.queueMedia, async (_event, input) => {
    const manager = media()
    await manager.queueMedia(input)
    return manager.getMediaSnapshot()
  })

  invoke<MediaSnapshot>(IPC.getMediaSnapshot, () =>
    media().getMediaSnapshot()
  )

  invoke<MediaJob>(IPC.getMediaJob, (_event, jobId) =>
    media().getMediaJob(jobId)
  )

  invoke<MediaSnapshot>(IPC.cancelMedia, async (_event, jobId) => {
    const manager = media()
    await manager.cancelMedia(jobId)
    return manager.getMediaSnapshot()
  })

  invoke<MediaSnapshot>(IPC.removeMedia, (_event, jobId) =>
    media().removeMedia(jobId)
  )

  invoke<null>(IPC.showMediaInFolder, (_event, jobId) =>
    media().showMediaInFolder(jobId)
  )

  // Additive Milestone 3B batch channels. Every handler goes through the same
  // trusted-sender wrapper above, and public results are safe Batch or
  // CollectionPreview DTOs only (no source URL, path, token or headers).
  const batches = (): BatchManager => {
    if (!context.batches) {
      throw new AppError(
        'BATCH_UNAVAILABLE',
        'Batch support is not available.'
      )
    }
    return context.batches
  }

  invoke<CollectionPreview>(IPC.analyzeBatchCollection, (_event, input) =>
    batches().analyzeCollection(input)
  )

  invoke<SmartBatchSubmitResult>(IPC.submitSmartBatch, (_event, input) =>
    batches().submitSmartBatch(input)
  )

  invoke<Batch>(IPC.createCollectionBatch, (_event, input) =>
    batches().createCollectionBatch(input)
  )

  invoke<BatchSnapshot>(IPC.getBatchSnapshot, () =>
    batches().getBatchSnapshot()
  )

  invoke<Batch>(IPC.getBatch, (_event, batchId) =>
    batches().getBatch(batchId)
  )

  invoke<BatchSnapshot>(IPC.cancelBatchItem, (_event, input) =>
    batches().cancelBatchItem(input)
  )

  invoke<BatchSnapshot>(IPC.cancelBatch, (_event, input) =>
    batches().cancelBatch(input)
  )

  invoke<BatchSnapshot>(IPC.retryBatchItem, (_event, input) =>
    batches().retryBatchItem(input)
  )

  invoke<BatchSnapshot>(IPC.removeBatch, (_event, input) =>
    batches().removeBatch(input)
  )

  invoke<null>(IPC.openBatchSource, (_event, input) =>
    batches().openBatchSource(input)
  )
}
