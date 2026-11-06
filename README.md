# DonDownload

A Windows-first, open-source download manager for ordinary HTTP(S) downloads.
This repository contains the **Milestone 1 foundation** (a working Electron
desktop app with a React renderer, a real aria2 engine, durable SQLite download
history, conservative restart reconciliation, and a Windows tray) plus
**Milestone 2A**: an optional Helium/Chrome/Edge Manifest V3 extension for
**manual** HTTP(S) capture through a strict native messaging bridge, and
**Milestone 2B**: an opt-in, per-site playback overlay for verified progressive
MP4/WebM-family sources, detected HLS/DASH manifests and explicit yt-dlp page
analysis for blob/MSE players, plus optional permission-gated browser file
hand-off. The local setup was previously verified with Helium 0.20.3.1
(Chromium 156.0.8078.79); Chrome and Edge remain supported for future installs.

The UI is deliberately small: an OLED-black, centered (~800 px) layout with a
compact top bar, a Quick Add form, and download cards with live status,
progress, speed, ETA, pause/resume, bounded retry, and open-in-folder. History
is stored locally and survives relaunches.

## Requirements

- Windows 10/11 (the primary target)
- Node.js 24+ (developed with Node 24.19; Electron 45 bundles Node 24.22 and
  SQLite 3.53 through the built-in `node:sqlite` module)
- npm 10+
- **aria2c** available locally for a development checkout (installed, not built
  from this repository — see licensing below). The Windows installer stages its
  pinned tools, including aria2, from `build/vendor` when `npm run
  build:installer` is used.
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
npm run test:fast # Tier 1: hermetic unit/component tests
npm test          # Tier 3: full Vitest suite (compatibility command)
npm run test:gate # Tier 3: full suite + typecheck + production build
npm run typecheck # main/preload and renderer TypeScript projects
npm run lint      # ESLint flat config (src, tests, extension, scripts)
npm run build     # typecheck + electron-vite production build
npm run build:native-host # optional: compile the browser native messaging host
npm start         # preview an existing production build
```

Focused process/native-host and optional real-aria2 checks are separated from
the fast loop. See [docs/testing-workflow.md](docs/testing-workflow.md) for the
tier table, subsystem commands, measured durations and input-isolation rules.

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

The `extension/` folder is a Chromium-compatible Manifest V3 extension (verified
locally with Helium 0.20.3.1 / Chromium 156.0.8078.79) that sends an explicitly
chosen HTTP(S) URL to the running desktop app. Manual capture stays available:

- Manual capture uses `activeTab`, `contextMenus` and `nativeMessaging`. The
  optional 2B overlay adds `scripting`, `storage` (session-only pending state)
  plus declared `optional_host_permissions`, but there are still no required
  host permissions and no always-on content scripts. `downloads` and
  `webRequest` are optional permissions requested only from the options page on
  a user gesture; there are no required `downloads`, `webRequest`,
  `notifications`, `cookies`, history or `tabs` permissions.
- The popup has an explicit **Download with DonDownload** action for the active
  page, lists progressive sources reported by that tab's own content script,
  and links to the separate settings page.
- Right-clicking a link shows **Download with DonDownload**.
- It never intercepts or blocks network requests. Playback capture is opt-in
  per site. An optional, off-by-default `webRequest` grant lets the worker
  observe response status and only four headers for exact opted-in media
  responses; it never reads cookies, credentials, request headers, bodies or
  DRM data and makes no extra requests. Automatic browser hand-off is off until
  the optional downloads permission is approved, and the browser's download is
  cancelled only after a durable desktop receipt and a bounded anonymous
  preflight confirms matching size/type metadata; this is not byte-for-byte
  identity proof and real-browser interception still needs verification.
- The video overlay is off by default for every site. It queues verified
  progressive sources, detected HLS/DASH manifests and completed yt-dlp
  analyses. See [opt-in video overlay](#browser-extension-opt-in-video-overlay-milestone-2b).
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

### 2. Load the unpacked extension (zero-config)

DonDownload now registers its native messaging bridge automatically on every
launch. The extension also pins a stable public key, so its ID no longer depends
on the folder it was loaded from:

**Fixed extension ID:** `mikinloaillialkiannpcejdbmfbljhm`

1. Start DonDownload once. It writes
   `%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.json` and the
   current-user Chrome/Helium and Edge registry keys. The app may be hidden in
   the tray.
2. Open the app's **Settings → Browser extension** panel. It shows the exact
   extension folder and connection state for Chrome, Helium and Edge.
3. In Helium, open `chrome://extensions` (Helium is Chromium-based and uses
   Chromium's standard extension manager). In Chrome, open
   `chrome://extensions`; in Edge, open `edge://extensions`.
