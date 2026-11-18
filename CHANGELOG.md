# Changelog

All notable changes to DonDownload are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A **Save to** choice in the Add dialog: pick any folder for one download
  instead of always using `Downloads\DonDownload`. The default folder,
  sort-into-type folders and all other downloads are unchanged.

## [1.0.0] - 2026-11-18

First public release.

### Added

- Firefox and Zen 140+ support in the browser extension: native messaging
  registered for Firefox, and automatic file hand-off through
  `downloads.onCreated`.
- Idle memory hand-off: after a minute in the tray the app exits to a tiny
  native tray stub (about 1 MB) and a fresh window can be opened from it.
- "Free memory when idle in the tray" setting, and no clipboard timer while
  clipboard watching is disabled.
- Reproducible memory benchmark (`npm run bench:memory`).

### Changed

- Much lower memory use: the GPU and network helper processes are folded into
  the main process, the window is dropped while the app is hidden in the tray,
  and helpers run at below-normal CPU priority.
- At most two media (yt-dlp/FFmpeg) jobs run at the same time, whatever the
  download limit.
- Taskbar progress is restored when the window is shown again.

### Fixed

- The browser hand-off card in the extension now disappears once its download
  finishes instead of showing a stale status.

## [0.1.0] - 2026-11-10

Initial tagged snapshot: the Electron app with aria2 downloads, SQLite history,
tray behaviour, the browser extension, media downloads through yt-dlp and
FFmpeg, the Smart Link Scanner, batches, settings and the Windows installer.

[1.0.0]: https://github.com/AVNNT/dondownload/releases/tag/v1.0.0
[0.1.0]: https://github.com/AVNNT/dondownload/releases/tag/v0.1.0
