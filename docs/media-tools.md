# Media tools: versions, install sources and licensing

This page records the external tools used by the Milestone 3A media path on the
local development machine. It separates **local machine setup** from **product
redistribution**. It is a factual note, not legal advice.

## Local verification setup (2026-11-04)

These tools are installed on the development machine, not stored in this
repository or produced by its build.

| Tool | Verified version | Install source | Exact local path |
| --- | --- | --- | --- |
| yt-dlp | `2026.10.26` | WinGet package `yt-dlp.yt-dlp` (publisher `yt-dlp`) | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe` |
| FFmpeg | `9.0.2-full_build` (Gyan) | WinGet package `Gyan.FFmpeg` (full build) | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe` |
| ffprobe | `9.0.2-full_build` (Gyan) | same Gyan package | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffprobe.exe` |
| Deno | `2.9.8` (stable, `x86_64-pc-windows-msvc`) | WinGet package `DenoLand.Deno`, user-scoped | `C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe\deno.exe` |

Equivalent install commands:

```powershell
winget install --id yt-dlp.yt-dlp -e
winget install --id Gyan.FFmpeg -e
winget install --id DenoLand.Deno -e
```

The Gyan page maps `winget install ffmpeg` to the release **full** build; the
package used here is `Gyan.FFmpeg`, whose installed folder is
`ffmpeg-9.0.2-full_build`. Deno was installed for the current user, so its
package directory is user-scoped rather than machine-wide.

## How DonDownload uses these tools

- **yt-dlp** performs media analysis and downloads. DonDownload locates it via
  `DONDOWNLOAD_YTDLP_PATH`, `<app>\vendor\yt-dlp\`, `<app>\vendor\bin\`, then
  `PATH`.
- **FFmpeg** is required only for options whose separate video and audio streams
  must be merged. The verified engine passes the located executable to yt-dlp
  with `--ffmpeg-location`. It is located via `DONDOWNLOAD_FFMPEG_PATH`,
  `<app>\vendor\ffmpeg\`, `<app>\vendor\ffmpeg\bin\`, `<app>\vendor\bin\`, then
  `PATH`.
- **ffprobe** is not invoked by the application at runtime. It was used by the
  verification checks to inspect outputs and confirm a full decode.
- **Deno** is a JavaScript runtime used by yt-dlp for extraction on sites that
  require it. DonDownload locates an explicit `DONDOWNLOAD_DENO_PATH`, a
  packaged/app-local vendor copy, or a copy on `PATH`, and passes the located
  path to yt-dlp. It does not install or update Deno.
- DonDownload never modifies its bundled vendor copies after installation. The
  Windows installer packaging baseline can include locally staged vendor
  copies; see [installer-packaging.md](installer-packaging.md).
- yt-dlp is the one exception that can be updated at runtime, because YouTube
  extractor changes regularly break older releases. See the next section.

## Runtime yt-dlp updates (verified managed copy)

The bundled `resources/vendor/yt-dlp/yt-dlp.exe` is read-only to the app. When
yt-dlp releases a newer version, DonDownload may place it at:

```text
<userData>/tools/yt-dlp/<version>/yt-dlp.exe
```

Resolution order per media job is:

1. an explicit `DONDOWNLOAD_YTDLP_PATH` override;
2. the newest managed version that is newer than the bundled version;
3. the bundled vendor copy;
4. `PATH`.

Because the locator resolves once per job, an update never replaces the
executable of a running download. If a media job is active, a verified update
is held and activated after the job settles.

The updater reads
`https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest` with a
`DonDownload/<app version>` user agent and no credentials. It only follows HTTPS
redirects on `github.com`, `api.github.com`, `objects.githubusercontent.com`
and `release-assets.githubusercontent.com`. It downloads `yt-dlp.exe` plus
`SHA2-256SUMS`, enforces a 50 MB size cap, verifies the exact SHA-256, writes a
temporary file, runs the new binary with `--version` (15 s timeout) and requires
the expected release tag before an atomic rename activates it. Any failure
keeps the current binary and reports a safe error.

The automatic check runs at most once every 24 hours in the background and is
controlled by **Keep yt-dlp up to date automatically** in Settings (default
on). Manual checks are available from the same page. Smoke-test mode disables
the automatic check entirely. At most two managed versions are retained; older
ones are deleted only inside `<userData>/tools/yt-dlp`.

## Licensing

### yt-dlp

yt-dlp itself is released under the **Unlicense** (public-domain dedication):
<https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE> and
<https://unlicense.org/>.

The standalone Windows `yt-dlp.exe` bundles Python and other third-party
components. Their licenses, including PSF, OpenSSL, SQLite, bzip2, libffi,
liblzma and zlib terms, are aggregated in
`THIRD_PARTY_LICENSES.txt`:
<https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt>.
Redistributing the executable therefore requires the Unlicense text plus the
applicable third-party notices, not just the Unlicense alone.

### FFmpeg (Gyan full build)

FFmpeg is a separate project: <https://ffmpeg.org/> and
<https://ffmpeg.org/legal.html>.

Gyan's build page states that all of its builds are **GPLv3**, and that its
release full build is GPLv3 rather than LGPL:
<https://www.gyan.dev/ffmpeg/builds/>. This matters because the full build
enables GPL-covered components. A GPLv3 redistribution carries source
availability, license-text and notice obligations; the exact obligations depend
on how the binaries are distributed.

### Deno

Deno is released under the **MIT License**:
<https://github.com/denoland/deno/blob/main/LICENSE.md>. Redistribution requires
retaining the copyright and permission notice.

### DonDownload

DonDownload's own source is MIT-licensed (see `LICENSE`). That license does not
replace or override the terms of any third-party binary that is redistributed
with it.

## Local setup versus redistribution

- Installing yt-dlp, FFmpeg, ffprobe or Deno on a development machine does not,
  by itself, distribute those tools through DonDownload. The current repository
  and build output contain no such binaries, and the app does not fetch them.
- If DonDownload ever bundles or ships these binaries, the distributor must
  comply with the applicable license, source-offer, notice and attribution
  obligations. For the Gyan GPLv3 build that includes the GPLv3 requirements;
  for the yt-dlp executable it includes the Unlicense and bundled third-party
  notices; for Deno it includes the MIT notice.
- Because the obligations depend on the distribution model and build contents,
  perform a legal review before any redistribution. This page is not a
  substitute for that review.

## Official sources

- yt-dlp project: <https://github.com/yt-dlp/yt-dlp>
- WinGet documentation: <https://learn.microsoft.com/windows/package-manager/winget/>
- WinGet manifest, yt-dlp: <https://github.com/microsoft/winget-pkgs/tree/master/manifests/y/yt-dlp/yt-dlp>
- WinGet manifest, Gyan FFmpeg: <https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Gyan/FFmpeg>
- WinGet manifest, Deno: <https://github.com/microsoft/winget-pkgs/tree/master/manifests/d/DenoLand/Deno>
- Gyan FFmpeg builds and licensing: <https://www.gyan.dev/ffmpeg/builds/>
- FFmpeg legal information: <https://ffmpeg.org/legal.html>
- Deno project: <https://github.com/denoland/deno>
