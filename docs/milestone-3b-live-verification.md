# Milestone 3B live verification (2026-11-04)

Baseline: `37de120` (`docs: record current settings and release status`).
Scope: bounded, opt-in live checks only. This document does not reopen
Milestone 3A and does not change `docs/development-status.md`.

Result summary:

| Subcheck | Result |
| --- | --- |
| Pixeldrain public list fixture selection | **BLOCKED** |
| Pixeldrain list preview | **BLOCKED** |
| Pixeldrain explicitly selected file download | **BLOCKED** |
| Blender Open Movies playlist preview | **PASS** |
| Exactly one explicit playlist entry selection | **PASS** |
| Pre-transfer duration/size bound | **PASS** |
| One selected media download through `MediaEngine`/`MediaJobsManager` | **PASS** |
| Size and SHA-256 verification | **PASS** (no upstream media checksum exists) |
| Full decode of the downloaded media | **PASS** |
| Deterministic media/temp cleanup | **PASS** |
| Gofile provider support | **NOT SUPPORTED** (browser fallback only) |

No result here claims a second playlist entry, a whole-playlist download, a
second provider, or Gofile automation.

## Environment

- Windows, Node `v24.19.0`, npm `11.17.0`.
- aria2 `1.37.0` (available, but not used by the playlist media path).
- yt-dlp `2026.10.26`, FFmpeg `9.0.2`, Deno `2.9.8`, all supplied through
  explicit `DONDOWNLOAD_*_PATH` variables from the local vendored build.
- No API key, account login, cookie store, browser profile, proxy, CAPTCHA
  solver or rate-limit workaround was used.

## Pixeldrain list: BLOCKED

The list portion was not run because no reliable, public, lawfully reusable
list fixture was established. The precise constraints are:

- The repository has a pinned public single-file Pixeldrain fixture
  (`VFjemoqC`), but no list fixture. A list cannot be created for this check
  without a Pixeldrain API key, and anonymous upload/list creation is not
  supported by the provider.
- The list example in the public Pixeldrain API documentation (`L8bhwx`)
  returned HTTP 404 when queried on 2026-11-04. It is documentation, not a
  usable fixture.
- A public list found incidentally while searching (`cKHnLWP7`) resolves, but it
  contains one 315,234,265-byte ZIP named `TATSUMAKI.zip` with no verifiable
  content or license metadata. It was not treated as a lawful fixture, was not
  downloaded, and is not used by any test.
- Enumerating or guessing other users' public or private lists is out of scope
  and was not attempted. A list is not "public" merely because its metadata can
  be read; the selected file must also have a verifiable public license and a
  bounded identity.

Consequently both **Pixeldrain list preview** and **Pixeldrain selected-file
download** are blocked on fixture availability, not on adapter behavior. The
existing `tests/pixeldrain.live.integration.test.ts` still covers only the
pinned public single-file path; it is not evidence for list preview or list
selection and was not rerun for this report.

To unblock this subcheck, provide a public Pixeldrain list URL whose contents are
known to be lawfully redistributable and small enough to bound, plus pinned
entry identity (name, size, SHA-256) for exactly one selected file. The same
opt-in rules below would then apply.

## Blender playlist preview: PASS

Fixture:
`https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz`

One real `MediaEngine.analyzeCollection` call returned the official
**Blender Open Movies** playlist with **18 entries** (18 available). The public
preview contained no page URL, video ID or provider selector. This is a
metadata-only flat listing; it does not download media.

## Explicit selection and pre-transfer bound: PASS

Exactly one entry was selected by pinned identity:

| Field | Pinned value |
| --- | --- |
| Playlist position | `13` |
| Title | `"Caminandes 2: Gran Dillama" - Blender Animated Short` |
| Duration (playlist metadata) | `147` seconds |
| Public video ID (internal test assertion only) | `Z4C82eyhwgU` |
| License basis | Blender Open Movie, publicly published as CC-BY |

