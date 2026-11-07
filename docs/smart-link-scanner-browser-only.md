# Smart Link Scanner: browser-only videos and manual/automatic matching

Status: implementation note. No live-site tests were run. Nothing is pushed.

This phase makes a failed video resolution visible and useful without ever
bypassing a site's access controls.

## Scan scope, quality labels and one-click downloads

- **One topic + directly linked pages.** A Discourse topic is read completely
  through its post stream JSON. After that the scanner follows only pages linked
  directly from those posts, one level deep (`MAX_SCAN_FOLLOW_DEPTH = 1`) and at
  most 10 pages per session (`MAX_SCAN_FOLLOW_PAGES = 10`). Forum chrome is
  never followed: other `/t/` topics, suggested/related topics, `/u/` profiles,
  `/c/` categories, `/tag/`, `/latest`, `/search`, login and account pages. The
  previous 25-page/two-level policy was the source of the extra hundreds of
  items: every followed topic brought its own sidebar, suggested topics and
  category/user links into the scan.
- **Real quality labels.** `formats.ts` reads a resolution hint from
  `format_note`, `resolution`, the format name/id and the stream URL path
  (`1080p`, `-1080.mp4`, `hls-720`, `640x360`). If no hint exists and a bundled
  ffprobe is available, a bounded header-only ffprobe read (2.5 s timeout, at
  most three formats, direct HTTP(S) files only) can learn the frame height.
  Otherwise the label is `Source quality (MP4)` with an optional bitrate hint;
  a raw `Quality 1` label is never shown. The chosen label is displayed on the
  card and written into the queued download row.
- **Pre-selected results.** When a topic finishes, every ready video with a
  confident script set is ticked together with the set's queueable files (the
  existing pairing bucket picks the best set), and standalone script sets are
  ticked with original names. Browser-only cards stay unticked. The user can
  untick anything, change the set/quality, and one prominent button queues the
  whole selection. `MAX_SCAN_SELECTION` (500) is enforced and reported.
- **Multiple topics.** The Scan tab accepts up to `MAX_SCAN_URLS` (10) URLs, one
  per line, deduplicated and normalized. Each URL is its own scan session. Main
  runs at most `MAX_ACTIVE_SCANS` (2) and queues the rest; the browser-extension
  scan path remains single-page. Results are grouped per topic (collapsible
  topic title). Pairings are resolved per session, so a script from topic A can
  never pair with a video from topic B. A single bulk IPC call
  (`scan:queue-selections`) queues one batch per topic; every batch title uses
  the sanitized topic title.
- **Folders.** The existing manager uses one scanner media folder for all
  videos and the normal download root for scripts. It has no per-topic
  subfolder option, so this change keeps the current folder behaviour rather
  than adding an unvalidated path input.

## 1. Browser-only video cards

- **Conservative page heuristic.** `isLikelyVideoPageUrl` (classify.ts) accepts a
  single video/player-shaped path (`/watch?v=…`, `/video/…`, `/videos/…`,
  `/v/…`, `/embed/…`, `/player/…`) or a known video host. Listings (`/videos`),
  tag/category/login/search paths, random articles, MEGA links and direct file
  paths stay `page` links. A URL is never turned into a direct file by this
  heuristic.
- **Discovery.** The extractor now keeps such anchors, so an EroScripts post
  that links to `hanime1.me/watch?v=…` produces a video card instead of a
  hidden page.
- **Discourse `rel="nofollow ugc"`.** Discourse marks every user link
  `nofollow`. `scoreFollowLink` no longer treats `nofollow` as a hard block; it
  lowers the follow priority by 10. Pagination, login/account, tag/listing,
  playlist and article links are still rejected before any fetch, and a
  `nofollow` random article is never followed.
- **New status `browser-only`.** When yt-dlp reports an unsupported URL, 403 or
  a Cloudflare/bot challenge, the resolver marks the card `browser-only` with
  the safe reason "Can't be read automatically — open it in your browser."
  There is exactly one analysis attempt per item (no retry loop). DRM, sign-in,
  live and playlist outcomes keep their existing statuses.
