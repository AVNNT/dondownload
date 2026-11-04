# Development status

As of 2026-11-04. Milestone 2B checkpoint: `e15c772`
(`feat: complete per-site video overlay milestone`), following the Milestone 2A
checkpoint `f03886d`. The Milestone 2B overlay work is complete and locally
verified. Milestone 3A is **PASS** at `e7e28ee`, verified end to end in a headed
Helium run against that HEAD. Milestone 3B has started in planning; no 3B
implementation is present.

## Current milestone

- **Milestone 1 foundation:** complete.
- **Milestone 2A (manual browser capture):** complete and locally verified.
  A Helium/Chrome/Edge-compatible Manifest V3 extension sends only an explicitly
  chosen HTTP(S) URL through the native messaging host to the loopback desktop
  bridge and the existing `DownloadManager.add` path.
- **Helium registration support:** committed at `f03886d`. The registration
  script keeps its explicit `Helium` option mapped to the verified
  Chromium-compatible Chrome current-user key.
- **Milestone 2B (per-site video overlay): COMPLETE and locally verified.**
  The overlay, per-site opt-in/revoke flow, truthful UI-only panel, regression
  tests and docs are implemented. A headed Helium run now shows the DD button
  after the real permission flow, injects it after reload, supports
  hover/click/keyboard/disable, and external revoke tears down an already-open
  tracked tab without a reload. This commit is the local checkpoint; no push or
  release was made.
- **Milestone 3A (media analysis and download): PASS at `e7e28ee`.**
  Additive media contracts and SQLite v2 persistence are integrated at
  `e76055f`; review fixes rejecting credential-bearing media URLs and adding a
  safe job title are at `f55b0fc`. Media option validation and desktop UI are
  integrated at `d0f5049` and `eae3e3f`; persistent job orchestration and IPC are
  integrated at `eb099b8` with an API-alignment fix at `8f3b2f1`. The
  yt-dlp/FFmpeg engine is integrated at `2923489`; review fixes for FFmpeg path
  passing, public stream filtering, DNS revalidation and preserving partial
  files are at `a747c67`. `index.ts` startup and conservative shutdown recovery
  are wired at `1954022`. The authenticated Helium/native media bridge and
  overlay are integrated at `318aaa5`, with the media manager connected as its
  target. Extension-side DTO validation enforces the shared audio/video
  invariants. Follow-up fixes for post-processing markers, bridge timeouts,
  duplicate jobs, analysis/cancel shutdown and cancelled downloads are at
  `9e4651e`, `8a39b47`, `16e61b2`, `dda951e` and `852b074`; the overlay quality
  radio and popup copy fixes are at `5b6d3d4`. The post-`5b6d3d4` headed Helium
  retest completed at `e7e28ee` and passed the selected/best workflow end to end.
  Current verified baseline: **372 tests passed / 0 skipped** with
  `ARIA2_TEST_BINARY` set, including 3/3 real-aria2 integration tests;
  typecheck, production build and native-host build pass. yt-dlp 2026.10.26,
  Gyan FFmpeg/ffprobe 9.0.2 and Deno 2.9.8 were used for the real runs; exact
  paths and licensing notes are in [media-tools.md](media-tools.md).
- **Milestone 3B: started — planning only.** No 3B source, schema or product
  scope is implemented in this tree yet. Milestone 3A is closed as PASS on the
  evidence recorded below.

## Root cause of the reported Milestone 2B failure

The first delegated report claimed that enable/injection succeeded. A real
Helium run contradicted it: after clicking **Enable on this site**, accepting
the prompt, and reopening the popup, the popup showed **On** with the copy
“Overlay enabled for 127.0.0.1:34526…”, yet the page still reported
`NO OVERLAY HOST`, and a reload did not inject anything.

Confirmed root cause:

1. **Chromium closes the extension action popup when it opens the optional
   permission prompt.** In Helium 0.20.3.1 / Chromium 156, clicking **Enable on
   this site** immediately closed the popup and showed the browser’s
   `"DonDownload Capture" has requested additional permissions` bubble.
2. The old implementation performed the registration and `executeScript`
   injection only in the `chrome.permissions.request` callback in the popup.
   Because that popup context was destroyed, the follow-up
   `dondownload:overlay-enable` message never ran. The grant was saved, but no
   content-script registration and no injection occurred.
