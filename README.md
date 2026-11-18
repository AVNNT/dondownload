# DonDownload

A fast, focused, open-source download manager for Windows, built on Electron,
React and aria2, with an optional browser extension.

![Main window with sample downloads](docs/screenshots/main-1280x800.png)

The screenshots in this README come from the app's development browser preview
with sample data, not from a live download session. More:
[details pane](docs/screenshots/details-1280x800.png) ·
[add dialog](docs/screenshots/add-dialog-1280x800.png) ·
[selection and batch actions](docs/screenshots/selection-1280x800.png) ·
[context menu](docs/screenshots/context-menu-1280x800.png) ·
[narrow window](docs/screenshots/narrow-800x600.png)

## Features

- **Fast segmented downloads.** Every HTTP(S) transfer runs through aria2, up to
  16 connections per file by default, with a per-host back-off when a server
  does not like that many. Three downloads run at once by default.
- **Browser hand-off.** The companion extension (Chrome, Edge, Helium, Brave and
  Firefox/Zen) sends a page or a link straight to the running app, and can hand
  ordinary file downloads over automatically. The browser's copy is cancelled
  only after the app has durably accepted the job.
- **Media downloads.** Paste a video page, or pick a stream from the extension
  overlay, and DonDownload analyses it with yt-dlp and downloads the quality you
  choose. FFmpeg merges separate video/audio streams, and yt-dlp can keep its
  managed copy up to date from GitHub releases (on by default).
- **Smart Link Scanner.** Paste up to 10 forum topic or page URLs and the app
  collects the direct download links, resolves linked video pages with yt-dlp,
  pairs scripts with videos and queues the whole selection as batches.
  Gofile share links open in your own browser, and the extension reads the file
  list from that tab.
- **Batches.** Group related files, watch them progress together, and retry or
  cancel individual items.
- **Low memory use.** The window is dropped while the app sits in the tray
  (about **141 MB**, vs. about **238 MB** with the window open). After a minute
  in the tray with nothing downloading, the app exits and leaves a tiny native
  tray icon (~1 MB). Clicking it, or sending a download from the browser
  extension, starts the app again.
- **A download list that stays quick.** Virtualised list, instant search,
  category filters, drag-and-drop or clipboard paste to add (`Ctrl+V`), undo for
  removals, and a details pane with per-connection info, checksum verification
  and "show in folder". Press `?` for the shortcut list.
- **Real settings.** Speed limit, concurrent downloads, connections per file,
  allowed hours (new downloads wait for the window; running ones finish),
  sort-into-type folders, automatic history cleanup, optional completion
  notifications, start at sign-in, resume interrupted downloads, three themes
  (OLED black by default) and interface size.
- **Durable history.** Every download is recorded in SQLite and survives
  restarts. Interrupted transfers are marked **Interrupted** rather than
  silently re-downloaded; one click retries them with the partial file kept.

## Install