- **Matching.** `buildScanScriptSets` includes both `ready` and `browser-only`
  video page links, so a browser-only card participates in title/post matching
  exactly like a resolved video.
- **Gofile share links.** A `gofile.io/d/<id>` link is the same kind of card: a
  `browser-only` page link with the action "Open in browser to list files". The
  extension then reads the rendered rows from the user's own tab and the files
  become normal cards; see `smart-link-scanner-gofile.md`.
- **Open in browser.** A new strict channel (`scan:open-in-browser`) accepts
  `{sessionId, itemId, pairing?}` with opaque IDs only. Main resolves the stored
  URL, validates it as a public HTTP(S) URL (`isPublicOpenableUrl`: no file/
  javascript/data, credentials, loopback, private, link-local or device
  addresses) and calls `shell.openExternal`. The renderer never receives the
  URL.

## 2. “Match to video file…”

- Available from a browser-only/ready video card and from a script-set row.
- Main opens the native open-file dialog with a video-extension filter. The
  picked path stays in main; the renderer receives only the display filename.
- The scripts are downloaded into the picked video's folder and renamed after
  completion with the existing all-or-nothing `applyPairRename` logic, using
  the real video basename.
- **Token-only exception to the download root.** A short-lived (30 min) opaque
  token maps to the picked file in `ManualMatchStore`. `DownloadManager`
  accepts only that token (`addPairingFile`), never a raw renderer path. The
  resolved path must be absolute, exist, be a regular file, and must not be a
  UNC/device path. `applyPairRename` still requires the video and every script
  to resolve inside that exact folder, never overwrites an existing target, and
  skips the whole set on one failure with the phase-3 messages.
- If a script was already downloaded earlier in the session, it is downloaded
  again into the chosen folder (subject to the normal duplicate policy for an
  unfinished copy). No file is moved between folders.

## 3. Automatic browser hand-off

- Clicking **Open in browser** with a chosen script set arms a memory-only
  pending pairing for the card's normalized page URL (hash/tracking parameters
  removed, query sorted). It stores the set ID, script item IDs, primary
  variant, rename flag and the scripts' exact-host Cookie (only when that host
  equals the scan's cookie host). TTL is 30 minutes.
- When the extension later posts detected media to the existing sniffed-media
  route, `BrowserMatchService` compares `pageUrl` exactly (same normalized URL
  and origin). On a match the pairing is consumed once and one scanner batch is
  created: the detected video plus the scripts, with the scripts going into the
  same output folder as the video. Phase-3 renaming then uses the actual
  downloaded video filename.
- If nothing matches (or the pairing expired), the service returns false and
  the existing sniffed-media hand-off is byte-for-byte unchanged. No cookie or
  header is added beyond what the existing route already allows; scan scripts
  keep using the exact-host cookie rule from the session.
- The card shows "Waiting for the video from your browser… play it there."
  (`browserMatchPending` is a boolean in the DTO; the URL stays internal).

## Safety decisions

- No DRM, login, paywall, CAPTCHA, Cloudflare or bot-check bypass. No challenge
  solving, no `cf_clearance` reuse, no headless browser. The only action offered
  is opening the public page in the user's own browser.
- No renderer URL/path in any DTO or IPC input. Open-in-browser and manual
  match accept opaque IDs/tokens only.
- Manual download folders are narrowed to one picked folder behind a token;
  the existing download-root checks stay unchanged for every other path.
- MEGA links remain ordinary page links and are not treated as video targets.

## Limits

- A browser-only card cannot be downloaded directly and is not queueable. It
  can only be opened, or paired with a local file / browser hand-off.
- Automatic hand-off requires the extension to report the same normalized page
  URL. Redirected pages that change the query/host, or a replay after 30
  minutes, will not match and behave like a normal hand-off.
- The 30-minute pending pairing is memory-only; a restart forgets it.
- A manual match settles after one attempt. Retrying a failed script does not
  re-run the rename automatically (same phase-3 trade-off).
