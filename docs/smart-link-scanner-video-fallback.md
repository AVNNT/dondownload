# Smart Link Scanner: direct-media fallback for unreadable video pages

Status: implementation note. No live-site tests were run. Nothing is pushed.

Some video pages cannot be resolved by yt-dlp at all: `hanime1.me/watch?v=…` has
no extractor and sits behind Cloudflare, and Pornhub/Eporner answer an age gate,
a geo block or a cookie wall. Those cards used to stay `browser-only` forever.
This phase gives them real quality options from two independent sources, in this
order:

1. **yt-dlp with the page's own Cookie** (already the first attempt).
2. **The page itself**, fetched once by the app.
3. **The user's own browser tab**, when the app fetch is refused.

Nothing here solves a challenge, bypasses an age gate, reuses `cf_clearance` or
injects into a page's main world.

## 1. yt-dlp with the one-shot Cookie

`resolveVideoCandidates` passes `ScanMediaAnalyzeOptions.cookie` only when the
video URL's `host` is exactly the session's `cookieHost` (the host the extension
read the Cookie for). A forum Cookie therefore never reaches hanime1.me, and a
hanime1.me Cookie never reaches a forum. The same rule gates the fallback fetch
below (`ScanSessionManager.cookieFor`).

## 2. App-side page fallback

`ScanSessionManager.applyPageFallbacks` runs after yt-dlp for every card that
ended up `browser-only` (and for the explicit "check as video" action). It does
one bounded `fetchPage` — same size/time limits, same public-target policy, the
exact-host Cookie only when available — and `extract/videoMedia.ts` reads:

- `<video>` / `<source src>` with quality from `size`, `label`, `res`,
  `data-quality`, `width`/`height`, or a URL hint (`…_1080p.mp4`);
- `og:video`, `og:video:secure_url`, `twitter:player:stream`;
- JSON-LD `VideoObject`/`Movie`/`Clip` `contentUrl` (+ `videoQuality`);
- `.m3u8`/`.mpd`/`.mp4` URLs in inline scripts, including player configs
  (`sources: [{src, label}]`, `"videoUrl"`, Pornhub-style `mediaDefinitions`).

A hint is taken from the rendition it belongs to: the nearest key *after* the
URL wins, because player configs name the URL before its label. Without that, a
`mediaDefinitions` array gave every rendition the first entry's quality.

Every URL is re-normalized (`http(s)`, no credentials) and each distinct host is
checked against the public-target policy before it can reach a downloader.
Private, loopback and unresolvable hosts are dropped silently; a card only
becomes `ready` when at least one source survived. The list is deduplicated and
capped at `MAX_SCAN_VIDEO_MEDIA_SOURCES` (24), best first.

The card name comes from `og:title`, then `<title>`, cleaned — so pairing with
`.funscript` files works exactly as for a yt-dlp-resolved video.

When the document is a Cloudflare/`cf-chl` challenge page or an age/login gate
and exposes no media, the card stays `browser-only` with the existing reason.
The renderer never receives a media URL: only opaque option IDs and display
metadata (`1080p · MP4`, `1080p · HLS`) leave the main process.

## 3. Queueing

`ResolvedScanTarget.media` carries the internal `{referer, sources}` record.

- **Progressive file** → the normal downloader, with `Referer` set to the page
  URL (most media hosts require it) and the page Cookie only when the media host
  is the page host.
- **HLS/DASH manifest** → `createScanMediaBatch({streams})`, i.e. the same
  media-engine/ffmpeg path the browser overlay uses for detected streams, so
  progress, pause and cancel stay in the normal media list.

A format ID that does not belong to the card is rejected
(`SCAN_OPTION_INVALID`), like a stale yt-dlp option.

## 4. Extension-tab fallback

When the app fetch is refused (Cloudflare 403/503, login or age gate), the user
opens the card in their own browser and scans that tab. The popup asks the
background worker (`dondownload:video-scan`), which injects
`extension/video-collector.js` — an isolated-world classic content script — and
polls for its bounded result (6 s collector wait, 20 s runner timeout).

The collector reads `video`/`source` elements, `currentSrc`, `og:*`, JSON-LD and
inline player configs, and reports only absolute `http(s)` media URLs, capped and
deduplicated. It never reads a Cookie (the extension does that separately, once,
for the exact origin), never clicks, and never touches the main world. A page
with no player element returns immediately so a normal page scan is not delayed.

The report travels over a dedicated bridge operation (`scan-video`) through the
native host to `POST /scan-video` and `ScanSessionManager.startVideoMedia`. When
the originating session still shows a `browser-only` card for that exact page,
the card is upgraded in place, so post numbers, script sets and the batch the
user is building stay together. Otherwise the page becomes its own one-card
session. A page that is not a single video page and has no waiting card is
refused (`SCAN_VIDEO_NOT_A_VIDEO_PAGE`) and the popup falls back to the normal
page scan.

## Limits

- Only what the page or the rendered DOM actually exposes is used. A player that
  builds its URL from an encrypted blob, a signed handshake or a DRM licence
  stays browser-only.
- A challenge page that returns no media keeps the card browser-only; the app
  never retries with a solved challenge.
- Age-gated content only works through the user's own signed-in tab.
- The internal media record is memory-only: a restart forgets it, and the card
  must be scanned again.
