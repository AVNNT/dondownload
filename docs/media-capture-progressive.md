# Progressive playback capture checkpoint

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
- `blob:` playback (Media Source / likely segmented or encrypted) and HLS/DASH
  manifests are shown as explicitly unsupported. They are never guessed into a
  file, and segment URLs are not mixed across players.
- The panel is detected-source-first and compact: one row per verified source
  with one Download action. It closes after a successful queue and the player
  button briefly shows `OK`. Opening the panel no longer runs yt-dlp.
- The previous page analyzer remains as an explicit `Analyze page with yt-dlp
  (fallback)` action. It is not used to populate the captured-source list and is
  not run on hover, injection or panel open.
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

- HLS/DASH support is deferred. A manifest is accepted only as an explicit
  unsupported state until a representation/audio mapping can be proven safely.
- No permission opt-in UI was added in this checkpoint. Observation runs only
  inside the already user-approved exact-origin content script; no new host
  permission, `webRequest`, `tabs`, cookies, downloads API or broad grant was
  added.
- Automatic browser handoff, capture options and keyboard shortcuts are next
  checkpoint work, not part of this change.
- Quality/resolution labels are not inferred. A progressive URL may be replaced
  by the player on a quality switch; each exact URL remains a separate row and
  the current one is marked. No 1080p/720p label is invented.
- Cross-origin iframe videos remain out of scope because the overlay is
  top-frame only.

## Fixture verification

Focused tests:

| Scenario | Result |
| --- | --- |
| Source identity accumulation, quality switch/dedupe/current, per-player isolation, navigation reset | extension overlay harness passed |
| Blob/MSE and manifest rejection with no invented download action | extension overlay harness passed |
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
npx vitest run tests/extension-overlay.test.ts tests/extension-bridge.test.ts \
  tests/extension-media-bridge.test.ts tests/extension-manifest.test.ts \
  tests/native-bridge.test.ts tests/media-engine.test.ts
npx vitest run tests/native-host.test.ts -t "captured"
$env:ARIA2_TEST_BINARY = '<local aria2c>'
npx vitest run tests/aria2.integration.test.ts -t "captured progressive"
node --check extension/overlay.js extension/overlay-core.js \
  extension/bridge.js extension/media-bridge.js extension/background.js
```

No broad test suite, installer, release, push, registry, desktop or real Helium
run was performed.
