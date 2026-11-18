# Third-party notices for staged Windows binaries

This file is a readable inventory of the third-party programs that the
DonDownload installer baseline can stage into `resources/vendor/`. It is not
legal advice and it is not a legal conclusion that a particular distribution is
compliant. DonDownload's own source is licensed under MIT (see `LICENSE`); that
license does not replace or override the terms of any bundled third-party
binary.

The application does not download these tools at runtime, with two documented
exceptions that write only below the user data directory: the managed yt-dlp
updater, and the on-demand Deno runtime for YouTube JS challenges. FFprobe is no
longer staged or invoked at all; the bounded header read that labels an
unlabeled stream uses FFmpeg itself. The staging script resolves each executable
from a local installation or cache when one exists, otherwise it downloads the
pinned official upstream release archive and verifies its hard-coded SHA-256
before extraction, then copies only the version-checked executable into the
git-ignored `build/vendor/` directory; for yt-dlp it stages the official
one-folder release archive (`yt-dlp.exe` plus `_internal/`). The installer then
includes that directory as `resources/vendor/`.

## Inventory

| Tool | Pinned version | Staged path | License | Upstream | Corresponding source archive |
| --- | --- | --- | --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | `vendor/aria2/aria2c.exe` | GPL-2.0-or-later | <https://aria2.github.io/> | <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2> |
| yt-dlp (`yt-dlp.exe` plus `_internal/`) | 2026.10.26 | `vendor/yt-dlp/` (official one-folder build) | Unlicense, plus bundled third-party licenses | <https://github.com/yt-dlp/yt-dlp> | <https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz> |
| FFmpeg (`ffmpeg.exe`) | 9.0.2 Gyan essentials build | `vendor/ffmpeg/ffmpeg.exe` | GPL-3.0-or-later | <https://ffmpeg.org/> | <https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz> |
| Deno (`deno.exe`) | 2.9.8 | not bundled; downloaded on demand into `<userData>/tools/deno/2.9.8/deno.exe` | MIT | <https://github.com/denoland/deno> | <https://github.com/denoland/deno/archive/refs/tags/v2.9.8.tar.gz> |

The exact staged hashes, sizes, source paths and license-file hashes are
recorded in `build/vendor/manifest.json` by `scripts/stage-vendor.ps1`. This
manifest records the files staged from local verified-version paths or from the
pinned upstream release archives; it does not authenticate the upstream origin
beyond the pinned SHA-256 or prove a reproducible build.

## Pinned binary download sources

When no local copy or cache is available, the staging script downloads only
these official upstream release assets. Each SHA-256 is hard-coded in
`scripts/stage-vendor.ps1` and checked before extraction.

