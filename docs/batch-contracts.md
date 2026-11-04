# Batch and collection contracts (Milestone 3B)

Status: shared contracts, SQLite v4 persistence and a main-process batch
orchestration slice are implemented. This document describes the contracts and
schema. The orchestrator, desktop IPC/preload wiring and hermetic tests are
covered in [development-status.md](development-status.md). Renderer UI and
native-bridge batch routes are deliberately **not** part of this layer.

## Scope and safety boundaries

- Desktop-first media playlists, Pixeldrain lists and direct-URL batches.
- No credential, cookie, token or auth-header extraction. No CAPTCHA or DRM
  bypass.
- **No torrent functionality or torrent networking of any kind.** No Milestone 4
  or Milestone 5 behavior is included.
- Public batch and collection-preview DTOs contain no source URL, disk path,
  token, header, cookie, selector or provider-internal metadata.
- Internal persistence may keep only a normalized HTTP(S) source URL on the
  batch/item rows so a later task can retry. Credentials are rejected and URL
  fragments are stripped before storage.
- Public item child IDs are opaque references to existing download/media jobs.
  They are not URLs or selectors.

The implementation lives in:

- `src/shared/batches.ts` — kinds, statuses, collection-preview DTOs,
  public/internal shapes, strict parsers and the safe `toPublicBatch`
  conversion.
- `src/main/db/database.ts` — additive schema v4 and batch persistence methods.
- `src/main/batches/manager.ts` — persistent batch orchestration.
- `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts` — trusted desktop
  IPC/preload surface.
- `tests/batch-contract.test.ts`, `tests/batch-database.test.ts`,
  `tests/batches-manager.test.ts`, `tests/batches-ipc.test.ts`.

## Kinds

| Kind | Meaning |
| --- | --- |
| `media-playlist` | A playlist whose entries become media jobs. Exactly one source URL is accepted at creation. |
| `pixeldrain-list` | A Pixeldrain list whose files become download/media children. Exactly one source URL is accepted at creation. |
| `direct-urls` | One or more independent direct HTTP(S) URLs. 1–500 sources are accepted at creation. |

## Collection previews and explicit selection

Playlist and Pixeldrain-list batches are never queued as a whole. They first
produce an ephemeral, renderer-safe `CollectionPreview`:

```ts
interface CollectionPreview {
  id: string // opaque server-generated preview ID
  kind: 'playlist' | 'pixeldrain-list'
  title: string
  entryCount: number
  availableCount: number
  unavailableCount: number
  entries: CollectionEntry[]
}

interface CollectionEntry {
  id: string // opaque preview-local entry ID
  position: number
  title: string
  availability: 'available' | 'unavailable'
  errorCode: CollectionEntryErrorCode | null
  errorReason: string | null
}
```

- Preview and entry IDs are opaque and bounded. They are never provider URLs,
  yt-dlp selectors or raw provider identifiers.
- `entryCount` must equal the number of entries. `availableCount` and
  `unavailableCount` must add up to `entryCount` and match the entries.
- Entry IDs and positions must be unique; positions must be inside the preview.
- An unavailable entry is independent: it carries a stable safe `errorCode`
  (for example `removed`, `private`, `region-restricted`, `unsupported`,
  `too-large` or `unknown`) and an optional short, safe reason. An available
  entry must not carry error metadata.
- A safe reason is bounded and rejected if it looks like a URL or filesystem
  path. Raw provider error text, headers, cookies, tokens and arbitrary provider
  objects are never part of the DTO.
- Preview entries are display data only. They are not a queue and cannot be
  auto-selected.

Analysis input is strict:

```ts
parseAnalyzeCollectionInput({ url })
// -> { url } normalized HTTP(S), credentials rejected, fragment stripped
```

Batch creation from a preview is always explicit:

```ts
parseCreateCollectionBatchInput({ previewId, selectedEntryIds })
// selectedEntryIds: 1..500 opaque entry IDs, unique, no implicit "all"
```

There is intentionally no `all`, `selectAll`, URL, selector or provider-token
field in the selection input. An empty selection, duplicate IDs, more than 500
IDs, unknown fields or malformed IDs are rejected.

## Statuses

Batch statuses:

`queued`, `running`, `complete`, `partial`, `error`, `cancelled`, `interrupted`

