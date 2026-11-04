import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { ApiResult, AppSnapshot } from '@shared/types'
import type { Aria2Service } from './aria2/service'
import type { DownloadManager } from './downloads/manager'
import { AppError, toErrorInfo } from './errors'

interface IpcContext {
  manager: DownloadManager
  aria2: Aria2Service
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
}
