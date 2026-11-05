# Development status

As of 2026-11-05. Milestone 2B checkpoint: `e15c772`
(`feat: complete per-site video overlay milestone`), following the Milestone 2A
checkpoint `f03886d`. The Milestone 2B overlay work is complete and locally
verified. Milestone 3A is **PASS** at `e7e28ee`, verified end to end in a headed
Helium run against that HEAD. Milestone 3B has the committed contracts/schema
foundation, persistent backend orchestration with desktop IPC/preload, a
desktop-first renderer batch UI, local aria2 batch lifecycle coverage, and an
opt-in live playlist check that previewed and downloaded exactly one explicitly
selected CC-BY entry. Pixeldrain public-list verification is blocked because no
reliable, licensed fixture was found. There is still no native-bridge batch
route, and the live provider check does not verify the renderer UI.
Milestone 4 is explicitly deferred. Milestone 5 download controls and scheduling
are integrated locally: global settings, per-download limits, scheduled starts,
allowed-hours enforcement, recovery behavior, and renderer controls are covered
by tests. The Windows installer baseline is integrated locally, and packaged
Deno is wired into yt-dlp calls. Isolated installer execution, signing, legal
clearance, and other release checks remain open.

## Current runtime summary (2026-11-05)

The packaged production Electron UI has now completed a real, CDP-driven local
download flow through the renderer, production preload/IPC, DownloadManager,
aria2 and SQLite. A throttled loopback fixture downloaded 16 MiB; progress,
pause, resume, completion, exact output size/hash, a live aria2 speed-limit
change and relaunch persistence all passed. The isolated test window was
headless/offscreen to avoid desktop interference; this verifies the actual
renderer, not a mocked React preview, but does **not** verify interaction with a
visible native window. No OS input, real Downloads path, Helium profile,
installer or external download host was used. Screenshots and a bounded renderer
trace are recorded in the dedicated verification section below.

On 2026-11-05, a fresh isolated packaged build passed playlist preview, explicit
one-entry selection, per-entry format inspection, and a capped audio-only
playlist batch download (2,550,209 bytes under a 25 MiB cap). The 480p merged
video variation downloaded both streams but failed during post-processing; no
successful merged playlist-video transfer is claimed. Direct-URL batch UI
lifecycle (failure/cancel/retry/restart) and disposable-profile Helium
integration remain open in this pass.

The earlier live selected-playlist media download remains a successful,
separate Milestone 3B result (see its section below); it is not superseded by
this local HTTP flow. Pixeldrain list and Gofile-folder coverage remain open.

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
- **Milestone 3B: backend slice and desktop renderer UI implemented; native
  routes still absent.** The committed foundation remains shared
  batch/collection contracts (`src/shared/batches.ts`), additive SQLite schema v4
  (`batches` and `batch_items`) and hermetic contract/migration tests. This slice
  adds `src/main/batches/manager.ts`, secure batch IPC/preload methods, and
  main-process wiring:
  - Smart multi-URL submit returns a typed result with an optional created
    direct-item batch, separately pending collection previews, and independent
    invalid/unsupported/failed entries. Nothing from a preview is auto-queued.
  - Direct HTTP(S) items reuse `DownloadManager.add`, including its duplicate
    policy. Pixeldrain single files are resolved through the isolated adapter to
    the documented raw endpoint before `add`.
  - Pixeldrain lists and obvious playlist URLs are analyzed into ephemeral
    previews. `createCollectionBatch` accepts only explicit preview entry IDs.
    Playlist entries are resolved with `MediaEngine.resolveCollectionEntries`,
    then analyzed and queued one entry at a time through `MediaJobsManager`.
    The renderer can inspect formats for explicitly selected entries, choose
    only a reported `best`, 1080p/720p/480p/360p or audio-only option, and set an
    optional per-job byte cap. Unavailable chosen qualities and known sizes over
    the cap are marked `skipped`; there is no silent quality substitution.
  - Persisted parents/items keep child-ID mappings, per-item progress/errors and
    aggregate status. Startup marks active parents/items `interrupted`; nothing
    auto-resumes. Removing a batch deletes only its DB row and never a child
    download/media record or file. Group cancel cancels media children or pauses
    direct children without deleting files. Individual retry re-resolves the
    stored source and never runs an automatic retry loop.
  - Gofile share/folder links are kept as truthful `unavailable` items. They are
    never scraped for tokens; only an explicit safe browser action can open an
    exact canonical `https://gofile.io/{d|f}/{id}` link with no credentials,
    query or fragment.
  - URL/selection counts are bounded by the shared limits (500 URLs, 500 selected
    entries). Direct adds are serialized, aria2 still owns transfer concurrency,
    and media queueing is globally serialized to one active playlist job.
  - SQLite v7 persists per-media-job byte caps and playlist quality/cap policy
    across retries and restart. Runtime progress enforcement stops an over-cap
    transfer; the verified final file size is checked before a job can complete.
    Caps apply to media jobs, not direct aria2 transfers. Progress-based stopping
    can allow a brief network overrun before yt-dlp reports progress.
  - Desktop IPC exposes analyze/submit/create/read/list/cancel/retry/remove/open
    and snapshot-update observation, all through the existing trusted-sender
    wrapper. Public results are parsed `Batch`/`CollectionPreview` DTOs and never
    include a source URL, path, token or header.
  - The desktop renderer adds `src/renderer/src/components/BatchSection.tsx` and
    mounts it in `App.tsx` below the existing single-URL `QuickAdd` form.
    `QuickAdd` is unchanged. The batch surface has a newline-separated multi-URL
    input with an explicit submit, independent submit outcomes, explicit
    collection selection, expandable parent cards and per-item actions. It reads
    `getBatchSnapshot`, subscribes to `onBatchSnapshotChanged`, and unsubscribes
    on cleanup with no polling timer.
  Native-bridge batch routes and live provider verification are still not
  implemented. Scope remains desktop-first media playlists, Pixeldrain lists and
  direct-URL batches, with no credential/cookie/token extraction and no
  CAPTCHA/DRM bypass. **Milestone 4 is explicitly deferred.** There is no torrent
  functionality or torrent networking in this tree.
- **Milestone 5A foundation: shared download-control settings and SQLite v5.**
  `src/shared/settings.ts` defines exact-key settings/per-download DTOs and
  parsers with safe bounds. The additive v5 migration creates one
  `download_settings` row and adds nullable `scheduled_at` /
  `speed_limit_bps` columns to `downloads`. Existing rows become null
  (unscheduled/unlimited), so all existing behavior is preserved. Runtime
  settings application, trusted IPC/preload API and live/startup aria2 changes
  are described in the next section. No renderer UI, installer, torrent/VPN or
  privileged work is included. See [download-settings.md](download-settings.md).
