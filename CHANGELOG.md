# Changelog

All notable changes to DonDownload are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Updating no longer stops at "DonDownload cannot be closed" while a browser
  keeps the extension helper running.

## [1.3.2] - 2026-11-19

Security and reliability fixes from a full code review.

### Security

- A page in the app or an enabled site can no longer make the app request
  loopback, home-network or cloud-metadata addresses. The "check file size"
  probe, the browser bridge's queue-download route and the link preflight now
  all refuse non-public hosts before any connection is made.
- The link preflight no longer forwards the page's `Referer` (and any query
  string in it) to a different host it redirects to, such as a CDN. It is sent
  only to the original host and scheme, like a one-download cookie.
- A download prepared by the page's own request can no longer replace the
  verified final address with an unverified one; the main process re-checks it.
- Downloads that carry a login cookie now hand the downloader only the verified
  final address on the cookie's own host, and retries reuse that address. If
  that address redirects again during the download, the downloader can still
  follow it; closing that needs a downloader update.

### Fixed

- Removing a download at the same moment as pausing, resuming or restarting it
  no longer brings the row back or leaves a download running in the engine.
- A retry or a resume from history now continues the partially downloaded file
  instead of leaving it behind and starting a second `name (2)` copy. A
  complete or unrelated file is still never overwritten.
- After a same-process restart of the download engine, downloads that still
  have their saved login no longer show "needs login".
- Clearing the download list now reports which part of the view failed and
  restores only those rows; progress can no longer step backwards after a
  window has been reopened.
- Queueing a new download while another one is paused in the same folder no
  longer deletes the paused download's temporary data.
- For downloads taken from a page's media, the login cookie now goes to the
  media engine through a private cookie file instead of the command line.
- The app now keeps the history file's last good backup, starts from it (or a
  fresh history) when the file is damaged instead of failing to launch, and
  logs it clearly. A damaged or newer file is never silently replaced.
- Shows, opens and deletes of a download now confirm the real path is inside
  its own folder, and opening a download at startup no longer stalls.
- If saving history fails, the app now keeps logging it (rate-limited) instead
  of going quiet for the rest of the session.
- The native-messaging registration now adopts an existing host path only when
  it is the app's own host inside its install folder; otherwise it rewrites it.
- Cancelling a media download while it is starting up no longer leaves a stray
  temporary folder or a running child process.

## [1.3.1] - 2026-11-18

A stability release: bug fixes only, no new features.

### Fixed

- Opening, revealing, verifying or deleting a download can no longer reach a
  file outside its own folder when its saved history entry points at a whole
  drive.
- Different MEGA links that differ only in their decryption key are no longer
  reported as the same download, and MEGA links already in history match again
  after the upgrade.
- Closing the first-start guide no longer risks reverting another settings
  change made while the guide was open.
- If the folder chosen for one download is no longer available, the Add dialog
  now says so and asks you to choose it again instead of quietly using the
  default folder.
- Save to refuses a whole drive (like `D:\`) and asks for a folder on it
  instead, so the download can still be opened, revealed and deleted.
- Diagnostics and log files now also hide drive paths that appear inside
  another word.

## [1.3.0] - 2026-11-18

### Added

- Choose where each download is saved ("Save to") in the Add and Quick add
  dialogs. The chosen folder applies to that one download; the default folder,
  sort-into-type folders and all other downloads are unchanged.

### Changed

- The Firefox extension in releases is now signed by Mozilla and installs
  permanently.

### Fixed

- Copy diagnostics now hides bare `token=`, `password=` and `api_key=` values.

## [1.2.0] - 2026-11-18

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
- Duplicate warnings before adding a direct link. The Add dialog and Quick add
  show an inline notice for the same normalized URL: "Already downloaded on
  <date> · <file name>" with Open file, Show in folder and Download again, or
  "Already in your list" with Show it while a job is still queued. The primary
  action never starts a duplicate by itself.
- Duplicate checks use an indexed, normalized-URL column (schema v23), so a
  lookup never scans download history. Scheme/host case, fragments, default
  ports and trailing whitespace are ignored; the query string still matters.
- Browser file hand-off answers an exact duplicate of a finished file that
  still exists with the existing completion card (and an "Already downloaded"
  toast on Windows) instead of downloading the bytes again. A missing file
  downloads normally.
- Multi-link batches and scanner results mark history duplicates with an
  "already downloaded" badge and leave them unchecked by default.
- Media (yt-dlp) duplicate matching uses only the same source URL plus format;
  the queue action warns first and a second press downloads another copy.
- Settings → Downloads: "Warn about duplicates" (on by default).

### Fixed

- The installer now bundles the real aria2 download engine; the 1.1.0 build
  contained a broken copy and was never published.

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

[1.3.2]: https://github.com/AVNNT/dondownload/releases/tag/v1.3.2
[1.3.1]: https://github.com/AVNNT/dondownload/releases/tag/v1.3.1
[1.3.0]: https://github.com/AVNNT/dondownload/releases/tag/v1.3.0
[1.2.0]: https://github.com/AVNNT/dondownload/releases/tag/v1.2.0
[1.1.0]: https://github.com/AVNNT/dondownload/releases/tag/v1.1.0
[0.1.0]: https://github.com/AVNNT/dondownload/releases/tag/v0.1.0
