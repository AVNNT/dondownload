# Progressive playback capture checkpoint

> Update: the product direction is now NDM-style detected-media sniffing on
> enabled sites. See `docs/media-sniffing.md`. The progressive `currentSrc`
> path, the yt-dlp analysis fallback and their security limits below still
> apply and remain the YouTube path.

Status: first verified checkpoint of the daily-use media capture path. No
installer, release, push, registry change, desktop launch or real Helium session
was performed for this note.

## What changed

- The opted-in overlay now observes only the exact media element that is
  actually playing. It reads `currentSrc` on `playing`/`timeupdate` events and
  never reads cookies, request headers, DRM data, dimensions, MSE segment
  requests or resource-timing traffic.
- A source is shown only when it is a public HTTP(S) URL whose path (or the
  filename derived from it) names a progressive container: MP4, WebM, M4V, MOV,
  OGV or MKV. Sources are accumulated per player, exact URLs are deduplicated,
  a replay of an earlier URL becomes current again without a duplicate row, and
  SPA/`popstate`/`hashchange`/`pageshow` navigation clears the previous page's
  sources.
- `blob:` playback (Media Source) and HLS/DASH manifests are no longer dead
  ends. They are never guessed into a file, and segment URLs are not mixed
  across players. When the attached player has no verified progressive source
  (or its current source is blob/MSE or a manifest), the panel shows `Find
  qualities with DonDownload`.
- That action sends the **top page URL** through the existing media analyze
  bridge (`dondownload:media-analyze`). The content script still supplies no
  URL at all: the worker derives it from the trusted `sender.tab.url` after the
  exact-origin registration, tab association and permission checks. The desktop
  app runs its existing yt-dlp analysis and public-target validation. blob,
  manifest, segment, cookie and header values never leave the page.
- The response is rendered in the overlay as verified options with resolution,
  container, reported size (or `Size unknown`) and whether the streams are
  merged. A direct Download action on an option queues exactly that opaque
  `analysisId` + `optionId` pair. Progressive captured sources stay first and
  keep their existing one-click behaviour.
- Visible top-frame `<iframe>` players are detected from the top frame only
  (large enough, connected, visible, `http(s)` src) when no top-frame video is
  playing. The panel offers `Find qualities for embedded video`, which sends
  that embed src as a separate `dondownload:media-analyze-embed` request. No
  script is injected into the sub-frame, no new permission is requested, and
  the desktop app still applies its public-target validation.
- The panel is detected-source-first and compact: one row per verified source
  with one Download action. It closes after a successful captured-source queue
  and the player button briefly shows `OK`; queued quality rows stay visible
  with an `Added ✓` state.
- The floating icon no longer waits for a captured progressive source or even
  the first rendered frame. It appears as soon as a large visible `<video>` is
  attached and either `play()` was requested (`paused === false`) or metadata
  is available (`readyState >= 1`). `play`, `loadedmetadata`, `loadeddata` and
  `canplay` are observed in addition to `playing`/`timeupdate`, and an
  already-playing element is checked immediately when the script is injected.
  YouTube-style SPA navigation (`yt-navigate-finish`, `yt-page-data-updated`,
  `popstate`, `hashchange`, `pageshow` and a cheap URL-change check) resets the
  icon, captured sources and cached analysis for the new video without a
  reload, even when the player element is reused.
- Background analysis is now allowed **only on an origin where the user
  explicitly enabled the overlay**. When that exact player is blob/MSE, an
  HLS/DASH manifest, or has started with no progressive source, the content
  script debounces 500 ms after the URL settles and starts the existing
  `dondownload:media-analyze` request for the top page URL. At most one
  analysis is in flight per tab; the result is cached per page URL until the
  analysis `expiresAt`, and stale responses are ignored by token and URL after
  SPA navigation. Opening the panel or the toolbar popup shows cached options
  immediately, or a clear `Finding qualities…` state while it runs. The manual
  `Find qualities` action remains the explicit retry. A selected option stays
  pinned by `analysisId` + `optionId`; it is never substituted.
- The toolbar popup now reflects streaming players. If the overlay reports a
  blob/MSE/HLS/DASH player it shows `Streaming video detected` with the same
  cached quality options (one-click queue) or `Finding qualities…`, while
  progressive sources remain listed as before. When nothing is detected it
  shows `Nothing detected` and still offers `Find qualities for this page`.
  After a successful queue both the overlay row and the popup row show
  `Added ✓` and the same option is not queued twice for that page.
- A detected source is queued through the existing native messaging host and
  the authenticated loopback bridge. The new
  `/queue-captured-source` route revalidates the public target and calls the
  existing `DownloadManager.add` / aria2 path with the observed filename, so
  success is returned only after the manager has queued the job and attempted
  persistence. This initial manual-capture acknowledgment is not yet a durable
  browser-handoff guarantee: the manager retries failed database writes. It
  does not open or focus the desktop window.
