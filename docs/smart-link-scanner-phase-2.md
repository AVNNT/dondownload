# Smart Link Scanner phase 2: video resolution and one-level discovery

Status: implementation note. No live-site tests were run. Nothing is pushed.

## What phase 2 adds

- **Video resolver** (`src/main/scanner/videoResolver.ts`). Video page links and
  iframe embeds are analyzed through the existing media manager/engine
  (`analyze(url, { cookie?, signal? })`). The resolver keeps concurrency at 2, a
  per-session cap of 15 analyses, and forwards the scan abort signal into the
  yt-dlp child. Results populate the scan item with a sanitized title, the
  already-validated public HTTPS thumbnail, duration, best resolution, an exact
  or approximate size, the source hostname and a renderer-safe format list that
  exposes only opaque option IDs and labels.
- **Failure states.** DRM (`MEDIA_DRM_PROTECTED`) becomes `protected`; yt-dlp
  sign-in/age/login errors become `signin`; unsupported pages, playlists, live
  streams, timeouts and extractor failures become `unavailable` with a short
  reason; a missing yt-dlp becomes `tool-unavailable` and never fails the scan.
  `looksLikeSigninError` was added to the media analyzer so real yt-dlp
  sign-in/age output maps to `MEDIA_ANALYSIS_SIGNIN`.
- **Bounded recursive discovery** (`follow.ts`, `robots.ts`, session wiring).
  The scanner follows at most 25 pages (including the pasted page), at most two
  levels deep, with at most two concurrent fetches per host and a 75-second
  session budget. It follows iframe embeds, known yt-dlp video hosts, and
  same-registrable-domain watch/video paths or video-looking anchors. It never
  follows pagination, tag/category, login/account, cart/share, `rel=nofollow`
  or external non-video links. Cycles are prevented by a normalized-URL visited
  set.
- **Robots.txt.** Only pages the scanner follows itself are checked. The pasted
  URL is always fetched. Rules are parsed by a small bounded parser (longest
  match wins; Allow wins a tie) and cached per origin for the session. An
  unreachable or oversized robots.txt is treated as allow.
- **Video identity dedupe.** In addition to normalized-URL dedupe, the session
  merges repeated embeds by `youtube:<id>`, `vimeo:<id>` and similar URL
  patterns. The media analysis DTO does not expose yt-dlp's raw
  `extractor`/`id`, so URL patterns are the renderer-safe fallback.
- **Queueing.** `scan:queue-selection` accepts an optional `videoOptions` array
  of `{ itemId, optionId?, outputFormat? }` while remaining backward compatible
  with `{ sessionId, itemIds }`. Parsing is strict and rejects extra keys,
  duplicates, malformed IDs, unknown selected item IDs and unsupported
  containers. At queue time a fresh analysis is reused; an expired analysis is
  re-run through the media manager and the requested visible option is matched
  by label/kind/container because opaque IDs change per analysis. Defaults are
  the item's best video option and `auto` output, matching the Media tab.
- **Mixed batch.** Direct files and resolved videos are submitted as one
  scanner batch (`BatchManager.createScanMediaBatch`) with `download` and
  `media` child items. The batch manager keeps the scanner analysis/option
  selection and cookie in memory only; a restart marks active items
  interrupted rather than resuming them.

## Thumbnails and CSP

The renderer CSP already allows `img-src 'self' data: https:`
(`electron.vite.config.ts` and `tests/meta-csp.test.ts`). Phase 2 therefore
keeps the existing `Thumbnail` component (lazy load, `referrerPolicy="no-referrer"`,
icon fallback) and renders the validated public HTTPS URL directly. No
main-process thumbnail fetcher or custom protocol was added. Only an HTTPS URL
that passed `MediaAnalysis` validation reaches the renderer; no other source
URL or format URL is part of the scan DTO.

## Renderer

The Videos group renders a card per `page-link` video with thumbnail, title,
duration badge, best resolution, exact/approximate size, hostname, a quality
dropdown built from the safe format options, a checkbox and a per-card
Download button. Cards update progressively as analyses finish. Resolving,
protected, sign-in, unavailable and tool-missing states have distinct badges
and short reasons. Preview fixtures include resolved, protected and resolving
examples.

## Limits and trade-offs

- A single scan can analyze 15 videos and follow 25 pages. Further items remain
  visible but the session reports `limited` with a clear message.
- Known video hosts are followed only when robots allows it; they are primarily
  resolved through yt-dlp rather than scraped.
- Gofile/Pixeldrain pages keep their phase 1 direct-file/batch handling and are
  not routed through yt-dlp. Gofile share links are never fetched by the app at
  all; the extension lists them from the user's own tab
  (`smart-link-scanner-gofile.md`).
- URL-pattern identity can miss an unfamiliar extractor's aliases; normalized
  URL dedupe still applies.

## Verification

`npm run typecheck`, `npm run lint` (0 errors), `npm run test:fast`,
`npm run test:extension` and `npm run build` are run for this change. The new
tests cover resolver states, cancellation, caps, exact-host cookies, follow
scoring, depth/cycles, robots handling, time budget, video-identity dedupe and
video queue validation/re-analysis.
