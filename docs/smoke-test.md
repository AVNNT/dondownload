# Safe production smoke test

Last updated: 2026-11-04.

This document describes the opt-in smoke path added for verifying a packaged or
unpacked **production** DonDownload build without installing it and without
touching the user's desktop, browser profile, registry, normal Electron
userData directory, downloads folder, tray, native messaging host or loopback
bridge.

## What it is

The app has an explicit smoke mode:

- `DONDOWNLOAD_SMOKE_TEST=1` (environment) or `--smoke-test` (argument) enables
  it.
- It is off by default. Normal `npm run dev`, `npm start` and an installed app
  take the unchanged desktop path. Renderer diagnostic listeners are attached
  only when smoke mode constructs the hidden window.
- When enabled, an absolute `--user-data-dir=<new directory>` is mandatory.
- The normal Electron userData directory is refused, as is a relative path, a
  filesystem root, or a result file outside the isolated directory.
- Invalid smoke configuration exits before Electron reaches `ready`; it never
  falls through to normal startup.

The harness is `scripts/smoke-test.mjs` (Node built-ins only, no new
dependency). It creates a fresh temporary directory, launches the real Electron
executable, passes the explicit flags, reads `smoke-result.json` and prints the
same JSON. On success it removes its temporary directory unless `--keep` is
used. On failure it keeps it for diagnosis.

## Safety boundaries

Smoke startup still uses the real Electron runtime, real preload/renderer
bundle, real SQLite database, real `DownloadManager`, real `Aria2Service` child,
real `MediaJobsManager`/media engine and real bundled tool probes. The following
are deliberately suppressed:

- No `BrowserWindow` is shown or focused. The window is created hidden, loads
  the real renderer and is never shown.
- No tray icon or tray menu is created.
- No native browser bridge listener is opened and no bridge endpoint file is
  written.
- No native messaging host registration is run. No registry key, browser
  profile, extension or normal userData path is touched.
- No OS mouse, keyboard, UI Automation, browser automation or desktop input is
  used.
- Renderer diagnostics observe only the real smoke window's `webContents`.
  Nothing is injected into the page and no debugger or remote-debugging port is
  enabled.
- The downloads directory is `<isolated userData>/smoke-downloads`, never the
  user's real Downloads folder.
- The app does not start a download, media analysis, playlist preview or any
  other network transfer.
- Shutdown uses the normal flush/stop/close sequence (bridge if any, batches,
  media children, download persistence, aria2, SQLite). The app also has a
  last-resort bounded exit timer, and the harness has a wall-clock timeout that
  terminates only the process tree it created (`taskkill /pid <own child> /T
  /F` on Windows).

A hostile or accidental invocation cannot make smoke mode open the normal
profile: it is forced to exit before `ready` unless a distinct absolute
`--user-data-dir` is supplied.

## Commands

```powershell
npm ci --include=dev
npm run build
# Produce an unpacked production application without running an installer:
npx electron-builder --win --x64 --dir

# Verify the unpacked package (default when dist/win-unpacked exists):
npm run smoke
# or explicitly:
npm run smoke:packaged
# or another packaged/custom executable:
node scripts/smoke-test.mjs --app "C:\path\to\DonDownload.exe"
```

For an already-built source production bundle (`out/`) with
`node_modules/electron`, the script can also launch:

```powershell
npm run smoke
```

That source form uses `node_modules/electron/dist/electron.exe` with the built
`out/main/index.js`. It is useful for development but the packaged
`dist/win-unpacked/DonDownload.exe` form is the authoritative check that
resources resolve from a real application layout. A source run needs a
repository-root `vendor/` directory (or explicitly allowed overrides) because
it does not read `build/vendor/`; the packaged layout does.

