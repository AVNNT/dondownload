# DonDownload 10/10 mission checkpoint

Updated: 2026-11-05. Latest local commit: `2796dc0`; working tree is clean.
No push or release.

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

## IN PROGRESS

- None. Final local status/history audit is complete.

## DEFERRED / UNSUPPORTED

- HLS/DASH, blob/MSE, cross-origin iframe capture, separate audio pairing, and
  general third-party player/site adapters: no safe representation/audio
  mapping implemented; do not present them as downloadable.
- Actual Helium/Chromium `webRequest`, Downloads API and Native Messaging
  integration, extension options UI in a live browser, and detection/queue
  latency: unverified in this checkpoint.
- Anonymous preflight proves public replay plus matching type/size, not
  byte-for-byte identity. The browser API exposes no body hash or request method;
  mismatch/unknown size safely leaves the browser transfer running.
- Player identity can remain ambiguous if a site reuses one video element for a
  different title without navigation/resource identity evidence. The overlay
  retains at most 32 exact progressive URLs per player.

## NEXT ACTION

Final focused recovery verification: all five manager-recovery tests passed,
covering runtime GID loss without retry consumption, confirmed startup GID loss,
aria2 unavailability and transient RPC failure preservation, and tracked GID
recovery. Next useful verification requires a disposable supported Chromium/Helium
environment; do not substitute the sidebar preview for those platform APIs.
