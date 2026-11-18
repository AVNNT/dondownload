# Download settings contract and runtime application (Milestone 5A)

Status: shared settings contract, additive SQLite schema v19 persistence, runtime
settings service, trusted IPC/preload API, startup/live aria2 application and a
renderer form for global limits. A Windows installer baseline is integrated.
Scheduling and individual download controls are not implemented; this does not
change existing download, media or batch history and adds no torrent/VPN
behavior. Automatic history cleanup removes old finished list rows only; files
on disk are never deleted.

## Scope

- `src/shared/settings.ts` defines the renderer-safe settings and per-download
  control DTOs plus exact-key parsers with safe bounds.
- `src/main/db/database.ts` migrates the database from v4 to v5 transactionally
  and exposes `loadSettings()` / `saveSettings()` plus
  `saveDownloadControls()` for one download row.
- `src/main/settings/manager.ts` loads the persisted settings once, exposes a
  safe runtime copy, validates updates, applies the three global aria2 limits,
  and keeps persistence/runtime state consistent on failure.
- `src/main/aria2/service.ts` applies the current settings through
  `aria2.changeGlobalOption` after aria2 answers but before it reports ready or
  `start()` resolves.
- `src/main/ipc.ts`, `src/shared/ipc.ts`, `src/shared/types.ts` and
  `src/preload/index.ts` expose `getSettings` / `updateSettings` through the
  existing trusted-sender wrapper.
- `src/renderer/src/components/SettingsSection.tsx` exposes the three global
  aria2 limits. It intentionally does not expose allowed hours, because that
  setting is stored but not yet enforced.
- `tests/settings-contract.test.ts`, `tests/settings-database.test.ts`,
  `tests/settings-manager.test.ts`, `tests/settings-ipc.test.ts` and
  `tests/aria2-args.test.ts` cover the contract, defaults, bounds, CHECK
  constraints, v1-v4 upgrades, failed migration rollback, live apply/rollback,
  startup apply and IPC trust.
- No secret, URL or filesystem path is stored in the settings table or sent in
  a settings response.

## Global settings

One row (`id = 1`) is persisted in `download_settings`. Defaults preserve the
previous all-day, unlimited-speed behavior:

| Field | Default | Allowed range | Meaning |
| --- | --- | --- | --- |
| `maxConcurrentDownloads` | `3` | `1..16` | Maximum concurrent downloads; applied to aria2. |
| `perHostConnections` | `16` | `1..16` | Maximum connections per host; applied to aria2. |
| `globalSpeedLimitBps` | `0` | `0..1073741824` | Global bytes/second; `0` means unlimited; applied to aria2. |
| `allowedHours.enabled` | `false` | boolean | When false, there is no time restriction (all day). |
| `allowedHours.start` | `"00:00"` | exact `HH:mm` | Local-clock start of the allowed window. |
| `allowedHours.end` | `"00:00"` | exact `HH:mm` | Local-clock end of the allowed window. |
| `sortDownloadsByType` | `false` | boolean | Saves new downloads into type subfolders of the default download directory. |
| `historyRetentionDays` | `30` | `0`, `7`, `30`, `90` | Remove old finished list entries after this many days; `0` means Never. Files stay on disk. |

The database also enforces these bounds with CHECK constraints, including
`id = 1`, integer-only flags and zero-padded 24-hour clock strings.

### 16 connections per server and the one-time migration

`DEFAULT_PER_HOST_CONNECTIONS` is `16`, aria2's hard cap: 16 connections per
server measured much faster than the previous default of 4. Schema version 14
performs the one-time settings migration, raising a stored
`per_host_connections = 4` (the old default) to `16`. Only that exact value is
touched, and because the migration belongs to the schema version it runs once
per database: a user who later chooses 4 again keeps it.

### Automatic per-host back-off

Some servers refuse 16 parallel connections. When aria2 reports one of those
failures — HTTP 429 or 503, "Too many connections", or a repeated
connection-refused/reset on the same host — the connection count for **that
host only** walks down `16 -> 8 -> 4 -> 1` and the download is retried
automatically with the lower value. The user's setting is always the upper
bound, and the reduced value is remembered in memory for the session (TTL 24 h)
so new downloads to that host start from it. The memory is keyed by host name
only; no URL, header or cookie is stored. The policy lives in the pure module
`src/main/downloads/perHostConnections.ts` and is covered by
`tests/per-host-connections.test.ts`.