The script strips `DONDOWNLOAD_ARIA2_PATH`, `DONDOWNLOAD_YTDLP_PATH`,
`DONDOWNLOAD_FFMPEG_PATH`, `DONDOWNLOAD_FFPROBE_PATH` and
`DONDOWNLOAD_DENO_PATH` by default so the app must locate its bundled resources
(or app-local/PATH copies). Pass `--allow-tool-overrides` only when explicitly
testing the override mechanism instead.

Useful options:

```text
--app <exe>             choose the executable to launch
--user-data-dir <dir>   use a new/empty directory instead of a temp directory
--keep                  keep the generated userData directory after PASS
--timeout-ms <ms>       bounded wall-clock timeout (default 120000)
--allow-tool-overrides  keep DONDOWNLOAD_*_PATH overrides
```

Exit code `0` means: the app reported `PASS`, every check passed, and the
Electron process exited normally before the timeout. Any failure, timeout or
nonzero exit is non-zero.

## Result file and checks

The app writes `<userData>/smoke-result.json` and also prints the same JSON.
Shape:

```json
{
  "schemaVersion": 2,
  "kind": "dondownload-smoke-test",
  "status": "PASS",
  "startedAt": "2026-11-04T...",
  "finishedAt": "2026-11-04T...",
  "durationMs": 1234,
  "pid": 1234,
  "environment": {
    "appVersion": "1.0.0",
    "electronVersion": "...",
    "chromeVersion": "...",
    "nodeVersion": "...",
    "platform": "win32",
    "arch": "x64",
    "packaged": true,
    "userDataPath": "<isolated>",
    "resourcesPath": "<package resources>"
  },
  "checks": [
    {
      "name": "aria2.ready",
      "status": "PASS",
      "detail": "version=1.37.0; path=...",
      "durationMs": 42
    }
  ],
  "diagnostics": {
    "entries": [
      {
        "category": "console",
        "severity": "warning",
        "fatal": false,
        "message": "..."
      }
    ],
    "suppressed": 1,
    "dropped": 0
  },
  "logs": ["PASS ...", "FAIL ..."]
}
```

`status` is `PASS` only when every check is `PASS`.

Checks cover:

| Check | What a PASS means |
| --- | --- |
| `config.isolated-user-data` | userData, download directory and result file are inside the explicit isolated directory. |
| `desktop-ui.suppressed` | the real window exists but is hidden and unfocused; the native bridge state file was not written. |
| `renderer.loaded` | the production `file:` renderer reached `readyState=complete` and React rendered content into `#root`. |
| `renderer.diagnostics` | no fatal renderer console exception, preload failure, renderer-process loss, failed document load or failed local `file:` resource was observed. Warnings and bounded diagnostics are reported without failing. |
| `sqlite.ready` | the real `node:sqlite` database opened inside isolated userData, migrations reached the current schema, and download/settings reads succeeded. |
| `aria2.ready` | the real `aria2c` child located from packaged/app-local/PATH resources started and answered RPC with a version. |
| `download-manager.ready` | the real download manager loaded existing state and sees aria2 as ready. |
| `media-manager.tool-state` | the real media manager/engine probed yt-dlp successfully. |
| `media-tool.ytdlp` | bundled/app-local/PATH yt-dlp ran `--version` with `--ignore-config` and exited 0. |
| `media-tool.ffmpeg` | bundled/app-local/PATH FFmpeg ran `-version` and exited 0. |
| `media-tool.deno` | bundled/app-local/PATH Deno ran `--version` and exited 0. |

### Renderer diagnostics scope

The `renderer.diagnostics` check observes the actual hidden window and records:

- `console-message` at warning or error level; informational/debug messages are
  ignored.
- `did-fail-load` for document, frame and subframe loads.
- Resource-level `webRequest.onErrorOccurred` entries filtered to the smoke
  window (removed after the run).
- `render-process-gone` and `preload-error`.

Each entry records `category`, `severity` (`warning` or `error`), a sanitized
message and whether it is fatal. Messages have control characters removed,
whitespace collapsed and are truncated to 400 characters. At most 50 entries
are retained; later entries increment `dropped`. Diagnostics are capped so a
noisy renderer cannot grow the result file without limit.

