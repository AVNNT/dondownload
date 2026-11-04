# Third-party notices for staged Windows binaries

This file is a readable inventory of the third-party programs that the
DonDownload installer baseline can stage into `resources/vendor/`. It is not
legal advice and it is not a legal conclusion that a particular distribution is
compliant. DonDownload's own source is licensed under MIT (see `LICENSE`); that
license does not replace or override the terms of any bundled third-party
binary.

The application does not download these tools at runtime. The staging script
copies locally installed, version-checked executables into the git-ignored
`build/vendor/` directory. The installer then includes that directory as
`resources/vendor/`.

## Inventory

| Tool | Pinned version | Staged path | License | Upstream | Corresponding source archive |
| --- | --- | --- | --- | --- | --- |
| aria2 (`aria2c.exe`) | 1.37.0 | `vendor/aria2/aria2c.exe` | GPL-2.0-or-later | <https://aria2.github.io/> | <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2> |
| yt-dlp (`yt-dlp.exe`) | 2026.10.26 | `vendor/yt-dlp/yt-dlp.exe` | Unlicense, plus bundled third-party licenses | <https://github.com/yt-dlp/yt-dlp> | <https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz> |
| FFmpeg (`ffmpeg.exe`) | 9.0.2 Gyan full build | `vendor/ffmpeg/ffmpeg.exe` | GPL-3.0-or-later | <https://ffmpeg.org/> | <https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz> |
| ffprobe (`ffprobe.exe`) | 9.0.2 Gyan full build | `vendor/ffmpeg/ffprobe.exe` | GPL-3.0-or-later | <https://ffmpeg.org/> | <https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz> |
| Deno (`deno.exe`) | 2.9.8 | `vendor/deno/deno.exe` | MIT | <https://github.com/denoland/deno> | <https://github.com/denoland/deno/archive/refs/tags/v2.9.8.tar.gz> |

The exact staged hashes, sizes, local source paths and license-file hashes are
recorded in `build/vendor/manifest.json` by `scripts/stage-vendor.ps1`.

## aria2

- License: GPL-2.0-or-later. The GPLv2 text and the OpenSSL license shipped with
  the local WinGet package are included in
  `third-party/licenses/aria2-COPYING.txt` and
  `third-party/licenses/aria2-LICENSE.OpenSSL.txt`.
- The Windows build may include additional libraries from its MinGW build
  environment. A distributor must verify the complete dependency list for the
  exact binary and provide the complete corresponding source for that binary,
  not only the aria2 project source.
- aria2 is used as a separate subprocess over loopback JSON-RPC. Do not describe
  the combined installer as MIT-only.

## yt-dlp

- License: Unlicense. The text is included in
  `third-party/licenses/yt-dlp-UNLICENSE.txt`.
- The standalone Windows `yt-dlp.exe` bundles Python and other third-party
  components. The upstream aggregated notice file for the pinned release is
  included in `third-party/licenses/yt-dlp-THIRD_PARTY_LICENSES.txt`. The
  executable must not be redistributed with the Unlicense text alone.
- Source archive: the upstream source tarball above. A distributor should also
  archive the build recipe used to produce the standalone executable, or provide
  a written offer that covers it.

## FFmpeg and ffprobe (Gyan full build)

- License: GPL-3.0-or-later. The GPLv3 text and the Gyan build README are
  included in `third-party/licenses/ffmpeg-GPLv3.txt` and
  `third-party/licenses/ffmpeg-GYAN-BUILD-README.txt`.
- The Gyan build README identifies the exact FFmpeg source commit
  (`946fcce07b`), the build configuration and external assets. The full build
  enables GPL-covered components; it is not an LGPL build.
- A distributor must provide the complete corresponding source for the exact
  binary, including the build scripts and configuration needed to reproduce it,
  plus the GPLv3 notice. Verify whether any external assets listed in the Gyan
  README are actually bundled before making a distribution claim.
- `ffprobe.exe` is staged for completeness and diagnostics. The current
  application does not invoke it at runtime.

## Deno

- License: MIT. The upstream license text is included in
  `third-party/licenses/deno-LICENSE.txt`; retain the copyright and permission
  notice when redistributing the executable.
- Deno is staged because current yt-dlp YouTube extraction requires a
  JavaScript runtime. The current application does not yet pass the bundled
  Deno path to yt-dlp; see `docs/installer-packaging.md` for that known gap.
- Source archive: the upstream source tarball above.

## Source-offer strategy for GPL binaries

Redistributing the GPL-covered aria2 and FFmpeg/ffprobe binaries requires more
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