3. The old popup treated `chrome.permissions.contains(...) === true` as
   **On** and displayed the “Overlay enabled for … Hover a video …” hint from
   the grant alone. That is why the popup looked successful while the page had
   no overlay and reloads had nothing to run.

This also explains the reload failure: with no registration, there was no
persistent exact-origin content script.

A separate question was whether an exact origin with a non-default port is
valid for `chrome.scripting.registerContentScripts`. It is: on the same Helium
build, `http://127.0.0.1:34526/*` was stored as a persistent registration,
injected after a real reload, and `chrome.permissions.contains` returned true
for exactly that ported origin while returning false for
`http://127.0.0.1/*`. No port-stripped or broader fallback is used.

## Fixes in the working tree

- Added `extension/overlay-controller.js`, a Chrome-API-injected lifecycle
  module so the whole enable/sync/disable flow is testable with a fake browser:
  - Validates the canonical exact origin and the exact-origin grant.
  - Registers or updates the one exact-origin isolated-world content script and
    then reads the stored registration back to verify its shape.
  - Injects `overlay-core.js` + `overlay.js` into the current tab only when the
    tab is still on the granted origin.
  - Runs a page-side `executeScript` probe that requires the overlay host, its
    shadow-root `.trigger`, and a healthy `__dondownloadOverlayRuntime`.
  - Returns `registered` and `injected` separately, so callers cannot confuse a
    host grant with a working overlay.
  - Deduplicates concurrent enable attempts for the same origin/tab.
  - Disable removes the registration, removes the exact-origin grant, clears
    pending state, notifies all same-origin tabs, and verifies both removals
    before returning success.
  - `permissions.onRemoved` also drops an orphaned registration and notifies
    already-open content scripts for tracked same-origin tabs.
- Permission-prompt lifecycle:
  - Before requesting, the popup records the exact origin and tab with
    `chrome.storage.session` (`rememberPendingEnable`).
  - The background worker now has top-level `chrome.permissions.onAdded` and
    `chrome.permissions.onRemoved` listeners. `onAdded` reads the pending exact
    origin/tab and performs the same registration + injection + verification,
    even though the action popup has been closed.
  - Pending state expires after five minutes and is cleared on success, denial
    or revoke.
- Popup behaviour:
  - On open, if the exact origin is already granted, the popup sends a sync
    request that re-applies the registration and verifies the current tab. This
    heals the “granted but page never injected” state on the next popup open.
  - The state badge is **On** only when the response says
    `granted && registered && injected`; otherwise it shows **Not ready** with
    a reload hint. A bare grant is never rendered as success.
  - The success status line is set only after the verified result.
  - The status wording is generated by the pure `describeOverlayStatus` helper,
    which is unit-tested to never turn `granted && !ready` into “Overlay is on”.
- Added the `storage` permission for `chrome.storage.session` only. It grants no
  host access and stores only one pending `{ origin, tabId, createdAt }` entry.
- `site-policy.js`/`.d.ts` gained the `dondownload:overlay-sync` message type.
- `overlay-controller.d.ts` provides types for the new module.

## Follow-up truthfulness fixes (review round 2)

Two remaining lifecycle issues were fixed in the same working tree.

1. **External revoke now tears down already-running content scripts.**
   `permissions.onRemoved` previously removed only the persistent registration,
   which affects future page loads; code already running in an open document
   stayed until reload. The fix tracks tabs that are known to run the overlay in
   `chrome.storage.session` (`dondownloadOverlayTabs`):
   - `enable`/`sync` records the verified same-origin tab;
   - the content script sends a new `dondownload:overlay-ready` announcement
     after injection or reload, and the worker records `sender.tab.id`;
   - `chrome.tabs.onRemoved` prunes closed tab ids;
   - external revoke sends `dondownload:overlay-disabled` to the tracked tabs.

   This does **not** add `tabs`, broad host permissions or `<all_urls>`. It also
   does not try to rely on `chrome.tabs.query({ url: pattern })` after revoke:
   Chrome only exposes URL filtering to `tabs` or a matching host grant, and
   both are deliberately absent once the user revokes. The tracked-tab design is
   therefore the safe best-effort path. The teardown message carries the exact
   origin, and the content script tears down only when
   `message.origin === location.origin`, so a stale/reused tab id cannot remove
   another site's overlay. If the grant is already gone when a page announces
   itself, the worker immediately sends the disabled message back.

   Honest limitation: an already-open tab that was never recorded (for example
   one opened before this version was loaded, or a session-storage write that
   failed) cannot be discovered after revoke without broader access. Its overlay
   disappears on the next reload because the registration is gone. No broadened
   access was added to close that gap.

