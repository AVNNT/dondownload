# Download settings contract (Milestone 5A foundation)

Status: shared settings contract and additive SQLite schema v5 persistence.
This milestone intentionally does **not** apply the settings at runtime, expose
IPC/preload methods, add renderer UI, touch the installer, or add torrent/VPN
behavior. It also does not change any existing download, media or batch
history.

## Scope

- `src/shared/settings.ts` defines the renderer-safe settings and per-download
  control DTOs plus exact-key parsers with safe bounds.
- `src/main/db/database.ts` migrates the database from v4 to v5 transactionally
  and exposes `loadSettings()` / `saveSettings()` plus
  `saveDownloadControls()` for one download row.
- `tests/settings-contract.test.ts` and `tests/settings-database.test.ts` cover
  the contract, defaults, bounds, CHECK constraints, v1-v4 upgrades and failed
  migration rollback.
- No settings are sent over IPC or the native bridge. No secret, URL or
  filesystem path is stored in the settings table.

## Global settings

One row (`id = 1`) is persisted in `download_settings`. Defaults preserve the
previous behavior: all-day downloads and unlimited speed.

| Field | Default | Allowed range | Meaning |
| --- | --- | --- | --- |
| `maxConcurrentDownloads` | `3` | `1..16` | Maximum concurrent downloads when the setting is later applied. |
| `perHostConnections` | `4` | `1..16` | Maximum connections per host when later applied. |
| `globalSpeedLimitBps` | `0` | `0..1073741824` | Global bytes/second; `0` means unlimited. Upper bound is 1 GiB/s. |
| `allowedHours.enabled` | `false` | boolean | When false, there is no time restriction (all day). |
| `allowedHours.start` | `"00:00"` | exact `HH:mm` | Local-clock start of the allowed window. |
| `allowedHours.end` | `"00:00"` | exact `HH:mm` | Local-clock end of the allowed window. |

The database also enforces these bounds with CHECK constraints, including
`id = 1`, integer-only flags and zero-padded 24-hour clock strings.

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
| `npx vitest run tests/settings-contract.test.ts tests/settings-database.test.ts tests/database.test.ts tests/batch-database.test.ts` | **53 passed**, 4 files |
| `npm run test:fast` | **passed** |
| `npm run typecheck` | **passed** |

## Not included

- No runtime application of concurrency, per-host connection, speed-limit or
  allowed-hours values to aria2 or the media engine.
- No `AddDownloadInput`/`DownloadManager` wiring for `scheduledAt` or
  `speedLimitBps`.
- No IPC/preload/renderer UI, no installer change, no torrent/VPN work and no
  privileged OS behavior.
