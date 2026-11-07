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
  // Bulk history removal for "Clear list": one database transaction and one
  // publish in the main process instead of a call per row. Files are kept.
  removeDownloads: 'download:remove-many',
  showInFolder: 'download:show-in-folder',
  openFile: 'download:open-file',
  analyzeMedia: 'media:analyze',
  queueMedia: 'media:queue',
  getMediaSnapshot: 'media:get-snapshot',
  getMediaJob: 'media:get-job',
  // Display-only details for one media job, fetched on demand by the details
  // pane. Scoped on purpose: bulk media DTOs still never carry a source URL
  // or path. Uses the same trusted-sender wrapper.
  getMediaJobDetails: 'media:get-job-details',
  cancelMedia: 'media:cancel',
  pauseMedia: 'media:pause',
  resumeMedia: 'media:resume',
  retryMedia: 'media:retry',
  deleteDownloadFile: 'download:delete-file',
  // File checksum verification (additive). The renderer sends only the opaque
  // download id plus an expected hash; main resolves and validates the path.
  verifyChecksum: 'download:verify-checksum',
  computeChecksum: 'download:compute-checksum',
  cancelChecksum: 'download:cancel-checksum',
  checksumProgress: 'download:checksum-progress',
  deleteMediaFile: 'media:delete-file',
  removeMedia: 'media:remove',
  removeMediaJobs: 'media:remove-many',
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
  getDesktopSettings: 'desktop-settings:get',
  updateDesktopSettings: 'desktop-settings:update',
  desktopSettingsChanged: 'desktop-settings:changed',
  // Desktop integration (additive). `clipboardLink` and `revealRow` are
  // main-to-renderer only; `copyText` records the app's own clipboard write so
  // the watcher never offers it back.
  copyText: 'clipboard:copy-text',
  clipboardLink: 'clipboard:link-detected',
  revealRow: 'app:reveal-row',
  // Managed yt-dlp updater (additive). Settings persist separately from the
  // aria2 download settings; state and manual checks never expose a URL/path.
  getMediaToolSettings: 'media-tools:get-settings',
  updateMediaToolSettings: 'media-tools:update-settings',
  getYtdlpUpdateState: 'media-tools:ytdlp-state',
  checkYtdlpUpdate: 'media-tools:ytdlp-check',
  // Zero-config browser extension bridge registration (additive). Status
  // values are non-sensitive; folder actions never accept a renderer path.
  getBrowserExtensionStatus: 'browser-extension:get-status',
  repairBrowserExtension: 'browser-extension:repair',
  openBrowserExtensionFolder: 'browser-extension:open-folder',
  copyBrowserExtensionFolderPath: 'browser-extension:copy-folder-path',
  // Application self-update (additive). State is renderer-safe and never
  // contains an installer URL or path. Installing is only an explicit action.
  getAppUpdateState: 'app-update:get-state',
  checkAppUpdate: 'app-update:check',
  installAppUpdate: 'app-update:install',
  setAppUpdateAutoCheck: 'app-update:set-auto-check',
  appUpdateStateChanged: 'app-update:state-changed',
  // Smart Link Scanner phase 1 (additive). Starting/cancelling a scan never
  // queues anything; only the explicit queue-selection channel can create
  // downloads, and it accepts opaque session/item IDs only.
  scanStart: 'scan:start',
  scanStartMany: 'scan:start-many',
  scanCancel: 'scan:cancel',
  scanUpdated: 'scan:updated',
  scanQueueSelection: 'scan:queue-selection',
  scanQueueSelections: 'scan:queue-selections',
  // Direct-file size probe (additive). Bounded anonymous HEAD request used by
  // the Add dialog to show a link's size before queueing.
  probeUrlSize: 'download:probe-url-size',
  scanOpenInBrowser: 'scan:open-in-browser',
  scanPickMatchVideo: 'scan:pick-match-video',
  scanMarkAsVideo: 'scan:mark-as-video'
} as const