4. Turn on **Developer mode**.
5. Choose **Load unpacked** and select the folder shown in the panel
   (packaged: `<install>\resources\extension`; development: the repository's
   `extension` folder). If needed, use **Open folder** or **Copy path** there.
6. The extension's welcome page opens on first install. It checks the native
   connection and links to the same fixes if the app is not running yet.

No extension ID needs to be copied or typed. If a browser still shows
**Needs repair**, choose **Repair browser connection** in that Settings panel.
The panel also exposes the native host path, the exact `allowed_origins` and
the last registration error.

The generated manifest keeps only valid exact
`chrome-extension://<32 a-p characters>/` origins from an existing manifest and
adds the fixed ID. It never contains a wildcard. Registry writes are current-user
only (no administrator rights) and are skipped when the existing value already
matches.

### 3. Advanced fallback: register manually

The app-level registration above is the normal flow. `register-native-host.ps1`
is retained for advanced or legacy setups, offline recovery and explicit
inspection. It defaults to the fixed ID, so the common commands no longer need
`-ExtensionId`.

Helium (the verified local browser):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Browser Helium
```

Chrome and Edge:

```powershell
# Chrome only:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Browser Chrome

# Edge only:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Browser Edge

# Chrome and Edge:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Browser Both
```

Pass `-ExtensionId` only for an advanced setup where the loaded extension is
not the pinned manifest. IDs are comma-separated and validated as lowercase
`[a-p]{32}`; wildcards are rejected. Helium and Chrome share the
Chromium-compatible key, so include every extra ID in one command if you use
both.

The script:

- writes the same `%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.json`
  manifest with explicit `allowed_origins` entries such as
  `chrome-extension://<id>/` (never `*`);
- requires the manifest `path` to be a real `.exe`;
- writes current-user registry values:
  - Helium: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`
    (the Chrome-compatible key verified locally with Helium 0.20.3.1;
    no Helium-specific key is written)
  - Chrome: the same `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`
  - Edge: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dondownload.bridge`
- does not require administrator rights;
- is safe to run repeatedly.

Inspect the manifest without writing anything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -PrintManifest
```

Show the resolved registry keys and manifest path without writing anything,
including Helium's shared-key mapping:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -PrintRegistration -Browser Helium
```

Remove registrations and the generated manifest:

```powershell
# Helium: removes the shared Chrome-compatible key and the manifest.
# If Chrome also uses that key, re-register Chrome afterwards.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Unregister -Browser Helium

# Chrome and Edge: also removes Helium's shared registration.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 `
  -Unregister -Browser Both
```

If you used a custom `-ManifestPath`, pass the same path when unregistering.
Reload the extension (or restart the browser) after registering.

The NSIS uninstaller runs
`"$INSTDIR\DonDownload.exe" --unregister-native-host` and waits for it. That
mode removes both registry keys and the manifest only when the manifest `path`
is inside the installed application folder. A development registration that
points at the repository is deliberately left alone.

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
  the badge. DonDownload registers automatically at startup; choose **Repair
  browser connection** in Settings or restart the app if this still appears.
- Extension ID not in `allowed_origins`: the browser reports native host access
  as forbidden. The fixed ID is registered automatically; use the Settings
  **Repair browser connection** action, or the advanced registration script.
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

## Browser extension: opt-in progressive playback capture

The overlay attaches a small **DD** button to a playing video. It accumulates
the exact verified progressive MP4/WebM-family sources exposed by that player;
decoded dimensions may label a proven URL but never prove a download source.
Each row has one Download action and queues through the authenticated native
bridge with durable SQLite acceptance. Optional `webRequest` response evidence
can verify extensionless progressive sources and exact sizes. Detected HLS/DASH
manifests are listed and downloaded through the fixed yt-dlp path, and a
blob/MSE player gets an explicit **Find qualities** analysis; a visible embed
can be analyzed too, but the overlay is never injected into a cross-origin
iframe. See [`docs/automatic-browser-handoff.md`](docs/automatic-browser-handoff.md)
for permissions, focused tests and current limits.

The overlay is **off by default** and applies only to sites you explicitly
enable. If a site is not opted in, no overlay script or UI exists there.

Earlier live Helium checks are historical evidence only. The latest playback
capture and hand-off changes have focused local tests, but real Chromium request
observation, Downloads API behavior, Native Messaging integration and Helium
video capture have not been verified for this checkpoint.

### Permission and privacy design

- **No always-on all-sites content script.** The manifest has no
  `content_scripts` entry and no `<all_urls>` access.
- The manifest declares `optional_host_permissions` for `http://*/*` and
  `https://*/*`. This is only a declaration required by Chromium before it will
  let the extension *ask*; it grants nothing by itself.