- **Milestone 5A runtime settings: implemented.** The settings service loads the
  persisted row, validates full exact-key updates, and applies
  `max-concurrent-downloads`, `max-connection-per-server` and
  `max-overall-download-limit` through `aria2.changeGlobalOption`. Startup
  applies the snapshot after aria2 answers but before `ready`/`start()`
  resolves; live updates apply first and persist after aria2 accepts, with
  rollback to the previous options if either step fails. Trusted
  `settings:get` / `settings:update` IPC and preload methods are wired, with no
  renderer UI. Allowed-hours enforcement, scheduling, individual download
  controls and automatic restarts are still absent.

## Milestone 3B foundation scope (contracts and schema)

The foundation is deliberately narrow and additive:

- Batch kinds: `media-playlist`, `pixeldrain-list`, `direct-urls`.
- Batch statuses: `queued`, `running`, `complete`, `partial`, `error`,
  `cancelled`, `interrupted`. Item statuses: `queued`, `running`, `complete`,
  `error`, `unavailable`, `skipped`, `cancelled`, `interrupted`.
- Playlist and Pixeldrain-list previews are renderer-safe and ephemeral:
  opaque preview/entry IDs, bounded titles/counts, positions, independent
  `available`/`unavailable` availability and safe error code/reason only. Raw
  URLs, paths, selectors, tokens, headers, cookies and provider objects are
  excluded.
- Analysis accepts a normalized HTTP(S) source URL. Batch creation from a
  preview requires an opaque preview ID plus 1–500 explicit, unique entry IDs;
  there is no implicit all-entry or auto-queue path.
- Public DTOs are exact-key, bounded and verified to exclude source URLs, disk
  paths, tokens, headers, cookies and selectors. Internal records retain only a
  normalized HTTP(S) source URL for retry; credentials are rejected and
  fragments are stripped.
- Items reference existing download/media children through opaque `childId`
  values. Per-item errors, independent `unavailable`/`skipped` states,
  `skippedItems` aggregate progress, individual retry/cancel, group cancel,
  aggregate progress and interrupted recovery are represented in the contracts.
- Batch persistence was introduced in transactional, additive SQLite schema v4:
  v1 download rows, v2 media rows and v3 batch parents are preserved, and a
  failed v4 rebuild rolls back completely. v4 rebuilt only `batch_items` to
  accept `unavailable`/`skipped` while preserving every row, index and cascade.
  Milestone 5A and download-control migrations followed additively; schema v7
  adds persisted media caps and playlist selection policy while leaving existing
  rows unlimited and at the legacy best-quality behavior.
- Still not included by the foundation contracts themselves: renderer UI,
  native-bridge batch routes, live provider verification, Milestone 4/5 work,
  torrents or VPN.

See [batch-contracts.md](batch-contracts.md) for the full contract and schema
description.

## Milestone 3B backend orchestration slice

Status: implemented in the working tree, hermetic tests and typecheck/build
passing. The desktop renderer batch UI is documented in the next section. No
native-bridge batch route is part of this slice.

Implementation:

- `src/main/batches/manager.ts` owns persisted parent/item state and consumes
  narrow ports for downloads, media jobs, playlist resolution and Pixeldrain.
- `src/main/ipc.ts` registers additive batch channels through the existing
  trusted-sender wrapper; `src/preload/index.ts` exposes the same methods and a
  snapshot-update subscription.
- `src/main/index.ts` wires the manager with the existing `DownloadManager`,
  `MediaJobsManager`, media engine and Pixeldrain adapter, and marks active batch
  work interrupted before media shutdown.
- `tests/batches-manager.test.ts` and `tests/batches-ipc.test.ts` cover recovery,
  duplicate/invalid isolation, explicit collection selection, child mapping,
  cancel/retry/remove isolation, Gofile open allowlisting, Pixeldrain routing and
  trusted-sender rejection.

Behavioral boundaries:

- `submitSmartBatch` returns a typed result containing an optional direct-item
  batch, separately pending collection previews, and independent
  invalid/unsupported/failed entries. It never auto-queues a preview.
- Direct HTTP(S) items go through `DownloadManager.add`, so duplicate and retry
  policy is unchanged. Pixeldrain single files resolve through the adapter to the
  documented raw endpoint before `add`; Pixeldrain lists require explicit entry
  selection.
- Playlist selection resolves entry URLs, analyzes each selected entry through
  `MediaJobsManager`, and queues exactly one best verified video+audio option (or
  the best actual audio option when no video exists). Media queueing is serialized
  globally to one active playlist item; direct adds are serialized while aria2
  retains its own transfer concurrency.
- Batch creation, item transitions, child IDs and terminal aggregate status are
  persisted. Startup marks active parents/items `interrupted` and never resumes.
  Group cancel cancels media children or pauses direct children; individual retry
  re-resolves the source and does not loop. Removing a batch only deletes its DB
  row; child jobs and files are never removed.
- Gofile share links are `unavailable` items with a stable browser-required
  message. A separate explicit action opens only the stored canonical
  `https://gofile.io/{d|f}/{id}` URL via main-process `shell.openExternal`; query,
  fragment and credentials are rejected.

Verification for this working tree:

| Command | Result |
| --- | --- |
| `npx vitest run tests/batches-manager.test.ts tests/batches-ipc.test.ts` | **22 passed**, 2 files |
| `npm run test:fast` | **423 passed**, 26 files |
| `npm run typecheck` | **passed** |
| `npm run build` | **passed** |

Known gaps for this slice:

- No native-bridge batch routes.
- No live provider or media-download verification was run for this backend slice;
  tests use hermetic fake managers/adapters and never fetch a provider or file
  body.
- Smart submit only probes obvious playlist URLs (a `list` query parameter or
  common playlist/set/album paths). Ambiguous playlist URLs can still use the
  explicit collection-analysis action, but are otherwise handled as direct URLs.
- Direct children are submitted one at a time and media jobs one at a time. This
  is intentionally conservative, not a throughput optimization.
- The shared item contract has no `paused` status, so a direct child paused
  outside the batch is observed as a running batch item until it completes,
  fails or is cancelled from the batch.
- Retry creates a new child mapping and never deletes the previous child record
  or partial file.
- No batch-level retry, pause/resume or item-row removal action is exposed.
- No Milestone 4/5, torrent or VPN work is included.

See [batch-contracts.md](batch-contracts.md) for the full contract and schema
description.

## Milestone 3B desktop renderer batch UI

Status: implemented in the working tree, with hermetic fast tests, typecheck and
production build passing. No live provider, media-download or real-profile check
was run for this UI.

Implementation:

- `src/renderer/src/components/BatchSection.tsx` is the new desktop-first batch
  surface. `src/renderer/src/App.tsx` mounts it below the unchanged single-URL
  `QuickAdd` form, inside the existing centered OLED-black layout with the
  compact top navigation and no sidebar.
- The section loads `getBatchSnapshot`, subscribes to
  `onBatchSnapshotChanged`, and unsubscribes in the effect cleanup. There is no
  polling timer; snapshot updates arrive through the existing desktop event path.
- The multi-URL form accepts newline-separated HTTP(S) URLs and requires an
  explicit **Submit batch** action. Per-entry results render independently as
  `Queued`, `Preview ready`, `Needs browser`, `Invalid` or `Failed`, using only
  the safe backend codes/messages. No raw URL is echoed by the result DTO.
