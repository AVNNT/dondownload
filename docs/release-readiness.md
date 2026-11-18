# DonDownload release-readiness checklist

Status: **1.2.0 release prepared; releases are built by GitHub Actions.** The
application and browser extension are version 1.2.0, the updater points at the
public `AVNNT/dondownload` repository and its Ed25519 update signing key is
configured. The installer is still **unsigned**. Code-signing, the Chromium
extension store listing and human legal review remain open. This checklist is
not legal clearance. Future releases ship a Firefox `.xpi` signed by Mozilla
(unlisted channel), so it installs permanently.

## Verified

- [x] Latest locally verified installer (2026-11-06 build):
      `dist/DonDownload-0.1.0-x64-setup.exe`, approximately **234 MB**. The
      1.2.0 installer is produced by the `Release` workflow (or a local
      `npm run release`); record its size and SHA-256 in the release handoff
      rather than in this document. The payload uses the Gyan FFmpeg essentials
      build.
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
      final hash. 1.2.0 ships unsigned on purpose; do not claim a signed
      installer.
- [ ] **Extension store listing:** produce the store listing for the
      Chromium-compatible extension. Releases ship the extension inside the
      installer and as `dondownload-extension-chromium-<version>.zip` /
      `dondownload-extension-firefox-<version>.xpi` assets. The Firefox xpi is
      signed by Mozilla through the AMO secrets and installs permanently from a
      plain file open; for Chromium a store listing is still missing, so loading
      the unpacked (extracted) package remains the documented install path.
- [ ] **GPL corresponding source:** attach reviewed source archives for the
      exact shipped aria2 and FFmpeg/ffprobe binaries, or obtain a written offer
      that counsel approves. `dist/THIRD-PARTY-SOURCES.txt` records what was
      attached.

## Release pipeline (from 1.2.0)

The release is built by GitHub Actions, not on a maintainer machine.
`scripts/stage-vendor.ps1` downloads the pinned aria2, yt-dlp and FFmpeg
release archives from their official upstream URLs and verifies a hard-coded
SHA-256 for each one, so a `windows-latest` runner needs nothing but Node.js,
npm and the .NET Framework compiler that ships with Windows.

### Maintainer release flow

1. Bump `version` in `package.json` and `extension/manifest.json`, and add the
   matching `## [<version>] - <date>` section to `CHANGELOG.md`.
2. Commit and push to `master`.
3. `git tag v<version> && git push origin v<version>`. Pushing the tag starts
   `.github/workflows/release.yml`.
4. The workflow checks out the tag, requires the tag to equal `v` +
   `package.json` version, runs `npm ci`, typecheck, lint, `test:fast`,
   `test:extension`, then `node scripts/release.mjs --ci --publish`.
5. Review the draft GitHub release: every asset must be present (installer, its
   `.blockmap` when present, both extension packages, `SHA256SUMS.txt`,
   `SHA256SUMS.txt.sig`, `THIRD-PARTY-SOURCES.txt`), the notes must match the
   changelog section and the signature must verify. Publish the draft manually.
   Drafts are invisible to the updater.
6. The installed app then checks the published release at most once per 24
   hours.

The workflow also accepts a manual `workflow_dispatch` run with a `tag` input,
for rebuilding a draft for an existing tag. It never moves or creates a tag.

### What the release build does

`release.mjs` (`--ci` in Actions) does, in this order:

1. Refuse to continue unless the working tree is clean. Locally it also requires
   `master` and `origin/master` to match; in CI (`--ci` or
   `GITHUB_ACTIONS=true`) that check is skipped and the already-pushed tag must
   point at `HEAD` instead.
2. Run `npm run build:installer` (native host, tray stub, pinned vendor
   downloads with checksum verification, typecheck, electron-vite build, NSIS
   x64 installer).
3. Build the browser extension packages from `extension/`:
   - `dist/dondownload-extension-chromium-<version>.zip` — extract it and use
     "Load unpacked" (or load `extension/` directly from a checkout).
   - `dist/dondownload-extension-firefox-<version>.xpi` — the same files with
     `manifest.json` at the archive root.
   `.d.ts`, test and source-map files are excluded; icons and CSS are included.