`MediaEngine.resolveCollectionEntries` was called once with only that opaque
entry ID. It returned one target with the pinned title, position, duration and
video ID. No playlist-wide selection or auto-queue occurred.

Before `queueMedia`, a read-only fixed-argument yt-dlp metadata probe checked the
selected entry again. It required:

- duration at most `180` seconds;
- at least one muxed HTTP format with a positive `filesize`/`filesize_approx`;
- the smallest such estimate at most `25 MiB`.

The smallest muxed estimate was **8,827,849 bytes** (360p MP4). The test asserts
the exact container (`mp4`) and height (`360`) in the fresh `MediaAnalysis`
before queueing. If the estimate is missing, the entry changes, or the estimate
exceeds the bound, the test fails before any download starts. A progress guard
also cancels the job if actual bytes cross the 25 MiB bound.

## Selected download through `MediaEngine`/`MediaJobsManager`: PASS

One `MediaJobsManager.analyzeMedia` call and exactly one
`MediaJobsManager.queueMedia` call were made for that entry and the muxed 360p
MP4 option. No merge was required. The job reached `complete`; no second queue,
retry or playlist item was created.

Verification performed by the test:

- output directory was the unique approved temp root, not user Downloads;
- exactly one output file existed, with no `.part` or `.ytdl` residue;
- actual size was greater than zero and at most 25 MiB;
- `completedBytes` and `totalBytes` equalled the on-disk size;
- SHA-256 was computed over the whole file and validated as a 64-character
  hexadecimal digest (YouTube publishes no upstream checksum to compare
  against);
- FFmpeg decoded the whole file with both the first video and first audio
  stream mapped, exit code `0`.

The exact downloaded byte count and digest were not persisted after the run
because the live fixture and all artifacts are intentionally deleted. The
assertions above are the evidence; no checksum is claimed as a reusable
fixture identity.

## Cleanup: PASS

The test used `%TEMP%\opencode\milestone-3b-playlist-download-*`, a unique
`mkdtemp` directory under the approved temp base. It closed the manager, stopped
the engine, removed the media file and the whole temp root, and ran the same
removal from `afterAll` as a failure-safe fallback. A post-run check of
`%TEMP%\opencode` showed no remaining `milestone-3b-playlist-download-*`
directory and no downloaded media.

## Commands

Hermetic checks:

```powershell
npm run typecheck
npm run test:fast
```

Results on 2026-11-04:

- `npm run typecheck`: passed (node and web projects).
- `npm run test:fast`: **31 files, 467 tests passed**.

Opt-in live check (run once, no retry loop):

```powershell
$env:DONDOWNLOAD_LIVE_PLAYLIST_DOWNLOAD = '1'
$env:DONDOWNLOAD_YTDLP_PATH = '<path>\yt-dlp.exe'
$env:DONDOWNLOAD_FFMPEG_PATH = '<path>\ffmpeg.exe'
$env:DONDOWNLOAD_DENO_PATH = '<path>\deno.exe' # optional, used when present
npm run test:playlist-download:live
```

Result: **1 file, 1 test passed** in 18.47 s.

The existing preview-only check remains available separately:

```powershell
$env:DONDOWNLOAD_LIVE_PLAYLIST = '1'
$env:DONDOWNLOAD_YTDLP_PATH = '<path>\yt-dlp.exe'
npm run test:playlist:live
```

It was not rerun for this report; the new check performs the preview, selection
and one explicit download in the same run.

## Gofile and browser fallback

Gofile remains **not supported**. There is no Gofile resolver, transfer path,
opt-in live test or provider claim in this work. Do not infer Gofile support
from the playlist or Pixeldrain results.

If a provider or item cannot be handled without authentication, cookies, a
browser profile, CAPTCHA solving, DRM removal or rate-limit evasion, use the
browser to download it manually. DonDownload does not automate those flows and
this verification does not attempt them.