- Collection previews are rendered as local, ephemeral selection cards with
  native checkboxes, individual and multiple selection, an explicit
  **Select all available** action (bounded to 500 available entries), a clear
  selection action, and **Queue selected**. Nothing is preselected and nothing
  from a preview is queued until that explicit action. Unavailable entries are
  disabled, show their safe reason/code and do not block available siblings.
- Parent batch cards are expandable and show status, aggregate item counts,
  aggregate byte progress when known, per-item status/error and per-item
  retry/cancel actions. Active groups expose **Cancel group**. Every group card
  exposes **Remove group card**, with copy stating that removal clears only batch
  history and keeps child downloads, media jobs and files on disk.
- Gofile browser-required entries expose **Open in browser** only through
  `openBatchSource` with the opaque batch/item IDs. The renderer never builds,
  reads or opens a raw source URL and uses no browser or OS automation.
- Loading, snapshot-error and empty states are present. Controls are native
  buttons/checkboxes with labels, `aria-expanded`, progressbar values and visible
  focus treatment; layout wraps on narrow widths and motion is limited to
  existing short transitions.
- No new framework, dependency, browser test, main/shared/preload change,
  provider/media/DB change, torrent/VPN path or Milestone 5 work is included.

Verification for this working tree:

| Command | Result |
| --- | --- |
| `npm run test:fast` | **423 passed**, 26 files |
| `npm run typecheck` | **passed** |
| `npm run build` | **passed** (typecheck plus main/preload/renderer build) |

Known gaps for the UI slice:

- No live Pixeldrain, playlist, Gofile or real-aria2 run was made. The UI was not
  exercised in a real profile or with OS mouse/keyboard input.
- No renderer component test was added; the fast suite covers the existing
  contracts, manager and mocked IPC behavior, not DOM interactions.
- Smart submit still only probes obvious playlist URLs. An ambiguous playlist
  URL can be submitted again through an explicit collection-analysis flow only
  if a future UI exposes that action; this slice does not add a separate
  analyze-only control.
- The UI relies on the backend's safe display labels for the Gofile
  browser-required action (`Browser required`), because public batch items do
  not carry a provider code.

See [batch-contracts.md](batch-contracts.md) for the full contract and schema
description.

## Milestone 5A foundation (settings contract and SQLite v5)

Status: foundation slice, superseded by the runtime application section below
for runtime behavior. This slice itself added the contract and persistence; the
later slice wires runtime, IPC/preload and aria2.

Implementation:

- `src/shared/settings.ts` (new) defines `DownloadSettings`, `AllowedHours`,
  `DownloadControls`, defaults, limits and exact-key parsers
  (`parseDownloadSettings`, `parseAllowedHours`, `parseClockTime`,
  `parseDownloadControls`, `parseScheduledAt`,
  `parsePerDownloadSpeedLimitBps`). Unknown/missing fields, wrong types,
  out-of-range values and malformed clock strings are rejected rather than
  clamped. The DTOs contain no URL, path or secret field.
- Defaults preserve current behavior: 3 concurrent downloads, 4 per-host
  connections, global speed `0` (unlimited), allowed hours disabled with
  `00:00`/`00:00` (all day). Allowed-hours time is the system local clock;
  overnight windows are supported and `start === end` is a full 24-hour window.
- `src/main/db/database.ts`: `SCHEMA_VERSION` is 5. The v5 migration runs in the
  existing transactional migration loop and only uses additive `ALTER TABLE
  downloads ADD COLUMN` plus `CREATE TABLE download_settings`. It adds
  `scheduled_at` and `speed_limit_bps` to downloads (null for every existing
  row = unscheduled/unlimited) and inserts one default settings row.
- `loadSettings()` / `saveSettings()` parse through the shared contract and fail
  closed. `saveDownloadControls(id, controls)` can persist per-download controls
  for one existing row; the manager does not call it yet.
- `SCHEMA_VERSION` remains the only version source. A newer database is still
  refused, and a failed v5 migration leaves the database at v4 with no partial
  columns, settings table or rows.
- No `src/shared/types.ts`, `AddDownloadInput`, `DownloadManager`, IPC, preload,
  renderer, installer or packaging file was changed.

Verification for this working tree:

| Command | Result |
| --- | --- |
| `npx vitest run tests/settings-contract.test.ts tests/settings-database.test.ts tests/database.test.ts tests/batch-database.test.ts` | **53 passed**, 4 files |
| `npm run test:fast` | **449 passed**, 28 files |
| `npm run typecheck` | **passed** |

Migration coverage includes genuine v1, v2, v3 and v4 databases upgraded to v5
with download/media/batch rows, statuses, indexes and the `batch_items` cascade
FK preserved; invalid settings rejected by both parsers and CHECK constraints;
default and custom round-trips; and a forced v5 failure after the `ALTER TABLE`
steps that rolls back to v4 completely.

Known gaps for this foundation:

- No runtime application: concurrency, per-host connections, global speed limit,
  allowed-hours enforcement and per-download scheduling/speed limits are not
  wired to aria2 or the media engine.
- No settings or per-download-control IPC/preload/UI.
- No `AddDownloadInput` additions and no manager behavior change.
- No installer, torrent, VPN or privileged OS change.

See [download-settings.md](download-settings.md) for the contract and schema
details.

## Milestone 5A runtime settings application

Status: implemented in the working tree. Global concurrency, per-host
connection and global speed-limit settings are now loaded from SQLite and
applied to aria2 at startup and on live update. Scheduling, allowed-hours
enforcement, individual download controls, renderer UI and installer work are
still outside this slice. No renderer UI, browser, OS input or real download was
used for verification.

Implementation:

- `src/main/settings/manager.ts` (new) owns the runtime settings snapshot. It
  loads once through `DownloadDatabase.loadSettings()`, re-validates with the
  shared `parseDownloadSettings()` contract, and returns a defensive copy.
  Unknown/missing keys, wrong types and out-of-range values are rejected before
  persistence or aria2.
- `updateSettings` applies `max-concurrent-downloads`,
  `max-connection-per-server` and `max-overall-download-limit` through
  `aria2.changeGlobalOption` when aria2 is ready, then saves the row. A failed
  live apply re-applies the previous options and leaves persisted/cached state
  unchanged; a failed save after a successful apply also rolls aria2 back.
- `src/main/aria2/service.ts` gains an `onBeforeReady` hook. It runs after
  `aria2.getVersion()` succeeds and before the service sets `status: 'ready'` or
  resolves `start()`, so persisted settings are in effect before the first
  download. A failed apply aborts startup with `ARIA2_SETTINGS_FAILED` instead of
  reporting a ready engine with stale options.
- `src/main/aria2/args.ts` now launches with the shared defaults
  (3 concurrent downloads, 4 connections per host, unlimited global speed)
  instead of the former hard-coded 5/8. This is an intentional, documented
  behavior change; no schema migration is needed because the v5 row already
  seeded these defaults.
