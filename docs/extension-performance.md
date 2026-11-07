# Extension performance audit

Measured against the Manifest V3 extension in `extension/` before and after the
lighter-content-scripts change. All numbers are per document / per service
worker generation unless stated otherwise.

## 1. What is injected, where and when

The manifest declares **no** `content_scripts`. Everything is registered or
injected at runtime.

| Script | How it is injected | Pages | Run time | What runs at load |
| --- | --- | --- | --- | --- |
| `overlay-bootstrap.js` *(new)* | `scripting.registerContentScripts`, all-sites registration | every `http(s)` page while "use on all sites" is on (the default) | `document_idle` | one `querySelector('video')`, four capture listeners (`pointerover`, `play`, `playing`, `loadedmetadata`), one `runtime.onMessage` listener, one `overlay-ready` message |
| `overlay-core.js`, `overlay-runtime.js`, `overlay-ui.js`, `overlay-qualities.js`, `overlay-kvs.js`, `overlay-capture.js`, `overlay.js` | per-origin registration, or `scripting.executeScript` from the bootstrap / popup enable / open-tab sweep | only opted-in origins, or an all-sites page that has a video, hovers a video/iframe, or is asked by the popup | `document_idle` (registration) or immediately (executeScript) | shadow-DOM host + panel, 1 `MutationObserver` on `document.documentElement` (`childList` + `subtree`), 1 `ResizeObserver` for the active video only, 15 document/window listeners, 10 listeners per discovered `<video>`, 1 `runtime.onMessage`, 1 `storage.onChanged`, one `overlay-ready` message, two `storage.local.get` calls |
| `gofile-collector.js` | `scripting.executeScript` from `gofile-scan.js` after the popup's Scan action | the scanned Gofile tab | on demand | bounded collector run; `waitForRows` uses one `MutationObserver` (or a poll when unavailable) until the scan deadline |
| `video-collector.js` | `scripting.executeScript` from `video-scan.js` after the popup's Scan action | the scanned video tab | on demand | bounded DOM read of rendered media |
| `image-collector.js` | `scripting.executeScript` from `popup.js` after the Images action | the active tab | on demand | scroll loop with bounded `setTimeout` steps, floating counter, stops on idle/limit/Stop |
| `handoffCardInjected` | `scripting.executeScript` (function, not a file) from `handoff-card.js` after a confirmed hand-off | the active tab | on demand | up to 3 cards; one 2 s interval **only while the document is visible**, stops on done/error/close/30 min |

Before the change the all-sites registration injected the seven overlay files
on every page. Now it injects only `overlay-bootstrap.js`; the full files are
loaded for a tab that actually uses a player. Per-origin (explicitly enabled)
sites still get the full overlay immediately.

## 2. Page-load cost

### Unrelated page (no player), all-sites mode on

| Cost | Before | After |
| --- | --- | --- |
| Content-script files injected by the registration | 7 | 1 (`overlay-bootstrap.js`) |
| `MutationObserver`s | 1 (whole document subtree) | 0 |
| `setInterval` timers | 1 (2 s SPA-URL fallback) | 0 |
| `ResizeObserver`s | 0 | 0 |
| Event listeners | 15 document/window + 1 runtime + 1 storage | 4 document + 1 runtime |
| Shadow-DOM host/panel nodes | created | not created |
| `storage.local` reads | 2 + 1 `remove` | 0 |
| Messages to the worker | 1 (`overlay-ready`) | 1 (`overlay-ready`) |

### Page with a video

The bootstrap loads the full overlay once (one extra message and one
`executeScript`), then behaviour is the same as before. The full overlay's
observer now ignores mutation batches that cannot change the overlay, and the
2 s navigation interval is replaced by the Navigation API where available
(Chrome/Edge/Helium ≥ 102, the manifest minimum).

## 3. Mutation work

`overlay-ui.js` observes `document.documentElement` with
`{ childList: true, subtree: true, attributes: false, characterData: false }`.

Before: every observer batch scheduled a trailing pass (`120 ms`); a pass ran
`querySelectorAll('video')`, `querySelectorAll('iframe')`, `getComputedStyle`
for every ancestor of the active player, `getBoundingClientRect` calls, and a
full install/scan.

After: the batch is first filtered by `mutationRecordsAreRelevant(records)`
(only an added/removed `VIDEO`, `IFRAME`, `SOURCE`, or a subtree containing
one). A relevant batch is coalesced into one trailing pass, then run in
`requestIdleCallback` with a `250 ms` timeout.

| Scenario | Before | After |
| --- | --- | --- |
| 1,000 DOM mutations that never touch a player | up to ~8 passes (one per quiet 120 ms window) while the page is busy | 0 passes |
| 1,000 mutation callbacks delivered as one burst | 1 pass | 1 pass |
| A player appears/leaves | 1 pass | 1 pass |

