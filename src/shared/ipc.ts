export const IPC = {
  getSnapshot: 'app:get-snapshot',
  snapshotChanged: 'app:snapshot-changed',
  restartAria2: 'app:restart-aria2',
  addDownload: 'download:add',
  pauseDownload: 'download:pause',
  resumeDownload: 'download:resume',
  startDownloadNow: 'download:start-now',
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
  mediaSnapshotChanged: 'media:snapshot-changed',
  // Milestone 3B batch orchestration (additive). All batch channels reuse the
  // existing trusted-sender wrapper and never return a source URL or path.
  analyzeBatchCollection: 'batch:analyze-collection',
  submitSmartBatch: 'batch:submit-smart',
  createCollectionBatch: 'batch:create-collection',
  getBatchSnapshot: 'batch:get-snapshot',
  getBatch: 'batch:get',
  cancelBatchItem: 'batch:cancel-item',
  cancelBatch: 'batch:cancel',
  retryBatchItem: 'batch:retry-item',
  removeBatch: 'batch:remove',
  openBatchSource: 'batch:open-source',
  batchSnapshotChanged: 'batch:snapshot-changed',
  // Milestone 5A runtime settings (additive). Both channels reuse the existing
  // trusted-sender wrapper; values are the exact-key download-settings DTO.
  getSettings: 'settings:get',
  updateSettings: 'settings:update'
} as const