- `src/main/ipc.ts`, `src/shared/ipc.ts`, `src/shared/types.ts` and
  `src/preload/index.ts` add trusted `settings:get` / `settings:update` channels
  and `getSettings` / `updateSettings` preload methods. The update is a full
  exact-key `DownloadSettings` object; no secret, URL or path is added.
- No automatic aria2 restart is performed on settings change. Active downloads
  are not paused, resumed or otherwise touched.
- `tests/settings-manager.test.ts` uses a fake store and fake aria2 client to
  cover defaults, validation-before-side-effects, startup apply, live apply,
  apply failure rollback and save failure rollback.
  `tests/settings-ipc.test.ts` covers channel registration, trusted routing,
  validation errors and untrusted-sender rejection. `tests/aria2-args.test.ts`
  asserts the launch defaults match the shared contract.

Verification for this working tree:

| Command | Result |
| --- | --- |
| `npx vitest run tests/settings-manager.test.ts tests/settings-ipc.test.ts tests/settings-contract.test.ts tests/settings-database.test.ts tests/aria2-args.test.ts` | **44 passed**, 5 files |
| `npm run test:fast` | **465 passed**, 30 files |
| `npm run typecheck` | **passed** |
| `npm run build` | **passed** |

Behavior and gaps:

- The three global aria2 limits are live. `allowedHours` is persisted and parsed
  but not enforced, and per-download `scheduledAt` / `speedLimitBps` are not
  wired to `AddDownloadInput` or `DownloadManager`.
- `SettingsSection` exposes the global concurrency, per-host connections and
  speed-limit settings. It does not expose or imply enforcement of allowed hours
  or per-download controls yet.
- If aria2 is not ready, an update persists for the next start instead of
  starting aria2 early. The startup hook applies the snapshot before ready.
- No torrent, VPN or privileged OS behavior was added.

See [download-settings.md](download-settings.md) for the contract and runtime
details.

## Milestone 5 local installer and packaged Deno update

The installer baseline from `badf256` is integrated at `f5c251e`. The media tool
locator now resolves the packaged Deno executable and supplies it as a fixed
yt-dlp JS-runtime argument for analysis, playlist preview and media download.
`tests/media-js-runtime.test.ts` covers vendor lookup and argument placement.

Verification after integration:

| Check | Result |
| --- | --- |
| `npm run test:fast` | **467 passed**, 31 files |
| `npm run typecheck` | **passed** |
| `npm run build` | **passed** |
| `npm run test:gate` | **507 passed / 7 skipped**; build passed |
| `npm run build:installer` | Native-host build, vendor staging and app build passed; script stopped because `electron-builder` is not installed in the main worktree |
| electron-builder 26.18.0 invoked from the installer worktree | **passed**, NSIS x64 artifact built locally without running it |

The artifact produced at that historical checkpoint was
`dist/DonDownload-0.1.0-x64-setup.exe` (302,260,785 bytes, SHA-256
`4138a78ccabc3d3c656fa8cb70fe54c37d383d43ce33a06c7c84d779cd4d2e61`); it has
since been superseded by the final extracted-payload validation recorded below.
All five packaged vendor executable hashes matched `build/vendor/manifest.json`.
The installer was not executed. It remains unsigned; GPL corresponding-source
delivery/legal review, a fresh-path install/uninstall test, browser native-host
registration verification, and release signing remain manual release gates.

## Milestone 3B local batch and live playlist integration coverage

Status: two opt-in integration files and the related test scripts were added.
No production code changed. The local batch file was run against real aria2 and
passed; the live playlist preview file was run once with the real yt-dlp engine
and passed. Neither run exercised a public media download.

Files:

- `tests/batches.integration.test.ts` — local, deterministic, loopback-only
  coverage for persistent batch paths. It skips unless `ARIA2_TEST_BINARY`
  points at a real `aria2c`.
- `tests/playlist.live.integration.test.ts` — opt-in live preview/resolution
  check. It skips unless `DONDOWNLOAD_LIVE_PLAYLIST=1` and an explicit
  `DONDOWNLOAD_YTDLP_PATH` are set.
- `package.json`: both files are excluded from `test:fast`;
  `tests/batches.integration.test.ts` is included in `test:integration` (and
  therefore in `npm test`/`test:gate`, where it skips without the aria2 env);
  `npm run test:playlist:live` runs only the live playlist file;
  `npm run test:batches:integration` runs only the local batch file.

### Local persistent batch integration (actually run)

Environment: aria2c `1.37.0`
(`C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\aria2.aria2_Microsoft.Winget.Source_8wekyb3d8bbwe\aria2-1.37.0-win-64bit-build1\aria2c.exe`),
real `Aria2Service`, real `DownloadManager`, real SQLite database and real
`BatchManager`. The HTTP fixture is a deterministic loopback server serving
generated bytes with Range support; all artifacts are under a unique
`os.tmpdir()/opencode` directory. No external network, provider API, media
tool, OS input or real user profile is used.

Observed:

1. **Direct smart batch completion.** `submitSmartBatch` created one direct
   item, the real child download completed through aria2, the batch mapped the
   child ID, and the item/batch reached `complete` with 524,288 bytes. The
   SQLite row was flushed and reopened with a fresh `BatchManager`; the parent
   and item were still `complete` (not rewritten to `interrupted`), with the
   same `childId` and byte counts. The resolved source URL was absent from the
   public batch snapshot.
2. **Batch cancellation and parent removal isolation.** An 8 MiB throttled
   loopback transfer was allowed to make partial progress, then
   `cancelBatchItem` paused the real aria2 child. The item became `cancelled`,
   the child download became `paused` with partial bytes, and the persisted
   batch/item state was `cancelled` with the same child mapping. Removing the
   parent deleted only the batch row: the child download record remained
   `paused`, and the partial file remained on disk and non-empty. aria2 can
   flush a few already-buffered bytes immediately after the pause RPC, so the
   test asserts the file still exists and is non-empty rather than freezing its
   exact length.

### Live playlist preview and selection resolver (actually run, no download)

Environment: yt-dlp `2026.10.26`, Deno `2.9.8` added to `PATH` through
`DONDOWNLOAD_DENO_PATH`, no cookies, browser profile, account or
authentication. Fixture:
`https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz`
(official Blender Open Movies, public CC-BY).

Observed in the single live run:

- The real `MediaEngine.analyzeCollection` was called exactly once.
- The returned preview kind was `playlist` and its title contained
  "Blender"; `entryCount` matched the returned entry list and was greater than
  zero, availability counts summed to `entryCount`, and at least one entry was
  available. Positions were contiguous from zero.
- The public preview JSON contained no `http(s)://`, `youtube.com`, `youtu.be`,
  `watch?v=` or `list=` text.
- Exactly one opaque available entry ID was passed to
  `resolveCollectionEntries` inside the main-process test. The single returned
  target matched the entry ID and title, and its URL was an `https` YouTube page
  URL already normalized by `normalizeMediaSourceUrl`.