- The popup asks for **one exact origin** (for example
  `https://example.com/*`) from a user click on **Enable on this site**. Chrome
  or the Chromium fork may show its normal per-site permission prompt. If the
  request is denied, no overlay is injected and nothing on the page changes.
- `scripting` is used only to register a content-script registration whose
  `matches` array contains that exact origin and to inject the ordered overlay
  files into the current tab after the grant (`overlay-core.js`,
  `overlay-runtime.js`, `overlay-ui.js`, `overlay-qualities.js`,
  `overlay-capture.js` and `overlay.js`). It is not used for broad script
  execution or page-data collection.
- `storage` is used only for `chrome.storage.session`: one pending exact
  origin/tab while the browser shows the permission prompt, and a short-lived
  map of tab ids already running the overlay so an external revoke can notify
  them. The pending entry is cleared when the grant is applied, denied or
  revoked; the tab map is pruned on tab close and on disable/revoke. Both
  disappear when the browser exits. No page content, full page URLs or download
  data are stored; only the exact granted origins and tab ids described here.
- The registration runs in the **isolated world**, top frame only, with
  `allFrames: false` and `persistAcrossSessions: true`. The popup grants no
  persistent broad host access.
- **Success is verified, not assumed.** After registering, the worker injects
  the overlay and runs a page-side probe that requires the overlay host, its
  shadow-root button, and a healthy overlay runtime. The popup shows **On** and
  its success copy only when both the per-site registration and that in-page
  probe succeed.
- **The permission prompt closes the action popup.** Chromium/Helium 0.20.3.1
  (Chromium 156) closes the popup as soon as the Allow/Deny prompt is shown, so
  the popup's request callback cannot be relied on to run the follow-up work.
  Before requesting, the popup records the exact origin and tab in
  `chrome.storage.session`; a top-level `chrome.permissions.onAdded` listener in
  the service worker finishes the registration and injection when the grant
  arrives. Opening the popup again also re-checks and re-applies an existing
  grant for the current tab, so a popup that was closed by the prompt cannot
  leave the site looking enabled with nothing on the page.
- **Turn off on this site** (in the popup or the overlay panel) unregisters that
  exact-origin content script, calls `chrome.permissions.remove` for the same
  origin pattern, and verifies that both the stored registration and the grant
  are actually gone. Only then does the popup show its success copy. If either
  removal fails or cannot be verified, the worker returns
  `OVERLAY_DISABLE_INCOMPLETE` with the individual `registrationRemoved` and
  `permissionRemoved` values, and the popup reports the failure instead of
  claiming site access was removed.
- **External revoke** (removing the origin from browser extension settings)
  unregisters the exact-origin registration and sends an origin-scoped teardown
  message to tabs already running the overlay. There is no `tabs` permission and
  no broad host grant, so the worker cannot query same-origin tabs after the
  grant is gone; it uses the session-only tab map populated by enable/sync and
  the content script's own ready announcement. This is best effort: a tab that
  was never tracked loses the overlay on its next reload, because the
  registration is already gone.
- The required permissions contain **no** `downloads`, `webRequest`,
  `webRequestBlocking`, `cookies`, history, `tabs` or notifications permission.
  `downloads`, `webRequest` and `cookies` are optional and requested only from
  the options page on a direct user gesture. Media detection runs **only** on
  exact origins the user enabled, or on all sites only after the separate
  all-sites switch and broad optional host grant. It observes response metadata
  (URL, status, Content-Type/Length/Range), never request headers, bodies,
  credentials, DRM data or MSE segment content.
