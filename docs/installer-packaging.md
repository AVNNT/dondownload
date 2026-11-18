# Windows installer packaging baseline

This document records the Windows installer packaging baseline and subsequent
application updates. The initial packaging change was developed independently
from settings runtime work; the current source and installer include the later
settings, media-runtime and Milestone 5 changes noted in the verification log.

## Scope

In scope:

- An electron-builder NSIS installer for Windows x64.
- A deterministic vendor staging script for the third-party executables.
- A per-user, assisted install with an explicit install directory and no
  elevation.
- Inclusion of the native messaging host, the unpacked extension assets, the
  current-user registration helper and the third-party notices.
- A readable per-tool notice and source-offer strategy.

Out of scope for this baseline:

- Applying or changing application settings.
- Reading OS-wide input, prompting for credentials or collecting telemetry.
- Privileged installation, per-machine installation, firewall or custom
  registry mutation during install, or changes to an existing DonDownload
  installation.
- Torrent, VPN, auto-update or cloud synchronization features.
- Automatic browser native-host registration. Registration remains an explicit,
  current-user, manual action.

## Pinned tools

The staging script pins the versions verified on the development machine and
documented in [media-tools.md](media-tools.md). The same pins are the download
pins: each version has one official upstream release archive and one hard-coded
SHA-256.

| Tool | Version | Expected staged path |
| --- | --- | --- |
| aria2 | 1.37.0 | `resources/vendor/aria2/aria2c.exe` |
| yt-dlp | 2026.10.26 | `resources/vendor/yt-dlp/yt-dlp.exe` |
| FFmpeg | 9.0.2 Gyan essentials build | `resources/vendor/ffmpeg/ffmpeg.exe` |

FFprobe is no longer staged: the bounded header read that labels a stream
without reported dimensions runs `ffmpeg -i <url>` and parses the stream table
FFmpeg prints on stderr.

Deno is not bundled either. Current yt-dlp YouTube extraction needs a JavaScript
runtime, so the app downloads the pinned, SHA-256 verified
`deno-x86_64-pc-windows-msvc` release archive into
`<userData>/tools/deno/<version>/deno.exe` the first time a YouTube job needs it
and passes that path to yt-dlp. Without a runtime, yt-dlp runs with exactly the
arguments a machine without Deno would use.

## Prerequisites

- Windows 10/11 x64.
- Node.js 24+ and npm 10+ locally (the release workflow uses Node.js 22).
- The .NET Framework C# compiler (`csc.exe`) for the native messaging host and
  the tray stub. It ships with Windows 10/11 and with `windows-latest` GitHub
  Actions runners; no .NET SDK, Visual Studio or NuGet package is required.
- No locally installed aria2, yt-dlp or FFmpeg. `scripts/stage-vendor.ps1`
  downloads each pinned upstream release archive, verifies its hard-coded
  SHA-256 and extracts only the expected executable. A clean checkout plus an
  internet connection is enough, which is what makes the GitHub Actions release
  workflow possible.

The staging script never runs `winget`, an installer or a package manager, and
it never executes a downloaded installer. It only downloads the pinned archive
URLs, hashes the archive, extracts the expected executable after the safe-zip
checks, executes that executable with a read-only version flag and copies the
verified file. An explicit `DONDOWNLOAD_*_PATH` override or an existing verified
cache entry skips the download entirely.

## Commands

```powershell
npm ci --include=dev      # restore the exact locked build toolchain
npm run stage:vendor      # stage and verify binaries into build/vendor
npm run build:installer   # native host + stage + app build + NSIS x64 installer
```

The first `stage-vendor` run downloads roughly 140 MB of pinned archives into
`%LOCALAPPDATA%\DonDownload\vendor` (override the base with `LOCALAPPDATA`).
Later runs reuse the cached archives after re-verifying their SHA-256.

`electron-builder` is a development dependency required by the installer script.
The lockfile pins it at 26.18.0; using `npm ci --include=dev` ensures a clean
checkout restores it rather than relying on a partially populated `node_modules`
directory.

If npm's `allow-scripts` policy skips Electron's postinstall step, run
`node node_modules/electron/install.js` once before building. That step only
installs the already-declared Electron development dependency.

