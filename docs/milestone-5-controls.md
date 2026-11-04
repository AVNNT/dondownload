# Milestone 5 download-control runtime

Status: implemented locally in this worktree. Per-download speed limits,
per-download connections, scheduled starts, local-time allowed hours, manual
Start Now, restart/recovery, direct/batch child consistency, a minimal OLED UI
and focused tests are included. Nothing in this slice was exercised with a GUI,
real downloads, installer execution, a browser or OS input.

## Architecture

The runtime extends the existing `DownloadManager` poll loop. There is no second
scheduler:

- `src/shared/schedule.ts` is the pure local-time policy module. It decides
  whether a job may start now and which policy is holding it back.
- `DownloadManager` owns the schedule/allowed-hours decision for every
  `aria2.addUri` job and drives one existing interval timer. Jobs are not handed
  to aria2 before they are allowed; submitted waiting jobs are paused when the
  allowed window closes.
- `BatchManager` direct children still call `DownloadManager.add`, so they go
  through exactly the same gate as a Quick Add download.
- `MediaJobsManager` receives a start gate from the same settings snapshot.
  Jobs queued while the gate is closed stay `queued`; the download manager's
  existing timer calls `pumpPolicy` to start them when the window opens. No
  separate media scheduler was added.

`SettingsManager` calls a new `onChanged` hook after a validated update is
committed. `src/main/index.ts` uses it to run one policy pass immediately, so an
allowed-hours edit does not wait for the next timer tick.

## Start rules and boundaries

All times are the system local clock. No time zone or UTC offset is stored.

| Rule | Behavior |
| --- | --- |
| Allowed-hours start | Inclusive. A start exactly at `09:00` is allowed. |
| Allowed-hours end | Exclusive. A start exactly at `17:00` is not allowed. |
| Normal window | `[start, end)` in local wall-clock minutes. |
| Overnight window | `start > end`, for example `[22:00, 24:00)` plus `[00:00, 06:00)`. |
| Equal start/end | Full 24-hour window when enabled, never a zero-length block. |
| Disabled | No restriction; the stored start/end values are ignored. |
| Schedule due | `now >= scheduledAt`, inclusive. |
| Past schedule | Immediately due; it does not expire into "never". |
| Both blocked | A future schedule is reported before allowed hours so the UI can show the more specific reason. |

DST uses wall-clock components, not elapsed UTC hours. The repeated 01:30 on a
fall-back day is evaluated twice, and the skipped spring-forward hour simply
never matches a local window. Tests use an explicit IANA zone so this behavior
does not depend on the machine running the suite.

A policy pass runs on the existing one-second download poll. A window boundary
therefore takes effect within one poll interval. Active transfers found in the
same pass are deliberately left running.

## Status and user intent

`DownloadItem.status` keeps the existing values. A policy-held job is
`waiting` plus a `blockReason`:

| Public field | Meaning |
| --- | --- |
| `scheduledAt` | Epoch-milliseconds scheduled start, or `null`. |
| `speedLimitBps` | Per-download bytes/second limit, or `null` for unlimited/global. |
| `connections` | Per-download `split` / `max-connection-per-server`, or `null` for the global value. |
| `blockReason` | `scheduled` or `allowed-hours`; `null` when not policy-held. |

A manual pause is always `status: 'paused'` with `blockReason: null`. This is the
distinction the UI and restart recovery use:

- A manually paused job is never unpaused by a schedule or a new allowed window.
  Only an explicit Resume or Start Now changes it.
- A policy-blocked waiting job may be unpaused automatically when its schedule is
  due and the allowed window is open.
- A future-scheduled job that the user pauses becomes `paused`; reaching its
  scheduled time later does not start it.

## Window close and active work

When the allowed window closes:

1. Transfers aria2 reports as `active` continue.
2. Submitted `queued`/`waiting` transfers are paused through
   `aria2.pause` and marked `waiting` + `blockReason: 'allowed-hours'`.
3. Jobs that were never submitted stay `waiting`; they are not handed to aria2.
4. The next window unpauses only policy-held waiting jobs and submits due jobs.

This is why a policy pause is not stored as `paused`: a restart or a later
window must not mistake it for a user pause.

## Per-download aria2 options

`AddDownloadInput` accepts one optional exact-key `controls` object:

```ts
{
  scheduledAt: number | null
  speedLimitBps: number | null
  connections: number | null
}
```

- Non-null `speedLimitBps` becomes `max-download-limit` on `aria2.addUri`.
- Non-null `connections` becomes both `split` and `max-connection-per-server`
  on `aria2.addUri`, in the supported `1..16` range.
