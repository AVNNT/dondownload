# Media contracts (Milestone 3A foundation)

Status: contracts plus integrated implementation. The media engine, media
manager, renderer media UI, native-bridge routes, C# host and extension bridge
have since been integrated and verified end to end in a headed Helium run.

## Public API

All methods are additive on `window.donDownload`; the existing download API is
unchanged.

| Method | IPC channel | Result |
| --- | --- | --- |
| `analyzeMedia(input)` | `media:analyze` | `ApiResult<MediaAnalysis>` |
| `queueMedia(input)` | `media:queue` | `ApiResult<MediaSnapshot>` |
| `getMediaSnapshot()` | `media:get-snapshot` | `ApiResult<MediaSnapshot>` |
| `getMediaJob(jobId)` | `media:get-job` | `ApiResult<MediaJob>` |
| `cancelMedia(jobId)` | `media:cancel` | `ApiResult<MediaSnapshot>` |
| `removeMedia(jobId)` | `media:remove` | `ApiResult<MediaSnapshot>` |
| `showMediaInFolder(jobId)` | `media:show-in-folder` | `ApiResult<null>` |
| `onMediaSnapshotChanged(listener)` | `media:snapshot-changed` | unsubscribe function |

`analyzeMedia` takes `{ url: string }`. `queueMedia` takes
`{ analysisId: string, optionId: string, force?: true, outputFormat?: "auto" | "mp4" | "mkv" | "webm" }`;
`force` is only for an explicit user "Download again" action. Omitting
`outputFormat` means `auto`, which uses the analysis's source-compatible
pairing/container without transcoding.

### Public DTO guarantees

- `MediaFormatOption`: `kind` (`video` | `audio`), opaque server-generated
  `optionId`, server-generated `label`, `container`, nullable `width`/`height`/
  `fps`, nullable `videoCodec`/`audioCodec`, `hasAudio`, `requiresMerge`, and
  nullable `filesizeBytes`; display estimates use `estimatedBytes` with
  `sizeIsEstimate`. `outputFormats` advertises only containers producible
  without transcoding, `outputSizes` provides a size per pairing when stream
  selection changes, `formatIds` exposes the verified source IDs for advanced
  display only, and `hdr` indicates source HDR metadata. The opaque `optionId`
  remains the only identifier accepted for queueing.
- `MediaAnalysis`: opaque `analysisId`, `title`, nullable `durationSeconds`,
  nullable safe HTTPS `thumbnailUrl`, verified `options`, nullable
  `bestVideoOptionId`, nullable `bestAudioOptionId`, and `expiresAt` (Unix epoch ms). Best-option IDs must
  reference an option of the correct kind.
- `MediaJob`: `id` (server-generated opaque identifier; UUID v4 is the
  reference implementation), `analysisId`, `optionId`, `kind`, `label`,
  safe analyzed `title`, `status`, `completedBytes`, nullable `totalBytes`, `speedBps`,
  nullable `errorMessage`, `createdAt`, `updatedAt`, `completedAt`.
  It never contains a page URL, disk path, raw yt-dlp format ID/selector,
  headers or cookies.
- `MediaToolState`: `status` (`stopped` | `starting` | `ready` |
  `unavailable` | `error`), nullable `version`, `message`, `hint`.
- `MediaSnapshot`: `{ tool: MediaToolState, jobs: MediaJob[], revision?: number }`.
  `revision` is the media delta-stream revision when an invoke response was
  built; the renderer uses it to discard a response older than a snapshot delta
  it already applied.
- `MediaQueueInput`: `{ analysisId, optionId, force?: true }`.

`MediaJobRecord` in `src/shared/media.ts` is an **internal persistence shape**
with `sourceUrl`, `title`, `dir` and `filePath`. It must never cross IPC or the
native bridge. `normalizeMediaSourceUrl` accepts only http(s), requires a host,
rejects userinfo, and removes fragments before storage.

## Native bridge contract

The existing `queue-download` operation, `NATIVE_BRIDGE_VERSION` and
`/queue-download` route are frozen and unchanged. Media operations use the same
authenticated `127.0.0.1` listener and bearer token.

Browser -> native-host envelopes (`type` is the operation):

