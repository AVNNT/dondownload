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
documented in [media-tools.md](media-tools.md):

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
- Node.js 24+ and npm 10+.
- The .NET Framework C# compiler (`csc.exe`) for the native messaging host. It
  ships with Windows; no .NET SDK, Visual Studio or NuGet package is required.
- Locally installed, pinned versions of aria2, yt-dlp and FFmpeg. They are not
  installed or downloaded by this repository.

The staging script never runs `winget`, an installer, a package manager or a
network download. It only executes each candidate executable with a read-only
version flag and copies the verified file.

## Commands

```powershell
npm ci --include=dev      # restore the exact locked build toolchain
npm run stage:vendor      # stage and verify binaries into build/vendor
npm run build:installer   # native host + stage + app build + NSIS x64 installer
```

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

- Resolves each tool from an explicit environment override first:
  `DONDOWNLOAD_ARIA2_PATH`, `DONDOWNLOAD_YTDLP_PATH`,
  `DONDOWNLOAD_FFMPEG_PATH`, `DONDOWNLOAD_FFPROBE_PATH` and
  `DONDOWNLOAD_DENO_PATH`.
- Otherwise uses the documented local installation path, then a `PATH` lookup.
- Executes the candidate with `--version` or `-version` and requires an exact
  version match with the pinned version.
- Refuses to continue when a tool is missing, a version differs, a license or
  notice file is missing, or the staging directory is outside the repository's
  ignored `build/` directory.
- Deletes and recreates `build/vendor/` so stale executables cannot leak into a
  build.
- Copies only executables. No installers, archives, caches or source trees are
  copied.
- Writes `build/vendor/manifest.json` with, per tool: name, executable, staged
  path, version, expected version, SHA-256, size, source kind/path/origin,
  license, license-file hashes, upstream URL, source version, source archive and
  notice text.

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
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dondownload.bridge` or
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dondownload.bridge`, and
it does not write a Helium-specific key.

The included helper is the existing `scripts/register-native-host.ps1`, copied
to `resources/registration/register-native-host.ps1`. It writes only under
`HKCU` and only the exact `chrome-extension://<32-character-id>/` origins passed
by the user. Helium is supported through the same verified
Chromium-compatible Chrome current-user key used by the existing registration
script; no Helium-specific key is written. Do not include a wildcard origin and
do not auto-register during install.

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
The source is deliberately opt-in: `src/shared/release.ts` exports
`UPDATE_REPO`, and while it is `null` every update surface shows
"Update source not configured" and no network request is made. Set it to a
validated `{ owner, repo }` only when the repository and release assets are
public.

Updates are authenticated as well as integrity-checked. Every release must
include a raw 64-byte Ed25519 signature over the exact bytes of
`SHA256SUMS.txt`, base64 encoded as `SHA256SUMS.txt.sig`. The matching public
key goes in `UPDATE_SIGNING_PUBLIC_KEY` as an SPKI PEM or its base64 SPKI DER.
If `UPDATE_REPO` is set while the public key is `null`, the checker makes no
request and reports **"Update signing key not configured"**.

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

1. Bump `version` in `package.json`.
2. Build the installer:

   ```powershell
   npm run build:installer
   ```

3. Generate an Ed25519 update signing key pair outside this repository, once,
   and keep the private key secret:

   ```powershell
   node scripts/generate-update-signing-key.mjs C:\secure\dondownload-update-key.pem
   ```

   The script refuses paths inside the repository. It prints the public key as
   base64 SPKI DER; paste that into `UPDATE_SIGNING_PUBLIC_KEY` in
   `src/shared/release.ts`. Never commit the private key.

4. Generate the checksum file for every `dist/DonDownload-*-setup.exe` and sign
   it in the same step:

   ```powershell
   $env:DONDOWNLOAD_UPDATE_SIGNING_KEY = 'C:\secure\dondownload-update-key.pem'
   npm run release:checksums
   ```

   This writes `dist/SHA256SUMS.txt` in `<sha256>  <filename>` format and
   `dist/SHA256SUMS.txt.sig` (base64 of the raw 64-byte Ed25519 signature over
   the exact `SHA256SUMS.txt` bytes). Without the environment variable the
   checksum file is written unsigned and a warning explains that the release
   cannot be served as an automatic update.

5. Create a GitHub release whose tag matches the app version (`vX.Y.Z` or
   `X.Y.Z`) and upload all three:
   - `dist/DonDownload-<version>-x64-setup.exe`
   - `dist/SHA256SUMS.txt`
   - `dist/SHA256SUMS.txt.sig`

6. Point `UPDATE_REPO` at that public repository. The installed app checks it
   on the next startup at most once per 24 hours.

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
- No auto-update, publish provider or telemetry is configured. The application
  updater exists but stays inert while `UPDATE_REPO` is `null`.
- No installer icon/branding is supplied; electron-builder may use its default
  icon until branded assets are added.
- GPL corresponding-source archives are not bundled or published by this
  baseline. A release owner must complete the source-offer strategy before any
  redistribution.
- Browser native-host registration remains manual and is not performed by the
  installer.
- The local artifact is built from locally installed tools; it is not a
  reproducible build of the upstream tool binaries themselves.
