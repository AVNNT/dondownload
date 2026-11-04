# Windows installer packaging baseline

This document describes the first Windows installer packaging baseline for
DonDownload. It is intentionally independent of the settings runtime: no
settings contract, settings UI, schema migration or settings persistence is
required to stage, build or inspect the installer.

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
| FFmpeg | 9.0.2 Gyan full build | `resources/vendor/ffmpeg/ffmpeg.exe` |
| ffprobe | 9.0.2 Gyan full build | `resources/vendor/ffmpeg/ffprobe.exe` |
| Deno | 2.9.8 | `resources/vendor/deno/deno.exe` |

Deno is bundled because current yt-dlp YouTube extraction requires a
JavaScript runtime. The application's existing locators already search
`process.resourcesPath/vendor/...` for aria2, yt-dlp and FFmpeg. Deno runtime
wiring is a separate application change and is listed as a known gap below.

## Prerequisites

- Windows 10/11 x64.
- Node.js 24+ and npm 10+.
- The .NET Framework C# compiler (`csc.exe`) for the native messaging host. It
  ships with Windows; no .NET SDK, Visual Studio or NuGet package is required.
- Locally installed, pinned versions of the five tools. They are not installed
  or downloaded by this repository.

The staging script never runs `winget`, an installer, a package manager or a
network download. It only executes each candidate executable with a read-only
version flag and copies the verified file.

## Commands

```powershell
npm install
npm run stage:vendor      # stage and verify binaries into build/vendor
npm run build:installer   # native host + stage + app build + NSIS x64 installer
```

If npm's `allow-scripts` policy skips Electron's postinstall step, run
`node node_modules/electron/install.js` once before building. That step only
installs the already-declared Electron development dependency.

`build:installer` runs the existing `build:native-host` script, then
`stage:vendor`, then the existing `build` script (typecheck plus electron-vite
production build), then electron-builder for the NSIS x64 target. No other
package scripts are added by this baseline.

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
    ffmpeg/ffprobe.exe
    deno/deno.exe
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
- Gyan FFmpeg/ffprobe full build: GPL-3.0-or-later.
- Deno: MIT.

Read [../third-party/NOTICE.md](../third-party/NOTICE.md) for the per-tool
inventory, license files, source versions and the source-offer strategy. This
document and the notice file are not legal advice and do not claim legal
sufficiency.

A redistributable release must publish the complete corresponding source for
the GPL-covered binaries (or provide a valid written offer), together with the
license texts and build information. The local build described here does not
include those source archives; it is a build-verification artifact.

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

## Known gaps

- Deno is located from the explicit `DONDOWNLOAD_DENO_PATH` override, packaged
  `resources/vendor/deno/`, app-local `vendor/deno/`, or `PATH`. The resolved
  path is passed as a fixed `--js-runtimes deno:<path>` argument to yt-dlp
  analysis, playlist preview and media-download operations. Unit tests cover
  the wiring; the baseline artifact predates this change and must be rebuilt
  before release review.
- ffprobe is staged but not invoked by the current application.
- The installer is not code-signed. Public distribution requires signing.
- No auto-update, publish provider or telemetry is configured.
- No installer icon/branding is supplied; electron-builder may use its default
  icon until branded assets are added.
- GPL corresponding-source archives are not bundled or published by this
  baseline. A release owner must complete the source-offer strategy before any
  redistribution.
- Browser native-host registration remains manual and is not performed by the
  installer.
- The local artifact is built from locally installed tools; it is not a
  reproducible build of the upstream tool binaries themselves.