- On an enabled site the worker lists detected video/audio files and HLS/DASH
  manifests in the toolbar popup and overlay. Range requests to the same file
  collapse to one row, segments are hidden, small/tracker responses are ignored,
  and a master HLS playlist is preferred over its variants. The user picks a
  row or HLS variant and one click queues it. YouTube keeps using the yt-dlp
  page analysis because its range/SABR streams are not standalone files.
- The overlay also observes an actual playing video element's `currentSrc`
  after playback starts. With the separate optional `webRequest` grant, the
  worker may attach exact response evidence (status, Content-Type,
  Content-Range, Content-Length, Content-Encoding) for that same URL in an
  opted-in top frame. A `blob:`/Media Source or HLS/DASH source is never guessed:
  the worker reports it as unsupported for direct capture and the overlay offers
  an explicit **Find qualities** analysis, which may use yt-dlp. See
  `docs/automatic-browser-handoff.md` and
  `docs/media-capture-progressive.md` for the evidence limits.
- **Cookies are off by default for every site.** The options page has a
  per-exact-origin opt-in that also requests the optional `cookies` permission.
  Only then does the worker read that site's cookies: for the detected media URL
  when a detected item is queued, and for the page (or its embedded player) when
  the overlay analyzes the page or queues a yt-dlp quality. The app passes the
  header to aria2 or converts it to a short-lived Netscape file for exactly one
  yt-dlp child, then deletes it; it is never persisted or logged. The cookie
  choice is part of the analysis identity, so analyze and queue must agree.
  Leaving the toggle off means no cookie is ever read.

**Tradeoff:** Chromium's optional-permission model cannot declare "any exact
origin the user might choose later" without declaring broad optional patterns
in the manifest. The implementation therefore declares the two HTTP(S) optional
pattern families but requests only a canonical exact origin. The user still sees
and approves the narrow per-site prompt, and a site with no grant receives no
content script. If a future Chromium version cannot request an exact-origin
subset from these declared patterns, the extension reports the failure rather
than silently widening access.

**Non-default ports:** an exact origin such as
`http://127.0.0.1:34526` is a valid match pattern for both the optional host
grant and `chrome.scripting.registerContentScripts` in Helium 0.20.3.1 /
Chromium 156. The implementation keeps the port in the permission request and
in the persistent registration (`http://127.0.0.1:34526/*`), and reload injection
was verified against that pattern. No port-stripped or broader fallback is used.

### What the overlay does

- Shows a 30 × 30 px OLED-black floating button on the active playing video,
  also usable on hover, leaving native player controls (usually at the bottom)
  available. The button can be dragged and remembers its relative position per
  origin.
- Uses an open **Shadow DOM** with isolated CSS, so page styles and overlay
  styles do not leak into each other.
- Handles dynamically inserted and removed videos through DOM event delegation
  and a `MutationObserver`; repositions on scroll, window resize, video resize
  and fullscreen transitions.
- Clicks and pointer-downs inside the overlay stop propagation and prevent the
  default action, so normal bubble-phase player handlers do not see them and
  using the overlay does not toggle play/pause or trigger player shortcuts. A
  page that installs its own capture-phase document listener before the overlay
  could still observe the event, as with any in-page UI.
- **Keyboard:** no default shortcut is declared, so it cannot conflict with a
  page or browser hotkey. Set one at `chrome://extensions/shortcuts`; the
  command toggles the overlay for the active tab. `Escape` closes the panel and
  returns focus to the button.
- Respects `prefers-reduced-motion: reduce` by removing transitions.
- The expanded panel shows the progressive sources this exact player actually
  played, detected HLS/DASH manifest rows, and explicit **Find qualities**
  analysis results, with one Download action per row. Every entry comes from the
  player, the response sniffer or a completed yt-dlp analysis; nothing is
  invented.
- Existing manual popup/right-click HTTP(S) capture and the exact-origin Native
  Messaging bridge are unchanged.

### Manual Helium check for Milestone 2B

Keep the existing unpacked extension folder and its derived ID; do not remove
the extension. These steps assume the local Helium setup described above.

1. Open `chrome://extensions` in Helium and reload the unpacked DonDownload
   extension so the new manifest is read. Confirm the extension still shows the
   expected ID and no new required site access.
2. Open a normal `http://` or `https://` page that contains a video. The overlay
   is off until you opt in.
