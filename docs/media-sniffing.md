# NDM-style detected media

Status: implemented behind the existing optional `webRequest` grant. No
installer, release, push or registry change was performed for this note.

## What the user sees

- On a site they enabled (the same exact-origin flow as the overlay), the
  toolbar badge shows the number of media items detected for the current tab.
- The toolbar popup lists each detected item with its type, filename/title,
  quality, known size and source host, plus a one-click **Download** button. An
  HLS master playlist is one entry whose variants are separate quality rows.
- The floating overlay panel lists the same detected items first, followed by
  the existing yt-dlp "Find qualities" analysis options. Both remain available,
  and `Added ✓` feedback plus duplicate-queue protection are unchanged.
- The yt-dlp analysis section stays for sites yt-dlp supports. YouTube is
  deliberately left on that path: `googlevideo.com/videoplayback` range/SABR
  streams are not standalone downloadable files.

## Detection rules

| Rule | Behaviour |
| --- | --- |
| Media type | `video/*`, `audio/*`, `application/vnd.apple.mpegurl`, `application/x-mpegURL`, `application/dash+xml` |
| Extensions | `.mp4 .m4v .webm .mkv .mov .mp3 .m4a .aac .ogg .opus .flac .wav .m3u8 .mpd` |
| Size | Known audio/video below 100 KB is ignored; unknown size is still listed |
| Range requests | Same URL with only `range=`, `rn=`, `rbuf=` removed collapses to one row |
| HLS/DASH | A manifest is one entry; `.ts`/`.m4s` fragments are hidden but mark it active |
| HLS master | The master is preferred over a variant; its fetched text lists resolution/bandwidth and the selected variant is pinned |
| Ads/trackers | A small host list (doubleclick, googlesyndication, adnxs, criteo, taboola and similar) is ignored |
| YouTube | `googlevideo.com` `/videoplayback` is ignored |
| Scope | Per-tab, capped at 50, cleared on top-level navigation; an SPA URL change keeps entries already seen for the new URL |

Manifest text is fetched with `credentials: 'omit'`. If that fetch is blocked by
CORS or requires cookies, the manifest remains listed with "quality unknown".

## Download path

The extension sends one validated `queue-sniffed-media` message through the
existing native host and authenticated loopback bridge:

```text
{ url, pageUrl, referer, userAgent, kind: file|hls|dash,
  variant?, filename?, title, cookie?, expectedBytes? }
```

- `file` uses the normal aria2 path with per-job `referer`, `user-agent` and
  (only when opted in) one `Cookie:` header.
- `hls`/`dash` uses yt-dlp's generic extractor on the manifest or pinned variant
  with `--referer`, `--user-agent`, `--add-header Cookie: …` when present,
  `--concurrent-fragments`, and mp4 merge/remux. The job appears in the normal
  media list with progress, pause/cancel and recovery semantics.
- The visible filename is the sanitized tab/video title plus the real extension;
  no URL id, opaque key or job id is used. Existing collision handling adds
  ` (2)` and later suffixes.

## Security model

- Detection is limited to exact origins the user enabled, unless the user turns
  on **Detect media on all sites**. That switch requests the broad optional
  `http://*/*` and `https://*/*` host permission; turning it off removes the
  broad grant and the preference.
- `webRequest` remains optional and is requested only from an options-page
  gesture. Only response headers and public response metadata are read; request
  headers, bodies, credentials and DRM data are never exposed.
- Cookies are **off by default for every site**. The per-site toggle requests
  the optional `cookies` permission and records the exact origin. Only then is
  `chrome.cookies.getAll({ url })` called for a detected media URL. The header
  exists in one native message and one aria2/yt-dlp job; it is never stored in
  extension settings, the app database or logs. The tradeoff is explicit: an
  opted-in cookie can grant access to the user's logged-in account for that one
  job.
- The app still applies `assertPublicTarget` to both the media URL and the
  pinned HLS variant before aria2/yt-dlp start. Private, loopback and reserved
  targets are rejected. Header values are length/control-character validated on
  both sides and cannot contain CR/LF.
- Per-download headers are memory-only. A relaunch cannot resume a job with
  stale cookies; active jobs become interrupted under the existing policy.

## Known limits

- With a per-site grant, Chromium only exposes `webRequest` events for origins
  covered by that grant. Media served from a different CDN origin is therefore
  not observed until the user turns on all-site detection. This keeps the
  exact-origin security model intact.
- HLS master parsing depends on a credential-free fetch. Cross-origin manifests
  that need CORS or cookies stay listed with an unknown quality but can still be
  downloaded through yt-dlp when the site allows it.
- DRM-protected media remains unsupported. Detection is not a DRM or paywall
  bypass.
- Small clips below 100 KB are intentionally ignored when the size is known.

## Verification

Unit coverage:

- `tests/extension-media-sniffer.test.ts` — classification, size threshold,
  ad/YouTube exclusion, range collapse, segment suppression, master/variant
  preference, per-tab reset/cap, badge text, filename, queue message.
- `tests/sniffed-media.test.ts` — app-side parser, public/private and header
  limits, cookie redaction, title-based filenames, aria2 header options and
  yt-dlp referer/UA/Cookie arguments.
- `tests/native-bridge.test.ts` — detected-file headers, private/non-http/
  oversize rejection, HLS delegation to a media job and cookie-injection
  rejection.

Browser E2E fixtures (isolated temp profile, generated media):

- HLS master page: one entry, 360p/720p variants, no segment rows, badge count
  and overlay rows.
- Referer-protected hidden MP4: detected, then downloaded in `--native` mode
  with the app's Referer and matching SHA-256.
- MP3 audio page: detected above the size threshold.
- Detected HLS variant in `--native` mode: normal media job, verified MP4 and
  ffprobe duration.