4. Sign the Firefox xpi with Mozilla (addons.mozilla.org, unlisted channel) and
   replace it with the signed bytes, keeping the asset name. This runs only
   when `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` are set. `--ci --publish` fails
   without them, so a release never ships an unsigned extension by accident;
   locally the step is skipped with a warning, and `--skip-amo` makes an
   unsigned build explicit for forks without AMO access. See
   [Mozilla extension signing](#mozilla-extension-signing-amo).
5. Write and sign `dist/SHA256SUMS.txt` with the update signing key. The
   extension packages are built (and the Firefox one is signed) before this
   step so both of them are covered by the checksums and the signature; the
   installer line stays first, which is what the updater searches for.
6. Write `dist/THIRD-PARTY-SOURCES.txt` (the written offer/pointer described
   below) and, if the optional sources directory exists, list the GPL source
   archives found there.
7. Without `--publish`, print the exact asset list and the commands a publish
   run would use. Nothing is tagged, pushed or uploaded. With `--publish`, run
   `gh release create v<version> --draft --title "DonDownload <version>"
   --notes-file ...` with every asset. If a draft for the tag already exists,
   its assets are re-uploaded with `--clobber`; an already published release is
   never modified.

Locally, `npm run release` is the same build without tagging or uploading, and
`npm run release -- --publish` is the manual fallback if Actions is unavailable.

### Update signing key

- CI reads the key from the **`UPDATE_SIGNING_KEY` repository secret**: the
  Ed25519 private key as PKCS#8 PEM text. The workflow writes it to
  `%RUNNER_TEMP%\update-signing-key.pem`, restricts its ACL to the runner user,
  points `DONDOWNLOAD_UPDATE_SIGNING_KEY` at it and deletes it in an `always()`
  step. The key text is never echoed.
- If the secret is missing (for example on a fork), the job **fails** with a
  clear message instead of publishing an unsigned `SHA256SUMS.txt`.
- Locally the key lives **outside the repository** at
  `%USERPROFILE%\.dondownload-release\update-signing-key.pem`. Override the
  location with `DONDOWNLOAD_UPDATE_SIGNING_KEY` if it is stored elsewhere.
- `npm run release` refuses to run when the key is missing: an unsigned
  `SHA256SUMS.txt` cannot be served as an authenticated update.
- **Back the key up.** Losing it prevents every future authenticated update for
  installed copies; every existing installation would have to be replaced by a
  manual download. Keep one copy in the Actions secret and at least one offline
  copy. Never commit it, paste it into an issue or attach it to a release.
- The matching public key is committed in `src/shared/release.ts`
  (`UPDATE_SIGNING_PUBLIC_KEY`, base64 SPKI DER). Rotating the key requires a
  new release that ships the new public key before it can be used.
- Generate a key pair once with
  `node scripts/generate-update-signing-key.mjs <path-outside-the-repo>`.

### Mozilla extension signing (AMO)

- The release `.xpi` is signed by Mozilla through the addons.mozilla.org API,
  so Firefox 140+ installs it permanently from a plain file open (or drag and
  drop), not only through `about:debugging`.
- CI reads the credentials from the **`AMO_JWT_ISSUER`** (API key) and
  **`AMO_JWT_SECRET`** (API secret) repository secrets. The release workflow
  passes them to the release step only; `release.mjs` hands them to web-ext as
  `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`, so they never appear on a command
  line or in a log line.
- Signing uses the pinned `web-ext@8.9.0` (exact version, fetched with
  `npx -y`) on the `unlisted` channel with a 15-minute approval timeout. 8.3.0
  fails with "Unsupported file type"; never float this version.
- The signed output replaces
  `dist/dondownload-extension-firefox-<version>.xpi` before the checksums are
  written, so `SHA256SUMS.txt` and its Ed25519 signature cover the signed
  bytes. `release.mjs` refuses to continue unless the xpi contains
  `META-INF/mozilla.rsa` or `META-INF/cose.sig`.
- `--ci --publish` without both secrets **fails**; a release never ships an
  unsigned extension silently. A local `npm run release` skips signing with a
  warning instead.
- **Forks without AMO access** pass `--skip-amo` to ship the unsigned xpi on
  purpose. Combining `--skip-amo` with the credentials is refused as
  contradictory. An unsigned xpi only installs temporarily, unless the browser
  is Developer Edition/Nightly with `xpinstall.signatures.required` set to
  `false`.

### Code signing is still open

The installer, the application executable, the native messaging host, aria2,
yt-dlp and FFmpeg/ffprobe remain **NotSigned**. 1.2.0 does not change that:
`npm run release` never invokes `signtool`, never requests a certificate and
never claims a signature. Until an authorized certificate is available, expect
SmartScreen warnings and document them honestly.

### Draft releases must be published manually

`release.mjs --publish` only creates a **draft**, locally or in CI. Drafts are
invisible to the application updater and to users. After review:

1. Confirm all assets are attached: installer, its `.blockmap` when present,
   both extension packages, `SHA256SUMS.txt`, `SHA256SUMS.txt.sig` and
   `THIRD-PARTY-SOURCES.txt`.
2. Download `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` from the draft, verify the
   Ed25519 signature with the public key in `src/shared/release.ts`, and verify
   each asset hash. For the Firefox xpi, also confirm it contains
   `META-INF/mozilla.rsa` (or `META-INF/cose.sig`): that is Mozilla's signature,
   and without it Firefox only installs the add-on temporarily.
3. Check the release notes rendered from the `## [1.2.0] - 2026-11-18` section
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

## Build your own

The installer build is self-contained. A clean checkout builds offline from a
warm npm cache; the first build downloads the pinned, checksum-verified vendor
archives.

```powershell
npm ci
npm run build:installer
```

The result is `dist/DonDownload-<version>-x64-setup.exe`. This needs no update
signing key and no GitHub access. The compiled-in updater still points at the
official `AVNNT/dondownload` releases, so a local build only accepts updates
signed by the official key. That is safe, but a fork should either configure
its own repository and key (below) or disable the updater.

**Fork with your own releases.** Nothing in the official repository is needed:

1. Build (above) and confirm the app runs.
2. Generate your own update signing key pair outside the repository:

   ```powershell
   node scripts/generate-update-signing-key.mjs "$env:USERPROFILE\.dondownload-release\update-signing-key.pem"
   ```

3. In `src/shared/release.ts`, set `UPDATE_REPO` to your `{ owner, repo }` and
   paste the printed public key into `UPDATE_SIGNING_PUBLIC_KEY`. Rebuild; the
   updater only accepts releases from that repository signed by that key.
4. Add the private key as the `UPDATE_SIGNING_KEY` Actions secret (PKCS#8 PEM
   text) in your fork. Add `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (an
   addons.mozilla.org API key and secret) if you want Mozilla-signed extension
   packages; without them the release step fails by design, so pass `--skip-amo`
   in the workflow if your fork ships the unsigned xpi on purpose. The release
   workflow then signs and drafts its own releases when you push a `v*` tag.
5. Tag and push as in the maintainer flow above.

**Fork without releases.** Set `UPDATE_REPO` to `null` (or
`UPDATE_SIGNING_PUBLIC_KEY` to `null`) in `src/shared/release.ts`. The updater
then reports the source as not configured and makes no network request. No key
or secret is required.

Do not reuse the maintainer's public key with a different repository: the
updater would reject every release, and distributing a build that trusts a key
you do not control is unsafe.

## Release owner actions

1. Provide access to an authorized signing certificate through the approved
   secure process, then sign and verify the final installer.
2. Back up the update signing private key
   (`%USERPROFILE%\.dondownload-release\update-signing-key.pem`) to offline
   storage before the first publish, confirm the `UPDATE_SIGNING_KEY` Actions
   secret holds the same key, and confirm the committed
   `UPDATE_SIGNING_PUBLIC_KEY` matches it.
3. Put the reviewed GPL source archives in
   `%USERPROFILE%\.dondownload-release\sources\` (or provide counsel-approved
   written-offer wording) before distribution.
4. Push the `v<version>` tag, review the draft release the workflow creates, and
   publish it after verification. Use `npm run release` for a local dry run when
   needed.
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
