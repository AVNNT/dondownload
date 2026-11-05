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
  openFile: 'download:open-file',
  analyzeMedia: 'media:analyze',
  queueMedia: 'media:queue',
  getMediaSnapshot: 'media:get-snapshot',
  getMediaJob: 'media:get-job',
  cancelMedia: 'media:cancel',
  removeMedia: 'media:remove',
  showMediaInFolder: 'media:show-in-folder',
  openMediaFile: 'media:open-file',
  mediaSnapshotChanged: 'media:snapshot-changed',
  // Milestone 3B batch orchestration (additive). All batch channels reuse the
  // existing trusted-sender wrapper and never return a source URL or path.
  analyzeBatchCollection: 'batch:analyze-collection',
  analyzeCollectionSelection: 'batch:analyze-selection',
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
  updateSettings: 'settings:update',
  // Managed yt-dlp updater (additive). Settings persist separately from the
  // aria2 download settings; state and manual checks never expose a URL/path.
  getMediaToolSettings: 'media-tools:get-settings',
  updateMediaToolSettings: 'media-tools:update-settings',
  getYtdlpUpdateState: 'media-tools:ytdlp-state',
  checkYtdlpUpdate: 'media-tools:ytdlp-check'
} as const
