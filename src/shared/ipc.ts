export const IPC = {
  getSnapshot: 'app:get-snapshot',
  snapshotChanged: 'app:snapshot-changed',
  restartAria2: 'app:restart-aria2',
  addDownload: 'download:add',
  pauseDownload: 'download:pause',
  resumeDownload: 'download:resume',
  retryDownload: 'download:retry',
  removeDownload: 'download:remove',
  showInFolder: 'download:show-in-folder',
  analyzeMedia: 'media:analyze',
  queueMedia: 'media:queue',
  getMediaSnapshot: 'media:get-snapshot',
  getMediaJob: 'media:get-job',
  cancelMedia: 'media:cancel',
  removeMedia: 'media:remove',
  showMediaInFolder: 'media:show-in-folder',
  mediaSnapshotChanged: 'media:snapshot-changed'
} as const