- That resolved URL and its video ID were absent from the public preview.
- The isolated working directory was still empty after preview and resolution,
  and no download API was called.

**This is preview/selection-resolver evidence only. No playlist media was
downloaded, so this record does not claim that a playlist download passed.**
The live entry count and exact title are deliberately not pinned because a
public playlist can change; the assertions check safety and internal
consistency instead.

### Verification for this coverage change

| Command | Result |
| --- | --- |
| `npx vitest run tests/batches.integration.test.ts` (`ARIA2_TEST_BINARY` set) | **2 passed**, 1 file |
| `npm run test:integration` (`ARIA2_TEST_BINARY` set) | **45 passed**, 4 files |
| `npx vitest run tests/playlist.live.integration.test.ts` (live env set) | **1 passed**, 1 file |
| `npm run test:fast` | **423 passed**, 26 files |
| `npm test` (`ARIA2_TEST_BINARY` set; live files skipped) | **468 passed / 2 skipped**, 30 passed + 2 skipped files |
| `npm run typecheck` | **passed** |

No production source was edited. The production build was not rerun because
only tests, scripts and documentation changed.

### Remaining gaps for this coverage

- **Live Pixeldrain list remains unverified.** The live Pixeldrain file check
  still covers only one public single-file fixture; there is no clearly
  licensed, stable public list fixture in this repository, so live list
  metadata and selection were not exercised.
- **Gofile share folders remain unsupported.** Only canonical
  `https://gofile.io/{d|f}/{id}` links are kept as truthful `unavailable`
  browser-required items. Folder contents are not enumerated, pending a
  verified, documented unauthenticated API; no token scraping or browser
  automation is used.
- Playlist download, media queueing and renderer UI behavior were not
  exercised in this run. The live check covers preview and the opaque-selection
  resolver only.
- No native-bridge batch route, real-profile UI run, OS input check or public
  media download is part of this coverage.
- The local batch integration requires a real aria2 binary; it is skipped, not
  silently passed, when `ARIA2_TEST_BINARY` is absent.

See [batch-contracts.md](batch-contracts.md) for the full contract and schema
description. See [testing-workflow.md](testing-workflow.md) for the updated
tier commands.

## Milestone 3B selected playlist media download (actually run)

The opt-in `tests/playlist-download.live.integration.test.ts` now covers one
explicitly selected entry from the official Blender Open Movies playlist. It
uses a read-only metadata preflight with a 25 MiB transfer ceiling, queues only
the selected muxed 360p option through `MediaEngine`/`MediaJobsManager`, checks
completion and actual size, computes SHA-256, fully decodes audio/video with
FFmpeg, and removes its unique temporary output. The one live run passed. Since
YouTube does not publish a pinned checksum for this rendition, the digest was
computed and format-checked but is not claimed as an upstream-verified hash.

The live Pixeldrain list fixture check remains **BLOCKED**: the API-documentation
example returned 404; an unrelated 315 MB public ZIP without verifiable license
was not used; creating a list requires an API key. No list preview or
selected-file download was attempted. The existing Pixeldrain live file test is
not list evidence. Gofile remains unsupported, with the explicit browser fallback
and no authentication/token scraping.

## Installer environment and release audit checkpoint

The installer payload's aria2 1.37.0, yt-dlp 2026.10.26, Deno 2.9.8,
FFmpeg/ffprobe 9.0.2 version commands passed. Packaged aria2 also passed the
local aria2 and batch integration tests (3 + 2 tests) using loopback fixtures.
Windows Sandbox was not available, checking its optional feature required
elevation, and no VM runner was found; the installer was **not** executed. The
Helium registration helper was inspected in print-only mode; no registry or
browser profile was changed, so installed Native Messaging and Helium
communication remain unverified.

The installer is **unsigned**. Version/hash-manifest checks and packaged license
file hashes passed, but local WinGet paths do not establish upstream authenticity
or reproducible builds. GPL corresponding-source archives/written offer and
legal review remain release blockers; see
[licensing-release-audit.md](licensing-release-audit.md). No production release
or signing claim is made.

## Milestone 5 scheduling and per-download controls

Integrated locally at `fd64503`. Global allowed hours use local wall-clock time
and the existing `DownloadManager` poll loop. New downloads can carry a start
time, speed limit and connection count; direct batch children use the same gate.
User-paused jobs remain paused, while explicit Start Now/Resume/Retry actions
override policy for the current process. SQLite schema v6 adds connection and
policy-hold state additively; policy-held, not-yet-submitted downloads are
recoverable after restart, while genuinely in-flight downloads remain
interrupted. The renderer exposes allowed-hours settings, Quick Add controls,
and download-card status/actions. See [milestone-5-controls.md](milestone-5-controls.md)
for behavior and implementation details.

Verification after integration: `npm run test:fast` passed **504 tests**;
`npm run typecheck` passed; and `npm run test:gate` passed **544 tests / 8
skipped** with the production build passing. No GUI or real download was used
for scheduler verification. The allowed-hours transition is checked on the
existing one-second polling cadence (so it is not a hard real-time boundary),
schedules have no automatic end/pause, and Start Now overrides are not persisted.
Media jobs have no per-job schedule/speed/connection controls; queued media may
wait for the policy window only in the current process and is not automatically
restarted after relaunch.

Installer dependency root cause: `electron-builder@26.18.0` was already declared
in `package.json` and pinned in `package-lock.json`, but the main worktree's
`node_modules` did not contain the development dependency. There is no project
`.npmrc`, and npm's current `omit` setting is empty; the exact earlier
provisioning action that left the partial tree is not recorded. `npm ci
--include=dev` restored the locked tree; no package manifest or lockfile changes
were needed. This is the reproducible clean-checkout dependency restore path and
is now the documented installer setup command.

The rebuilt current-source installer is
`dist/DonDownload-0.1.0-x64-setup.exe` (302,265,742 bytes, SHA-256
`649974f3f7def431114fdea0874992abde89e45fcba2ff3704651e328b9e7e04`).
`npm run build:installer` completed with electron-builder 26.18.0. The native
host was built (24,576 bytes); the unpacked packaged app and all five vendor
executables are present. aria2 1.37.0, yt-dlp 2026.10.26, FFmpeg/ffprobe 9.0.2
and Deno 2.9.8 were invoked from the packaged resource paths. Each vendor
executable's size and SHA-256 matched `build/vendor/manifest.json`. Installer
Authenticode status is **NotSigned**. No installer or packaged app was executed;
install/uninstall still requires an isolated Windows Sandbox/VM, which was not
available. Installed Helium Native Messaging communication remains unverified.

Remaining release blockers include isolated install/uninstall, installed
Helium/native-host registration and communication, code signing, GPL
corresponding-source delivery or an approved written offer plus legal review,
broader real scheduling/window-transition verification, and lawful Pixeldrain
list fixture validation. Gofile remains unsupported. The successful Blender
playlist media test is recorded above and was not repeated.

### Additional bounded scheduler and dependency checks

