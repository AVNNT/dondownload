# Development status

As of 2026-11-04. Last checkpoint: `7a52684`
(`feat: checkpoint DonDownload Milestone 2A`). The Helium registration changes
described below are still uncommitted in the working tree.

## Current milestone

- **Milestone 1 foundation:** complete.
- **Milestone 2A (manual browser capture):** complete and locally verified.
  A Helium/Chrome/Edge-compatible Manifest V3 extension sends only an explicitly
  chosen HTTP(S) URL through the native messaging host to the loopback desktop
  bridge and the existing `DownloadManager.add` path.
- **Helium registration support:** implemented in the current working tree
  (uncommitted). The registration script now has an explicit `Helium` browser
  option that maps to the verified Chromium-compatible Chrome current-user key.
  Chrome and Edge keep their existing keys and behavior.
- **Helium duplicate/force/hidden verification:** complete. Manual checks in an
  isolated Helium profile confirmed the duplicate warning and explicit
  `Download again`, a genuine second transfer, and capture while the main window
  is hidden in the tray with the process and aria2 alive.
- **Milestone 2B (media overlay):** not started. There is no overlay code or UI
  in this checkpoint.

## Truly completed

- Milestone 1: Electron/React desktop app, real aria2 lifecycle and JSON-RPC,
  SQLite history, restart reconciliation, tray behavior, validated IPC, URL and
  file-name sanitization.
- Milestone 2A: manual popup and link context-menu capture, strict native
  messaging schema and URL validation, exact `allowed_origins`, loopback-only
  authenticated bridge, shared duplicate policy with explicit `Download again`,
  and current-user registration/unregistration for Chrome and Edge.
- Helium registration: explicit `-Browser Helium` mapped to
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`;
  unregister removes the same shared key and generated manifest. No
  Helium-specific registry key was added because none was verified as required.
- `-PrintRegistration` prints the resolved browser/key/manifest plan as JSON
  without writing to the registry or filesystem. It is used by the automated
  registration tests so they do not touch the real user profile.
- README now has Helium-first local setup instructions and retains Chrome/Edge
  notes for future installs, including the shared Helium/Chrome key caveat.
- Real Helium duplicate handling is verified: the active-transfer popup returned
  the exact message `This URL is already queued or downloading in DonDownload.
  Choose Download again only if you want a second copy.`, offered
  `Download again`, and the database held only one active row for the exact URL
  before the second click.
- Real Helium force-download is verified: clicking `Download again` while the
  first transfer was still active created a second active row for the same URL,
  with filenames `slow-page-run4.html` and `slow-page-run4.1.html`.
- Real Helium hidden-window capture is verified: after closing the DonDownload
  main window to the tray with `CloseMainWindow`, the process stayed alive, the
  window was invisible, the bridge endpoint file was present, and aria2 stayed
  alive. An actual Helium popup capture of `http://127.0.0.1:34523/` then
  completed in the database (54/54 bytes) while the window remained hidden.
- Real Helium registration is verified against the standard manifest: the exact
  extension ID `efakbfgkcnfjpomeejapmhpaihompngo` was registered through the new
  `-Browser Helium` script path to
  `C:\Users\PC\AppData\Roaming\DonDownload\native-messaging\com.dondownload.bridge.json`,
  and `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`
  points there with the exact origin only and the real built executable.

## Not complete / not claimed

- No Milestone 2B overlay or media detection exists.
- No automated test writes or removes a real HKCU registration. Tests validate
  the manifest and the resolved registration plan. The real registration/write
  path has now been manually exercised for Helium against the standard manifest;
  the explicit Helium unregister path is still covered only by plan-only tests
  and needs a manual check before it is claimed as verified.
- No commit or push was made for the Helium registration changes.
- The orchestrator reran the focused tests, typecheck and full suite against the
  current working tree; results are recorded below. One shell-wrapped extra
  PowerShell parser check command hit quoting trouble and is not claimed as
  passed; the parser check result is the prior implementation worker's report.
- The manual duplicate/force/hidden checks used a local-only slow fixture. Some
  initial attempts with a broken fixture produced error test rows, but the
  successful runs described above prove the acceptance criteria. The fixture,
  downloads and error rows are task-owned local test artifacts only; they do not
  involve personal files and were deliberately not reported or deleted.

## Local verification context

Environment:

- Helium executable:
  `C:\Users\PC\AppData\Local\imput\Helium\Application\chrome.exe`
- Helium 0.20.3.1 / Chromium 156.0.8078.79
- Extension ID: `efakbfgkcnfjpomeejapmhpaihompngo`
- Working current-user key:
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`
- Exact allowed origin: `chrome-extension://efakbfgkcnfjpomeejapmhpaihompngo/`

Manual checks performed for this status update, in an isolated Helium profile
using the actual extension, popup, native messaging, real DonDownload process and
aria2:

- **Duplicate warning:** loading an active transfer's popup again produced the
  exact message `This URL is already queued or downloading in DonDownload.
  Choose Download again only if you want a second copy.` and a `Download again`
  control; the database still had only one active row for
  `http://127.0.0.1:34523/slow-page-run4.html`.
- **Explicit second copy:** clicking `Download again` while the first transfer was
  active created a second active row for the same URL, with filenames
  `slow-page-run4.html` and `slow-page-run4.1.html`.
- **Hidden main window:** `CloseMainWindow` moved DonDownload to the tray; the
  process stayed alive, the window was invisible, the bridge endpoint file was
  present and aria2 was alive. A subsequent actual Helium popup capture of
  `http://127.0.0.1:34523/` completed in the database at 54/54 bytes while the
  window remained hidden.
- **Registration:** the exact Helium extension ID was re-registered with the new
  `-Browser Helium` script path to the standard manifest
  `C:\Users\PC\AppData\Roaming\DonDownload\native-messaging\com.dondownload.bridge.json`.
  The registry value
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`
  points at that manifest, `allowed_origins` contains the exact origin only, and
  the manifest targets the real built executable.
- Right-click context-menu capture was separately verified earlier and is not
  part of this duplicate/force/hidden run.

## Tests run for this change

The prior implementation worker reported the following for this working tree.
They were not rerun by the earlier status update, and the parser and
`-PrintRegistration` entries remain that worker's reports rather than
orchestrator reruns.

| Command | Result |
| --- | --- |
| `npx vitest run tests/native-host-registration.test.ts` | **12 passed**, 1 file |
| `npm run build:native-host` | **built** `native\dondownload-native-host.exe` (15,872 bytes) |
| PowerShell parser check on `scripts\register-native-host.ps1` | **OK**, no parse errors (worker report) |
| `register-native-host.ps1 -PrintRegistration -Browser Helium ...` | Resolved to the Chrome-compatible key; **no writes** |
| `register-native-host.ps1 -PrintRegistration -Unregister -Browser Helium` | Resolved to the same shared key; **no writes** |

The orchestrator then reran the following against the current working tree on
2026-11-04 after the preceding status update. These are actual rerun results:

| Command | Result |
| --- | --- |
| `npx vitest run tests/native-host-registration.test.ts tests/native-host.test.ts` | **29 passed**, 2 files (11:27:47) |
| `npm run typecheck` | **passed** (11:27) |
| `npm test` | **160 passed, 3 skipped**; 14 passed / 1 skipped files (11:28:44) |
| `git diff --check` | **passed**, no whitespace errors |

The 3 skipped tests are the optional real-aria2 integration tests, skipped
because `ARIA2_TEST_BINARY` was not set. The last historical full suite before
this change was 155 passed / 3 skipped; the current total is 160 passed / 3
skipped because this change added five registration tests. The full suite
includes the registration and native-host changes. One Vitest/Vite config
warning was emitted during the runs; it is informational and did not fail any
command.

A shell-wrapped extra parser check command had quoting trouble, so that specific
attempt is **not** claimed as passed. The PowerShell parser check result above is
the prior implementation worker's report.

## Known issues

- **No overlay yet.** Milestone 2B is unimplemented.
- **Shared Helium/Chrome key.** Helium and Chrome use one manifest and one
  current-user registry value. Registering either browser with a different ID
  list replaces the shared `allowed_origins`; include all required IDs in one
  command. Unregistering Helium removes the shared key, so re-register Chrome if
  it is still needed.
- **Registration tests are plan-only.** They deliberately avoid modifying HKCU.
  Real Helium registration against the standard manifest is manually verified;
  real unregistration is still a manual verification step and has not been
  re-checked in this update.
- **Helium version-specific evidence.** The verified path is Helium 0.20.3.1 /
  Chromium 156.0.8078.79. Other Chromium forks and future Helium builds are not
  verified, and no speculative keys should be added.

## Model handoff status

Standby **Plan-only**. This is **not** a runnable execution handoff: it contains
no claim that implementation or verification is already running. The manual
Helium duplicate/force/hidden checks are complete, and the orchestrator has rerun
the focused tests, typecheck and full suite successfully. The remaining work is
review and a local checkpoint commit. No agent should infer permission to start
Milestone 2B implementation or to make overlay/UI changes from this status;
only planning or delegation may begin after the commit.

## Safe next action

1. Review the uncommitted Helium registration changes in
   `scripts/register-native-host.ps1`, `README`, tests and `build/native`
   comments.
2. Create a local checkpoint commit for the reviewed Milestone 2A registration
   update while the last checkpoint remains `7a52684`. The focused tests,
   typecheck and full suite have already been rerun by the orchestrator; rerun
   only if the reviewed diff changes.
3. Only after that commit, begin Milestone 2B planning or delegation. Do not
   start Milestone 2B implementation, add overlay code, push or create a release
   in this checkpoint.
