# Testing workflow

Last updated: 2026-11-04. This document describes the three test tiers and the
input-safety rules for verification work. It does not change the existing full
suite: `npm test` still runs every Vitest test file.

## Three tiers

| Tier | Command | Use when | What it runs |
| --- | --- | --- | --- |
| 1 — fast development | `npm run test:fast` | Routine edit/refactor loop; unit, component and policy changes | All hermetic unit/component tests. It excludes the compiled native-host process tests, the native-host registration script tests and the optional real-aria2 integration file. |
| 2 — focused integration | `npm run test:integration` | A change crosses a process, native-host framing/registration or aria2 boundary | The compiled native-host process suite (including the 22 s timeout regression), the registration script suite, and the optional real-aria2 integration file. |
| 3 — milestone gate | `npm run test:gate` | Before closing a milestone or checkpointing a release candidate | `npm test` (the full existing suite) followed by `npm run build` (typecheck plus Electron production build). |

`npm test` remains the full suite and is intentionally unchanged for backwards
compatibility. `npm run test:gate` adds the build milestone gate; it does not
replace `npm test`.

### Tier 2 and slow-test separation

The native-host file contains a deliberate regression that waits 22 s to prove
`analyze-media` can outlast the regular 20 s bridge timeout. It is kept at full
strength, but it is not part of the fast loop:

```powershell
npm run test:native-host            # routine native-host tests; 22 s regression skipped
npm run test:native-host:timeout    # only the 22 s bridge-timeout regression
npm run test:native-host:registration
npm run test:aria2                  # optional real aria2; skips without ARIA2_TEST_BINARY
```

The timeout split uses Vitest's `--testNamePattern` filter, so
`tests/native-host.test.ts` is not deleted, weakened or forced to run slower in
Tier 1. `npm run test:integration` includes the timeout regression explicitly.

The aria2 semantics are unchanged: `tests/aria2.integration.test.ts` runs only
when `ARIA2_TEST_BINARY` points at a local `aria2c` binary. Without it, those
three tests skip and the rest of Tier 2 still runs.

### Subsystem-focused commands

```powershell
npm run test:extension   # extension bridge, manifest, media bridge, overlay, site policy
npm run test:media       # media contracts, engine, IPC and job manager
npm run test:native-host # routine native-host process tests without the 22 s regression
npm run test:aria2       # optional real-aria2 integration
```

Use a direct file filter when the change is narrower:

```powershell
npx vitest run tests/media-engine.test.ts
npx vitest run tests/native-host.test.ts -t "queue-media"
```

## Measured durations (2026-11-04, this machine)

These are actual wall-clock results from the commands below, not estimates.

| Command | Result | Wall time | Vitest duration |
| --- | --- | --- | --- |
| `npm run test:fast` | 21 files, 329 passed | 1.56 s | 1.02 s |
| `npm run test:native-host` | 27 passed, 1 skipped | 4.89 s | 4.34 s |
| `npm run test:native-host:timeout` | 1 passed, 27 skipped | 22.79 s | 22.25 s |
| `npm run test:native-host:registration` | 12 passed | 3.55 s | 2.97 s |
| `npm run test:aria2` (`ARIA2_TEST_BINARY` set) | 3 passed | 17.31 s | 16.75 s |
| `npm run test:extension` | 6 files, 87 passed | 0.74 s | 0.15 s |
| `npm run test:media` | 4 files, 81 passed | 1.56 s | 0.99 s |

The combined `npm run test:integration` command was not rerun after its three
constituent files passed in the focused runs above; repeating the same 22 s and
aria2 work would add no information. The full suite was also not rerun for this
workflow change because only `package.json` scripts and documentation changed.
Historical results remain:

- Full suite: **372 passed / 0 skipped**, about **26.71 s**, with
  `ARIA2_TEST_BINARY` configured.
- Focused native-host run: **28 passed** in about **26.63 s / 27.67 s** wall,
  including the **22.1 s** bridge-timeout test.
- aria2 integration: about **16.97 s** historically.

The fast tier is roughly 25 s shorter than the historical full-suite run, but
that comparison is not a controlled benchmark: the fast tier runs fewer files
and does not include native-host or aria2 process work. The 22 s regression
still costs about 22 s whenever it is explicitly selected.

## Input isolation and manual-only browser checks

Routine tests must not use OS mouse/keyboard input, active windows, a real
browser or real browser profile, `SetCursorPos`, `mouse_event`, `SendInput`, UI
Automation (UIA), PyAutoGUI or desktop shortcuts. They must not launch
Electron/Helium or start media engines such as yt-dlp/FFmpeg.

- **Real browser permission click is manual-only.** If a real-browser permission
  prompt must be exercised, the user performs the permission click by hand. An
  agent must not automate the permission prompt or retry browser automation.
- **T3 browser is disconnected.** Do not attempt browser automation retries. If
  a check requires the T3 browser, report the disconnected constraint and stop
  rather than falling back to desktop input or a real profile.
- **No downloads.** Routine verification creates no user downloads. The aria2
  integration uses a local loopback HTTP fixture and temporary directories only,
  and runs only when explicitly selected with `ARIA2_TEST_BINARY`.

## Mocked renderer vs native Electron IPC

The fast and subsystem tiers are hermetic. They use mocked Electron modules,
mocked Chrome extension APIs and component/policy tests; they do not start the
Electron app or exercise native Electron IPC.

The native-host tests do start a real compiled C# native messaging executable
(`native/dondownload-native-host.exe`) against a local fake app server. That
validates native-messaging framing and the loopback bridge contract, but it is
still not Electron IPC. Verifying native Electron IPC requires launching the
real app manually; no routine command here does that.

## Historical Milestone 3A evidence and caveats

Milestone 3A is closed as **PASS** at `e7e28ee`; this testing workflow does not
reopen or re-verify it. The historical evidence is:

- Full suite: **372 passed / 0 skipped** with `ARIA2_TEST_BINARY` set, including
  3/3 real-aria2 integration tests, about 26.71 s.
- Real yt-dlp/FFmpeg/Deno media runs against YouTube and Wikimedia, with
  ffprobe and full-decode checks.
- Real-aria2 capture integration passed 3/3.

Caveats recorded in [development-status.md](development-status.md) still apply.
The historical headed checks predate this stricter input-isolation rule: they
used a disposable Helium profile, synthetic Win32/CDP input and UI Automation for
the permission prompt instead of a manual-only click, and loaded the extension
unpacked. The visible permission bubble was not observed on YouTube, and
mid-merge cancellation remains unverified because no FFmpeg child was running
when cancellation was issued. Do not treat the historical automation pattern as
a model for future browser checks, and do not cite these timings as newly
measured results.