Added a real-aria2 integration case in `tests/aria2.integration.test.ts`. It uses
the newly packaged aria2 executable, a loopback-only HTTP fixture and a unique
temporary download directory: a scheduled item remains `waiting` with no output
before its due time, then completes with exact fixture bytes after the due time.
Command: `npx vitest run tests/aria2.integration.test.ts -t 'holds a scheduled download'`
with `ARIA2_TEST_BINARY` set to `dist/win-unpacked/resources/vendor/aria2/aria2c.exe`;
result **1 passed, 3 skipped**. This verifies one scheduled-start path against
real aria2, not all real-window transitions, UI behavior, restart recovery or
the one-second boundary race.

`npm audit --omit=dev` found **0 vulnerabilities** in production dependencies.
The full development/build dependency tree reports **6 moderate** advisories in
electron-builder's transitive packaging chain (including minimatch); no
automated upgrade was applied. Review/mitigate this build-toolchain advisory
before release without changing the pinned installer builder unnecessarily.

## Final extracted-payload validation

After the above test-harness and packaging-document updates, the installer was
rebuilt from the current checkpoint with `npm run build:installer` (electron-
builder 26.18.0). Final artifact:
`dist/DonDownload-0.1.0-x64-setup.exe`, 302,265,855 bytes, SHA-256
`f0e271c3644b21a8182023e8351ab7495067ae80565cba699eb6b0abcc4cf3fd`;
Authenticode is **NotSigned**.

7-Zip listed and extracted the NSIS payload to a unique
`%LOCALAPPDATA%\Temp\opencode\dondownload-final-payload-*` directory without
running setup. The package contains the app executable, `app.asar`, native host,
extension manifest, manual native-host registration helper, vendor manifest,
all five tools, app MIT license, third-party notices and all seven license
files. Extracted vendor sizes/hashes and license/notice hashes matched their
staging manifest/repository sources. Version commands passed from extracted
tool paths. The production media/aria2 path locators resolved all packaged tools
against the extracted resource directory (`npm run test:packaged-resources`: **1
passed**). Archive inspection found no obvious test/coverage, dotenv, SQLite or
log files. This is payload and locator verification only: the app was not
launched, installed or uninstalled; no registry, browser profile, physical
input, or existing download directory was touched.

Focused real-aria2 runs using only loopback fixtures passed **3 tests**: future
scheduled submission; outside-hours queue + Start Now + active completion after
the allowed-hours close; and restart recovery of an in-flight transfer (partial
file retained, no silent auto-resume, explicit retry completes via HTTP Range).
The first allowed-hours test attempt exposed a test-only snapshot selection
issue; it was corrected to select by filename and the rerun passed.
`npm run test:fast` passed **504 tests**. The final full `npm run test:gate`
passed **544 tests / 11 skipped**, with typecheck and production build passing.
The opt-in packaged-resource and real-aria2 checks were also run separately and
passed. Source archive candidates and their locally computed hashes are
documented in [licensing-release-audit.md](licensing-release-audit.md).

Overall release readiness remains **BLOCKED** on legal/corresponding-source
review, signing, isolated install/startup/uninstall and installed Helium bridge
verification, plus review of moderate build-toolchain advisories. Pixeldrain
list validation remains fixture-blocked; Gofile folders and torrents/VPN remain
out of scope/deferred.

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

## Latest visible/runtime verification — 2026-11-04

The prior extracted-payload-only statement above was superseded by an opt-in
hidden Electron smoke implementation (`18ca325`) and two independent runs of
the current unpacked production app. Both runs exited normally with **10/10
checks passed** (2.624 s and 1.818 s). They verified actual Electron 45.2.2,
production preload/renderer mount, hidden/unfocused window, isolated SQLite
schema 6, DownloadManager and packaged aria2 1.37.0 readiness, plus yt-dlp
2026.10.26, FFmpeg 9.0.2 and Deno 2.9.8 probes. A second fresh isolated profile
also started and shut down cleanly. This was not an installer run, visible
desktop launch, or real transfer.

**Status classification:**

- **WORKING (runtime verified):** packaged/unpacked Electron hidden startup and
  bounded normal shutdown; SQLite initialization; aria2 and DownloadManager
  startup; bundled tool discovery/version probes. Real aria2 HTTP fixture tests
  pass for completion, pause/resume, scheduled start, allowed-hours queue and
  Start Now, active completion past closing, and restart/Range recovery.
- **IMPLEMENTED (not fully runtime-verified here):** the normal visible desktop
  window and IPC-backed UI; yt-dlp analysis/quality choice and FFmpeg media job
  execution; playlist/Pixeldrain collection workflows; batch persistence and
  native-host/Helium flows. A real Helium session was not performed in this run.
- **BROKEN:** no new product defect confirmed. A first temporary preview server
  attempt failed due to harness command quoting/root mapping and was corrected;
  this was test infrastructure only.
- **UNSUPPORTED / deferred:** Gofile folders, torrents and VPN. Pixeldrain list
  live behavior remains fixture-limited.

## T3-visible renderer and test evidence

The T3 direct browser connection was unavailable, but its server-side preview
was available. The built production React renderer was served in an isolated
preview with an explicitly injected mock `window.donDownload` API. Quick Add,
simulated progress-card rendering, a settings save, a mock media error, and
mock media quality selection (1080p/720p/audio-only, including changing the
selected option) were exercised through preview interactions. This is visual
renderer evidence only: the preview did not run Electron IPC, aria2, yt-dlp,
FFmpeg, playlists, batches, extension code or Helium integration. Chromium
reported one `frame-ancestors`-in-meta-CSP warning; no renderer exception was
reported.

Artifacts are in the ignored local directory
`artifacts/test-runs/electron-smoke-20261104-224215/`: two machine-readable
Electron results and console logs, `aria2-integration.log`, a summary, the
temporary renderer harness, and screenshots. Open `run-summary.md` first. The
visual screenshots are `screenshots/renderer-media-quality-720p.png` and
`screenshots/renderer-media-error.png`; `renderer-quality-interaction.mp4` is a
short mock quality-selection recording.

Current tier results: `npm run test:fast` **513/513** (1.29 s);
`npm run test:gate` **553 passed / 11 skipped**, typecheck/build passed (27.06 s);
focused real-aria2 fixtures **5/5** (46.82 s); packaged Electron smoke **10/10**
twice. No active browser profile, normal userData, registry, real Downloads,
physical desktop input or installer was used. No screenshots of the hidden
Electron smoke exist because the smoke window intentionally remains hidden.

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

## Testing workflow (2026-11-04)