2. **Disable no longer reports unconditional success.**
   `disableOverlayForOrigin` now verifies that
   `chrome.scripting.getRegisteredContentScripts({ ids })` is empty and that
   `chrome.permissions.contains({ origins: [pattern] })` is false after the
   removal calls. A failed `unregisterContentScripts`, a failed/throwing
   `permissions.remove`, or an unreadable verification returns
   `ok: false` with `error.code = OVERLAY_DISABLE_INCOMPLETE`, plus
   `registrationRemoved`, `permissionRemoved`, `granted`, `registered`,
   `notifiedTabs` and `failedNotifications`. Notification remains best effort
   and an unreachable tab does not fail an otherwise verified removal.
   Verification makes a concurrent `permissions.onRemoved` listener harmless:
   if it removed the state first, the verification still reports both removals
   as complete. The popup imports `overlayRemovalConfirmed(result)` and shows
   its success copy only when `ok`, `registrationRemoved` and
   `permissionRemoved` are all true; otherwise it shows the error and refreshes
   only the grant (it does not run the healing sync, which would re-register the
   overlay the user just tried to remove).

Still absent by design: no required host permissions, no `<all_urls>`, no
always-on `content_scripts`, no `downloads`, `webRequest`, `tabs`, `cookies` or
history permission, and no media-source reads, network sniffing, playback
control or DRM/auth/CAPTCHA bypass.

## Regression coverage added

- `tests/extension-overlay-controller.test.ts` (24 tests) with a mocked Chrome
  API:
  - no grant → `PERMISSION_REQUIRED`, no registration, no injection;
  - non-default port preserved in the persistent registration;
  - successful enable reports `registered` and `injected`;
  - page-side verification failure returns `injected: false` and
    `INJECTION_NOT_VERIFIED`, and the status helper does not show success;
  - a registration that does not persist fails visibly with
    `REGISTRATION_FAILED` and never injects;
  - tab navigated away still saves the registration but reports
    `ORIGIN_MISMATCH` with `injected: false`;
  - sync with an existing grant re-registers/injects; sync without a grant does
    nothing;
  - pending request + matching `permissions.onAdded` finishes registration and
    injection after the popup was closed;
  - unrelated grants are ignored; stale pending requests expire; pending state
    can be cleared;
  - disable removes registration, grant and page UI and notifies the tab;
  - a failed `unregisterContentScripts` returns
    `OVERLAY_DISABLE_INCOMPLETE`, `registrationRemoved: false`, and never claims
    success;
  - a failed/throwing permission removal returns
    `OVERLAY_DISABLE_INCOMPLETE`, `permissionRemoved: false`, `granted: true`;
  - a concurrent `permissions.onRemoved` that already removed both still makes
    disable verify as successful;
  - a failed best-effort tab notification does not turn verified removal into
    failure;
  - external revoke removes the registration and notifies only tracked
    same-origin tabs (`origin` carried in every message); another origin's
    registration is untouched;
  - reload/ready announcements track the tab; a late-ready document whose grant
    was already revoked is told to tear down immediately; a ready announcement
    from a different origin is rejected and not tracked;
  - status copy: Off, On only for `granted && ready`, Not ready for a bare
    grant, Unavailable for unsupported pages.
- `tests/extension-overlay.test.ts`: adds a `dondownload:overlay-ready`
  announcement assertion and proves the content script tears down only for a
  disabled message whose `origin` exactly matches `location.origin`.
- `tests/extension-site-policy.test.ts`: explicit assertion that
  `http://127.0.0.1:34526/*` survives the origin ↔ pattern round trip and the
  registration, plus source guardrails for the pending-request and
  `permissions.onAdded` wiring, ready-message tracking, verified-success and
  verified-removal conditions, and origin-scoped teardown.
- `tests/extension-manifest.test.ts`: expects the added `storage` permission and
  the new controller file.

## Tests actually run for this working tree

