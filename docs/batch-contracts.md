# Batch and collection contracts (Milestone 3B foundation)

Status: foundation only. This document describes the shared contracts and SQLite
v3 persistence added by the first Milestone 3B task. Providers, the playlist
engine, the batch orchestrator, renderer UI, IPC handlers and native-bridge
routes are deliberately **not** part of this layer.

## Scope and safety boundaries

- Desktop-first media playlists, Pixeldrain lists and direct-URL batches.
- No credential, cookie, token or auth-header extraction. No CAPTCHA or DRM
  bypass.
- **No torrent functionality or torrent networking of any kind.** No Milestone 4
  or Milestone 5 behavior is included.
- Public batch DTOs contain no source URL, disk path, token, header, cookie,
  selector or provider-internal metadata.
- Internal persistence may keep only a normalized HTTP(S) source URL on the
  batch/item rows so a later task can retry. Credentials are rejected and URL
  fragments are stripped before storage.
- Public item child IDs are opaque references to existing download/media jobs.
  They are not URLs or selectors.

The implementation lives in:

- `src/shared/batches.ts` — kinds, statuses, public/internal shapes, strict
  parsers and the safe `toPublicBatch` conversion.
- `src/main/db/database.ts` — additive schema v3 and batch persistence methods.
- `tests/batch-contract.test.ts`, `tests/batch-database.test.ts`.

## Kinds

| Kind | Meaning |
| --- | --- |
| `media-playlist` | A playlist whose entries become media jobs. Exactly one source URL is accepted at creation. |
| `pixeldrain-list` | A Pixeldrain list whose files become download/media children. Exactly one source URL is accepted at creation. |
| `direct-urls` | One or more independent direct HTTP(S) URLs. 1–500 sources are accepted at creation. |

## Statuses

Batch statuses:

`queued`, `running`, `complete`, `partial`, `error`, `cancelled`, `interrupted`

- `partial` means the batch finished while at least one item kept an independent
  error.
- `cancelled` means an explicit group cancel.
- `interrupted` is for recovery after a restart; only `queued` and `running` are
  active statuses.

Item statuses:

`queued`, `running`, `complete`, `error`, `cancelled`, `interrupted`

Each item owns its own `errorMessage`, byte progress and timestamps. An item
failure never overwrites a sibling's state. Individual retry/cancel and group
cancel are therefore state changes, not new child records.

Aggregate progress is derived by `summarizeBatchItems`:

- `totalItems`, `completedItems` and `failedItems` are counts.
- `completedBytes` is the sum of item bytes.
- `totalBytes` is `null` if any item's total is still unknown; unknown totals are
  never invented.

## Public vs internal

Public `Batch` / `BatchItem` values are strictly parsed with exact keys and
bounded values. `toPublicBatch` builds the public shape field by field, so
internal `sourceUrl` values cannot leak by accident.

Internal `BatchRecord` / `BatchItemRecord` add `sourceUrl` only. They are used by
the main process and are never sent over IPC or the native bridge. Existing
`DownloadItem` and `MediaJob` public contracts are unchanged.

## SQLite schema v3

Migration v3 is additive and transactional. It never rewrites v1 download rows or
v2 media rows.

`batches`:

`id`, `kind`, `title`, `status`, `source_url`, `error_message`, `created_at`,
`updated_at`, `completed_at`

`batch_items`:

`id`, `batch_id` (foreign key, cascade delete), `position`, `kind`, `status`,
`child_id`, `title`, `label`, `completed_bytes`, `total_bytes`, `error_message`,
`source_url`, `created_at`, `updated_at`, `completed_at`

Indexes cover batch creation/status and item ordering/status. Item positions are
unique per batch. There are no cookie, token, header, selector, guest-token or
disk-path columns.

Persistence lifecycle API added in this layer:

- `loadBatches()` / `loadBatch(id)`
- `saveBatch(record)`
- `saveBatchWithItems(record, items)` — atomic parent+children write
- `saveManyBatchItems(items)` — atomic progress write
- `deleteBatch(id)` — cascades to items only
- `deleteBatchItem(batchId, itemId)`

These are additive; existing download/media methods and behavior are unchanged.

## Recovery semantics

A later orchestrator can mark active batches/items `interrupted` through the same
save methods after a restart. Completed, cancelled and errored items stay
untouched. Retry is expected to move an item back to `queued` and clear its error;
group cancel is expected to set the parent to `cancelled` and cancel active
children. None of that orchestration is implemented in this foundation task.

## Explicitly deferred

- Provider implementations and network calls.
- Playlist/Pixeldrain resolution engines.
- Batch orchestration, retry/cancel wiring and recovery execution.
- Renderer components, IPC handlers, preload APIs and native-bridge routes.
- Milestone 4 and 5, torrents, VPN and desktop automation.