The test commands are now split into three tiers without changing the full
suite: `npm run test:fast` for hermetic unit/component work,
`npm run test:integration` for native-host/registration, optional real-aria2 and
local persistent-batch work, and `npm run test:gate` for the full `npm test`
suite plus the production build. Opt-in live provider checks remain separate:
`npm run test:pixeldrain:live` and `npm run test:playlist:live` run only with
their explicit environment gates. The native-host 22 s bridge-timeout regression
is preserved and selected explicitly with `npm run test:native-host:timeout`; it
is not part of the fast loop. See [testing-workflow.md](testing-workflow.md) for
commands, subsystem filters, measured durations, the strict no-desktop-input
rule, manual-only real browser permission checks, the mocked-renderer vs
native-Electron-IPC distinction, and the historical 3A timing/caveat record.
This workflow change did not rerun or reopen the 3A evidence.

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
- **Playlists/collections and 3B features.** The 3B backend orchestration slice
  and desktop batch UI are covered by hermetic tests plus local real-aria2 batch
  integration. Both a real yt-dlp playlist preview/opaque-entry resolver and a
  selected CC-BY playlist media download are verified above. Live Pixeldrain
  lists and Gofile folders remain unverified. The desktop renderer has now been
  exercised in actual packaged Electron with isolated local HTTP and IPC, but
  not in a visible native window or a real Helium profile. See the dedicated
  3B and runtime-verification sections for exact evidence and gaps.

## Packaged Electron real-world verification (2026-11-04)

The following checks used the unpacked production package at
`artifacts/packaged-verification/win-unpacked/DonDownload.exe`, a fresh isolated
unpacked production package, the actual renderer/preload/IPC and isolated
smoke user-data/download locations. The window was headless/offscreen; no OS
input, real Downloads folder, browser profile or installed application was used.
The CDP harnesses and machine-local artifacts are under `scripts/` and
`artifacts/test-runs/` respectively.

### Media GUI: PASS

- The real Media page probed yt-dlp `2026.10.26` and FFmpeg `9.0.2`, analyzed
  the public CC-BY Blender Open Movies Caminandes entry and displayed 33 real
  format options.
- Exactly one 144p merged VP9/Opus option was explicitly selected in the UI.
  The job completed at **3,974,423 bytes**. Bundled ffprobe confirmed 256×144
  VP9 video and stereo Opus audio; exit code 0. SHA-256:
  `ee27795000223b9eeae75c50fe47a78a4b3435b00f61620315586cc8a6752f65`.
- Evidence: `artifacts/test-runs/electron-media-2026-11-04T23-12-40-813Z/`
  (`result.json`, renderer trace, input/analysis/selection/active/completion
  captures, isolated output). One initial harness sample observed the engine's
  transient `stopped` state before the asynchronous tool probe settled; the
  corrected run waited for `ready` and passed without an extra provider request.
- Audio-only was not repeated; prior 3A audio-only verification remains the
  separate evidence for that path.

### External HTTP GUI: PASS

- GitHub raw redirect completed in the packaged app with inferred filename
  `Windows.gitignore`; 290-byte output SHA-256 matched the public fixture.
- A completed URL could be intentionally added again. An unfinished active
  duplicate instead showed the explicit warning and did not add another job.
- The OVH 1 MiB Range-capable file paused at 16 KiB, resumed, and completed with
  matching 1 MiB size and SHA-256. A raw-GitHub 404 ended in a readable error.
- Evidence: `artifacts/test-runs/electron-http-2026-11-04T23-19-19-139Z/`
  (`result.json`, renderer trace, screenshots and isolated files).

### Playlist quality/cap GUI: PARTIAL / PASS

- The actual packaged Batches page previewed 18 real playlist entries with none
  selected. One pinned CC-BY Caminandes entry was explicitly selected; only then
  did the app analyze its yt-dlp formats. The user selected the reported
  audio-only option, set 25 MiB, and the batch completed at **2,550,209 bytes**.
  The isolated final output stayed below the cap and the parent/item state was
  complete. No quality fallback occurred.
- A separate attempt with the reported 480p merged option downloaded about
  17 MB of streams but failed in yt-dlp post-processing; it did not complete and
  no merged-output success is claimed. The engine surfaced the safe generic
  failure state. This failure remains to be diagnosed independently of caps.
- Successful evidence: `artifacts/test-runs/electron-playlist-2026-11-05T00-06-27-569Z/`
  (`result.json`, screenshots, isolated DB and output). Failed merge evidence:
  `artifacts/test-runs/electron-playlist-2026-11-05T00-05-21-307Z/`.
- No packaged direct-URL batch progress/failure/cancel/retry/restart scenario is
  claimed from this pass. The deterministic real-aria2 batch integration suite
  remains loopback/backend coverage, not renderer lifecycle evidence. Pixeldrain
  lists remain blocked on a lawful, bounded public fixture.

### Helium and daily-use assessment

- Helium was **not rerun** in this pass. Although a previous Milestone 3A headed
  test passed in a disposable profile, creating a new isolated native-host
  registration would write the shared Chromium-compatible current-user registry
  key; safe isolation from the user's existing browser registration was not
  established. Manual permission dialogs remain untested here.
- The tested direct HTTP and individual Media flows work in the production
  package, but Smart Batch renderer lifecycle, playlist batch size/quality
  behavior, packaged batch restart persistence and current Helium integration
  remain open. Therefore this verification alone does **not** establish
  all-features readiness for daily personal use; it does not reveal a product
  failure in the tested HTTP or individual media flows.

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
error. Milestone 3A is PASS. The Milestone 3B backend slice adds persistent
batch orchestration, trusted desktop IPC/preload and hermetic coverage. The
desktop renderer batch UI now adds explicit multi-URL submission, collection
selection, expandable batch cards, independent item actions and safe Gofile
browser opens; native-bridge batch routes and live-provider verification remain
future work.

## Safe next action

1. Continue runtime-first coverage: external HTTP hosts, batches, scheduling,
   media and Helium/native messaging each need their own real-runtime evidence.
   The local loopback UI flow does not establish those behaviours.
2. If visible-window appearance/native chrome needs checking, use a
   user-supervised session only when it will not disrupt the user's desktop; the
   current automation intentionally stays hidden and offscreen.
3. Keep the remaining unverified non-blockers visible rather than treating them
   as regressions or silently closing them.
4. Preserve the earlier Helium automation caveats (disposable profile, CDP/UIA/
   Win32 input, synthetic unsupported-page video, hidden-window completion and
   no FFmpeg child during cancellation). They are historical and are not claims
   about the new HTTP UI run.
5. Do not push or create a release without separate approval.

## CSP diagnostic fix and packaged smoke checkpoint (2026-11-04)

The hidden packaged Electron smoke exposed Chromium's diagnostic that
`frame-ancestors` is ignored in a meta-delivered CSP. Commit `f7baa75` removes
only that ineffective directive from the production and development meta
policies; the effective directives are unchanged. `tests/meta-csp.test.ts`
guards both generated policies and their directive lists.

Verification on the integrated source:

| Command | Result |
| --- | --- |
| `npm run test:fast` | **526 passed**, 37 files (1.33 s) |
| `npm run build` | **passed**; generated production meta CSP has no `frame-ancestors` |
| `npx electron-builder --win --x64 --dir` | **passed**; rebuilt unpacked app |
| `npm run smoke:packaged` | **PASS**, 11/11 checks; 1.853 s; renderer diagnostics: 0 errors, 0 warnings, 0 suppressed, 0 dropped |
| `npm run test:gate` | **566 passed / 11 skipped**, 39 passed + 6 skipped files; build passed (26.93 s test suite) |