```json
{ "type": "analyze-media", "url": "https://example.com/watch?v=1" }
{ "type": "queue-media", "analysisId": "...", "optionId": "...", "force": true, "outputFormat": "mkv" }
{ "type": "media-status", "jobId": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
{ "type": "cancel-media", "jobId": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

Native host -> desktop loopback bodies and routes:

| Route | Body | Success response |
| --- | --- | --- |
| `POST /analyze-media` | `{ "url": "https://..." }` | `{ "ok": true, "operation": "analyze-media", "analysis": MediaAnalysis }` |
| `POST /queue-media` | `{ "analysisId": "...", "optionId": "...", "force": true?, "outputFormat": "auto" \| "mp4" \| "mkv" \| "webm"? }` | `{ "ok": true, "operation": "queue-media", "job": MediaJob }` |
| `POST /media-status` | `{ "jobId": "..." }` | `{ "ok": true, "operation": "media-status", "job": MediaJob }` |
| `POST /cancel-media` | `{ "jobId": "..." }` | `{ "ok": true, "operation": "cancel-media", "job": MediaJob }` |

Failures use the existing bridge error shape:
`{ "ok": false, "error": { "code": "MEDIA_...", "message": "..." } }`.

All request and response parsers reject unknown/extra fields. Identifiers are
opaque server-generated values (analysis/option/job); raw format selectors are
rejected. `src/shared/mediaBridge.ts` defines the typed `MediaBridgeTarget`
interface the loopback server will consume.

## Lifecycle

Exact statuses: `queued` | `analyzing` | `downloading` | `merging` | `complete` |
`error` | `cancelled` | `interrupted`.

- `analyzing` is visible in the UI while an analysis runs or is re-run; an
  analysis itself is returned by `analyzeMedia` and is not a persisted job.
- A queued job moves `queued` -> `downloading` -> `merging` when needed ->
  `complete`. Options that do not require merging skip `merging`.
- `queued`, `analyzing`, `downloading` and `merging` are active states. After a
  restart they become `interrupted`.
- `error`, `cancelled`, `interrupted`, `complete` are terminal for that job.
  Queueing again creates a new job.
- Recovery is conservative: never auto-download or auto-resume and never delete
  partial files.
- `removeMedia` removes only the database row; it never deletes media files.

## Behavior

- Analysis is fresh and server-side. An `optionId` is valid only for its
  `analysisId` until `expiresAt`; stale or mismatched option IDs are rejected.
- Audio-only options are in scope. Queueing a `kind: "audio"` option downloads
  an actual audio-only stream.
- `bestVideoOptionId` is a real video+audio deliverable. When the source has
  separate video and audio streams, the referenced option uses
  `requiresMerge: true` and `hasAudio: true`, and yt-dlp/ffmpeg combine the
  streams only when that toolchain can do so. A video-only stream is never the
  best video option; if no video+audio output can be produced, the value is
  `null`.
- `bestAudioOptionId` references an actual audio-only (`kind: "audio"`) stream,
  or is `null` when none exists.
- Progress bytes, lifecycle/error, option identity/label and output
  directory/path are persisted for recovery. Cookies, headers, raw metadata and
  yt-dlp commands are never persisted.
- Out of scope for 3A: playlists/collections, DRM/CAPTCHA bypass, browser
  cookies/credentials, arbitrary format selectors, arbitrary output paths or
  templates, and Milestone 3B features.

## Progressive playback capture route (additive)

The optional overlay can send one source observed from actual playback to a
separate authenticated route, `/queue-captured-source`, using the native
message `queue-captured-source` with exactly `{ type, url, filename? }`.

- Only progressive containers are accepted (MP4, WebM, M4V, MOV, OGV, MKV).
  Blob/MSE, HLS/DASH and unknown containers are rejected; they are never queued
  as guessed files.
- The browser validates the URL and filename first; the native host repeats
  strict shape/extension checks; the desktop route revalidates the public
  network target and calls `DownloadManager.addDurable`/aria2. The response is
  successful only after SQLite writes and reads back a durable receipt.
- A missing database or uncertain persistence fails closed; no success is
  reported to the extension.
  The route does not open, focus or otherwise interact with the desktop window.
- No cookies, request headers, DRM data, segment URLs or page dimensions are
  read or sent. No new host permission is required beyond the user's existing
  exact-origin overlay grant.
- See [media-capture-progressive.md](media-capture-progressive.md) for the
  UI/source-observation behavior. No real-browser observed-to-usable latency
  has been measured.

## Security constraints

- The existing direct `/queue-download` route, native `queue-download`
  operation, `DownloadManager`/aria2 path and `downloads` table remain
  unchanged. A webpage URL is never sent to aria2.
- Media routes stay on the authenticated loopback listener with the bearer
  token, exact POST route schemas, no CORS, and no unauthenticated endpoint.
  Browser `Origin` / `Sec-Fetch-Site` requests stay rejected.
- Worker C's extension must validate `sender.id`, `sender.tab`, the top frame,
  and the exact current grant/origin before calling native. No host permissions
  are added.
- Page URLs are normalized http(s); credential-bearing URLs are rejected and
  fragments are removed. The analyzer
  must also block non-public targets and local/private addresses.
- The future yt-dlp launcher uses fixed arguments only, `shell: false` and
  `--ignore-config`. It must never use browser cookies/credentials, bypass
  DRM/CAPTCHA, accept arbitrary flags/commands, user-supplied format selectors,
  paths or output templates.
- Format selection is by opaque `optionId` mapped server-side to a fresh
  analysis. The display-only `formatIds` are never accepted as queue selectors.
  `outputFormat` only selects among
  the option's server-advertised containers; incompatible requests are rejected
  and are never replaced by another container, quality or a transcode.
- Error and log messages must not contain URLs, disk paths, tokens, cookies or
  request payloads.

## Later worktree ownership

- **Worker A (engine):** `src/main/media/**` and engine tests.
- **Worker B (product/persistence orchestration):** `src/main/mediaJobs/**`,
  `src/main/ipc.ts`, `src/main/index.ts`, renderer media components/`App` and
  manager tests. Worker B does not edit `src/main/db/database.ts` or shared
  contracts.
- **Worker C (Helium/bridge):** `src/main/nativeBridge/server.ts`,
  `native/NativeHost.cs`, `extension/**`, native bridge/extension tests.
- **Foundation worker (this branch):** shared types/contracts,
  `src/preload/index.ts`, DB schema plus DB tests, and this document.

Other paths stay untouched.