- Null `connections` deliberately leaves both options unset so aria2 uses the
  live global `max-connection-per-server` setting. An explicit connection value
  is fixed for that GID; a later global edit applies to new downloads.
- The global speed limit remains `max-overall-download-limit` through
  `aria2.changeGlobalOption`. Per-download and global limits can both apply, with
  aria2 enforcing the tighter effective limit.
- The same options are used by scheduled submission, Resume/Start Now, Retry and
  both direct and batch children.

Unknown, missing, wrong-typed or out-of-range control fields are rejected by the
shared exact-key parser. Controls contain no URL, path, token, header or secret.

## Persistence and restart recovery

- Schema v5 already stores `downloads.scheduled_at` and
  `downloads.speed_limit_bps`.
- Additive transactional schema v6 adds `downloads.connections` and
  `downloads.block_reason`. No table is rebuilt and no existing row is
  rewritten.
- A scheduled or allowed-hours-blocked job persists its `waiting` status and
  block reason before aria2 receives a GID. An empty GID is valid in that state.
- On restart, policy-held waiting rows are kept waiting. When the schedule and
  window permit, the normal policy pass submits them. A persisted user `paused`
  row is never resumed automatically.
- Ordinary `queued`/`active`/`waiting` rows that aria2 no longer tracks keep the
  previous conservative recovery: they become `interrupted` unless they were
  explicitly policy-held.
- Start Now, Resume and Retry are explicit one-process overrides. The override
  is not persisted; after a relaunch the normal policy applies again.

## Media limitation

The media engine is not aria2, so the aria2 per-download speed and connection
options do not apply to media jobs. This slice applies the global allowed-hours
gate to media starts:

- A new media job queued outside the window stays `queued` and is started by the
  download manager's existing timer when the window opens.
- A media job already running when the window closes is allowed to continue.
- Persisted `queued` media rows loaded at startup are not auto-started, because
  the current media schema has no policy-blocked marker or per-job schedule.
- There is no per-media `scheduledAt`, `speedLimitBps` or connection control.

A future media-schema slice would be needed to persist per-job media schedules or
policy holds. Until then, media is global-allowed-hours only.

## API and UI

- Trusted IPC `download:start-now` and preload `startDownloadNow(id)` expose the
  explicit Start Now action.
- `QuickAdd` has an optional OLED-styled "Schedule & limits" area for local start
  time, speed (MiB/s) and connections.
- Each download card shows its schedule/limit and `Scheduled` or `Allowed hours`
  for a policy-held job, with **Start now**. A manually paused card keeps
  **Resume**.
- `SettingsSection` now edits allowed hours (enabled, inclusive start, exclusive
  end) alongside the existing global limits.

## Verification

Focused runs in this worktree:

| Command | Result |
| --- | --- |
| `npx vitest run tests/download-schedule.test.ts tests/download-controls-manager.test.ts tests/download-controls-ipc.test.ts tests/settings-contract.test.ts tests/settings-database.test.ts tests/validation.test.ts tests/settings-manager.test.ts tests/media-jobs-manager.test.ts tests/manager-recovery.test.ts tests/manager-duplicates.test.ts tests/database.test.ts tests/batch-database.test.ts` | **159 passed**, 12 files |
| `npm run test:fast` | **504 passed**, 34 files |
| `npm run typecheck` | **passed** |
| `npm run build` | **passed** |

Coverage includes start/end inclusivity, equal times, overnight windows,
schedule boundaries and expiry, DST spring-forward/fall-back behavior, live
settings edits, active-transfer continuation, policy pause versus manual pause,
Start Now, removal/completion, restart recovery, per-download aria2 options and a
direct batch child using the same gate. All fixtures are controlled and fake;
no real download, browser, GUI, OS input or installer run is involved.

## Known limitations

- Boundary changes are applied by the one-second policy tick; an aria2 waiting
  job could start in the sub-second race between an active transfer finishing and
  the close-window pass pausing it.
- A schedule has only a start time. It does not pause a job later or define an
  end time.
- Start Now intentionally overrides both a future schedule and allowed hours for
  that process. It is not persisted across a relaunch.
- Restart recovery still marks an in-flight transfer `interrupted`; the app does
  not silently resume it. The user retries explicitly.
- Per-download connection values are fixed on the aria2 GID. Global
  `perHostConnections` changes affect new downloads and aria2's global default,
  not already queued per-download overrides.
- Media has no per-job schedule, speed limit or persisted policy hold, as
  described above.
- No GUI, browser, real download, installer execution, push or release was
  performed for this slice.
