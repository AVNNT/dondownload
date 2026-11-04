# Download settings contract and runtime application (Milestone 5A)

Status: shared settings contract, additive SQLite schema v5 persistence, runtime
settings service, trusted IPC/preload API, and startup/live aria2 application.
This milestone still does **not** add renderer UI, scheduling or individual
download controls, touch the installer, or add torrent/VPN behavior. It also
does not change existing download, media or batch history.

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
| `perHostConnections` | `4` | `1..16` | Maximum connections per host; applied to aria2. |
| `globalSpeedLimitBps` | `0` | `0..1073741824` | Global bytes/second; `0` means unlimited; applied to aria2. |
| `allowedHours.enabled` | `false` | boolean | When false, there is no time restriction (all day). |
| `allowedHours.start` | `"00:00"` | exact `HH:mm` | Local-clock start of the allowed window. |
| `allowedHours.end` | `"00:00"` | exact `HH:mm` | Local-clock end of the allowed window. |

The database also enforces these bounds with CHECK constraints, including
`id = 1`, integer-only flags and zero-padded 24-hour clock strings.

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
- `SCHEMA_VERSION` is `5`. Databases written by a newer schema are still
  refused rather than modified.

## Verification

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
