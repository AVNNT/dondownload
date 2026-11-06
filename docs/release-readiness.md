# DonDownload release-readiness checklist

Status: **Release candidate verified locally; not yet published.** The current
installer, a silent per-user install/uninstall cycle, the installed packaged app
and real-browser native end-to-end checks pass. Remaining blockers are the
code-signing certificate, a public release repository and an extension store
listing. This checklist is not legal clearance.

## Verified

- [x] Current installer built with electron-builder 26.18.0:
      `dist/DonDownload-0.1.0-x64-setup.exe`, approximately **234 MB**. The
      payload uses the Gyan FFmpeg/ffprobe essentials build.
- [x] Silent per-user install into a fresh temporary folder, verified on
      **2026-11-06**. The installer did not require elevation.
- [x] The installed application passed the packaged smoke test against an
      isolated userData directory.
- [x] Silent uninstall removed the installed files, shortcuts and the
      per-user uninstall entry. `userData` was left intact, as was an existing
      development native-host registration that pointed outside the install
      directory.
- [x] Real-browser native end-to-end suite: **20 PASS in both Chromium and
      Helium**.
- [x] NSIS payload inspected: native host, extension, manual registration
      helper, licenses and notices present.
- [x] Extracted tool paths resolve through production locators; aria2, yt-dlp,
      FFmpeg, ffprobe and Deno version probes passed. Hashes and sizes match the
      staging manifest.
- [x] App MIT license and third-party license/notice hashes match repository
      files. No test, coverage, dotenv, SQLite or log files appeared in the
      extracted outer payload or app archive listing.
- [x] Signature status checked: extracted Deno binary reported Authenticode
      Valid; installer, app, native host, aria2, yt-dlp, FFmpeg and ffprobe
      reported NotSigned. No installer signing claim is made.
- [x] `npm run lint`, `npm run typecheck`, the full Vitest suite
      (**854 passed / 13 skipped**, 2026-11-06) and `electron-vite build`
      passed.
- [x] Production dependency audit: zero findings (`npm audit --omit=dev`).
- [x] Source candidates (aria2 1.37.0, yt-dlp 2026.10.26, FFmpeg commit,
      Deno 2.9.8) downloaded and archive-tested; local hashes and completeness
      gaps are recorded in [licensing-release-audit.md](licensing-release-audit.md).

## Remaining blockers

- [ ] **Code-signing certificate:** obtain an authorized certificate, sign and
      timestamp the final installer, then verify the signature and publish the
      final hash.
- [ ] **Public release repository:** create the public GitHub repository, set
      `UPDATE_REPO`, publish the signed installer plus `SHA256SUMS.txt` and
      `SHA256SUMS.txt.sig`, and configure `UPDATE_SIGNING_PUBLIC_KEY`.
- [ ] **Extension store listing:** produce the store package and listing for the
      Chromium-compatible extension. Until then, loading the unpacked extension
      remains the documented install path.

## Release owner actions

1. Provide access to an authorized signing certificate through the approved
   secure process, then sign and verify the final installer.
2. Create the public repository and the first signed release. Keep the update
   signing private key outside the repository and back it up securely; losing it
   prevents future authenticated updates.
3. Decide the extension distribution path (Chrome Web Store and/or a
   Chromium-compatible listing) and submit the listing for review.

## Limitations

- This checklist covers packaging, updates and browser-extension readiness. It
  is **not legal clearance**. The third-party corresponding-source strategy and
  the review notes in [licensing-release-audit.md](licensing-release-audit.md)
  still apply to any redistribution.
- Pixeldrain public-list live validation remains blocked until a lawful,
  bounded fixture is supplied. Do not guess or enumerate user lists.
- Gofile folders remain unsupported; keep the manual browser fallback truthful.
- Torrent and VPN features remain deferred and are not release blockers for the
  current HTTP/media scope.
- The installer remains unsigned until the signing blocker is resolved.