Each download sets aria2's `split` to its effective connection count, so a
lowered count also lowers the split. The launch arguments keep
`--min-split-size=1M`, `--optimize-concurrent-downloads=true`,
`--stream-piece-selector=inorder` and `--disk-cache=0` (see Performance tuning
below).

### Runtime defaults and the 5/8 to 3/4 change

Before this slice aria2 was launched with hard-coded
`--max-concurrent-downloads=5` and `--max-connection-per-server=8`. Runtime
settings now use the contract defaults (`3` concurrent downloads and `4`
connections per host) and apply them on every start. This is an explicit
behavior change from the previous hard-coded values; it is documented rather
than silently migrated because the v5 settings row was already created with
these defaults.

`buildAria2Args` now launches with the same shared defaults, and the
`onBeforeReady` hook applies the persisted values before the first download can
start. `globalSpeedLimitBps` is always applied (`0` = unlimited). No automatic
aria2 restart is performed when settings change.

### Sort downloads into folders by type

Off by default. When enabled, a new download that uses the default download
directory (the user did not pick a folder for it) is saved into a subfolder
chosen by extension:

| Folder | Extensions |
| --- | --- |
| `Video` | mp4 mkv webm mov avi m4v ts flv wmv, plus `.funscript` |
| `Audio` | mp3 m4a flac wav ogg opus aac wma |
| `Images` | jpg jpeg png gif webp avif heic bmp svg |
| `Archives` | zip rar 7z tar gz tgz xz bz2 zst iso |
| `Documents` | pdf doc docx xls xlsx ppt pptx txt rtf epub md csv odt |
| `Programs` | exe msi msix apk dmg appimage |

Unknown extensions and files without one stay in the default directory.
`.funscript` goes to `Video` so a player finds the script next to its video.
Media jobs also go to `Video` (video output) or `Audio` (audio-only output) when
sorting is on; with sorting off they keep the existing `Media` folder.

The subfolder is created when missing. The mapping and path resolution live in
the pure `src/shared/typeFolders.ts` module. Only new downloads are affected:
existing rows are never moved, and a download with an explicitly picked folder
is never re-sorted.

### Choosing a folder for one download

The Add dialog shows the save folder above the primary button. **Change** opens
the native folder picker and applies the choice to that one direct download;
**Use default** clears it. The picked folder may be outside the default download
root. Main keeps the path behind a short-lived opaque token, resolves it again
when the download is added, and re-checks that the folder still exists. A
download in a picked folder bypasses type sorting, and its retry/resume path
also remembers the folder after a restart.

### Automatic history cleanup

`historyRetentionDays` keeps the download list small without touching files on
disk. The choices are Never (`0`), 7, 30 and 90 days; the default is 30. The
Settings page shows it as "Remove finished entries from the list after" with the
hint "Files stay on disk."

Eligibility is deliberately narrow:

- Downloads: `complete`, `error` and `interrupted` rows whose
  `completedAt ?? updatedAt` is strictly older than the cutoff. An `error` or
  `interrupted` row with a pending automatic retry is kept.
- Media jobs: `complete`, `error`, `cancelled` and `interrupted` rows with the
  same timestamp rule.
- Active, queued, waiting, paused, scheduled and retrying rows are never
  removed.
- A child row referenced by a batch is kept while that batch still has any
  unfinished item.
- A batch is removed only when every item is terminal and the batch's own
  finished time is older than the cutoff. Its child rows are evaluated
  separately and keep their files.

The cleanup reuses the existing "Remove from list" / "Clear download list" path:
every list source is deleted in one SQLite transaction and the managers then
clear their in-memory maps through the same forget helpers, so snapshots,
thumbnails and caches stay consistent. Nothing is deleted from the filesystem.

It runs once about 30 seconds after startup (so first paint is not delayed),
then every 6 hours, and immediately after a committed settings change. "Never"
disables all runs. Schema 19 adds the setting column and expression indexes on
`(status, COALESCE(completed_at, updated_at))` for downloads, media jobs and
batches so the state + timestamp predicate stays cheap.

### Runtime application

- **Startup:** `SettingsManager` loads `loadSettings()` once. `Aria2Service`
  calls the settings hook after aria2 answers `aria2.getVersion()` and before it
  sets `status: 'ready'` or resolves `start()`. A rejected
  `aria2.changeGlobalOption` aborts startup with `ARIA2_SETTINGS_FAILED` rather
  than reporting ready with stale options.
