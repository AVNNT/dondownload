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

## IN PROGRESS

- None. Final local status/history audit is complete.

## DEFERRED / UNSUPPORTED

- HLS/DASH, blob/MSE, cross-origin iframe capture, separate audio pairing, and
  general third-party player/site adapters: no safe representation/audio
  mapping implemented; do not present them as downloadable.
- Verified in real headless Chromium (not Helium): webRequest evidence,
  Downloads API fail-safe path, options UI. Still unverified: the interactive
  optional-permission prompt (headless has no bubble; harness pre-declares the
  permissions), and anything needing Native Messaging - i.e. one-click queue
  into the app and the successful hand-off path (browser cancel after durable
  receipt). Windows Chromium finds native hosts only via the registry, which
  this session must not modify. Detection/queue latency not measured.
- Anonymous preflight proves public replay plus matching type/size, not
  byte-for-byte identity. The browser API exposes no body hash or request method;
  mismatch/unknown size safely leaves the browser transfer running.
- Player identity can remain ambiguous if a site reuses one video element for a
  different title without navigation/resource identity evidence. The overlay
  retains at most 32 exact progressive URLs per player.

## NEXT ACTION

With approval for a temporary HKCU native-host registration (removed after),
extend scripts/e2e-extension-chromium.mjs to cover one-click queue and the
successful hand-off path against a dev app instance with temp data dirs.

Previous note:

Final focused recovery verification: all five manager-recovery tests passed,
covering runtime GID loss without retry consumption, confirmed startup GID loss,
aria2 unavailability and transient RPC failure preservation, and tracked GID
recovery. Next useful verification requires a disposable supported Chromium/Helium
environment; do not substitute the sidebar preview for those platform APIs.
