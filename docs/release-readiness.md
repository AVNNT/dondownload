# DonDownload release-readiness checklist

Status: **1.0.0 release prepared locally; not yet published.** The application
and browser extension are version 1.0.0, the updater points at the public
`AVNNT/dondownload` repository and its Ed25519 update signing key is configured.
The installer is still **unsigned**. Code-signing, the extension store listing
and human legal review remain open. This checklist is not legal clearance.

## Verified

- [x] Latest locally verified installer (2026-11-06 build):
      `dist/DonDownload-0.1.0-x64-setup.exe`, approximately **234 MB**. The
      1.0.0 installer is produced by `npm run release`; record its size and
      SHA-256 in the release handoff rather than in this document. The payload
      uses the Gyan FFmpeg/ffprobe essentials build.
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
      final hash. 1.0.0 ships unsigned on purpose; do not claim a signed
      installer.
- [ ] **Extension store listing:** produce the store listing for the
      Chromium-compatible extension. 1.0.0 ships the extension inside the
      installer and as `dondownload-extension-chromium-1.0.0.zip` /
      `dondownload-extension-firefox-1.0.0.xpi` release assets; until a store
      listing exists, loading the unpacked (extracted) package is the documented
      install path.
- [ ] **GPL corresponding source:** attach reviewed source archives for the
      exact shipped aria2 and FFmpeg/ffprobe binaries, or obtain a written offer
      that counsel approves. `dist/THIRD-PARTY-SOURCES.txt` records what was
      attached.

## Release pipeline (1.0.0)

The release is built locally, not in CI: `scripts/stage-vendor.ps1` stages
aria2, yt-dlp and FFmpeg from locally installed, version-checked binaries, so a
CI runner would need those binaries redistributed into the workflow.

`npm run release` (that is `node scripts/release.mjs`) is local, idempotent and
does, in this order:

1. Refuse to continue unless the working tree is clean, `master` is checked out
   and it matches `origin/master`.
2. Run `npm run build:installer` (native host, tray stub, vendor staging,
   typecheck, electron-vite build, NSIS x64 installer).
3. Build the browser extension packages from `extension/`:
   - `dist/dondownload-extension-chromium-<version>.zip` — extract it and use
     "Load unpacked" (or load `extension/` directly from a checkout).
   - `dist/dondownload-extension-firefox-<version>.xpi` — the same files with
     `manifest.json` at the archive root, **unsigned**, for temporary loading
     or self-distribution.
   `.d.ts`, test and source-map files are excluded; icons and CSS are included.
4. Write and sign `dist/SHA256SUMS.txt` with the update signing key. The
   extension packages are built before this step so both of them are covered by
   the checksums and the signature; the installer line stays first, which is
   what the updater searches for.
5. Write `dist/THIRD-PARTY-SOURCES.txt` (the written offer/pointer described
   below) and, if the optional sources directory exists, list the GPL source
   archives found there.
6. Without `--publish`, print the exact asset list and the commands a publish
   run would use. Nothing is tagged, pushed or uploaded.

`npm run release -- --publish` additionally creates the lightweight tag
`v<version>` if it is missing, pushes it, and runs
`gh release create v<version> --draft --title "DonDownload <version>"
--notes-file ...` with every asset. If a draft for the tag already exists, its
assets are re-uploaded with `--clobber`; an already published release is never
modified.

### Update signing key

- The Ed25519 private key lives **outside the repository** at
  `%USERPROFILE%\.dondownload-release\update-signing-key.pem`. Override the
  location with `DONDOWNLOAD_UPDATE_SIGNING_KEY` if it is stored elsewhere
  (for example on removable media).
- `npm run release` refuses to run when the key is missing: an unsigned
  `SHA256SUMS.txt` cannot be served as an authenticated update.
- **Back the key up.** Losing it prevents every future authenticated update for
  installed copies; every existing installation would have to be replaced by a
  manual download. Store at least one offline copy separate from the build
  machine, and never commit it, paste it into an issue or attach it to a
  release.
- The matching public key is committed in `src/shared/release.ts`
  (`UPDATE_SIGNING_PUBLIC_KEY`, base64 SPKI DER). Rotating the key requires a
  new release that ships the new public key before it can be used.
- Generate a key pair once with
  `node scripts/generate-update-signing-key.mjs <path-outside-the-repo>`.

### Code signing is still open

The installer, the application executable, the native messaging host, aria2,
yt-dlp and FFmpeg/ffprobe remain **NotSigned**. 1.0.0 does not change that:
`npm run release` never invokes `signtool`, never requests a certificate and
never claims a signature. Until an authorized certificate is available, expect
SmartScreen warnings and document them honestly.

### Draft releases must be published manually

`npm run release -- --publish` only creates a **draft**. Drafts are invisible to
the application updater and to users. After review:

1. Confirm all assets are attached: installer, its `.blockmap` when present,
   both extension packages, `SHA256SUMS.txt`, `SHA256SUMS.txt.sig` and
   `THIRD-PARTY-SOURCES.txt`.
2. Download `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` from the draft, verify the
   Ed25519 signature with the public key in `src/shared/release.ts`, and verify
   each asset hash.
3. Check the release notes rendered from the `## [1.0.0] - 2026-11-18` section
   of `CHANGELOG.md`.
4. Publish the draft on GitHub. Only then does `releases/latest` offer it.

### GPL corresponding source

`scripts/release.mjs` never downloads source. If
`%USERPROFILE%\.dondownload-release\sources\` exists (override with
`DONDOWNLOAD_RELEASE_SOURCES_DIR`), every regular file in it is treated as an
optional corresponding-source archive, hashed into
`THIRD-PARTY-SOURCES.txt` and attached to the release. Nothing is attached when
the directory is absent; the file then states that the release owner must
supply the source before distribution. Complete corresponding source for the
exact shipped binaries — including build inputs for the aria2 Windows build and
the Gyan FFmpeg configuration — remains a legal gate, not just a packaging step.

## Release owner actions

1. Provide access to an authorized signing certificate through the approved
   secure process, then sign and verify the final installer.
2. Back up the update signing private key
   (`%USERPROFILE%\.dondownload-release\update-signing-key.pem`) to offline
   storage before the first publish, and confirm the committed
   `UPDATE_SIGNING_PUBLIC_KEY` matches it.
3. Put the reviewed GPL source archives in
   `%USERPROFILE%\.dondownload-release\sources\` (or provide counsel-approved
   written-offer wording) before distribution.
4. Run `npm run release`, review the dry-run asset list, then
   `npm run release -- --publish` and publish the draft after verification.
5. Decide the extension distribution path (Chrome Web Store and/or a
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
