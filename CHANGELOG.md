# Changelog

All notable changes to DonDownload are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A more useful tray menu: a status line ("3 downloading · 4.2 MB/s" or
  "Nothing downloading"), Pause all / Resume all, the speed-limit presets, a
  Recent submenu (the last five finished downloads, plus "Show in folder" for
  the newest), "Add from clipboard" (enabled only while the clipboard holds a
  URL — checked when the menu opens, never on a timer), "Settings" and Quit.
  The menu is built only as it opens, never per progress update, and the tray
  tooltip ("DonDownload · 3 downloading · 42%") updates at most every two
  seconds and only while something is downloading, so an idle tray keeps no
  timers of its own. The idle native tray stub keeps just "Open DonDownload"
  and "Quit", matching the app's wording.

## [1.1.0] - 2026-11-18

First public release.

### Added

- Firefox and Zen 140+ support in the browser extension: native messaging
  registered for Firefox, and automatic file hand-off through
  `downloads.onCreated`.
- A short first-start guide: where downloads go, connecting your browser
  (detected from the usual Windows install folders with the existing
  native-messaging status), and the key shortcuts. It is shown once, can be
  replayed from Settings → Getting started, and can be skipped with Esc.
- Completion notifications on Windows now have "Open" and "Show in folder"
  buttons. Clicking the toast body still reveals the finished row; a file that
  was moved or deleted shows the normal missing-file message.
- Idle memory hand-off: after a minute in the tray the app exits to a tiny
  native tray stub (about 1 MB) and a fresh window can be opened from it.
- "Free memory when idle in the tray" setting, and no clipboard timer while
  clipboard watching is disabled.
- Local log files in `%APPDATA%\dondownload\logs\main.log`, rotated at 1 MB and
  kept to three files. Writes are buffered, flushed on a timer and on quit, and
  never happen per progress update.
- Every log line is redacted: only a site's host survives from a URL, the user
  profile becomes `%USERPROFILE%`, other paths keep only an extension, and
  cookies, tokens and `Authorization` values become `[redacted]`. Set
  `DONDOWNLOAD_DEBUG_LOG=1` for verbose (still redacted) records.
- Settings → Help & diagnostics: "Copy diagnostics" (app version, Windows
  build, aria2/yt-dlp/FFmpeg versions, browser extension state, key non-personal
  settings and the last 100 redacted log lines), "Open log folder" and a
  "Report a bug" link.
- Documentation for building your own installer and for running a fork with its
  own update key or with the updater disabled.

### Changed

- Much lower memory use: the GPU and network helper processes are folded into
  the main process, the window is dropped while the app is hidden in the tray,
  and helpers run at below-normal CPU priority.
- At most two media (yt-dlp/FFmpeg) jobs run at the same time, whatever the
  download limit.
- Taskbar progress is restored when the window is shown again.
- `npm run build:installer` is self-contained: when no locally installed or
  cached copy exists, it downloads the pinned official aria2 and FFmpeg releases
  (in addition to yt-dlp) and verifies a hard-coded SHA-256 before extracting.
- Problem reports from the main process (aria2 and yt-dlp crashes, browser
  bridge errors, history and settings failures, uncaught exceptions) go to the
  log file instead of only stderr. Development builds still print them.

### Fixed

- The browser hand-off card in the extension now disappears once its download
  finishes instead of showing a stale status.

## [0.1.0] - 2026-11-10

Initial tagged snapshot: the Electron app with aria2 downloads, SQLite history,
tray behaviour, the browser extension, media downloads through yt-dlp and
FFmpeg, the Smart Link Scanner, batches, settings and the Windows installer.

[1.1.0]: https://github.com/AVNNT/dondownload/releases/tag/v1.1.0
[0.1.0]: https://github.com/AVNNT/dondownload/releases/tag/v0.1.0