`build:installer` runs the existing `build:native-host` script, then
`build:tray-stub`, then `stage:vendor`, then the existing `build` script
(typecheck plus electron-vite production build), then electron-builder for the
NSIS x64 target. `scripts/build-tray-stub.ps1` compiles `native/TrayStub.cs`
into the windowed `native/dondownload-tray.exe` that is shipped next to the
native messaging host in `resources/native/`. No other package scripts are
added by this baseline.

## Vendor staging

`scripts/stage-vendor.ps1`:

- Resolves each tool from the first available source:
  1. an explicit environment override: `DONDOWNLOAD_ARIA2_PATH`,
     `DONDOWNLOAD_YTDLP_PATH`, `DONDOWNLOAD_FFMPEG_PATH`, or the matching
     archive override `DONDOWNLOAD_ARIA2_ZIP_PATH`,
     `DONDOWNLOAD_YTDLP_ZIP_PATH`, `DONDOWNLOAD_FFMPEG_ZIP_PATH`;
  2. the documented local installation path, then a `PATH` lookup;
  3. a verified release archive cached below
     `%LOCALAPPDATA%\DonDownload\vendor`;
  4. the pinned official upstream release archive, downloaded from the exact
     URL below and accepted only when its SHA-256 matches the pinned value.
- Uses these pinned download sources:

  | Tool | Upstream release asset | SHA-256 |
  | --- | --- | --- |
  | aria2 1.37.0 | `https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip` | `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288` |
  | yt-dlp 2026.10.26 | `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_win.zip` | `fd51b212cf8380c7a52ee08c0d6be7f3c59b2f2c832eaf7b45acfae6eab57419` |
  | FFmpeg 9.0.2 (Gyan essentials) | `https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip` | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` |

  The FFmpeg asset is the GyanD/codexffmpeg GitHub mirror of the gyan.dev
  package `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip`;
  both downloads are byte-identical and share the SHA-256 above. The GitHub
  release is pinned because it is the more stable URL for CI.
- Rejects an archive whose SHA-256 does not match, before anything is
  extracted. Every archive entry name is validated for zip-slip safety and
  size-capped; the FFmpeg archive is 49 entries and only `bin/ffmpeg.exe` is
  written.
- Executes the extracted or local candidate with `--version`/`-version` and
  requires an exact version match with the pinned version.
- Refuses to continue when a tool is missing, a version differs, a license or
  notice file is missing, or the staging directory is outside the repository's
  ignored `build/` directory.
- Deletes and recreates `build/vendor/` so stale executables cannot leak into a
  build.
- Copies only executables. No installers, archives, caches or source trees are
  copied into `build/vendor/`. Downloaded archives stay in the local cache.
- Writes `build/vendor/manifest.json` with, per tool: name, executable, staged
  path, version, expected version, SHA-256, size, source kind/path/origin,
  license, license-file hashes, upstream URL, source version, source archive,
  notice text and, when the tool came from an archive, the pinned archive name,
  URL, SHA-256, size and extracted entry.

`-ForceArchiveDownload` skips the local executable lookups and the
`DONDOWNLOAD_*_ZIP_PATH` overrides so the cache, download and checksum path can
be verified on a machine that also has the tools installed. CI runners do not
need it: they have no local installations.

The manifest is deterministic for the same inputs: it has no timestamp and the
tool order is fixed. The staged executables and manifest are git-ignored. They
must never be committed.

Example manifest shape:

```json
{
  "schemaVersion": 1,
  "generatedBy": "scripts/stage-vendor.ps1",
  "platform": "win32-x64",
  "tools": [
    {
      "name": "aria2",
      "stagedPath": "aria2/aria2c.exe",
      "version": "1.37.0",
      "sha256": "<hex>",
      "sizeBytes": 5649408,
      "source": { "kind": "verified-local-path", "path": "<local path>", "origin": "documented local installation path" },
      "license": "GPL-2.0-or-later",
      "licenseFiles": [{ "path": "third-party/licenses/aria2-COPYING.txt", "sha256": "<hex>", "sizeBytes": 18092 }]
    }
  ]
}
```

## Installer configuration

`electron-builder.yml` defines:

- `appId: com.dondownload.app`, `productName: DonDownload`, NSIS x64 target.
- `files`: only the electron-vite production output and the application
  `package.json`/`LICENSE` (plus source-map and `node_modules` exclusions).
  The main/preload bundles use Electron and Node built-ins; the renderer
  bundles React, so dev-only `node_modules` copies are not shipped.
- `extraResources`: the staged vendor directory, the compiled native host, the
  unpacked extension, the current-user registration helper, third-party notices
  and this document.
- `publish: null`: no update feed, publish provider, telemetry or cloud service.
- `win.requestedExecutionLevel: asInvoker`: no elevation.
- NSIS `oneClick: false`: assisted install, not a one-click silent install.
- NSIS `perMachine: false`: per-user installation.
- NSIS `allowElevation: false`: no elevation prompt.
- NSIS `include: scripts/installer/force-current-user.nsh`: the assisted
  installer's install-mode page is skipped and current-user mode is forced, so
  an administrator account cannot select a per-machine installation.
- NSIS `packElevateHelper: false`: electron-builder's elevate helper is not
  shipped because this installer never elevates.
- NSIS `allowToChangeInstallationDirectory: true`: explicit install path.
- NSIS `runAfterFinish: false`: the app is not launched automatically.
- NSIS `deleteAppDataOnUninstall: false`: uninstall does not delete per-user
  application data. Downloads live in the user's chosen download directory and
  are never touched by the uninstaller.

The installer does not write firewall rules, does not add custom registry
values, does not register a browser native host, and does not modify an
existing installation beyond the standard NSIS per-user uninstall entry and an
upgrade of the same per-user application.

## Installed layout

Relative to the installed application's `resources/` directory:

```text
resources/
  vendor/
    manifest.json
    aria2/aria2c.exe
    yt-dlp/yt-dlp.exe
    ffmpeg/ffmpeg.exe
  native/dondownload-native-host.exe
  extension/                 # unpacked Manifest V3 extension
  registration/register-native-host.ps1
  licenses/THIRD_PARTY_NOTICES.md
  licenses/third-party/      # license and build-notice texts
  licenses/installer-packaging.md