| Command | Result |
| --- | --- |
| `npx vitest run tests/extension-overlay-controller.test.ts tests/extension-overlay.test.ts tests/extension-site-policy.test.ts tests/extension-manifest.test.ts` | **53 passed**, 4 files |
| `npm run typecheck` | **passed** |
| `npm test` | **210 passed, 3 skipped**; 17 passed / 1 skipped files |
| `npm run build` | **passed**; typecheck plus Electron main/preload/renderer build |
| `node --check` on `background.js`, `popup.js`, `site-policy.js`, `overlay-controller.js`, `overlay-core.js`, `overlay.js`, `bridge.js` | **passed** |

The 3 skipped tests are the optional real-aria2 integration tests, skipped
because `ARIA2_TEST_BINARY` was not set. The previous full-suite result was
201 passed / 3 skipped; the 9 additional passing tests cover the external-revoke
teardown, ready-tab tracking and truthful disable/remove verification added in
review round 2.

## Headed Helium verification (2026-11-04, after the fix)

Environment:

- Helium `0.20.3.1` / Chromium `156.0.8078.79`
- Extension: the repository `extension` folder, ID
  `efakbfgkcnfjpomeejapmhpaihompngo`
- Fresh disposable profile:
  `C:\Users\PC\AppData\Local\Temp\opencode\dondownload-2b-fix\profile4`
  (not the real Helium profile; the existing unpacked extension was not
  altered or removed)
- Fixture: `http://127.0.0.1:34526/` with a 640 × 360 dynamically inserted
  `<video>` and a page-side diagnostic plus click counter
- Browser launched with `--load-extension` and `--remote-debugging-port`; the
  fixture page and worker were inspected over CDP.

Observed sequence:

1. Opened the real action popup from the Extensions menu. State: **Off**.
2. Windows mouse input clicked **Enable on this site**. The browser showed
   `"DonDownload Capture" has requested additional permissions` /
   `Read and change your data on 127.0.0.1`; as expected, the action popup
   closed.
3. The prompt’s **Allow** button was activated through Windows UI Automation
   `Invoke` (an accessibility invocation, not a hardware mouse click — see the
   caveat below).
4. Without reopening the popup, the fixture page already had
   `#dondownload-overlay-host` with an open shadow root. This proves the
   pending-request + `permissions.onAdded` path completed the job the closed
   popup could not.
5. Reloaded the page. The overlay host was injected again from the persistent
   exact-origin registration containing
   `http://127.0.0.1:34526/*`.
6. Moved the Windows pointer from outside the video onto it. The 30 × 30 **DD**
   button appeared at the video top-right (`left: 702px`, `top: 108px` in page
   coordinates) with the host/trigger visible.
7. Windows mouse input clicked **DD**. The panel opened with the truthful
   “Video download is not available in this milestone” copy, the disabled
   **Download video (unavailable)** action and the **Turn off overlay on this
   site** control. The fixture’s page click counter remained `0`, so the overlay
   click did not bubble to the page player.
8. `Escape` (OS-level keyboard input) closed the panel.
9. Reloaded to a fresh hidden state, then sent `Alt+Shift+D` (OS-level
   keyboard input). The button appeared and focus moved to the overlay host.
10. Reopened the popup. It showed **On** and “Overlay is on for
    127.0.0.1:34526…”, which now comes from a successful sync +
    page-side verification rather than the grant alone.
11. Clicked **Turn off on this site**. The popup showed Off and “Overlay turned
    off and site access removed…”; the page host was removed immediately.
12. `chrome.permissions.getAll()` then reported no origins,
    `chrome.scripting.getRegisteredContentScripts()` returned an empty list, and
    a reload left the page with `NO OVERLAY HOST`.

Caveats:

- The **Allow** button was invoked with Windows UI Automation, not with a
  hardware mouse. The real permission prompt, the real grant, and the
  popup-closed lifecycle were exercised; the click mechanism is the only
  automation difference.
- Enable, hover, DD click and disable used Windows cursor/click input
  (`SetCursorPos` + `mouse_event`), not a human hand on a mouse. The browser
  delivered real pointer events to the page.
- Keyboard checks used OS-level `keybd_event`.
- In that Milestone 2B run, no media playback or actual download was involved;
  that overlay version was UI-only.

### Review round 2 external revoke (same date, separate fresh profile)

- Helium `0.20.3.1` / Chromium `156.0.8078.79`; unpacked repository extension,
  ID `efakbfgkcnfjpomeejapmhpaihompngo`; disposable profile under the approved
  temp directory, removed after the run.