- Manual page/link capture, the existing extension permission flow, and the
  desktop Media URL analyzer are unchanged.

## Deliberate limits and deferred work

- DRM-protected media remains unsupported. Analysis only reports what yt-dlp
  can verify; it is never used to bypass DRM, access restrictions or a paywall.
- Automatic analysis is not a general background crawler. It runs only inside
  the exact-origin content script the user explicitly enabled, only after a
  real player is detected on that page, at most once per settled page URL, and
  the cached result is reused until `expiresAt`. A failure is never retried
  automatically; the visible `Find qualities` action is the retry. Everything
  remains pinned to the returned opaque option identifiers: if the analysis
  expires or the option no longer validates, the overlay shows the existing
  `Analyze this page again` message and never substitutes another quality.
- No permission opt-in UI was added. Observation runs only inside the already
  user-approved exact-origin content script; no new host permission,
  `webRequest`, `tabs`, cookies, downloads API or broad grant was added. Embed
  detection reads only the iframe rectangle and `src` from the top frame; it
  never injects into or reads a sub-frame document.
- Automatic browser handoff, capture options and keyboard shortcuts are
  implemented in the following checkpoint; see `automatic-browser-handoff.md`.
  This note remains the record of the currentSrc-only overlay checkpoint.
- Quality/resolution labels are not inferred from dimensions. A progressive URL
  may be replaced by the player on a quality switch; each exact URL remains a
  separate row and the current one is marked. yt-dlp's verified labels are the
  only source of resolution names in the analysis list.

## Fixture verification

Focused tests:

| Scenario | Result |
| --- | --- |
| Source identity accumulation, quality switch/dedupe/current, per-player isolation, navigation reset | extension overlay harness passed |
| Icon readiness after play()/metadata, largest ready candidate, 500 ms prefetch debounce, cache reuse/expiry, in-flight/stale-response rules | `extension-overlay-timing` passed |
| Automatic prefetch starts once after the debounce, reuses the cache on reopen, and ignores a response after SPA navigation | extension overlay harness passed |
| Popup view distinguishes streaming/embedded/progressive/nothing and shows verified options or retry | `extension-overlay-timing` capture-view tests passed |
| Quality rows show Added ✓ and refuse a second queue for the same exact option | extension overlay harness passed |
| Blob/MSE and manifest states offer explicit analysis with no invented download action | extension overlay harness passed |
| Verified analysis options show resolution/container/size/merge and queue the exact pinned option | extension overlay harness passed |
| Expired pinned analysis surfaces Analyze this page again without substitution | extension overlay harness passed |
| Visible top-frame embed detection thresholds and separate embed analyze request | extension overlay and media-bridge harnesses passed |
| One-click captured queue message with exact URL/filename and subtle close feedback | extension overlay harness passed |
| Exact-origin authorization and native envelope for the captured source | `extension-media-bridge` and `extension-bridge` passed |
| Authenticated loopback route, public-target rejection, duplicate and body limits | `native-bridge` passed |
| Native-host route/body validation with the rebuilt Windows executable | `native-host` captured tests passed |
| Small isolated fixture actual download integrity, no yt-dlp analysis | real aria2 integration passed; 524,288 bytes, SHA-256 matched |

Measured in the isolated loopback fixture on this machine:

```text
[captured-source fixture] bytes=524288 accepted=17ms complete=1103ms
[captured-source fixture] bytes=524288 accepted=17ms complete=1105ms
```

`accepted` is the time from the shared captured-source contract input to
`DownloadManager.add` resolving (queue usable, persistence attempted). `complete` is the
full loopback transfer to verified bytes (about 1.1 s across two runs). These
are local fixture timings and are not a promise for external sites or larger
files.

The captured route's public-target check is exercised with an injected DNS
lookup in the bridge unit tests; the real-download fixture uses loopback because
it is isolated, and therefore calls the same shared parser plus
`DownloadManager.add` directly instead of weakening the production public-target
rejection for a test.

## Commands run

```text
npm run typecheck
npm run build:native-host
npx vitest run tests/extension-overlay.test.ts tests/extension-overlay-timing.test.ts \
  tests/extension-bridge.test.ts \
  tests/extension-media-bridge.test.ts tests/extension-manifest.test.ts \
  tests/native-bridge.test.ts tests/media-engine.test.ts
npm run test:extension:chromium
npx vitest run tests/native-host.test.ts -t "captured"
$env:ARIA2_TEST_BINARY = '<local aria2c>'
npx vitest run tests/aria2.integration.test.ts -t "captured progressive"
node --check extension/overlay-core.js extension/overlay-runtime.js \
  extension/overlay-ui.js extension/overlay-qualities.js \
  extension/overlay-capture.js extension/overlay.js \
  extension/bridge.js extension/media-bridge.js extension/background.js
```

No broad test suite, installer, release, push, registry, desktop or real Helium
run was performed.
