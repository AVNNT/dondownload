# Headed Helium verification: external revoke (review round 2)

Date: 2026-11-04. Test-only sub-agent run. No source changes, commit, push or
release.

## Scope

Verify the review-round-2 external-revoke path with the unpacked extension in an
isolated headed Helium profile:

- grant the exact fixture origin;
- confirm the overlay appears and the tab is tracked;
- revoke the origin from Helium's browser UI, not the DonDownload popup;
- confirm the already-open page loses the overlay without reload;
- confirm the persistent registration and grant are gone;
- confirm a reload does not re-inject.

## Environment

- Helium `0.20.3.1` / Chromium `156.0.8078.79`
  (`C:\Users\PC\AppData\Local\imput\Helium\Application\chrome.exe`).
- Extension: repository `extension` folder, ID
  `efakbfgkcnfjpomeejapmhpaihompngo`.
- Fresh disposable profile under
  `C:\Users\PC\AppData\Local\Temp\opencode\dondownload-2b-revoke\profile-1`
  (deleted after the run). The real Helium profile was not opened or modified.
- Fixture: `http://127.0.0.1:34526/`, a 640 x 360 `<video>` inserted dynamically
  after one second, with a page click counter and an overlay-state timeline.
- Browser launched with `--user-data-dir=<disposable>`, `--load-extension=<repo
  extension>`, `--remote-debugging-port=9334`, `--no-first-run` and no profile
  import.

## Observed sequence

1. Opened the action popup from the browser Extensions menu, clicked **Enable on
   this site** with OS mouse input. The browser permission prompt
   `"DonDownload Capture" has requested additional permissions` appeared and
   the action popup closed, as expected.
2. Activated **Allow** through Windows UI Automation `Invoke` (the same caveat as
   the previous round). Without reopening the popup, the fixture page already had
   `#dondownload-overlay-host`.
3. Browser state after the grant:

   ```text
   permissions.origins: ["http://127.0.0.1:34526/*"]
   registered: [{
     id: "dondownload-overlay-1bd5a910",
     matches: ["http://127.0.0.1:34526/*"],
     js: ["overlay-core.js", "overlay.js"],
     persistAcrossSessions: true
   }]
   session.dondownloadOverlayTabs: {
     "http://127.0.0.1:34526": [440800471]
   }
   ```

   Tab `440800471` was the active fixture tab, so the tracked-tab path was
   exercised.
4. Real OS pointer movement over the video produced the 30 x 30 **DD** trigger at
   page coordinates `(702, 108)`. An OS mouse click opened the panel and the
   fixture's page click counter stayed at `1`, so the overlay click did not reach
   the page player. OS `Escape` closed the panel, and OS `Alt+Shift+D` re-showed
   the trigger after the pointer moved away.
5. External revoke used the browser UI only:

   - Extensions toolbar menu (puzzle icon);
   - three-dot menu on **DonDownload Capture**;
   - **This can read and change site data**;
   - **When you click the extension**.

   The `chrome://extensions` details page also showed the per-site switch under
   "Automatically allow access on the following sites", but in this build that
   switch was **disabled** (checked but `pointer-events: none`), so it could not
   be used. The toolbar per-site site-access control is the available browser UI
   revoke path. The DonDownload popup and its **Turn off on this site** button
   were not used.
6. Selecting **When you click the extension** made the browser show
   "Reload this page to apply your updated settings on this site". The overlay
   teardown had already happened before any reload; **Cancel** was chosen and the
   page was not reloaded for the teardown check.
7. Immediate result in the same open document (under one second after the
   revoke, page click counter still `1`):

   ```text
   hasHost: false
   page timeline appended: "NO OVERLAY HOST"
   permissions.origins: []
   registered: []
   session: {}
   ```

   The `chrome://extensions` details page toggles changed to off.
8. A real page reload was then performed. After it:

   ```text
   hasHost: false
   page timeline: ["NO OVERLAY HOST"]
   page click counter: 0 (fresh document)
   permissions.origins: []
   registered: []
   session: {}
   ```

   Opening the extension popup showed **Off** with **Enable on this site** (the
   disable button remained disabled). OS `Alt+Shift+D` produced no overlay.

## Verdict

**PASS.** The tracked-tab external-revoke path removed the overlay from the
already-open page without a reload, removed the persistent registration, removed
the exact-origin grant, and a reload did not re-inject. No DonDownload bug was
found.

## Input method and caveats

- OS mouse input was `SetCursorPos` + `mouse_event`; OS keyboard input was
  `keybd_event`. Clicks were guarded to the disposable browser PID so they could
  not land in the user's other Helium window.
- The permission prompt's **Allow** button was activated with Windows UI
  Automation `Invoke`, not a hardware mouse click. This matches the prior
  round's documented caveat.
- Popup, menu, overlay hover/click, and revoke selections all used real OS-level
  input delivered to the real browser; the only automation difference is that no
  human hand operated the mouse or keyboard.
- The revoke UI labels the site as `127.0.0.1`, but the extension's actual
  `chrome.permissions.getAll()` grant was the exact ported origin
  `http://127.0.0.1:34526/*`; both the exact grant and the exact registration
  were verified gone.
- The browser's "Reload this page..." bubble is expected UI for a site-access
  change. It was dismissed with **Cancel**; the no-reload teardown result was
  observed before any navigation.
- No media playback, download, network sniffing or format probing is involved;
  the overlay remains UI-only.

## Cleanup

The disposable profile, fixture server and task scripts were removed after the
run. Only processes belonging to the disposable profile were stopped. The real
Helium profile, its windows, the existing unpacked extension and user data were
not modified.