- Fixture exact origin `http://127.0.0.1:34526/` with the dynamic 640 x 360
  video. Grant came from the real popup prompt; the overlay appeared without
  reopening the popup.
- Worker session state tracked the open fixture tab:
  `dondownloadOverlayTabs: {"http://127.0.0.1:34526":[440800471]}`.
- Revoked from the browser Extensions menu's per-site **This can read and change
  site data** control, choosing **When you click the extension**. The
  `chrome://extensions` details page per-site switch was disabled in this build,
  so the toolbar per-site control was the available browser UI revoke path. The
  DonDownload popup's disable button was not used.
- The already-open tracked page removed the overlay host immediately with the
  page click counter unchanged and no navigation; the page timeline appended
  `NO OVERLAY HOST`. Registration list was empty, permission origins were empty,
  and session tracking was empty.
- A subsequent reload left `NO OVERLAY HOST`, the popup showed **Off**, and
  `Alt+Shift+D` did nothing. Full evidence and input caveats:
  `docs/verification-helium-external-revoke-2026-11-04.md`.

## Milestone 3A verification checkpoint (2026-11-04)

Status: **PASS** at HEAD `e7e28ee`. This section records what was actually run
for the integrated 3A media path. The headed Helium retest that was outstanding
at `5b6d3d4` completed and passed; it closes 3A and starts 3B planning.

### Local external tools

These are machine-local installations, not repository contents or bundled
artifacts. DonDownload neither bundles nor auto-downloads them; see
[media-tools.md](media-tools.md) for install sources, licensing and
redistribution notes.

| Tool | Verified version | Exact path used |
| --- | --- | --- |
| yt-dlp | `2026.10.26` | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe` |
| FFmpeg | `9.0.2-full_build` (Gyan) | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe` |
| ffprobe | `9.0.2-full_build` (Gyan) | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffprobe.exe` |
| Deno | `2.9.8` (stable, `x86_64-pc-windows-msvc`) | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe\deno.exe` (user-scoped WinGet install) |

- The native messaging host was rebuilt with `npm run build:native-host`, which
  wrote the git-ignored `native\dondownload-native-host.exe`.
- FFmpeg was passed to yt-dlp explicitly for separate-stream merges
  (`--ffmpeg-location`); ffprobe was used independently to validate outputs.
  FFmpeg is required only for options that need a merge.
- Deno is an external runtime dependency used by yt-dlp for JavaScript
  extraction. DonDownload does not ship or manage it.

### Real media verification

- **YouTube, CC-BY "Caminandes"**: analysis returned 31 verified options. The
  best-video choice used separate H.264 video and Opus audio streams and merged
  at 1080p. A selected 144p video option and an audio-only option were also
  downloaded. Every output was checked with ffprobe and a full decode; all
  returned exit code 0.
- **Wikimedia Commons, "Big Buck Bunny"**: a single muxed VP9/Opus file was
  downloaded and also passed ffprobe plus a full decode (exit code 0).
- **Live post-fix merge**: after `5b6d3d4`, a 144p separate-stream download
  emitted the merge step in engine output, and the merged file decoded cleanly.
- **Cancellation**: cancelling a live yt-dlp job killed the real process tree
  with `taskkill /T`. No FFmpeg child process was present at that moment, so this
  run verifies the yt-dlp/process-tree path, not mid-merge cancellation.
- **Persisted failure state**: a real engine analysis used a deliberately missing
  FFmpeg path before spawn. The failure was written to SQLite; the database was
  closed and reopened, and the failed state was still reported instead of a
  reset or stuck "running" row.
- **aria2**: real-aria2 integration tests passed 3/3 with `ARIA2_TEST_BINARY`
  pointed at `aria2c` 1.37.0
  (`C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\aria2.aria2_Microsoft.Winget.Source_8wekyb3d8bbwe\aria2-1.37.0-win-64bit-build1\aria2c.exe`).
- **Full suite**: 372/372 passed with `ARIA2_TEST_BINARY` set (0 skipped).
  Without it, the 3 optional integration tests are skipped by design.
- **Static/build checks**: `npm run typecheck`, `npm run build` and
  `npm run build:native-host` passed.

### Headed Helium end-to-end retest (2026-11-04, HEAD `e7e28ee`)

Status: **PASS**. This retest closed the 3A gate. It loaded the unpacked
repository extension into a fresh disposable Helium profile; the user's real
Helium profile and existing unpacked extension were not modified or removed.
Browser automation used CDP for page/worker inspection and Win32
cursor/keyboard input plus Windows UI Automation for prompt activation, not
human hardware input.