The smoke ran the actual packaged Electron 45.2.2 app with a hidden,
unfocused window and unique temporary user data/download paths. SQLite schema
6, aria2 1.37.0, DownloadManager, yt-dlp, FFmpeg and Deno initialized or probed
successfully. The temporary user data was removed after success. The captured
console transcript is retained outside Git at
`artifacts/test-runs/electron-smoke-20261104-2301-csp-fix/smoke-console.log`.
This smoke does not test a real transfer, visible-window interaction, installer,
or Helium/native-messaging integration. The earlier mock-renderer CSP warning
recorded above predates this fix and is now resolved in the actual Electron
diagnostics run. No push or release was made.

## Packaged Electron UI and local HTTP transfer verification (2026-11-04)

Status: **PASS for the exercised local HTTP flow.** The newly added
`scripts/electron-ui-verification.mjs` launched the rebuilt unpacked production
app (`dist/win-unpacked/DonDownload.exe`) in a fresh isolated smoke `userData`
directory. It enabled Chromium CDP on loopback and used DOM input/click events
against the real rendered page. The app window was hidden and offscreen; no
physical input or desktop-window automation was used. This is the production
renderer, production preload and trusted IPC connected to the actual managers,
SQLite and aria2—not the mocked React preview. It is not proof of visible native
window appearance or titlebar behavior.

Observed end-to-end:

1. Captured the real Quick Add form, entered a custom filename and a controlled
   loopback HTTP URL, then submitted through the form.
2. The actual download card reported active progress (512 KiB of 16 MiB at the
   captured point). The card's **Pause** action transitioned to `paused`; the
   **Resume** action restarted transfer and progress increased.
3. Changed the Settings UI global speed limit to **262,144 bytes/s** during the
   active transfer. The UI reported “Settings saved and applied”; an authenticated
   `aria2.getGlobalOption` query to this app's isolated aria2 process returned
   `max-overall-download-limit=262144`.
4. The card reached **Complete**. Output was exactly 16,777,216 bytes and matched
   the deterministic fixture SHA-256:
   `287507f403176f1f5b22b9a4d9cb49f7d7f88ac19e406b5ae87ce109564846bd`.
5. Relaunched the app against the same isolated userData. The UI/IPC snapshot
   retained the completed download, persisted Settings retained 262,144, and
   aria2 restored the same limit on startup.

T3's direct browser preview was disconnected. Instead, the actual Electron
screenshots were placed in a T3-rendered evidence gallery in the conversation.
They are full-page CDP captures from this real packaged run; their accessible
local files are under
`artifacts/test-runs/electron-ui-2026-11-04T22-35-20-186Z/screenshots/`:
`01-quick-add.png`, `02-in-progress.png`, `03-paused.png`,
`05-settings-saved.png`, `06-completed.png` and `07-relaunched-persisted.png`.
The retained machine-readable result is `result.json` in that run directory;
`renderer-trace.json` is a 9.5 MB CDP renderer trace. The actual downloaded test
file is in the run's isolated `user-data/smoke-downloads` directory, not the
user's Downloads folder. These ignored artifacts are local and not committed.

Verification commands for this run: `npm run build` (typecheck and production
bundles passed), `npx electron-builder --win --x64 --dir` (unpacked package
rebuilt), `node --check scripts/electron-ui-verification.mjs`, and
`node scripts/electron-ui-verification.mjs` (end-to-end run passed).
`npm run smoke:packaged` also passed its 11/11 startup/resource/diagnostic
checks on the rebuilt app (2.750 s; zero renderer diagnostics). The fast and full
unit suites were deliberately not rerun; no general unit tests were added. No
control failed in the actual flow, so no product fix or delegation was needed.
The harness's first screenshot draft omitted the card's below-the-fold area; it
was corrected to use full-page CDP captures and the final screenshots show the
actual active/paused/completed states.

This makes the **basic HTTP download path materially better verified**, but is
not enough to claim the whole product ready as a daily driver. Visible native
window behavior, external HTTP servers, real-user Downloads placement, broad
restart/pause schedules, Helium/native messaging and live media/batch scenarios
remain separate coverage gaps. No installer was rebuilt or executed, and no
push/release was made.

## Compact renderer redesign and packaged UI verification (2026-11-05)

The renderer now has a centered compact layout with OLED-black surfaces, higher
contrast supporting text, restrained green accents and a non-floating compact
top navigation: Downloads (default), Media, Batches and Settings. Only the
selected view renders. Downloads puts Quick Add first, prioritizes active/queued
work over completed history, and uses smaller expandable cards with visible
progress, speed/ETA and actions. Empty states are reduced. Media, batch and
settings workflows remain on their existing renderer/preload/IPC contracts.
Settings uses decimal MB/s for the editable global limit and shows the exact
stored B/s alongside the human-readable KB/s/MB/s value; saved backend values
remain byte/sec. No aria2, yt-dlp, SQLite or IPC implementation was rewritten.

The actual rebuilt unpacked Electron app was re-run with isolated CDP on
2026-11-04/05 (run directory `artifacts/test-runs/electron-ui-2026-11-04T23-02-08-182Z/`). The production renderer/preload/IPC accepted Quick Add and downloaded
the throttled 16 MiB loopback fixture; progress, pause, resume, completion/hash,
live limit application and settings/completed-record persistence after relaunch
passed. The same run captured actual Electron screenshots for Downloads default,
active, paused, completed, Media, Batches, Settings and a 375px-wide Downloads
viewport. The narrow viewport reported `documentElement.scrollWidth=365` at a
375px layout width (no horizontal overflow). No physical input or visible
desktop window was used; narrow layout was exercised using CDP viewport metrics.

Screenshots are under that run's `screenshots/` directory (`01-quick-add.png`,
`02-in-progress.png`, `03-paused.png`, `06-completed.png`, `08-media.png`,
`09-batches.png`, `10-settings.png`, `11-narrow-downloads.png`). `result.json`
and the renderer trace are retained in the run directory, outside Git. A
before/after pair is available from the prior actual Electron run at
`artifacts/test-runs/electron-ui-2026-11-04T22-35-20-186Z/screenshots/01-quick-add.png`
and this redesign run's `01-quick-add.png`; the before screenshot visibly had
all sections stacked in one long page.

Verification: `npm run build` (typecheck and production build passed),
`npx electron-builder --win --x64 --dir` (unpacked app rebuilt),
`node --check scripts/electron-ui-verification.mjs`,
`node scripts/electron-ui-verification.mjs` (real packaged CDP flow and required
views passed), and `npm run smoke:packaged` (11/11 checks, zero renderer
diagnostics). No unit tests were added or run; no installer was rebuilt. The
only harness adjustments were selectors/page waits and additional screenshots
for the newly navigable renderer. Visible-native-window behavior remains
untested because verification avoided desktop interference.