Fatal entries are error-level renderer console messages, document/main-frame
load failures, failed local `file:` resources, preload errors and renderer
process loss. `ERR_ABORTED` is treated as a non-fatal warning. Remote resource
failures are recorded as errors but are not fatal because they do not prove the
local production bundle is broken. Chromium's exact warning that a meta CSP
`frame-ancestors` directive is ignored is suppressed only at warning level; if
the same text is reported at error level it remains fatal.

The check runs after the other checks so renderer failures raised while startup
settles are included. It cannot observe messages emitted before the listeners
are attached (immediately after the window is created) or after the run
finishes.

## What this proves

- The production Electron main/preload/renderer bundles start and the renderer
  reaches a rendered state.
- The renderer produced no fatal uncaught console errors, failed local
  document/resource loads, preload errors or renderer-process loss during the
  smoke run.
- The production SQLite schema can be created/migrated in a fresh isolated
  profile and read through the real persistence layer.
- The packaged resource layout can locate and start the real aria2 binary.
- The packaged resource layout can locate and execute the real yt-dlp, FFmpeg
  and Deno binaries (version probes only).
- The real `DownloadManager`, media manager/engine and aria2 service wire
  together during startup.
- The app can shut down without a visible UI, tray, bridge or user-profile
  interaction.

## What this does not prove

- It does not install, uninstall or upgrade anything. It does not verify NSIS,
  shortcuts, uninstall entries or installer registry behavior.
- It does not register or exercise the browser native messaging host, extension
  or bridge (those paths are intentionally not started).
- It does not download anything or perform real aria2 transfers, media
  analysis, playlist preview, merge or cancellation.
- It does not verify network access, provider behavior, DNS policy or
  credentials.
- It does not verify visual layout beyond "React rendered something into
  `#root`", accessibility, focus behavior on a real desktop, GPU
  acceleration, DPI scaling or permission prompts.
- Renderer diagnostics cover only what the hidden window reports during this
  bounded run. They do not prove that every interaction, later navigation,
  dialog or long-running session is error-free.
- It does not prove the bundled tool versions match the pinned versions. The
  staging script remains the version-pin gate; smoke reports the versions it
  observed.
- It does not prove code signing, licensing/source-offer compliance, firewall
  behavior or a reproducible rebuild.
- It does not guarantee cleanup if the machine is powered off or the whole
  process is killed by an external supervisor. The normal shutdown path and the
  harness timeout are both bounded, and the harness only terminates its own
  child process tree.

## Risks and operational notes

- Electron still starts Chromium's normal process model. The isolated
  userData directory receives Chromium caches and session files; it is a
  temporary directory by default.
- The smoke run starts aria2 with its loopback RPC listener and a random secret,
  exactly like production startup, then stops it. It does not open a browser
  bridge listener.
- A packaged build must already contain `resources/vendor/`. Run
  `npm run stage:vendor` before packaging; smoke will fail the tool checks if a
  binary is missing.
- If the harness times out, it kills the Electron process tree it started. It
  does not search for or kill unrelated Electron/aria2 processes.
- Keep the printed `smoke-result.json` for the verification record. The
  temporary directory is removed after PASS unless `--keep` is passed.

## Tests

`tests/smoke-config.test.ts` covers the opt-in gate, mandatory isolated
userData, refusal of the normal profile, result-path containment and
machine-readable PASS/FAIL aggregation. `tests/smoke-diagnostics.test.ts`
covers diagnostic classification, warning/error separation, the narrow
meta-CSP exception, fatal local resource/document failures, sanitization and
bounds, and the report field. The real Electron check is the
`scripts/smoke-test.mjs` run above; it is intentionally not part of the hermetic
Vitest tiers because it launches Electron and real child processes.