Results:

- **YouTube analysis:** the CC-BY "Caminandes" source returned 31 verified
  options. The quality radio now activates correctly (the `5b6d3d4` fix), and
  the popup copy matches the actual state.
- **Selected 144p option:** the job's stored option identity matched the exact
  option chosen in the overlay — no re-analysis or silent substitution. Output:
  **3,566,824 bytes**, H.264 256x144 video plus Opus audio, verified with
  ffprobe and a full decode (exit code 0).
- **Best video (1080p):** the best-video action produced **40,051,426 bytes**,
  H.264 1920x1080 plus Opus audio, also verified with ffprobe and a full decode
  (exit code 0). This job completed while the application window was hidden;
  restoring the UI showed the job as complete.
- **Hidden-window progress:** while the window was hidden, progress bytes were
  observed increasing and persisting in SQLite for the running job. The
  persisted bytes and the final complete state are consistent.
- **Audio-only and Wikimedia (earlier real runs):** the audio-only option and
  the Wikimedia Commons VP9/Opus file downloaded and decoded cleanly. Those
  results predate the retest and are unchanged.
- **Unsupported page:** `example.com` has no video element, so a synthetic video
  was injected to drive the overlay feedback path. The overlay reported the
  unsupported page, and the analysis request returned a **generic safe error**
  with no URL, path, token or internal detail.
- **Cancellation:** cancelling a live yt-dlp job killed the real yt-dlp process
  tree. No FFmpeg child process was present at the moment of cancellation, so
  this verifies the yt-dlp/process-tree path, not mid-merge cancellation.
- **aria2 capture:** the real-aria2 integration run completed a capture and its
  output checksum matched the source bytes; 3/3 real-aria2 tests passed.

No cookies, credentials, DRM keys or CAPTCHA solving were used or attempted.

Caveats:

- The extension was loaded **unpacked** from the repository into a **disposable
  Helium profile**. The real Helium profile was untouched.
- All browser interaction was automated with CDP, Win32 input and UI Automation;
  no physical human hardware input was used.
- On the **YouTube** enable path, the grant completed without a visible
  permission bubble; `example.com` did show the real permission bubble. The
  grant and overlay behaviour were verified on both, but the visible prompt UI
  itself was observed only on `example.com`.
- `example.com` needed a synthetic `<video>` to exercise the unsupported-page
  overlay feedback. The synthetic element and probe script were local,
  task-owned test fixtures, not application code.
- The best-video job finished while the app was hidden. The complete UI was
  observed after restoring the window, not live during completion.
- Mid-merge cancellation remains untested because no FFmpeg child was running
  when cancellation was issued.
- The retest made **no source or documentation changes**. These docs were
  updated afterward to record the result.

The application's media destination during the verified runs was the user's real
Downloads path. This record does not claim that the user's data was modified or
cleaned.

## Not complete / not claimed

- **Media handling is explicit and bounded.** Analysis is an explicit user
  action, and options come from yt-dlp rather than network sniffing. The path
  does not read cookies, bypass DRM/authentication/CAPTCHA, or fabricate
  formats/qualities. Only the runs recorded above are verified.
- **Human hardware input was not used for the 2B or 3A headed checks.**
  Automation limitations and the exact input mechanisms are recorded above; the
  functional flow was verified with real browser prompts and real page
  pointer/keyboard events. 3A used the same automation approach.
- Cross-origin iframe videos are not covered (registration and injection are
  top-frame only). Restricted pages such as `chrome://`, `edge://`, the Chrome
  Web Store and `file://` are ineligible.
- No push or release was made. `e15c772` remains the Milestone 2B checkpoint and
  `e7e28ee` is the Milestone 3A documentation checkpoint; this record is
  documentation only and is not a release.
- The disposable Helium profiles, fixture server and probe scripts were local
  task-owned files under the approved temporary directory. The user’s real
  Helium profile and existing unpacked extension were not modified or removed.

## Known issues

- **Milestone 2B is complete and locally checkpointed.** The functional
  enable/allow/hover/click/keyboard/disable flow and tracked-tab external-revoke
  teardown have been verified in Helium. Input automation caveats are recorded
  above.
