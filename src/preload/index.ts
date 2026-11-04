import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AddDownloadInput,
  ApiResult,
  AppSnapshot,
  DonDownloadApi
} from '../shared/types'

const api: DonDownloadApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<ApiResult<AppSnapshot>>,
  addDownload: (input: AddDownloadInput) =>
    ipcRenderer.invoke(IPC.addDownload, input) as Promise<ApiResult<AppSnapshot>>,
  pauseDownload: (id: string) =>
    ipcRenderer.invoke(IPC.pauseDownload, id) as Promise<ApiResult<AppSnapshot>>,
  resumeDownload: (id: string) =>
    ipcRenderer.invoke(IPC.resumeDownload, id) as Promise<ApiResult<AppSnapshot>>,
  retryDownload: (id: string) =>
    ipcRenderer.invoke(IPC.retryDownload, id) as Promise<ApiResult<AppSnapshot>>,
  removeDownload: (id: string) =>
    ipcRenderer.invoke(IPC.removeDownload, id) as Promise<ApiResult<AppSnapshot>>,
  showInFolder: (id: string) =>
    ipcRenderer.invoke(IPC.showInFolder, id) as Promise<ApiResult<null>>,
  restartAria2: () =>
    ipcRenderer.invoke(IPC.restartAria2) as Promise<ApiResult<AppSnapshot>>,
  onSnapshotChanged: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on(IPC.snapshotChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.snapshotChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('donDownload', api)
