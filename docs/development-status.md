# Development status

As of 2026-11-04. Milestone 2B checkpoint: `e15c772`
(`feat: complete per-site video overlay milestone`), following the Milestone 2A
checkpoint `f03886d`. This checkpoint contains the completed, reviewed overlay
implementation and verification record.

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
- **Milestone 3A:** in progress; not verified or complete. Additive media
  contracts and SQLite v2 persistence are integrated at `e76055f`; review fixes
  rejecting credential-bearing media URLs and adding a safe job title are at
  `f55b0fc`. The current baseline has 231 tests passed / 3 skipped and
  typecheck passed. Four isolated DeepSeek workers are implementing the engine,
  desktop UI, Helium bridge/overlay, and media-job orchestration. yt-dlp and
  FFmpeg are not installed/found; no real media integration has been verified.

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
- No media playback or actual download is involved; the overlay is UI-only.

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

## Not complete / not claimed

- **No media extraction, sniffing, decoding or downloading exists.** The
  overlay never inspects media source URLs, formats, qualities, network
  requests, cookies, DRM, authentication or CAPTCHAs. There is no fabricated
  quality/format choice and no success claim.
- **Human hardware input was not used.** Automation limitations and the exact
  input mechanism are recorded above; the functional flow is verified with real
  browser prompts and real page pointer/keyboard events.
- Cross-origin iframe videos are not covered (registration and injection are
  top-frame only). Restricted pages such as `chrome://`, `edge://`, the Chrome
  Web Store and `file://` are ineligible.
- No push or release was made. `f03886d` remains the previous Milestone 2A
  checkpoint; this commit records the Milestone 2B checkpoint.
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
- **UI only.** There is no media download, format probing, network sniffing,
  quality selection, DRM/auth/CAPTCHA bypass or fabricated option.
- **Optional pattern declaration tradeoff.** Chromium requires broad optional
  HTTP(S) pattern families in the manifest before an exact origin can be
  requested later. The declaration grants nothing by itself; the narrow
  exact-origin prompt is still required. Non-default ports are preserved and
  were verified in the persistent registration.
- **Shared Helium/Chrome key from 2A remains.** Unregistering Helium removes the
  shared key; re-register Chrome if it is still needed.

## Model handoff status

The DeepSeek V4.1 Flash implementation worker reproduced and fixed the
permission-prompt lifecycle failure, corrected success reporting, hardened
external revocation and disable verification, and added regression coverage.
The orchestrator reviewed the changes. The worker-reported focused/full tests,
typecheck and build passed, and headed Helium checks verified both enable and
tracked-tab external revoke in disposable profiles. The Milestone 2B work is
locally checkpointed; no push or release was made.

## Safe next action

1. Keep this file current as later milestones change.
2. Preserve the documented caveat that physical human hardware input was not
   used; all headed Helium checks used OS-level input and UI Automation for the
   **Allow** prompt.
3. Do not push or create a release without separate approval.