- `partial` means the batch finished while at least one item kept an independent
  error or was skipped/unavailable.
- `cancelled` means an explicit group cancel.
- `interrupted` is for recovery after a restart; only `queued` and `running` are
  active statuses.

Item statuses:

`queued`, `running`, `complete`, `error`, `unavailable`, `skipped`,
`cancelled`, `interrupted`

Each item owns its own `errorMessage`, byte progress and timestamps. An item
failure never overwrites a sibling's state. Individual retry/cancel and group
cancel are therefore state changes, not new child records.

- `error` means an attempted item failed.
- `unavailable` means the provider preview says the entry cannot be downloaded
  (for example private, removed or region-restricted).
- `skipped` means the item was deliberately not attempted for a safe local
  reason.
- `unavailable` and `skipped` are terminal skips, not failures. They are
  independent of sibling items and are counted by `skippedItems`. A public
  `BatchItem` with either status must carry `completedBytes: 0` and
  `totalBytes: null`.

Aggregate progress is derived by `summarizeBatchItems`:

- `totalItems`, `completedItems`, `failedItems` and `skippedItems` are counts.
- `skippedItems` is the number of items with status `unavailable` or `skipped`.
  It never includes `error` items.
- `completedBytes` is the sum of verified item bytes. Skipped/unavailable items
  contribute no bytes.
- `totalBytes` is `null` if any non-skipped item's total is still unknown;
  unknown totals are never invented. A skipped/unavailable item does not make
  the whole batch's total unknown.
- `completedItems + failedItems + skippedItems` can never exceed
  `totalItems`.

## Public vs internal

Public `Batch` / `BatchItem` values are strictly parsed with exact keys and
bounded values. `toPublicBatch` builds the public shape field by field, so
internal `sourceUrl` values cannot leak by accident.

Internal `BatchRecord` / `BatchItemRecord` add `sourceUrl` only. They are used by
the main process and are never sent over IPC or the native bridge. Existing
`DownloadItem` and `MediaJob` public contracts are unchanged.

## SQLite schema v4

Migration v4 is additive and transactional. It preserves v1 download rows, v2
media rows and v3 batch parent rows, and rebuilds only `batch_items` to accept the
`unavailable`/`skipped` item statuses. A failed v4 rebuild rolls back completely
and leaves the prior v3 schema and rows intact.

`batches`:

`id`, `kind`, `title`, `status`, `source_url`, `error_message`, `created_at`,
`updated_at`, `completed_at`

`batch_items`:

`id`, `batch_id` (foreign key, cascade delete), `position`, `kind`, `status`,
`child_id`, `title`, `label`, `completed_bytes`, `total_bytes`, `error_message`,
`source_url`, `created_at`, `updated_at`, `completed_at`

Indexes cover batch creation/status and item ordering/status. Item positions are
unique per batch. There are no cookie, token, header, selector, guest-token or
disk-path columns. Collection previews are ephemeral and are not persisted.

The `batch_items.status` CHECK accepts `queued`, `running`, `complete`, `error`,
`unavailable`, `skipped`, `cancelled` and `interrupted`. `SCHEMA_VERSION` is 4.

Persistence lifecycle API added in this layer:

- `loadBatches()` / `loadBatch(id)`
- `saveBatch(record)`
- `saveBatchWithItems(record, items)` — atomic parent+children write
- `saveManyBatchItems(items)` — atomic progress write
- `deleteBatch(id)` — cascades to items only
- `deleteBatchItem(batchId, itemId)`

These are additive; existing download/media methods and behavior are unchanged.

## Recovery semantics

The batch manager marks active batches/items `interrupted` on startup and on
graceful shutdown, then persists the result. Completed, cancelled, errored,
unavailable and skipped items stay untouched. Nothing is auto-resumed. Retry moves
one failed/interrupted item back to `queued` and re-resolves its source; group
cancel sets the parent to `cancelled` and cancels/pauses active children. Removing
a batch deletes only its parent row (and item rows by cascade), never a child
download/media record or a file.

## Explicitly deferred

- Renderer batch/selection components.
- Native-bridge batch routes.
- Live-provider verification for playlist, Pixeldrain and Gofile behavior.
- Milestone 4 and 5, torrents, VPN and desktop automation.