3. Open the DonDownload popup, then choose **Settings & site access**. Under
   **Site access**, confirm the state is **Site access off**, then click
   **Enable overlay on this site** and accept the browser's prompt for that
   exact site. Reload the page if needed, then reopen Settings to confirm
   **Overlay on** only when it was actually verified. If it says not verified,
   reload the page and check again.
4. Hover or start the video. A small **DD** button should follow the active
   playing player. The video must not start or pause because of the hover or
   button click.
5. Click **DD**. The compact panel lists only detected progressive sources; pick
   one only if you want to queue it. Close it with `Escape` or by clicking
   outside.
6. If you set a command shortcut at `chrome://extensions/shortcuts`, it should
   toggle the panel for the active tab without starting playback.
7. Click **Turn off overlay on this site** in the panel, or use the options
   page's **Turn off overlay on this site** action. The button should disappear,
   and `chrome://extensions` site access for that origin should no longer show a
   grant. Reload the page and confirm the overlay does not return. If either
   removal fails, the options page must show an error, not the success message.
8. To check the external-revoke path, enable the site again, keep the page open,
   then remove that origin's site access from `chrome://extensions`. The overlay
   on the open page should disappear without a reload when that tab was tracked;
   a reload must not bring it back. A tab that was never tracked may keep the UI
   until its next reload, which is the documented best-effort limit.
9. Repeat the existing Milestone 2A popup and right-click capture checks; the
   manual capture path must behave exactly as before.

Restricted pages such as `chrome://`, `edge://`, the Chrome Web Store, and
`file://` are not eligible. Videos inside cross-origin iframes are not covered
by the top-frame registration.

## Testing

The fast development tier is hermetic and needs no network, Electron launch or
aria2 binary:

```powershell
npm run test:fast   # Tier 1: unit/component/policy tests
npm run test:gate   # Tier 3: full suite + typecheck + production build
npm run typecheck
```

`npm test` remains the full suite. The native-host process tests, including its
22 s bridge-timeout regression, and the optional real-aria2 tests are Tier 2:

```powershell
npm run test:integration          # native host + registration + optional aria2
npm run test:native-host          # routine native-host tests, 22 s test skipped
npm run test:native-host:timeout  # only the 22 s regression
npm run test:aria2                # optional; skips without ARIA2_TEST_BINARY
```

See [docs/testing-workflow.md](docs/testing-workflow.md) for tier commands,
subsystem filters, historical and current timings, the strict no-desktop-input
rule, manual-only real-browser permission checks, and the mocked-renderer vs
native-Electron-IPC distinction.

GitHub Actions runs `npm run lint`, `npm run typecheck`, the full Vitest suite and
`electron-vite build` on `windows-latest` with Node 24
(`.github/workflows/ci.yml`).

The opt-in production smoke test launches a packaged/unpacked build against a
fresh isolated userData directory and reports machine-readable PASS/FAIL
details. It never shows a window, creates a tray, starts the browser bridge,
uses OS input or touches the normal profile. See
[docs/smoke-test.md](docs/smoke-test.md) for the exact command, checks and
limits:

```powershell
npm run build
npx electron-builder --win --x64 --dir
npm run smoke:packaged
```

The browser-bridge tests cover frame lengths and limits, strict schemas, URL
validation, exact allowed-origin manifest generation, unavailable-app responses,
oversized bodies and duplicate responses that never claim acceptance. The real
native-host tests run when `native\dondownload-native-host.exe` has been built;
the registration tests (including Helium's explicit Chrome-compatible key
mapping and unregister planning) run on Windows.

The 2B overlay tests run hermetically without a browser. They cover the exact
per-site permission policy (including preserving a non-default localhost port),
the absence of required host/all-sites access, video geometry/detection and
observer pruning, trigger and panel placement, Shadow DOM/observer/reduced-motion
wiring, click propagation guards, the keyboard path and typing guard,
disable/revoke messaging, and the truthful "format/quality unavailable" panel
copy. Mocked Chrome API tests cover the enable lifecycle: no grant means no
registration or injection; a failed page-side verification never becomes
success; a registration that does not persist fails visibly; the pending
request plus `permissions.onAdded` path completes when the popup was closed by
the prompt; reopening the popup re-syncs an existing grant; disable removes the
registration, grant and page UI; external revoke notifies only tracked
same-origin tabs and rejects cross-origin ready announcements; a late-ready
document whose grant was already revoked is torn down; a failed unregister or
permission removal returns explicit partial-failure fields instead of success,
while a concurrent `onRemoved` that already finished still verifies as
successful; and status copy shows **On** only for a verified registration plus
injection. A source guard also fails if the page-facing overlay starts reading
media sources, using `downloads`/`webRequest`, or calling `play()`/`pause()`.
The optional network observer is isolated in `extension/network-evidence.js`.

