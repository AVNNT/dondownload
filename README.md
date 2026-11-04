# DonDownload

A Windows-first, open-source download manager for ordinary HTTP(S) downloads.
This repository contains the **Milestone 1 foundation** (a working Electron
desktop app with a React renderer, a real aria2 engine, durable SQLite download
history, conservative restart reconciliation, and a Windows tray) plus
**Milestone 2A**: an optional Chrome/Edge Manifest V3 extension for **manual**
HTTP(S) capture through a strict native messaging bridge.

The UI is deliberately small: an OLED-black, centered (~800 px) layout with a
compact top bar, a Quick Add form, and download cards with live status,
progress, speed, ETA, pause/resume, bounded retry, and open-in-folder. History
is stored locally and survives relaunches.

## Requirements

- Windows 10/11 (the primary target)
- Node.js 24+ (developed with Node 24.19; Electron 45 bundles Node 24.22 and
  SQLite 3.53 through the built-in `node:sqlite` module)
- npm 10+
- **aria2c** available locally (not bundled — see licensing below)
- For the optional browser extension only: Windows .NET Framework 4.x, which
  provides `csc.exe` for building the small native messaging host. No .NET SDK
  or Visual Studio is required.

## Quick start

```powershell
npm install
npm run dev
```

Other scripts:

```powershell
npm test          # focused unit tests (Vitest)
npm run typecheck # main/preload and renderer TypeScript projects
npm run build     # typecheck + electron-vite production build
npm run build:native-host # optional: compile the browser native messaging host
npm start         # preview an existing production build
```

## Installing aria2

DonDownload launches a separate `aria2c` process. It does **not** download or
redistribute that binary. Choose one option:

1. Install with winget:

   ```powershell
   winget install aria2.aria2
   ```

   (or `scoop install aria2`), then restart DonDownload.

2. Place `aria2c.exe` in the repository at `vendor/aria2/aria2c.exe`.
   That directory is git-ignored.

3. Point DonDownload at an existing binary with an absolute or relative path:

   ```powershell
   $env:DONDOWNLOAD_ARIA2_PATH = 'C:\tools\aria2\aria2c.exe'
   npm run dev
   ```

Search order: `DONDOWNLOAD_ARIA2_PATH`, packaged `resources/vendor/aria2/`,
`<app>/vendor/aria2/`, then `PATH`.

If aria2c is missing, the app shows an actionable banner instead of pretending
a download works. After installing it, use **Retry aria2** in the app.

### aria2 licensing

DonDownload's own source is MIT-licensed (see `LICENSE`). aria2 is a separate
GPL-2.0-or-later program. It is invoked as a subprocess over local JSON-RPC and
is not included in this repository or its build output. If you distribute a
bundle that includes aria2, you are responsible for complying with aria2's
license, including providing its source and license notices. None of this is
legal advice.

## Browser extension: manual HTTP(S) capture (Milestone 2A)

The `extension/` folder is a Chrome/Edge Manifest V3 extension that sends an
explicitly chosen HTTP(S) URL to the running desktop app. It is **manual
capture only**:

- Permissions are just `activeTab`, `contextMenus` and `nativeMessaging`. There
  are no `downloads`, `webRequest`, `notifications`, host permissions, content
  scripts or `tabs`-history permissions.
- The popup has an explicit **Download with DonDownload** action for the active
  page.
- Right-clicking a link shows **Download with DonDownload**.
- It never observes, changes or cancels browser downloads, never intercepts
  requests, and never captures automatically.
- The toolbar badge shows `OK` only after the desktop app has accepted the URL;
  `!` means the action failed. The popup shows the specific error. No
  notifications permission is needed.

### 1. Build the native messaging host

The host is a real Windows executable compiled from `native/NativeHost.cs` with
the .NET Framework C# compiler that ships with Windows 10/11:

```powershell
npm run build:native-host
# writes native\dondownload-native-host.exe
```