`timeupdate` fires about 4 times per second per playing video. Each tick used to
run playback evaluation, trigger sync and prefetch scheduling. It is now
coalesced to at most one check per player per `500 ms` (≈2/s), and
`scheduleTriggerBurst` remains guarded so concurrent media events share one
burst.

`gofile-collector.js` previously ran `readRows()` on every observer batch while
a share rendered. It now waits for a `50 ms` quiet window, so a render that
produces 1,000 mutations causes one bounded read instead of one per batch.

## 4. Background service worker

The worker registers the following top-level listeners:

| Listener | Always installed | Work per event |
| --- | --- | --- |
| `downloads.onDeterminingFilename` | yes (`downloads` is required) | early return by `handledDownloadIds`; candidate policy, one native hand-off |
| `downloads.onCreated` (hand-off) | yes | early return if not a candidate |
| `downloads.onChanged` (hand-off) | yes | early return unless a positive `totalBytes.current` appears and the id was not decided |
| `downloads.onCreated` / `onChanged` (Gofile capture) | yes | O(1) return unless a capture window is armed |
| `webRequest.onHeadersReceived` (media sniffer) | only while media sniffing + optional `webRequest` grant are both active | cheap structural filters (`GET`, valid tab id, not `main_frame`), then URL/header classification; only a classified media response performs `tabs.get` + authorization |
| `webRequest.onBeforeRequest` (media sniffer) | same condition | only `main_frame`; clears that tab's map |
| `webRequest.onHeadersReceived` / `onBeforeRequest` (evidence) | only while network observation + grant are active | `method`/`frameId`/`type`/URL filters before any tab or permission lookup |
| `tabs.onRemoved`, `tabs.onUpdated` (URL), `tabs.onActivated` | yes | O(1) cleanup or badge refresh |
| `runtime.onMessage` | yes | one type switch; unknown types return immediately |
| `permissions.onAdded` / `onRemoved`, `storage.onChanged` | yes | invalidate caches, re-read only when a relevant key/permission changed |
| `commands.onCommand`, `contextMenus.onClicked` | yes | one user action |

### Per-response work and caches

`authorizeSniffTab` used to read `storage.local` (settings) and call
`permissions.contains({permissions:['webRequest']})` for every classified media
response. Settings and the optional grant now sit in in-memory caches:

| Cache | Bound | Invalidated by |
| --- | --- | --- |
| Sniffer settings | one object, 5 s TTL, in-flight reads deduplicated | `storage.onChanged` for `dondownloadCaptureSettings` |
| `webRequest` grant | one boolean, 30 s TTL | `permissions.onAdded` / `onRemoved` |
| Positive per-tab sniff authorization | 64 tabs, 5 s TTL | tab URL change, tab close, settings change |
| HLS master manifest results | 100 entries, 60 s TTL | top-frame navigation |
| Detected media per tab | 50 entries per tab, 64 tabs, 30 min tab TTL | tab close, top-frame navigation |

Badge/content-script notifications are coalesced to at most one per tab per
`150 ms` instead of one message per detected media response.

### Unbounded state that was found and bounded

| State | Before | After |
| --- | --- | --- |
| `sniffAuthCache` | `Map` removed only on tab close/URL change (positive entries only) | bounded 64-entry TTL cache |
| Media sniffer tab map | one entry per tab id forever if `onRemoved` was missed | ≤ 64 tabs and 30 min TTL, plus `onRemoved` cleanup |
| HLS manifest cache | 100 promises, no time bound | 100 entries, 60 s TTL |
| Network evidence | already bounded: 32 documents × 24 entries, 10 min TTL | unchanged |
| Handed-off / handled download ids | already bounded at 200 | unchanged |
| Gofile capture records | already bounded at 500 per 30 s window | unchanged |
| Overlay tracked tabs | already bounded at 200 tab ids per origin and pruned on `tabs.onRemoved` | unchanged |

After N simulated responses the media store holds at most
`min(N, 64) × min(media per tab, 50)` entries; the authorization cache holds at
most 64; the manifest cache at most 100. The worker no longer retains a record
for every tab id it has ever seen.

## 5. What deliberately did not change

- Gofile capture (30 s window, 500 rows, cancel + erase) is unchanged.
- Media sniffing classification, HLS parsing, deduplication and queueing are
  unchanged.
- The overlay UI, placement, qualities, capture rows, hand-off card and image
  collector behaviour are unchanged; the bootstrap only defers loading the
  same files until a page uses them.
- `webRequest` remains optional and is still registered only while the feature
  is enabled and granted; no request headers, cookies or bodies are read.