```

The staged manifest's `licenseFiles` entries use repository-relative paths.
In the installed application the same files are under
`resources/licenses/third-party/`.

## Browser host registration

Registration is deliberately manual and current-user only. The installer does
not edit
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge`,
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dondownload.bridge` or
`HKCU\Software\Mozilla\NativeMessagingHosts\com.dondownload.bridge`, and it
does not write a Helium-specific key.

The included helper is the existing `scripts/register-native-host.ps1`, copied
to `resources/registration/register-native-host.ps1`. It writes only under
`HKCU`, only the exact `chrome-extension://<32-character-id>/` origins passed by
the user, and for Firefox only the exact `allowed_extensions` add-on IDs it is
given. Helium is supported through the same verified Chromium-compatible Chrome
current-user key used by the existing registration script; no Helium-specific
key is written. Do not include a wildcard origin or add-on ID and do not
auto-register during install.

Example manual registration with explicit IDs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File ".\resources\registration\register-native-host.ps1" `
  -Browser Helium `
  -ExtensionId <helium-extension-id>
```

Use the exact IDs shown by the browser. Add every browser's ID to the same
registration when they differ. Unregistering Helium removes the shared
Chrome-compatible key, so re-register Chrome if it is still needed.

## Third-party licensing

The application's own source is MIT. The bundled binaries are separate works
with separate terms:

- aria2: GPL-2.0-or-later.
- yt-dlp: Unlicense plus bundled third-party licenses in the standalone
  executable.
- Gyan FFmpeg essentials build: GPL-3.0-or-later. The essentials build is the
  staged default; a locally installed full build is only a fallback source for
  the same executable.
- Deno: MIT. It is not redistributed in the installer, but its MIT text ships in
  `resources/licenses/third-party/` because the app can download the runtime on
  demand.

Read [../third-party/NOTICE.md](../third-party/NOTICE.md) for the per-tool
inventory, license files, source versions and the source-offer strategy. This
document and the notice file are not legal advice and do not claim legal
sufficiency.

A redistributable release must publish the complete corresponding source for
the GPL-covered binaries (or provide a valid written offer), together with the
license texts and build information. The local build described here does not
include those source archives; it is a build-verification artifact.

## Application updates

The application can check GitHub Releases for a newer DonDownload installer.
The source is fixed in `src/shared/release.ts`: `UPDATE_REPO` points at the
public `AVNNT/dondownload` repository and `UPDATE_SIGNING_PUBLIC_KEY` holds the
Ed25519 key that authenticates the release. Removing either value disables the
updater: it reports the source as not configured and makes no network request.

Updates are authenticated as well as integrity-checked. Every release must
include a raw 64-byte Ed25519 signature over the exact bytes of
`SHA256SUMS.txt`, base64 encoded as `SHA256SUMS.txt.sig`. The matching public
key goes in `UPDATE_SIGNING_PUBLIC_KEY` as an SPKI PEM or its base64 SPKI DER.
If a repository is configured while the public key is `null`, the checker makes
no request and reports **"Update signing key not configured"**.

When configured, the main process:

- requests `https://api.github.com/repos/{owner}/{repo}/releases/latest` with
  `Accept: application/vnd.github+json` and
  `User-Agent: DonDownload/<version>`, no cookies or credentials, a 15-second
  timeout and a 1 MiB response cap;