The equivalent explicit command is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-native-host.ps1
```

If `csc.exe` or `System.Web.Extensions.dll` is missing, install .NET Framework
4.x. The browser manifest always points at this `.exe`; it never points at a
`.cmd`, `.ps1` or JavaScript file. The executable is built locally and is
git-ignored.

### 2. Load the unpacked extension and note its ID

Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this repository's `extension` folder.
4. Copy the extension's 32-character ID.

Edge:

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the same `extension` folder.
4. Copy the extension's ID.

Chrome and Edge can derive different IDs for the same folder. If you want both
browsers to work, keep both IDs. An unpacked extension's ID is derived from its
folder path, so moving or copying the folder changes the ID; reload the
extension and register again with the new ID.

### 3. Register or unregister the native host (current user)

Register the exact ID(s). IDs are comma-separated and are validated as
lowercase `[a-p]{32}` — wildcards are rejected:

```powershell
# Chrome only:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Browser Chrome -ExtensionId <chrome-id>

# Chrome and Edge:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Browser Both -ExtensionId <chrome-id>,<edge-id>
```

The script:

- writes `%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.json`
  with explicit `allowed_origins` entries such as
  `chrome-extension://<id>/` (never `*`);
- requires the manifest `path` to be a real `.exe`;
- writes the current-user registry value:
  - Chrome: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`
  - Edge: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dondownload.bridge`
- does not require administrator rights;
- is safe to run repeatedly.

Inspect the manifest without writing anything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -PrintManifest -ExtensionId <id>
```

Remove the registrations and generated manifest:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Unregister -Browser Both
```

If you used a custom `-ManifestPath`, pass the same path when unregistering.
Reload the extension (or restart the browser) after registering.

### 4. Use it

1. Start DonDownload. It may be hidden in the tray.
2. Open an `http://` or `https://` page.
3. Click the toolbar icon, confirm the URL and choose
   **Download with DonDownload**; or right-click a direct link and choose
   **Download with DonDownload**.
4. Success is reported only after the app's existing `DownloadManager.add`
   accepted the job. The download appears in the same history and default
   Downloads folder as a Quick Add job.
5. An identical normalized HTTP(S) URL is rejected while its previous record is
   queued, active, waiting or paused. The popup reports the duplicate honestly
   and offers an explicit **Download again** action; the link context menu
   reports the duplicate and points you to that action in the app, never
   silently resubmitting.

### Errors you should see

- Unsupported scheme (`chrome:`, `edge:`, `file:`, `ftp:`), embedded
  credentials, malformed or overlong URLs: rejected in the extension, the
  native host and the app.
- Duplicate unfinished URL: a non-success `DUPLICATE_DOWNLOAD` response, never
  an acceptance. The popup shows **Download again**; the context menu directs
  you to the app action.
- Native host not registered: a clear registration hint in the popup and `!` on
  the badge.
- Extension ID not in `allowed_origins`: the browser reports native host access
  as forbidden; re-register with the exact ID.
- DonDownload not running, or a stale bridge endpoint after a crash: a prompt
  "not running/unavailable" error. The bridge never launches the app.
- aria2 unavailable: the app's existing actionable error is returned and the
  extension does not claim success.

### Security boundary

- The desktop bridge listens on `127.0.0.1` only, on a random port, with a new
  32-byte random bearer token per launch.
- Endpoint state lives at `%APPDATA%\dondownload\native-bridge.json` (Electron's
  per-user `userData`), protected by the user's profile ACL. It is removed on a
  clean shutdown. A stale file after a crash fails closed with a connection
  error rather than granting access.
- The bridge accepts only `POST /queue-download`, only `application/json`, with
  a 16 KiB body cap and either `{ "url": "..." }` or
  `{ "url": "...", "force": true }`. The optional boolean `force` is the only
  extra field and exists solely for an explicit user-initiated **Download
  again** action. Requests carrying a browser `Origin` or `Sec-Fetch-Site`
  header are rejected even if the token is known. There is no command, path,
  file name or filesystem input.
- The native host speaks the standard native-messaging framing (4-byte
  little-endian length + UTF-8 JSON), caps frames at 1 MiB, accepts
  `{ "type": "queue-download", "url": "..." }` with an optional boolean
  `force`, and writes diagnostics only to stderr without logging URLs.
- The browser manifest's exact `allowed_origins` is the authoritative
  browser-side origin check. The native host also rejects non-
  `chrome-extension://` caller origins as defence in depth.