An optional end-to-end test drives a real aria2 process against a local
throttled HTTP server that implements Range requests. It checks full HTTP
completion, real pause/resume to exact bytes, and restart recovery through the
real DownloadManager and a temporary SQLite database. It is skipped unless you
point it at a test binary (the binary remains in your temp/tools folder and is
not redistributed):

```powershell
$env:ARIA2_TEST_BINARY = 'C:\tools\aria2\aria2c.exe'
npm run test:aria2   # focused real-aria2 integration
npm test             # full suite also picks it up, including the native host

# Or run the file directly:
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
Browser extension (MV3, manual capture + opt-in progressive playback capture + optional safe hand-off)
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
- The browser extension's capture path is manual by default. It never requires
  the `downloads` permission; optional automatic hand-off is off until the user
  approves it and only handles supported non-media files after a durable desktop
  receipt.
- The overlay is opt-in per exact origin and captures supported progressive sources.
  It has no required host permissions and no always-on content script.
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

- Helium/Chrome/Edge-compatible Manifest V3 extension whose manual capture path
  uses `activeTab`, `contextMenus` and `nativeMessaging`: an explicit popup
  action and a link context menu. No downloads/webRequest interception, no
  notifications permission. (Milestone 2B adds `scripting` and optional host
  declarations for the opt-in overlay only.)
- Toolbar badge and popup feedback that report success only after the desktop
  app accepts the URL, with actionable errors for unsupported URLs, missing
  native host, unauthorized extension origin, connection failure and app
  failure.
- A real C# Windows native messaging executable built with the .NET Framework
  compiler (no SDK), using standard bounded length-prefixed UTF-8 JSON framing,
  strict schema/type/URL validation, stderr-only diagnostics and no URL logging.
- Repeatable current-user PowerShell registration/unregistration for Helium,
  Chrome and Edge with exact, validated `allowed_origins`; no wildcard and no
  admin rights. Helium is an explicit option that maps to the locally verified
  Chromium-compatible Chrome key; no unverified Helium-specific key is written.
- Zero-config registration on every normal app start: a stable pinned extension
  ID, an atomically written manifest, and idempotent current-user registry
  values for Chrome/Helium and Edge. The Settings UI reports per-browser state,
  host path, allowed origins and the last error, and can repair the connection.
  The uninstaller removes only a registration that points inside the installed
  application folder.
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

## Implemented in the opt-in video overlay

- A player-attached overlay with an OLED-black 30 × 30 px button, expandable
  panel, Escape close, reduced-motion handling and Shadow DOM-isolated CSS. The
  extension command is user-configurable at `chrome://extensions/shortcuts`;
  there is no hard-coded browser-conflicting key.
- Per-site opt-in from the popup: exact-origin optional host permission,
  exact-origin isolated-world content-script registration, immediate injection
  into the active tab, and explicit disable/revoke that unregisters the script
  and removes the site grant.
- The permission-prompt lifecycle is handled explicitly: Chromium closes the
  action popup when the prompt appears, so the exact origin/tab is recorded in
  `chrome.storage.session` and a `permissions.onAdded` listener in the service
  worker completes registration and injection. Reopening the popup re-syncs an
  existing grant. The popup shows **On**/success only after a page-side probe
  confirms the overlay host and runtime; a bare grant shows **Not ready**.
- Exact origins with non-default ports are preserved in both the grant and the
  persistent registration (verified with `http://127.0.0.1:34526`).
- Dynamic video support through delegated pointer events and a
  `MutationObserver`, with repositioning on scroll, resize and fullscreen.
- Interaction guards so overlay clicks never reach the page player and never
  call `play()`/`pause()`.
- Truthful UI: the panel lists only sources and qualities it actually verified
  (player playback, the response sniffer or a completed yt-dlp analysis) and
  states unavailable formats honestly instead of inventing them.