- **Live update:** `updateSettings` validates the complete exact-key object with
  `parseDownloadSettings` before persistence or aria2. When aria2 is ready, the
  three global options are applied first; the row is saved only after aria2
  accepts them. If the live apply fails, the previous options are re-applied
  (rollback when aria2 is reachable) and neither the persisted row nor the
  cached runtime settings change. If saving fails after a successful apply, the
  previous options are re-applied and the update is reported as failed.
- **No restart:** settings changes use `aria2.changeGlobalOption` only. The
  managed aria2 process and active downloads are not restarted, paused or
  otherwise altered.
- **Not applied yet:** allowed-hours enforcement and per-download
  `scheduledAt` / `speedLimitBps` remain contract/persistence only. No
  scheduler, download-manager wiring or UI is part of this slice.

## Settings API

| Surface | Name | Behavior |
| --- | --- | --- |
| IPC | `settings:get` | Returns the validated `DownloadSettings` snapshot. |
| IPC | `settings:update` | Accepts one complete `DownloadSettings` object; validates before persistence and before changing aria2. |
| Preload | `getSettings()` | `Promise<ApiResult<DownloadSettings>>`. |
| Preload | `updateSettings(settings)` | Replaces the full settings object and returns the applied snapshot. |

Both IPC channels use the same trusted-sender wrapper as the existing download,
media and batch channels. The payload is the exact-key DTO above; unknown,
missing, wrong-typed or out-of-range values are rejected with `ValidationError`
and are never clamped.


### Allowed-hours semantics

- Time is always the **system local clock**; no timezone or UTC conversion is
  stored.
- `start` and `end` are zero-padded 24-hour `HH:mm` strings (`00:00` through
  `23:59`). Values such as `9:05`, `24:00` and `09:60` are rejected.
- A window where `start > end` crosses midnight and is supported, for example
  `22:00` to `06:00`.
- `start === end` means a full 24-hour window when enabled. It never means
  "zero-length" or "blocked".
- `enabled: false` means no restriction regardless of the start/end values.
  This is the default and preserves the current all-day behavior.

## Per-download controls

Schema v5 adds two nullable columns to every `downloads` row:

| Column | Default for existing rows | Meaning |
| --- | --- | --- |
| `scheduled_at` | `NULL` | Optional epoch-milliseconds scheduled start. `NULL` means unscheduled. |
| `speed_limit_bps` | `NULL` | Optional bytes/second limit. `NULL` means unlimited. |

- `scheduled_at` must be a safe integer in `0..8640000000000000`.
- `speed_limit_bps` must be `NULL` or an integer in `1..1073741824`. Zero is
  rejected for per-download rows because `NULL`, not zero, represents
  "unlimited" there; the global setting uses `0` for unlimited.
- Existing and newly migrated rows receive `NULL` for both columns, so their
  behavior is unchanged. `ADD COLUMN` is additive and does not rewrite rows.
- `Database.saveDownloadControls(id, controls)` validates through the shared
  parser before writing. The download manager and IPC are not wired to call it
  in this milestone.

## Parsers and DTOs

`parseDownloadSettings`, `parseAllowedHours`, `parseClockTime`,
`parseDownloadControls`, `parseScheduledAt` and
`parsePerDownloadSpeedLimitBps` are exact-key parsers. Unknown or missing
fields, wrong types, out-of-range numbers and malformed clock strings are
rejected with `ValidationError`; values are never silently clamped. The DTOs
contain only the fields shown above, so URLs, paths, counters, credentials and
other secrets have no place in the contract.

## Schema v5 migration

- The migration adds the two `downloads` columns and creates the single-row
  `download_settings` table inside one `BEGIN IMMEDIATE` transaction.
- Existing v1 download rows, v2 media rows, v3/v4 batch parents/items and all
  statuses, indexes and the `batch_items` cascade FK are preserved.
- A failed v5 migration rolls back completely: no new columns, no settings row
  and no version bump. There is no destructive table rebuild in v5.
- `SCHEMA_VERSION` is `19`. Databases written by a newer schema are still
  refused rather than modified.

## Performance tuning

Measured with the local loopback benchmark in `tests/bench/`
(`npm run bench:throughput`, excluded from `test:fast`). It serves a generated
1 GiB file with HTTP Range support through the real `buildAria2Args` launch
path, optionally capping every socket at 8 MiB/s to model a slow server. Each
row is a median over rotated runs, so a variant does not always run first.

### aria2 launch flags (chosen)