- The bridge calls the existing `DownloadManager.add`. It cannot expose aria2
  RPC, start a second aria2, open or focus the desktop window, bypass URL/file
  name validation, or change retry, tray and history behavior.

### Manual verification

With the app running (tray-only is fine), the host registered and the extension
loaded:

1. Open an HTTP(S) page and use the popup. Expect `OK`/success only after the
   job appears in DonDownload.
2. Right-click a direct file link, choose **Download with DonDownload**, and
   confirm one new job.
3. Send the same link twice. The second attempt must report a duplicate and
   create no new job; choose **Download again** in the popup to create an
   intentional second copy.
4. Close DonDownload to the tray and repeat; it must still accept while the
   window is hidden.
5. Quit DonDownload and send again; expect a prompt "not running" error, not a
   false success.
6. Open a `chrome://`, `edge://` or `file://` page; expect an unsupported-URL
   error before any native message is sent.

## Testing

The default suite is hermetic and needs no network or aria2 binary:

```powershell
npm test        # focused unit tests; optional host/aria2 tests skip if unavailable
npm run typecheck
```

The browser-bridge tests cover frame lengths and limits, strict schemas, URL
validation, exact allowed-origin manifest generation, unavailable-app responses,
oversized bodies and duplicate responses that never claim acceptance. The real
native-host tests run when `native\dondownload-native-host.exe` has been built;
the registration tests run on Windows.

An optional end-to-end test drives a real aria2 process against a local
throttled HTTP server that implements Range requests. It checks full HTTP
completion, real pause/resume to exact bytes, and restart recovery through the
real DownloadManager and a temporary SQLite database. It is skipped unless you
point it at a test binary (the binary remains in your temp/tools folder and is
not redistributed):

```powershell
$env:ARIA2_TEST_BINARY = 'C:\tools\aria2\aria2c.exe'
npm test

# Or run only the integration file:
npx vitest run tests/aria2.integration.test.ts
```

### Manual tray smoke test

Run `npm run dev` with aria2 installed, start a download, and confirm:

1. Clicking the window close button hides the window; the tray icon remains and
   the download keeps progressing (speed/bytes advance when the window reopens).
2. Clicking the tray icon once, or double-clicking it, restores and focuses the
   window. The tray menu shows **Hide DonDownload** while it is visible and
   **Show DonDownload** while it is hidden.
3. Starting a second copy focuses the existing window instead of creating a
   second app or a second aria2 process.
4. **Quit DonDownload** in the tray menu closes the window immediately, stops
   the aria2 child process, and flushes/closes SQLite. Relaunching shows the
   completed history and the usual interrupted/paused recovery states.
5. Closing the window is not a quit: no `aria2c.exe` or app process disappears
   from Task Manager until you explicitly quit.

## How it works

```text
React renderer (sandboxed, no Node)
        │ narrow validated IPC through preload
        │
Browser extension (MV3, manual capture only)
        │ chrome.runtime.sendNativeMessage
        ▼
Native messaging host (C# .exe, 1 MiB framed JSON)
        │ loopback HTTP + per-launch bearer token
        ▼
Electron main
  ├─ Browser bridge: { url } (+ optional explicit force) -> DownloadManager.add
  ├─ DownloadManager: queue, polling, retry limits, UI snapshots
  ├─ Aria2Service: locate/start/stop aria2c, readiness and errors
  └─ Aria2Client: JSON-RPC over http://127.0.0.1:<random port>
        ▼
aria2c subprocess
```

Key properties:

- Renderer has `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, no webviews, permission requests denied, popups and
  navigation blocked.
- Preload exposes only typed functions; no raw `ipcRenderer` or Node APIs.
- Every IPC call verifies the sender is the main frame of the application
  window, then validates URL, file name and download IDs in the main process.
- Only `http:` and `https:` URLs are accepted. Embedded URL credentials and
  control characters are rejected.
- The browser extension is manual-only: it has no `downloads` or `webRequest`
  permission and sends only an explicitly chosen URL over native messaging.
- The native messaging host validates framing, size, schema and URL before
  forwarding a URL to the desktop bridge; diagnostics never include URLs.
- The desktop bridge is loopback-only, authenticated with a per-launch random
  bearer token, rejects browser-origin requests, and can only call the existing
  `DownloadManager.add` path. It never opens the window or starts aria2 itself.
- Duplicate prevention lives only in `DownloadManager.add`, so Quick Add and the
  browser bridge share it exactly. Matching is conservative: exact canonical
  HTTP(S) URL equality after the normal validation (which removes fragments).
  Queued, active, waiting and paused records block repeats; complete, error,
  interrupted and removed records do not. A synchronous per-URL reservation
  happens before any async aria2 add, so concurrent identical requests cannot
  both create a job.
- File names are sanitized against path traversal, Windows reserved characters
  and reserved device names. aria2 writes into a single download directory.
- aria2 is started with an argument array and `shell: false`; user input is
  never interpolated into a shell command.
- aria2 RPC binds to loopback only and uses a random port plus a per-launch
  random secret. The app disables aria2's user config file for deterministic
  behavior.
- Query strings, redirects and content-disposition naming are handled by aria2.
  Progress, completed bytes, speed and ETA come from real `tellStatus` data.
- aria2 retries transient transfer failures (`max-tries=3`, `retry-wait=2`).
  The app additionally caps user-visible attempts at three; the Retry button is
  hidden after the cap is reached.
- Download lifecycle/progress is stored in SQLite: URL, file name, directory,
  status, bytes, timestamps, file path and error text. Critical transitions
  (add, pause, resume, retry, complete, error, remove) are written immediately;
  progress snapshots are batched at most every 2.5 seconds. Startup reconciliation
  uses `aria2.tellStatus` only for records that may still be live.
- History uses the `node:sqlite` built-in shipped with Electron 45's Node 24.22
  runtime (SQLite 3.53). No native addon, `electron-rebuild` step, or asar unpack
  configuration is required. Schema migrations run in transactions and use
  `PRAGMA user_version`; all normal writes use prepared statements.
- There is no TTL or automatic purge. Rows remain until the user removes the
  download from the list. Removing a row never deletes the downloaded file.
- URL credentials are rejected before they reach aria2 or SQLite, and the app
  does not log download URLs or other payload data.

Downloads are saved to `%USERPROFILE%\Downloads\DonDownload` by default.

### Download history and restart recovery

The history database is a dedicated file in Electron's `userData` directory:

- Windows: Electron's user-data folder, normally
  `%APPDATA%\dondownload\downloads.sqlite3` (plus `-wal`/`-shm` files while the
  app is running); the exact folder name follows Electron's app name
- the schema is versioned and migrated transactionally; a database from a newer
  app version is refused rather than modified

Recovery is intentionally conservative. On launch or after **Retry aria2**:

- If aria2 still reports the stored GID, the record is reattached and polling
  resumes. The one exception is `paused`: a persisted manual pause is never
  overridden by aria2's tracked status, which may be `active` or `waiting`.
- If a record was `active`, `queued` or `waiting` but aria2 no longer tracks it,
  it becomes **Interrupted** with a message explaining that the partial file was
  kept. It is not silently re-downloaded.
- Records last saved as `paused` stay paused whether or not aria2 still tracks
  the GID. aria2 cannot reattach a paused GID after a process restart, so an
  explicit **Resume** re-adds that transfer with aria2's `--continue=true`,
  `--allow-overwrite=false` and `--auto-file-renaming=true` options. Existing
  partial or completed files are never deleted or overwritten.
- **Retry** on an interrupted/failed record likewise re-adds the transfer with
  continuation enabled. Network failures remain subject to the three-attempt
  cap; interrupted recovery does not consume that retry budget.
- Completed and failed history is never changed during reconciliation.

A normal quit flushes pending progress, stops aria2, checkpoints WAL and closes
the database. Choosing **Quit DonDownload** from the tray uses the same orderly
path; closing the window does not quit at all. An abrupt kill can lose at most
the current bounded progress batch; the last known lifecycle state is still
durable.

Download URLs are stored locally because Retry/Resume need them. URLs with
embedded userinfo are rejected before storage, and the app never logs download
URLs or other payloads. Query strings may contain site-specific tokens; the
database is protected by the operating system's per-user permissions on the
`userData` folder, not by application-level encryption.

## System tray and closing the window

DonDownload is Windows-first and keeps working while its window is hidden:

- Closing the main window hides it to the notification area instead of quitting.
  aria2, polling and SQLite persistence continue in the background.
- A tray click or double-click restores and focuses the window. The tray menu
  offers a state-aware **Show DonDownload** / **Hide DonDownload** item and an
  explicit **Quit DonDownload** item.
- The tray's explicit **Quit DonDownload** is the intentional way to stop the
  app. It runs the same orderly sequence as before: flush pending progress, shut
  down aria2, close and checkpoint SQLite. The window close handler sees the
  quit request and does not hide the window again, so quitting cannot loop.
- A second launch still obeys the single-instance lock and focuses the existing
  window, whether it is hidden or minimized. App activation on macOS does the
  same.
- The tray is created only after the app is ready. It does not launch the app,
  register a login item, or add a service. Quitting removes the icon; nothing
  is left running.

The icon is a small multi-resolution Windows `.ico` at
`src/main/assets/tray.ico` (16, 20, 24, 32, 40 and 48 px). It is imported with
electron-vite's `?asset` suffix, so both `npm run dev` and `npm run build` emit
it next to the main bundle (`out/main/chunks/`) and resolve the path relative to
that bundle. There is no hand-built `resources` path to keep in sync. If the
icon or tray cannot be created, the app logs a non-sensitive error and falls
back to the previous close-and-quit behavior so it can never become invisible
with no way to restore it.

## Implemented in Milestone 1

- Electron + React + TypeScript + Vite + Tailwind v4 scaffold and build.
- Secure main/preload/renderer split with sandboxing and context isolation.
- aria2 discovery, safe process launch, lifecycle management and RPC client.
- Real HTTP(S) download add, polling, progress/speed/ETA, pause, resume,
  remove, bounded retry and "show in folder".
- Validated IPC payloads, URL/file-name sanitization, and restricted RPC.
- Actionable aria2 unavailable/startup/exit errors with restart control.
- Durable SQLite download history with transactional schema migrations and
  prepared statements, retained indefinitely by default.
- Conservative startup/restart reconciliation: reattach live GIDs, mark lost
  in-flight transfers as interrupted, preserve paused state, and never
  auto-resume or delete files.
- Windows-first system tray: close hides the window, tray click/double-click
  restores it, Show/Hide and explicit Quit menu items, single-instance focus,
  and an orderly quit that still stops aria2 and flushes SQLite.
- Focused tests for SQLite persistence, migration/reopen, retained history,
  recovery transitions, URL/file-name validation, ID validation, JSON-RPC
  parsing, status normalization, formatting, retry policy, tray/close/quit
  policy, and the bundled tray icon.
- MIT license and setup documentation.

## Implemented in Milestone 2A

- Chrome/Edge Manifest V3 extension with only `activeTab`, `contextMenus` and
  `nativeMessaging` permissions: an explicit popup action and a link context
  menu. No downloads/webRequest interception, no notifications permission.
- Toolbar badge and popup feedback that report success only after the desktop
  app accepts the URL, with actionable errors for unsupported URLs, missing
  native host, unauthorized extension origin, connection failure and app
  failure.
- A real C# Windows native messaging executable built with the .NET Framework
  compiler (no SDK), using standard bounded length-prefixed UTF-8 JSON framing,
  strict schema/type/URL validation, stderr-only diagnostics and no URL logging.
- Repeatable current-user PowerShell registration/unregistration for Chrome and
  Edge with exact, validated `allowed_origins`; no wildcard and no admin rights.
- A loopback-only authenticated main-process bridge that can only call the
  existing `DownloadManager.add`. It works while the window is hidden in the
  tray, returns acceptance only after add succeeds, removes endpoint state on
  shutdown, and fails promptly when the app is unavailable.
- A shared duplicate policy in `DownloadManager.add`: exact normalized URL
  matching against unfinished jobs, no second aria2 GID or history row, a
  race-safe reservation, and a narrow `force` boolean for an explicit
  **Download again** action. The popup and Quick Add expose that action; the
  context menu reports duplicates without silently resubmitting.
- Focused tests for native framing/limits, strict schemas and URL validation,
  exact origin manifest generation, oversized payloads, unavailable-app
  responses, duplicate responses that never claim acceptance, and manager-level
  duplicate/force/concurrency behavior.

## Deferred (not implemented)

These are intentionally **not** claimed by these milestones:

- Automatic aria2 session restore (DonDownload marks lost transfers as
  interrupted instead of pretending they are still running).
- Notifications, auto-start/launch-at-login, or background services.
- Automatic browser interception, browser download takeover/cancellation,
  clipboard monitoring, drag-and-drop capture, or media overlays.
- Media/stream downloads (HLS/DASH), file hosts, login/cookie handling.
- BitTorrent, magnet links, Metalink, scheduling, bandwidth limits.
- Windows installer/signing, auto-update, and bundled aria2.
- Multi-directory selection UI, categories, search, and settings screens.

## Project layout

```text
src/main/                 Electron main process
  aria2/locator.ts        Safe aria2c discovery
  aria2/service.ts        Process lifecycle and readiness
  aria2/client.ts         Local JSON-RPC client
  aria2/rpc.ts            Pure RPC/status parsing
  db/database.ts          SQLite history, migrations, prepared statements
  downloads/manager.ts    Download queue, polling, persistence and recovery
  downloads/recovery.ts   Pure startup reconciliation policy
  nativeBridge/server.ts  Authenticated loopback browser bridge
  lifecycle.ts            Pure tray close/quit policy
  tray.ts                 Windows tray icon, menu and restore actions
  assets/tray.ico         Multi-resolution Windows tray icon
  ipc.ts                  Validated IPC handlers
  window.ts               Hardened BrowserWindow