- Focused hermetic tests for permission policy, detection/observer behavior,
  placement, interaction guards, keyboard access, disable/revoke flow and the
  unavailable-state copy.

## Deferred (not implemented)

These are intentionally **not** claimed by these milestones:

- Automatic aria2 session restore (DonDownload marks lost transfers as
  interrupted instead of pretending they are still running).
- Notifications, auto-start/launch-at-login, or background services.
- Clipboard monitoring and drag-and-drop capture.
- DRM/auth/CAPTCHA bypass, injected playback inside cross-origin iframes (a
  visible embed can still be analyzed through yt-dlp), and unverified stream
  reconstruction. The extension supports exact progressive sources, detected
  manifests and completed analyses; optional response evidence does not inspect
  credentials or bodies.
- BitTorrent, magnet links, Metalink, scheduling, bandwidth limits.
- Installer code signing (release builds are currently unsigned).
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
  media/engine.ts         Media engine public surface and download lifecycle
  media/analysis.ts       yt-dlp analysis, format parsing and bounded display text
  media/staging.ts        Staging directory, final-name reservation and cleanup
  media/progress.ts       yt-dlp progress parsing
  media/collections.ts    Ephemeral playlist previews and entry resolution
  media/toolchain.ts      yt-dlp/FFmpeg/Deno probing and versions
  nativeBridge/server.ts  Authenticated loopback browser bridge
  nativeHost/registration.ts Zero-config native messaging manifest/registry
  lifecycle.ts            Pure tray close/quit policy
  tray.ts                 Windows tray icon, menu and restore actions
  assets/tray.ico         Multi-resolution Windows tray icon
  ipc.ts                  Validated IPC handlers
  window.ts               Hardened BrowserWindow
src/preload/index.ts      contextBridge API
src/renderer/             React UI
src/shared/               Types, IPC channels, validation, format, policy,
                          native bridge protocol constants
extension/                Helium/Chrome/Edge MV3 popup, context menu, native client
                           and opt-in progressive playback capture overlay
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
- The browser extension's capture path is manual by default. It does not
  intercept or block requests or change browser download settings. Optional
  automatic hand-off requires the user to grant `downloads`, applies only to
  supported non-media files, and leaves the browser transfer running on any
  uncertainty. The desktop additionally performs one bounded anonymous range
  GET before cancelling the browser's copy, so authenticated or POST-only
  transfers are left running.
- The 2B video overlay is **opt-in per exact origin** and off by default per
  site. It observes only an actual playing element's `currentSrc` after
  playback. A separate optional, off-by-default `webRequest` grant adds exact
  response evidence for the same URL and nothing else; it does not read request
  headers/cookies/credentials/bodies, decode media, or bypass DRM,
  authentication or CAPTCHAs. Segmented Media Source and HLS/DASH playback is
  never guessed: only detected manifests and completed yt-dlp analyses are
  offered.
- The overlay is registered for the top frame of the exact granted origin only.
  Videos inside cross-origin iframes are not covered, and restricted pages such
  as `chrome://`, `edge://`, the Chrome Web Store and `file://` are ineligible.
- Chromium closes the action popup as soon as its permission prompt is shown.
  Accepting the prompt still enables the tab through the extension worker, but
  the popup itself cannot show the result while it is closed; reopening it
  re-checks and shows **On** only when the overlay is verified, otherwise
  **Not ready** with a reload hint.
- The manifest must declare broad optional HTTP(S) pattern families before the
  extension can request a single exact origin; declaring them grants nothing.
  The user still approves the per-site prompt, and disabling removes that site's
  grant and registration. If an exact-origin request is unsupported by a future
  browser build, enabling fails visibly instead of widening access.
- The native host must be registered separately for each browser profile/ID.
  Moving the unpacked extension folder changes its derived ID, so re-register
  after moving it.
- Helium is verified locally with 0.20.3.1 / Chromium 156.0.8078.79 using the
  Chrome-compatible current-user key. No Helium-specific key is written, and
  other Chromium forks or future Helium builds are not verified.
- Helium and Chrome share one current-user key and manifest. Registering either
  one with a different ID list replaces the shared `allowed_origins`, so include
  all IDs in one command. Unregistering Helium removes the shared key; re-register
  Chrome afterwards if Chrome is still needed.
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