| Flag | Why it is kept |
| --- | --- |
| `--split=16` / `--max-connection-per-server=16` | 16 connections per file measured ~2x the throughput of 8; already the user's configurable ceiling. |
| `--min-split-size=1M` | Smaller pieces let all 16 connections start early. aria2's 20M default used only 8 connections on a 256 MiB file (53.8 vs 101.1 MiB/s). |
| `--optimize-concurrent-downloads=true` | Disabling it dropped the 1 GiB loopback run from ~466 to ~131 MiB/s on a short sweep. |
| `--stream-piece-selector=inorder` | New. In-order pieces let 16 parallel connections write the file sequentially instead of out of order. 1 GiB / 16 connections: **427 -> 590 MiB/s** (median of 4 rounds). |
| `--disk-cache=0` | New. With sequential writes, the 16 MiB default cache only adds buffering: **590 -> 676 MiB/s** and aria2 CPU 1.48 s -> 1.27 s per 1 GiB (median of 8 rounds). |
| `--file-allocation=none` | Unchanged. `falloc` was neutral and `prealloc` pushed time-to-first-byte from ~80 ms to 664 ms with no throughput gain. Keeping `none` also avoids the documented `falloc` stall on non-NTFS/FAT32 and network targets. |

Before/after for the combined change on the 1 GiB unlimited-loopback fixture:

| Metric | Previous profile | Tuned profile |
| --- | ---: | ---: |
| Throughput | 427 MiB/s | **676 MiB/s** (1.58x) |
| Elapsed | 2396 ms | **1516 ms** |
| Time to first byte | 24 ms | 23 ms (within noise) |
| aria2 CPU per 1 GiB | 1.32 s | 1.27 s |
| Peak aria2 RAM | 13.5 MiB | 13.1 MiB |

On the 8 MiB/s-per-socket slow-server fixture the same change is neutral
(102.7 vs 105.5 MiB/s, 512 MiB file), because the server, not the disk, is the
bottleneck. The per-host connection back-off is unchanged and every download
still sets `split` to its own effective connection count.

Candidates measured and deliberately **not** kept: 32M/64M disk cache
(415/343 vs 466 MiB/s), HTTP pipelining (360 vs 466 MiB/s), `piece-length=4M`
(no gain), `stream-piece-selector=inorder` without disabling the cache (less
gain than the pair), `prealloc`/`falloc`, and `--lowest-speed-limit` (aborts
legitimately slow transfers without improving speed).

### yt-dlp media flags

`--concurrent-fragments` is now **8** (was 4). The native HLS/DASH downloader
already reports per-fragment progress, so fragments stay on yt-dlp and FFmpeg
is still used only for the merge/remux. Local HLS fixture: 100 fragments, 100 ms
latency per request.

| Concurrent fragments | Fragment download window | Whole job (startup + merge) |
| ---: | ---: | ---: |
| 4 (previous) | 3077 ms | 5507 ms |
| 8 (chosen) | **1567 ms** (1.96x) | **4017 ms** |
| 12 | 1215 ms | 3633 ms |

12 was faster on the synthetic fixture but is not used: 8 is the upper end of
the conservative range for real CDNs, and media jobs do not have the per-host
back-off that aria2 downloads have.

Not adopted for media:

- `--http-chunk-size`: no local evidence with per-connection throttling, and it
  adds Range requests and retry surface for servers that do not honour them.
- `--no-part`: hurts resume after an interruption; the current `.part` behavior
  is kept.
- yt-dlp's aria2c external downloader: no clear win for fragments, and it would
  duplicate progress/back-off handling outside the aria2 service.
- FFmpeg `-c copy` is already how yt-dlp merges; no transcode, `-threads` or
  postprocessor arguments were added because a stream copy does not decode.



| Command | Result |
| --- | --- |
| `npx vitest run tests/settings-manager.test.ts tests/settings-ipc.test.ts tests/settings-contract.test.ts tests/settings-database.test.ts tests/aria2-args.test.ts` | **44 passed**, 5 files |
| `npm run test:fast` | **465 passed**, 30 files |
| `npm run typecheck` | **passed** |
| `npm run build` | **passed** |

## Not included

- No allowed-hours enforcement and no scheduler. The window is persisted but has
  no effect on downloads yet.
- No `AddDownloadInput`/`DownloadManager` wiring for `scheduledAt` or
  `speedLimitBps`; `saveDownloadControls` remains uncalled by the manager.
- No renderer UI for settings, no installer change, no torrent/VPN work and no
  privileged OS behavior.
- No automatic aria2 restart on settings changes.