src/preload/index.ts      contextBridge API
src/renderer/             React UI
src/shared/               Types, IPC channels, validation, format, policy,
                          native bridge protocol constants
extension/                Chrome/Edge MV3 popup, context menu and native client
native/NativeHost.cs      C# native messaging host source
scripts/                  Native host build and current-user registration
tests/                    Vitest unit tests, bridge/host tests and optional
                          aria2 integration test
```

The built `native/dondownload-native-host.exe` is a local build artifact and is
git-ignored; compile it with `npm run build:native-host`.

## Known limitations

- DonDownload does not automatically resume interrupted transfers after a crash
  or relaunch. It marks them **Interrupted** so the user can decide; **Retry**
  re-adds them with continuation enabled. aria2's own session file is not used,
  so the original GID is not reattached after the process exits.
- A manually paused transfer cannot be unpaused in a new aria2 process. Its
  **Resume** action re-adds the transfer safely instead; the original GID is
  replaced in history.
- If SQLite cannot be opened, the app keeps working with an in-memory queue and
  logs a single non-sensitive error; history will not survive a relaunch in that
  fallback mode.
- aria2 determines the final file name from the server response; the name shown
  on a card can update after the first status poll.
- Removing a download from the list removes its history row but does not delete
  an already downloaded file.
- The tray does not add a launch-at-login entry. Closing the window keeps the
  current app session alive only until **Quit DonDownload** is chosen or the
  user signs out/restarts. If the tray cannot be created, closing the window
  quits as it did before so the app cannot become unreachable.
- The browser extension is manual-only. It does not detect downloads, intercept
  requests, change browser download settings, or offer video/media overlays.
- The native host must be registered separately for each browser profile/ID.
  Moving the unpacked extension folder changes its derived ID, so re-register
  after moving it.
- The bridge does not launch DonDownload. If the app is not running, the
  extension gets a prompt error and the user must start it.
- The bridge endpoint file is per-user and removed on a clean quit. After an
  abrupt crash it can remain until the next launch or manual deletion; it fails
  closed because the old port is no longer listening.
- Duplicate detection is intentionally conservative: only an exact canonical
  HTTP(S) URL match against an unfinished (queued, active, waiting or paused)
  history record is rejected. Different query strings, redirects or URLs that
  resolve to the same file are not treated as duplicates. **Download again**
  exists for a deliberate second copy.