- ignores drafts and prereleases, requires a strict `vX.Y.Z`/`X.Y.Z` tag, and
  offers the release only when it is strictly newer than `app.getVersion()`;
- requires `DonDownload-<version>-x64-setup.exe` (version equal to the tag),
  `SHA256SUMS.txt` and `SHA256SUMS.txt.sig`;
- follows only HTTPS `github.com`, `objects.githubusercontent.com` and
  `release-assets.githubusercontent.com` URLs, validating every redirect hop;
  the signature download uses the same host allowlist, redirect validation and
  a 4 KiB cap;
- verifies the Ed25519 signature before trusting any hash in
  `SHA256SUMS.txt`; a missing, malformed, oversized or invalid signature means
  no update is offered;
- downloads through `<userData>/updates/<version>/<file>.partial`, caps the
  installer at 600 MiB and requires the asset's declared size and SHA-256;
- deletes the file on a checksum mismatch and removes older update directories;
- checks automatically at most once per 24 hours and exposes a manual
  "Check now" action. The "Check for app updates automatically" setting
  defaults to ON;
- installs only on an explicit "Restart and install" action, refuses while a
  download or media job is active, re-verifies the hash, then starts the
  per-user NSIS installer detached with `shell: false` before quitting.

Release notes are shown as plain text only, truncated to 4 KiB.

### Publishing an update

Releases are built by GitHub Actions when a tag is pushed; see
[release-readiness.md](release-readiness.md) for the full checklist. The
maintainer flow is:

1. Bump `version` in `package.json` and `extension/manifest.json`, and add the
   matching `## [<version>] - <date>` section to `CHANGELOG.md`. Commit and push
   to `master`.
2. `git tag v<version> && git push origin v<version>`. The `Release` workflow
   checks that the tag equals `v` + the `package.json` version, runs typecheck,
   lint, `test:fast` and `test:extension`, builds the installer (staging the
   pinned vendor archives), signs `SHA256SUMS.txt` with the `UPDATE_SIGNING_KEY`
   secret and creates a **draft** GitHub release with every asset and notes from
   the changelog section.
3. Review the draft, verify the signature and hashes, then publish it manually.
   Drafts are invisible to the updater. The installed app checks the published
   release at most once per 24 hours.

`npm run release` still runs the same build locally without tagging or
uploading, and `npm run release -- --publish` is the manual fallback; both need
the update signing key at
`%USERPROFILE%\.dondownload-release\update-signing-key.pem` (or
`DONDOWNLOAD_UPDATE_SIGNING_KEY`). Generate a key pair once with
`node scripts/generate-update-signing-key.mjs <path>` and paste the printed
public key into `UPDATE_SIGNING_PUBLIC_KEY` in `src/shared/release.ts`. Never
commit the private key.

## Verification

Expected checks:

```powershell
npm run typecheck
npm run build
npm run stage:vendor
npm run build:installer
```

The installer artifact is written to `dist/`. Record its path, SHA-256 and size
in the handoff for each build.

An install test may be performed only in a fresh, unique temporary directory,
with no OS-wide input and without touching an existing DonDownload
installation. Do not run the installer as an upgrade over a real installation
as part of this baseline. If that isolation is not available, treat installation
testing as a manual step.

