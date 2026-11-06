# Automatic browser hand-off checkpoint

Status: locally implemented checkpoint on top of `568cb6b`. No push,
release, installer, registry change, desktop launch, browser-profile change,
real network observation or personal download was performed. This note does not
claim the media/browser mission is complete.

## Why this is separate from manual capture

`DownloadManager.add` keeps its existing behavior for Quick Add and the
explicit browser/link capture paths. Its `persistNow` catches database errors
and schedules a retry, so `add()` resolving is useful acceptance but not a
durability guarantee. That is acceptable for an explicit manual capture
acknowledgment, but not enough to cancel a download the browser already owns.

The additive `handoff-download` native operation and `/handoff-download`
loopback route are separate:

- `DownloadManager.addDurable` requires an open database.
- The row is written through `DownloadDatabase.saveDurable`, which switches
  WAL to `synchronous=FULL` for that row and reads the row back.
- Only after that verified write does the route return
  `{ ok: true, accepted: true, durable: true, operation: "handoff-download",
  receipt: { downloadId, persistedAt } }`.
- If no database exists, the operation fails before aria2 is touched.
- If the strict write fails after aria2 accepted a job, the manager removes the
  aria2 job (best effort), removes the in-memory row/controls and deletes any
  uncertain SQLite row. The route then reports failure.

Nothing in the bridge touches the browser downloads API. The extension is the
only side that may cancel, and only after the receipt above.

## Browser-side behavior

The extension declares `downloads` in `optional_permissions`, never in the
required `permissions` list. It is requested only from a direct user click on
the options page. Required host permissions are unchanged and still absent;
site access remains exact-origin and opt-in.

`AutomaticFileHandoff` is off by default. Granting the downloads permission from
the options page enables it once; revoking the permission makes it ineffective
and turns the stored preference off on the next options-page load.

When a browser download is created, all of the following must be true before a
native call is made:

- automatic hand-off is on and the downloads grant is still present;
- the item is `in_progress`, not paused, marked safe by the browser, HTTP(S),
  and not created by an extension;
- an exact positive browser total is available; if it is initially unknown, the
  extension waits for a `totalBytes` change and re-reads the item before retrying;
- neither its source/final origin nor its referring page is excluded;
- its URL path or filename identifies a supported non-media file (for example
  zip, PDF, 7z or an installer). Video/audio files, HLS/DASH manifests, media
  segments and extension-internal downloads are rejected.

The numeric `chrome.downloads` ID is the only identity key. A pending ID is
written to `storage.session` before the native call and remains there if the
worker is suspended. A processed or pending ID is never retried. Storage
failure means no native call and no cancellation. State updates are serialized
to avoid concurrent download events overwriting one another's reservations.

Failure, timeout, bridge unavailable, malformed receipt, duplicate/uncertain
state and a completed race all leave the browser's original download running.
Only a strict durable receipt triggers a re-read of the item; it is cancelled
only when the re-read still says `in_progress`. If it completed in the meantime,
the duplicate is kept, because a duplicate is safer than losing the file.

Feedback uses a short extension action badge. It never opens or focuses the
desktop window. The preference is on by default but remains a visual
notification only.

## Options, popup and commands

- `options.html` is a normal options tab with: floating-icon preference (on by
  default), automatic hand-off permission request, notification preference,
  exact-origin exclusions, existing exact-origin site access enable/disable,
  and shortcut guidance.
- The toolbar popup lists only sources observed on the active tab by that tab's
  own content script. It queries through `tabs.sendMessage`; it does not accept a
  page-supplied tab id and does not read page-provided URLs from the popup DOM.
  Manual page capture remains as the direct fallback.
- `commands.toggle-overlay` is declared without a default key, so it cannot
  conflict with a page/browser hotkey. The background worker sends a toggle to
  the active tab's content script. Users set a key at
  `chrome://extensions/shortcuts`.
- The old DOM `Alt+Shift+D` key listener was removed from the content script.

## Overlay lifecycle changes

- The floating icon follows the largest usable playing player, not only pointer
  hover. Hover still works before playback.
- The icon is draggable with a pointer. Its position is stored as a ratio of the
  video rectangle per origin and restored on later visits.
- Player listeners are owned by each player and removed when that player is
  detached or navigation resets the capture state. Source-row click handlers are
  removed when the row list is rebuilt, so repeated renders do not accumulate.
- Each player retains the 32 most recently observed exact progressive URLs,
  enough for real quality switching while bounding memory for token-rotating
  sources.
- `emptied` clears only the current marker, since ordinary quality changes also
  emit that event. Navigation/player removal clears stored identities. A player
  reused for a different video without observable navigation remains ambiguous.
  Sources are never mixed across separate player elements.
