# Bundled-tool licensing and provenance audit

Audit date: 2026-11-04. This is a release engineering inventory, not legal
advice, a compliance opinion, or authorization to redistribute the installer.

## Scope and verification

The checked build was produced from the local, version-pinned WinGet tool paths
through `scripts/stage-vendor.ps1`. The script checks each executable's reported
version, computes SHA-256, records its local path and hashes the bundled license
files. It does not download tools or independently authenticate their origin.
The observed `source.kind` for each binary was `verified-local-path`; no upstream
signature or reproducible-build attestation was verified in this audit.

The built installer was checked with Windows Authenticode inspection and is
**NotSigned**. Vendor executable hashes in the staged manifest matched the
payload in `dist/win-unpacked/resources/vendor/`. Every `licenseFiles` hash in
the staged manifest matched its repository file under `third-party/licenses/`.
The manifest and the executable hashes are build-specific; the staged binaries
are ignored and must not be committed.

## Binary inventory

| Binary | Version/build | License recorded by project | SHA-256 | Corresponding-source / notice status |
| --- | --- | --- | --- | --- |
| aria2 | 1.37.0 | GPL-2.0-or-later | `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2` | GPL text and OpenSSL license included. Exact Windows dependency/build inputs and complete corresponding source are not assembled. |
| yt-dlp standalone | 2026.10.26 | Unlicense plus bundled third-party components | `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d` | Unlicense and upstream aggregated `THIRD_PARTY_LICENSES.txt` included. Standalone build recipe/provenance archive is not assembled. |
| Gyan FFmpeg full build | 9.0.2, source commit `946fcce07b` | GPL-3.0-or-later per Gyan's full-build notice | `589e50b766d251afdf181dd664d40bd94407e200b019989fd7468c7d118a28d0` | GPL text and Gyan build README included. Exact source plus scripts/configuration and any required external assets are not archived as a release package. |
| Gyan ffprobe full build | 9.0.2, same build | GPL-3.0-or-later per Gyan's full-build notice | `02264dfa4f56baaa31e443ece8aa16d397f6b008200e7fd184d22b9009e75fd3` | Same source/build notice gap as FFmpeg. |
| Deno | 2.9.8 | MIT project license | `924397800533d3eb0ed0c889b20ad70e18b970d93acd8135bc043f425e528266` | Deno MIT text included. Human review should establish whether the redistributed executable's embedded third-party components require additional notices/source material beyond this file. |

The DonDownload application is MIT-licensed; that does not relicense these
separately bundled programs. Keep each binary's terms and notices visible in
the installed package and distribution materials.

## Corresponding-source and legal gates

Before distributing an installer containing the staged engines, the release
owner and counsel must determine and complete the obligations for the actual
distribution model. At minimum:

1. **aria2 and FFmpeg/ffprobe:** assemble the complete corresponding source for
   the exact shipped binaries, including applicable patches, build scripts,
   configuration, and covered linked components; or have counsel approve a
   valid written offer for that exact source. Upstream project source alone is
   not evidence that the Windows binaries can be rebuilt.
2. **Gyan full build:** preserve the exact Gyan build README/configuration and
   source commit used for 9.0.2; determine whether any separately distributed
   external assets and their licenses are implicated. Do not substitute the
   FFmpeg project license page for the build-specific notice.
3. **aria2 Windows executable:** identify the WinGet package recipe and full
   linked-library inventory for the exact executable, including the recorded
   OpenSSL notice and any other applicable notices/source obligations.
4. **yt-dlp standalone:** retain the exact upstream release source and the
   standalone packaging/build recipe; confirm that the shipped aggregated
   third-party license file matches the executable version and satisfies each
   bundled component's notice requirements.
5. **Deno executable:** inventory bundled third-party components and decide
   whether additional acknowledgements/source information must accompany the
   MIT license text.
6. Publish the notices, binary versions, source locations, and any written-offer
   process adjacent to the installer. Record source archive hashes in a
   release-specific manifest; do not imply the local binary SHA-256 is an
   upstream authenticity check.
7. Obtain human legal review for GPL combination/distribution questions, exact
   corresponding-source sufficiency, notices, source-offer wording and the
   intended installer/distribution model.

Current status: the repository contains readable notices and candidate upstream
source URLs, but it does **not** contain/publish complete corresponding-source
archives or a reviewed written offer. Redistribution clearance is therefore
**BLOCKED pending human/legal action**. No legal sufficiency is claimed.

## Installer and integration status

- NSIS configuration is per-user, assisted, `asInvoker`, non-elevating, and
  allows an explicit installation directory. It disables automatic launch after
  setup and preserves per-user application data on uninstall. Downloads are
  outside the installation directory and the uninstaller configuration does
  not remove them.
- The installer has **not** been executed. Windows Sandbox was not present in
  the available environment; checking the optional feature required elevation.
  No VM runner was found. Do not install on an existing user installation as a
  substitute.
- Native Messaging registration remains a manual current-user action using
  exact extension origins. The helper's print-only manifest/registration plan
  was inspected; no registry key or manifest file was written in this audit.
  Helium uses the Chromium-compatible Chrome current-user key based on prior
  local evidence. A fresh isolated install plus real Helium extension-to-host
  communication test remains blocked on an isolated Windows/browser environment.
- The installer is **unsigned**. No trusted/signed status is claimed. A
  production release requires an authorized signing certificate, signing and
  timestamping procedure, and verification on the final artifact.

## Authoritative references

- aria2 project and COPYING: <https://github.com/aria2/aria2> and
  <https://github.com/aria2/aria2/blob/master/COPYING>
- GNU GPL FAQ, including corresponding source: <https://www.gnu.org/licenses/gpl-faq.html>
- FFmpeg legal information: <https://www.ffmpeg.org/legal.html>
- Gyan Windows builds and build/source information: <https://www.gyan.dev/ffmpeg/builds/>
- yt-dlp project licensing and bundled notices:
  <https://github.com/yt-dlp/yt-dlp#licensing> and
  <https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt>
- Deno project license: <https://github.com/denoland/deno/blob/main/LICENSE.md>

These references are leads for release review and do not replace counsel's
review of the exact binaries and distribution.