### Verification record (2026-11-04)

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run stage:vendor`: passed for aria2 1.37.0, yt-dlp 2026.10.26,
  FFmpeg/ffprobe 9.0.2 and Deno 2.9.8.
- `npm run build:installer`: passed; electron-builder 26.18.0 produced an NSIS
  x64 installer.
- Artifact: `dist/DonDownload-0.1.0-x64-setup.exe`. The final size and SHA-256
  are recorded in the build handoff for this run rather than hard-coded here,
  because this document is itself packaged into the installer.
- The packaged `resources/vendor/` files match the SHA-256 values in
  `build/vendor/manifest.json` for all five tools.
- The packaged `app.asar` contains only `out/` and `package.json`; it does not
  contain `node_modules`. `resources/elevate.exe` is absent because
  `packElevateHelper: false`.
- `dist/builder-debug.yml` shows the custom
  `scripts/installer/force-current-user.nsh` include and the assisted,
  per-user NSIS configuration.
- Install/uninstall execution was **not** run. A real NSIS install would create
  current-user uninstall registry entries and shortcuts, which is outside the
  no-mutation constraint for this task. Payload and configuration were verified
  from `dist/win-unpacked/` and `dist/builder-debug.yml`; a real install test
  remains manual and must use a fresh unique temporary path.
- The artifact is unsigned and uses electron-builder's default icon.

### Verification record (2026-11-06)

- Current installer size is approximately **234 MB** with the Gyan
  FFmpeg/ffprobe essentials build.
- A silent per-user install into a fresh temporary folder completed without
  elevation. The installed app passed the packaged smoke test.
- The silent uninstall removed the installed files, shortcuts and the per-user
  uninstall entry. `userData` was left intact, and a development native-host
  registration that pointed outside the install folder was also left intact.
- The real-browser native end-to-end suite passed **20 checks in both Chromium
  and Helium**.
- The installer is still unsigned and was not signed by these checks.

### Verification record (2026-11-18)

- `scripts/stage-vendor.ps1` was run with `LOCALAPPDATA` pointed at an empty
  directory and no `DONDOWNLOAD_*` overrides, so all three archives were really
  downloaded from the pinned URLs and checked against the pinned SHA-256 before
  extraction. `-ForceArchiveDownload` bypassed the local installations for the
  verification run.
- Staged results: aria2 1.37.0 (`be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2`),
  yt-dlp 2026.10.26 (`08e30ae43a9f0c2d3ed716ef05a95fc7b4ee9d93862148e344bad3de51b93f3c`)
  and FFmpeg 9.0.2 (`3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`).
  The aria2 and FFmpeg executable hashes match the ones previously staged from
  local installations.
- A second run with the populated cache succeeded without a download.
- `.github/workflows/release.yml` was parsed and validated locally; the
  workflow itself was not executed on GitHub in this change.
- Install and uninstall behaviour is unchanged by this change.

## Known gaps

- Deno is optional and not bundled. It is located from the explicit
  `DONDOWNLOAD_DENO_PATH` override, app-local `vendor/deno/`, a previously
  downloaded copy under `<userData>/tools/deno/<version>/`, or `PATH`. For a
  YouTube page that needs a runtime and has none, the pinned release archive is
  downloaded once, SHA-256 verified against the checksum published in the same
  release, and installed atomically. The resolved path is passed as a fixed
  `--js-runtimes deno:<path>` argument; without one the arguments are identical
  to a machine without Deno. Unit tests cover the download, verification,
  single-flight and no-runtime paths with a mocked network. Rebuild the artifact
  after any source change before release.
- FFprobe is not staged and not invoked; the header read uses FFmpeg.
- The installer is not code-signed. Public distribution requires signing.
- No publish provider or telemetry is configured in `electron-builder.yml`
  (`publish: null`). The application updater reads GitHub Releases for
  `AVNNT/dondownload` and needs a signed `SHA256SUMS.txt`; the `Release`
  workflow drafts them when a `v*` tag is pushed and the maintainer publishes
  the draft manually.
- No installer icon/branding is supplied; electron-builder may use its default
  icon until branded assets are added.
- GPL corresponding-source archives are not downloaded or bundled by the build.
  `scripts/release.mjs` attaches archives from
  `%USERPROFILE%\.dondownload-release\sources\` when present and always writes
  `dist/THIRD-PARTY-SOURCES.txt`. A release owner must still complete the
  source-offer strategy before any redistribution.
- Browser native-host registration remains manual and is not performed by the
  installer.
- The installer build is self-contained (pinned, checksum-verified vendor
  archives), but the upstream tool binaries themselves are still not
  reproducible builds of their sources.