1. Open the [Releases](https://github.com/AVNNT/dondownload/releases) page and
   download `DonDownload-1.0.0-x64-setup.exe`.
2. Run it. The installer is per-user: it installs for your Windows account and
   **does not need administrator rights**.

**About the "Unknown publisher" warning (SmartScreen).** The 1.0.0 installer is
not code-signed, so Windows shows a blue *Windows protected your PC* dialog with
an unknown publisher. To continue, click **More info**, then **Run anyway**. If
you would rather check the file first, compare its SHA-256 with
`SHA256SUMS.txt` on the same release page:

```powershell
Get-FileHash .\DonDownload-1.0.0-x64-setup.exe -Algorithm SHA256
```

DonDownload needs Windows 10 or 11 on x64. The installer bundles aria2, yt-dlp
and FFmpeg, so nothing else has to be installed. Downloads are saved to
`%USERPROFILE%\Downloads\DonDownload` by default, with an optional
"sort into folders by type" setting.

Uninstalling through Windows Settings removes the app and its shortcuts but
never deletes your downloaded files or your history.

## Browser extension

The extension is optional. The desktop app works on its own: paste a link, drag
one in, or add one from the clipboard if you turn clipboard watching on.

The desktop app registers the browser side of the connection (the native
messaging host) by itself on every launch, for the current Windows user only, so
no setup scripts or registry edits are part of the normal path.

### Chrome, Edge, Helium and Brave

1. From the same GitHub release, download `dondownload-extension-chromium-1.0.0.zip`
   and extract it to a folder you keep (don't delete it while you use the
   extension).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the extracted folder.
5. Start DonDownload once, then open its **Settings → Browser extension** panel
   to see the connection state for each browser.

The extension has a fixed ID (`mikinloaillialkiannpcejdbmfbljhm`), so the folder
can be moved to another location without re-registering.

### Firefox and Zen (140 or newer)

1. Download `dondownload-extension-firefox-1.0.0.xpi` from the same release.
2. **Temporary:** open `about:debugging#/runtime/this-firefox`, choose
   **Load Temporary Add-on** and pick the `.xpi` (or the `manifest.json` inside
   an extracted folder). Firefox removes temporary add-ons when it restarts, so
   they have to be loaded again.
3. **Permanent:** Firefox only installs an `.xpi` permanently when it is signed
   by Mozilla. Alternatively use Firefox Developer Edition (or Nightly) with
   `xpinstall.signatures.required` set to `false` in `about:config`, then install
   the file from `about:addons` → gear icon → **Install Add-on From File**.

The add-on uses the fixed ID `dondownload@dondownload.app`, which the desktop
app registers automatically.

### What the extension does

- **Send this page** from the toolbar popup, or right-click a link →
  **Download with DonDownload**. Success is reported only after the app has
  accepted the job.
- **Automatic file hand-off.** Ordinary file downloads are passed to the app and
  the browser's copy is cancelled only after the app has confirmed a durable
  record and a size/type check. Anything unclear (sign-in, POST, unusual
  metadata) is left to the browser.
- **Media detection.** On normal http/https sites the extension lists the media
  files and HLS/DASH manifests it sees in the tab, so you can queue one with a
  click.
- **Optional video overlay.** Off by default; enable it per site to get a small
  **DD** button on a playing video with the qualities that player really used,
  plus an explicit **Find qualities** analysis through yt-dlp.

The extension never blocks or rewrites your browsing. `webRequest` and `cookies`
are optional permissions that are requested only when you use a feature that
needs them (media size evidence and per-site cookie opt-in).

## Updates

DonDownload checks GitHub Releases at most once every 24 hours (the setting is
on by default; **Check now** is available too). A release is only offered when:

- its tag is a strictly newer `vX.Y.Z` version,
- it contains `DonDownload-<version>-x64-setup.exe`, `SHA256SUMS.txt` and
  `SHA256SUMS.txt.sig`,
- the Ed25519 signature over `SHA256SUMS.txt` verifies against the public key
  built into the app, and the installer's SHA-256 matches that signed list.

The update is downloaded into the app's own data folder and installs only when
you click **Restart and install**. It refuses to start while a download or media
job is still running.

## Privacy

DonDownload has no accounts, no telemetry, no analytics and no crash reporting.

What leaves your machine:

- **Your downloads.** aria2, yt-dlp and FFmpeg connect to the servers you asked
  them to download from, as any downloader does. Pages fetched by the Smart Link
  Scanner are requested from their own sites.
- **The update check.** Once a day, `api.github.com` (and, if an update exists,
  GitHub's release download hosts) is asked for the latest release. The request
  carries a `DonDownload/<version>` user agent and no cookies or credentials.
- **Optional helper downloads.** yt-dlp can update itself and YouTube jobs can
  fetch a pinned Deno runtime; both come from GitHub releases and are checked
  against published SHA-256 sums.

What stays local: history in `%APPDATA%\dondownload\downloads.sqlite3`, settings,
the loopback address the extension uses to reach the app, and the native
messaging registration. The app does not log download URLs. URLs are stored in
the local history because retry and resume need them; query strings can carry
site-specific tokens, and the database is protected by your Windows user
profile's permissions rather than by application-level encryption.

The desktop bridge the extension talks to listens only on `127.0.0.1` with a
random port and a fresh bearer token per launch, and accepts nothing but a URL
to download.

## Uninstalling the browser extension

Remove the extension from `chrome://extensions` or `about:addons`. Running the
installer's uninstaller removes the native messaging registration it created;
a development registration that points at a source checkout is left alone.

## Building from source

Requirements: Windows 10/11 x64, Node.js 24+, npm 10+. For the extension and the
installer you also need the .NET Framework 4.x C# compiler (`csc.exe`), which
ships with Windows.

```powershell
npm ci
npm run dev
```

Useful scripts:

```powershell
npm run typecheck   # TypeScript, main/preload and renderer
npm run lint        # ESLint
npm run test:fast   # hermetic unit/component tests
npm test            # full Vitest suite
npm run build       # typecheck + production build
npm run build:native-host   # native messaging host (.exe)
npm run build:tray-stub     # native tray stub (.exe)
npm run build:installer     # Windows x64 NSIS installer in dist/
```

A development checkout does not bundle the third-party tools. Install aria2
(for example `winget install aria2.aria2`) or point the app at a binary with
`DONDOWNLOAD_ARIA2_PATH`; yt-dlp and FFmpeg are only needed for media
downloads. If a required tool is missing, the app says so instead of failing
silently.

Further reading:

- [Browser hand-off and the native host](docs/automatic-browser-handoff.md)
- [Media capture and the video overlay](docs/media-capture-progressive.md)
- [Media tools and their licenses](docs/media-tools.md)
- [Smart Link Scanner](docs/smart-link-scanner-browser-only.md)
- [Installer packaging](docs/installer-packaging.md)
- [Performance and memory](docs/performance.md)
- [Testing workflow](docs/testing-workflow.md)
- [Smoke test](docs/smoke-test.md)

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

DonDownload's own source is released under the [MIT License](LICENSE).

The installer also ships third-party programs that keep their own licenses:
aria2 (GPL-2.0-or-later), yt-dlp (Unlicense, plus bundled third-party licenses)
and the Gyan FFmpeg essentials build (GPL-3.0-or-later). Deno (MIT) is not
bundled; it is downloaded on demand for some YouTube jobs. See
[third-party/NOTICE.md](third-party/NOTICE.md) for the inventory,
[third-party/licenses/](third-party/licenses/) for the license texts and
[docs/licensing-release-audit.md](docs/licensing-release-audit.md) for the
release audit. Those notices travel with the installer. The MIT license for
DonDownload does not replace the terms of any bundled binary.