- The normal panel is detected-source-first. The technical notice and the
  explicit yt-dlp analyzer are hidden from normal use; the explicit fallback is
  the popup/options/manual Media-tab path. Legacy elements remain in the DOM for
  backward-compatible internal tests but are not shown.
- Quality labels such as `1080p` come only from the playing element's decoded
  dimensions **after** its exact `currentSrc` has already been proven to be a
  supported progressive URL. Dimensions are never used as source proof.

## Checkpoint 3: optional response evidence and anonymous hand-off proof

`webRequest` is declared only in `optional_permissions`, never in required
permissions. It is requested from a direct options-page user gesture and the
preference remains off until then. Listeners are installed only when the
optional grant is available; callbacks record evidence only while the explicit
preference is enabled.

The response path is deliberately narrow:

- only `type: "media"`, `method: "GET"`, frame 0, an exact tracked/opted-in page
  origin and an exact granted media origin;
- only status and Content-Type/Content-Range/Content-Length/Content-Encoding
  are read; `extraHeaders` is never requested;
- evidence is kept in memory by tab/frame/document and exact URL, bounded per
  document and by document count, with a short TTL;
- top-frame navigation, tab removal and service-worker restore clear it;
- delivery is event-driven from `loadeddata`/`playing` or an exact-URL push, not
  polling;
- extensionless sources require `video/mp4`/`video/webm` evidence from an
  honored `bytes=0-0` response with exact `Content-Range: bytes 0-0/total`.
  HLS/DASH manifests, `.m4s`/`.ts`/init segments, MSE fetch requests and compressed
  bodies are rejected;
- an exact size is shown only from a complete Content-Range total or an
  identity Content-Length. A partial length is never used.

The desktop durably queues captured progressive sources and revalidates
extensionless URLs with one bounded anonymous range GET. The strict hand-off
route also performs that preflight before calling `addDurable`: redirects are
revalidated per hop, DNS results are pinned for each request, credentials and
cookies are omitted, the response body is destroyed after headers, and the
exact total must match the browser's known byte count. An unknown total stays
with the browser.
The downloads API does not reveal GET vs POST or cookie dependence, so a
failed preflight leaves the browser transfer running instead of cancelling an
authenticated/POST transfer.

## Known limitations

- Capture remains **`currentSrc` only**. Optional response evidence can prove
  the same URL, but it cannot see inside `blob:`/Media Source playback. The
  extension does not read cookies, credentials, request headers, DRM data, MSE
  segments or resource timing. A `blob:`/Media Source playback or an HLS/DASH
  manifest is never guessed into a downloadable file; the overlay instead offers
  the explicit `Find qualities with DonDownload` analysis against the top page
  URL. Visible top-frame embeds get a separate analysis request for the iframe
  src. Neither path injects into a sub-frame or adds a permission. DRM-protected
  media remains unsupported.
- A quality switch replaces `currentSrc`; each exact URL remains a separate row.
  No quality is inferred when dimensions are unavailable.
- The automatic route accepts ordinary non-media files only. It is not a general
  replacement for manual page capture or the explicit yt-dlp Media path.
- Timeouts and stop conditions are bounded by the native host/bridge timeouts.
  This checkpoint was verified with focused fakes and a temp native compile, not
  against a real browser or external site.

## Verification performed

Focused tests only; no broad test suite was run:

| Scenario | Result |
| --- | --- |
| Strict durable SQLite receipt, uncertain-write rollback of aria2 and local row, no-database fail-closed, separate bridge route capability/unavailability | passed |
| Automatic extension hand-off aggregate: success cancel only after receipt; bridge failure, timeout, malformed receipt, storage failure, duplicate recursion, extension download and completed race preserve the browser transfer | passed |
| Overlay persistent playing icon, command toggle and trusted popup source query with dimension-derived label after source proof | passed |
| Exact URL/document response evidence, conservative unsupported response rejection, bounded stores and quality/source dedupe | `extension-network-evidence` passed |
| Anonymous preflight follows public redirects without credentials, verifies expected size/type, destroys the response body, rejects ignored/mismatched ranges | `public-preflight` passed |

Also run for this checkpoint:

```text
npm run typecheck
node --check extension/background.js
node --check extension/network-evidence.js
node --check extension/overlay-core.js
node --check extension/overlay-runtime.js
node --check extension/overlay-ui.js
node --check extension/overlay-qualities.js
node --check extension/overlay-capture.js
node --check extension/overlay.js
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-native-host.ps1 \
  -OutputPath C:\Users\PC\AppData\Local\Temp\opencode\dondownload-native-host-check.exe
```

No real-browser observed-to-usable or native-message timing was measured. The
network evidence test exercises in-process mapping only; sidebar UI checks do
not prove Chromium `webRequest`, downloads interception or Helium integration.