- **External-revoke teardown is best effort for tracked tabs.** Removing the
  grant makes same-origin tabs unavailable to `tabs.query({url})` without `tabs`
  or a broad host grant, which this extension does not have. Already-open tabs
  recorded from enable/sync/ready get an immediate origin-scoped teardown
  message; an unrecorded document disappears on its next reload. This is an
  explicit limitation, not a claim of universal immediate teardown. The
  tracked-tab path was verified in headed Helium on 2026-11-04; the unrecorded
  case remains uncovered.
- **The permission prompt closes the action popup.** That is browser behaviour,
  not a DonDownload bug. The worker applies the grant and injects without the
  popup; reopening the popup re-syncs and reports the verified state. There is
  no silent success while the popup is closed.
- **Capture-phase page listeners can still observe overlay events.** The
  overlay stops propagation at its own button/panel, which covers normal
  bubble-phase player handlers. A page that registered its own capture-phase
  `window`/`document` click listener before the content script may still see the
  event, as with any in-page UI.
- **Top-frame only.** Videos in cross-origin iframes are not covered.
- **Restricted pages.** Browser-internal and Web Store pages cannot be injected.
- **Milestone 3A media path is PASS at `e7e28ee`.** Analysis, option selection,
  selected-option download, best-video merge, audio-only, hidden-window progress
  persistence and safe failure handling were verified in headed Helium. The
  overlay is a launcher, not a network sniffer; it does not bypass DRM,
  authentication or CAPTCHA or invent options. Remaining unverified non-blockers
  are listed below.
- **Optional pattern declaration tradeoff.** Chromium requires broad optional
  HTTP(S) pattern families in the manifest before an exact origin can be
  requested later. The declaration grants nothing by itself; the narrow
  exact-origin prompt is still required. Non-default ports are preserved and
  were verified in the persistent registration.
- **Shared Helium/Chrome key from 2A remains.** Unregistering Helium removes the
  shared key; re-register Chrome if it is still needed.

## Remaining unverified non-blockers

These are known gaps in verification coverage, not known defects. None blocks the
Milestone 3A PASS above.

- **Mid-merge cancellation.** No FFmpeg child process existed when cancellation
  was exercised, so only the yt-dlp process-tree kill is verified.
- **Physical human input.** Every headed check used CDP, Win32 input or UI
  Automation; no human hand on a mouse/keyboard.
- **Visible permission bubble on YouTube.** The grant completed without an
  observed bubble there; the bubble UI itself was seen only on `example.com`.
- **Non-disposable profile install.** Verification used an unpacked extension in
  a disposable profile; the real profile was deliberately untouched.
- **Unrecorded-tab external revoke.** An already-open tab that never announced
  itself is only covered by the next reload (see Known issues).
- **Cross-origin iframes and restricted pages.** Top-frame only; browser-internal
  and Web Store pages are ineligible.
- **Playlists/collections and 3B features.** Out of scope for 3A and not
  exercised.

## Model handoff status

The DeepSeek V4.1 Flash implementation worker reproduced and fixed the
permission-prompt lifecycle failure, corrected success reporting, hardened
external revocation and disable verification, and added regression coverage.
The orchestrator reviewed the changes. The worker-reported focused/full tests,
typecheck and build passed, and headed Helium checks verified both enable and
tracked-tab external revoke in disposable profiles. The Milestone 2B work is
locally checkpointed; no push or release was made.

For Milestone 3A, the implementation worker installed and verified the external
toolchain, exercised real YouTube and Wikimedia analysis/download/merge paths,
checked cancellation and persisted failure handling, and ran the full suite with
real aria2. The post-`5b6d3d4` headed Helium retest at `e7e28ee` then completed
the selected/best workflow end to end, including exact-option matching, 144p and
1080p outputs, hidden-window progress persistence and a safe unsupported-page
error. Milestone 3A is PASS. Milestone 3B has started in planning only.

## Safe next action

1. Plan Milestone 3B scope and milestones; no 3B implementation exists yet.
2. Keep the remaining unverified non-blockers visible rather than treating them
   as regressions or silently closing them.
3. Preserve the documented caveats: disposable-profile unpacked extension,
   automated CDP/UIA/Win32 input rather than human hardware, no visible YouTube
   permission bubble in that run, synthetic video on `example.com`, best-video
   completion observed while the app was hidden, and no FFmpeg child during
   cancellation.
4. Do not push or create a release without separate approval.