| Tool | Pinned upstream release asset | SHA-256 |
| --- | --- | --- |
| aria2 1.37.0 | <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip> | `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288` |
| yt-dlp 2026.10.26 | <https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_win.zip> | `fd51b212cf8380c7a52ee08c0d6be7f3c59b2f2c832eaf7b45acfae6eab57419` |
| FFmpeg 9.0.2 Gyan essentials build | <https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip> | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` |

The FFmpeg asset is byte-identical to the gyan.dev package
<https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip>;
the GitHub mirror is pinned because it is the stable URL for CI.

## aria2

- License: GPL-2.0-or-later. The GPLv2 text and the OpenSSL license shipped with
  the local WinGet package are included in
  `third-party/licenses/aria2-COPYING.txt` and
  `third-party/licenses/aria2-LICENSE.OpenSSL.txt`.
- The Windows executable is extracted from the official aria2 1.37.0 win-64bit
  release asset
  <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip>
  (SHA-256 `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288`)
  when no verified local copy exists. The build may include additional
  libraries from its MinGW build environment. A distributor must verify the
  complete dependency list for the exact binary and provide the complete
  corresponding source for that binary, not only the aria2 project source.
- aria2 is used as a separate subprocess over loopback JSON-RPC. Do not describe
  the combined installer as MIT-only.

## yt-dlp

- License: Unlicense. The text is included in
  `third-party/licenses/yt-dlp-UNLICENSE.txt`.
- The official Windows one-folder build (`yt-dlp.exe` plus `_internal/`) bundles
  Python and other third-party components, just like the older one-file
  `yt-dlp.exe`. The upstream aggregated notice file for the pinned release is
  included in `third-party/licenses/yt-dlp-THIRD_PARTY_LICENSES.txt`. The
  executables and runtime files must not be redistributed with the Unlicense
  text alone.
- Source archive: the upstream source tarball above. A distributor should also
  archive the build recipe used to produce the standalone executable, or provide
  a written offer that covers it.

## FFmpeg (Gyan essentials build)

- License: GPL-3.0-or-later. The GPLv3 text and the Gyan build README are
  included in `third-party/licenses/ffmpeg-GPLv3.txt` and
  `third-party/licenses/ffmpeg-GYAN-ESSENTIALS-BUILD-README.txt`.
- The Gyan build README identifies the exact FFmpeg source commit
  (`946fcce07b`) and the build configuration. The essentials build
  enables GPL-covered components; it is not an LGPL build.
- The shipped executable is extracted from the pinned GyanD/codexffmpeg 9.0.2
  essentials release asset
  <https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip>
  (SHA-256 `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`),
  which is byte-identical to
  <https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip>.
- A distributor must provide the complete corresponding source for the exact
  binary, including the build scripts and configuration needed to reproduce it,
  plus the GPLv3 notice. Verify whether any external assets listed in the Gyan
  README are actually bundled before making a distribution claim.
- `ffprobe.exe` is not staged and not invoked. The bounded header read that
  labels a stream without reported dimensions runs `ffmpeg -i <url>` and parses
  the stream table FFmpeg prints on stderr, so the probe executable and its
  ~100 MB of installer payload are gone.

## Deno

- License: MIT. The upstream license text is included in
  `third-party/licenses/deno-LICENSE.txt`; retain the copyright and permission
  notice when redistributing the executable.
- Deno is not bundled. Current yt-dlp YouTube extraction needs a JavaScript
  runtime, so the application downloads the pinned `deno-x86_64-pc-windows-msvc`
  release archive into `<userData>/tools/deno/<version>/` the first time a
  YouTube job needs it, verifies its SHA-256 against the checksum published in
  the same pinned release, and passes the path to yt-dlp. The MIT text is
  included in `third-party/licenses/deno-LICENSE.txt` and ships in the installer
  so the notice travels with the downloaded runtime; release review should
  confirm whether the standalone executable's embedded dependencies need other
  notices.
- Source archive: the upstream source tarball above.

## Source-offer strategy for GPL binaries

Redistributing the GPL-covered aria2 and FFmpeg binaries requires more
than shipping a license text. Before any public or customer distribution, the
release owner must complete all of the following:

1. Archive the **complete corresponding source** for each GPL binary at the
   exact version and build identified by the staged binary's SHA-256. For
   FFmpeg that includes the exact source commit and the Gyan build scripts and
   configuration; for aria2 it includes the exact release source and the
   Windows/MinGW build inputs.
2. Publish those source archives at a stable location alongside the installer,
   or provide a written offer valid for at least three years to supply the
   corresponding source. A link to the upstream project alone is not a
   substitute for the offer.
3. Include the applicable license texts, this notice file, and the build
   information in the installed application and in the distribution page.
4. Record the source-archive URL and checksum in the release manifest and keep
   it aligned with the binary manifest.
5. Obtain a legal review of the actual distribution model. This file does not
   claim that any particular distribution is legally sufficient.

The local packaging verification in this repository does **not** include the
source archives. A locally produced installer is a build-verification artifact,
not by itself a cleared redistributable release.

## Release checklist

- [ ] `npm run stage:vendor` passes with the pinned versions.
- [ ] `build/vendor/manifest.json` hashes match the files in the installer.
- [ ] All files under `third-party/licenses/` are present in
      `resources/licenses/`.
- [ ] GPL corresponding-source archives are published or a written offer is in
      place before distribution.
- [ ] The distribution page names the exact binary versions and source URLs.
- [ ] Legal review is complete for the actual distribution model.
- [ ] The installer is code-signed if it will be distributed publicly.
