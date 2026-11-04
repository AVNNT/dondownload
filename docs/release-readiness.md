# DonDownload release-readiness checklist

Status: **BLOCKED for redistribution**. Local release preparation and payload
verification pass; legal, signing and isolated-install gates remain mandatory.
This checklist is not legal clearance or an install certification.

## Verified

- [x] Current installer built with electron-builder 26.18.0:
      `dist/DonDownload-0.1.0-x64-setup.exe`, 302,265,855 bytes,
      SHA-256 `f0e271c3644b21a8182023e8351ab7495067ae80565cba699eb6b0abcc4cf3fd`.
- [x] NSIS payload extracted to a disposable temp directory with 7-Zip; native
      host, extension, manual registration helper, licenses and notices present.
- [x] Extracted tool paths resolve through production locators; aria2, yt-dlp,
      FFmpeg, ffprobe and Deno version probes passed. Hashes and sizes match the
      staging manifest.
- [x] App MIT license and third-party license/notice hashes match repository
      files. No obvious test, coverage, dotenv, SQLite or log files appeared in
      the extracted outer payload or app archive listing.
- [x] Signature status checked: extracted Deno binary reported Authenticode
      Valid; installer, app, native host, aria2, yt-dlp, FFmpeg and ffprobe
      reported NotSigned. No installer signing claim is made.
- [x] `npm run test:fast`: **504 passed**, 34 files.
- [x] Final `npm run test:gate`: **544 passed / 11 skipped**, build and
      typecheck passed. The opt-in packaged-resource/live integrations remain
      skipped in the generic gate when no extracted payload/aria2 environment is
      set; both were run separately and passed.
- [x] Real aria2/local-fixture scheduling: scheduled start, queue outside
      allowed hours, Start Now override, and active transfer completion after
      the allowed-hours end all passed in focused integration runs. Real aria2
      restart recovery also passed: an in-flight transfer was interrupted,
      partial data was retained, and an explicit Range retry completed. Fake-
      clock tests cover boundary rules and policy-held recovery invariants.
- [x] Production dependency audit: zero findings (`npm audit --omit=dev`).
- [x] Source candidates (aria2 1.37.0, yt-dlp 2026.10.26, FFmpeg commit,
      Deno 2.9.8) downloaded and archive-tested; local hashes and completeness
      gaps are recorded in [licensing-release-audit.md](licensing-release-audit.md).

## Mandatory before redistribution

- [ ] **Corresponding source/legal review:** candidate source archives and
      hashes are in [licensing-release-audit.md](licensing-release-audit.md),
      but exact Windows build inputs, linked components and build recipes are
      incomplete. Provide complete corresponding source or a counsel-approved
      valid written offer for GPL aria2 and Gyan FFmpeg/ffprobe; review yt-dlp,
      Deno and all notices. No legal clearance is claimed.
- [ ] **Signing:** installer is **NotSigned**. Sign and timestamp the final
      artifact with authorized credentials, then verify its signature and hash.
- [ ] **Isolated installation/uninstallation:** run in disposable Windows
      Sandbox/VM with a fresh profile and install path; verify launch, upgrade,
      uninstall, data/download preservation and no registry changes beyond the
      documented app entry. The installer was not executed here.
- [ ] **Packaged app startup:** run the extracted app in the same disposable
      VM/profile after install validation. It was not launched here because the
      main process creates a window/tray and starts the loopback bridge; static
      payload/locator checks are not startup proof.
- [ ] **Installed browser bridge:** register the exact extension ID only in
      that disposable profile, then verify Helium-to-native-host communication
      and unregister cleanly. No real browser profile or registry was touched.
- [ ] **Build-tool advisory:** review the six moderate development-tree
      findings in `minimatch` and their electron-builder chain. Do not blindly
      upgrade; select a compatible fix and rebuild if required.
- [ ] **Final artifact gate:** after any source, dependency, license, signing or
      packaging change, rerun applicable tests, rebuild and re-check final
      installer hashes/signature.

## Actions needed from the release owner

1. Provide an isolated Windows 10/11 Sandbox or VM (or perform the documented
   install/uninstall test there) and a disposable browser profile for Helium
   bridge validation. Do not use the existing installation/profile.
2. Select a GPL distribution plan and obtain counsel's review; approve complete
   corresponding-source delivery or a valid written offer for the exact
   binaries/builds.
3. Provide access to an authorized signing certificate through the approved
   secure process, then sign and verify the final installer.
4. Decide whether to accept the moderate build-toolchain advisory temporarily
   or authorize a compatible, reviewed fix.
5. Optionally provide a lawful, bounded Pixeldrain list fixture; otherwise keep
   list validation explicitly blocked and out of product claims.

## Limitations and deferred scope

- [ ] Pixeldrain public-list live validation remains blocked until a lawful,
      bounded fixture is supplied. Do not guess or enumerate user lists.
- Gofile folders remain unsupported; keep the manual browser fallback truthful.
- Torrent and VPN features remain deferred and are not release blockers for the
  current HTTP/media scope.
- Extracted payload checks are **not equivalent** to install/uninstall or
  installed-app startup verification. GUI startup was not run on this machine.
