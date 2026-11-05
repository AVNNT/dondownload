# DonDownload 10/10 mission checkpoint

Updated: 2026-11-05. Latest commit: see `git log`; working tree clean. No push
or release.

## DONE

- `5765276`: event-driven, exact-player `currentSrc` capture for progressive
  MP4/WebM-family sources; per-player quality accumulation, compact one-click
  queue, and no upfront yt-dlp analysis.
- `568cb6b`: optional automatic browser-file hand-off, strict durable SQLite
  receipt, options, popup source list, draggable player icon and configurable
  shortcut. Uncertain hand-offs leave the browser transfer running.
- `4687306`: optional bounded response evidence for exact top-frame media URLs;
  extensionless MP4/WebM proof; strict anonymous preflight with pinned DNS and
  exact range/size validation; captured-source durable acceptance; safer
  hand-off when the browser total is initially unknown; retained-source cap.
- Focused overlay, evidence, hand-off, preflight and native-bridge tests passed;
  typecheck, extension syntax checks, native-host temporary compile and diff
  checks passed. Earlier isolated 512 KiB aria2 output matched SHA-256.
- Recovery no longer marks an in-flight GID interrupted unless a ready aria2
  client explicitly reports that GID missing. Service unavailability and
  transient status RPC errors preserve the record and partial progress.
- A GID lost during runtime polling now becomes `interrupted`, not `error`; this
  preserves the existing retry budget and partial-file recovery semantics.
- `f69a38b` and `2796dc0`: recovery audit and its focused tests are committed.

- `1c3922e`: full non-live suite had 2 failing extension tests that earlier
  checkpoints missed. Fixed: overlay status copy names the configured shortcut;
  site-permission guard retargeted to options.js (exact-origin invariant kept).
  Full suite now 640 passed / 8 skipped; typecheck passes.
- `a7d0f05`: `npm run test:extension:chromium` - real headless Chromium 156
  (cached Playwright build, temp profile, local fixtures, raw CDP, no registry).
  PASS: worker start, options UI + shortcut, exact-origin overlay injection,
  MP4 capture, extensionless webRequest-evidence capture, same-player quality
  accumulation, and no-native-host hand-off leaving the 2 MiB browser download
  complete with matching SHA-256.
- Local checkpoint (see `git log`): the overlay now offers `Find qualities with
  DonDownload` when the attached player is blob/MSE, an HLS/DASH manifest, or
  has no verified progressive source. It reuses the existing analyze → pick →
  queue media flow against the trusted top page URL, lists verified resolution,
  container, reported size and merge status, and queues exactly the pinned
  opaque option. Visible top-frame embeds get a separate `Find qualities for
  embedded video` request against the iframe src, with no sub-frame injection
  and no new permission. Expired/invalid pinned analyses show the existing
  `Analyze this page again` message and never substitute a quality.
  Progressive capture remains first and unchanged.
- `84488b8`, `92d89c7`: `npm run test:extension:chromium:native` adds real
  Native Messaging coverage against an isolated dev app (temp userData,
  downloads, SQLite, bridge state) via a temporary
  `HKCU\Software\Chromium\NativeMessagingHosts` key removed afterwards; the
  Helium (`Google\Chrome`) key is only read and asserted unchanged.
  Independently re-run: 15 PASS / 0 FAIL / 1 NOT-RUNNABLE. Covers native probe,
  one-click overlay queue (exact URL, SHA-256 match, ~110-140 ms
  click-to-accepted), hand-off success (browser cancelled only after durable
  app acceptance, same bytes, no duplicate file) and hand-off refusal for an
  auth-only resource (browser completes, nothing queued). The harness removes
  a stale registration from a hard-killed run only when it points to its own
  vanished temp dir. Full suite 644 passed / 8 skipped; typecheck passes.

## IN PROGRESS

- None. Final local status/history audit is complete.

## DEFERRED / UNSUPPORTED

- DRM-protected media: analysis does not and must not bypass DRM, access
  restrictions or paywalls.
- General third-party player/site adapters and site-specific extraction beyond
  what yt-dlp already supports: no bespoke adapter is implemented.
- Separate audio pairing is handled by yt-dlp/ffmpeg merge for analyzed options;
  no independent browser-side pairing layer exists.
- Verified in real headless Chromium (not Helium): webRequest evidence,
  Downloads API fail-safe path, options UI. Still unverified: the interactive
  optional-permission prompt (headless has no bubble; harness pre-declares the
  permissions) and Helium itself. Native Messaging paths are now verified in
  Chromium (see DONE).
- Anonymous preflight proves public replay plus matching type/size, not
  byte-for-byte identity. The browser API exposes no body hash or request method;
  mismatch/unknown size safely leaves the browser transfer running.
- Player identity can remain ambiguous if a site reuses one video element for a
  different title without navigation/resource identity evidence. The overlay
  retains at most 32 exact progressive URLs per player.

## NEXT ACTION

Nothing further is verifiable here without a human: the interactive "allow
this site" prompt (headless has no permission bubble) and a manual pass in real
Helium with a disposable profile. DRM-protected media remains unsupported by
design; streaming and embedded sources now go through the existing explicit
yt-dlp analysis flow.

## 2026-11-05 evening round (DeepSeek V4.1 Flash workers, reviewed)

- User-reported YouTube bugs fixed: HLS progress (`cdd16f7`), plain-title
  filenames via per-job staging (`ba541e6`), fast icon + prefetched qualities +
  streaming detection in popup (`b430810`).
- NDM-style media sniffing with badge, detected-media list, referer/UA-aware
  downloads, per-site cookie opt-in default OFF (`5dca13c`..`d702e82`).
- Multi-site: codec-less formats accepted, short-side quality labels
  (`e36f9b6`); `--impersonate chrome` when supported, Vimeo player URL + DRM
  error, size cap for unknown sizes, cookie opt-in for yt-dlp
  (`b97144e`..`3c9b577`).
- Verified yt-dlp updater (`84caad9`), onedir yt-dlp (~0.7 s faster per
  analysis, `f7f9281`), app/tray/extension icon (`5d63939`).
- Unified compact download list UI (`ac02c23`..`4af7dd3`, `79a1ec7`).
- Final gate: 804 unit tests pass; Chromium/Helium native 20 PASS / 1
  NOT-RUNNABLE (permission prompt); real-site YouTube/w3schools/embed 11 PASS
  in both; packaged smoke PASS; installer rebuilt with onedir yt-dlp and icon.
- Known limits: interactive permission prompt untested; live media thumbnails
  not supplied by backend; failed media has "Analyze again" not one-click
  retry; no delete-file action; Reddit/Bilibili need the cookie opt-in; DRM
  sites (Vimeo) unsupported; installer unsigned.
