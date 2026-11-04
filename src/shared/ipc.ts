export const IPC = {
  getSnapshot: 'app:get-snapshot',
  snapshotChanged: 'app:snapshot-changed',
  restartAria2: 'app:restart-aria2',
  addDownload: 'download:add',
  pauseDownload: 'download:pause',
  resumeDownload: 'download:resume',
  retryDownload: 'download:retry',
  removeDownload: 'download:remove',
  showInFolder: 'download:show-in-folder'
} as const
