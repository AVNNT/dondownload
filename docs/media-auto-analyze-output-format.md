# Media auto-analysis and output-format workflow

Status: implementation note for the focused media workflow change. No installer
was rebuilt, nothing was pushed, and no Electron/Helium window was launched.

> Superseded for the browser overlay only: the progressive-playback checkpoint
> in [media-capture-progressive.md](media-capture-progressive.md) stopped
> automatic yt-dlp analysis on panel open. The desktop Media tab still analyzes
> complete URLs automatically, and the overlay keeps an explicit
> `Analyze page with yt-dlp (fallback)` action.

## Root causes found in the existing code

- **Manual analysis in both UIs.** `MediaAnalyzer.tsx` was a submit form with a
  dedicated Analyze button. The extension overlay only sent
  `dondownload:media-analyze` from its Analyze button (`analyzePage`), so simply
  opening the capture panel never started analysis.
- **Hard-coded 1080p quality ceiling.** Both
  `src/renderer/src/components/MediaAnalyzer.tsx` and
  `extension/overlay.js` built their compact lists from the literal array
  `[1080, 720, 480, 360]`. A verified 1440p/2160p option existed in the analysis
  but had no visible row, and the default best option could be unselected
  visually.
- **Not a general field-drop in the UI/bridge.** The code already carried
  `filesize`/`filesize_approx` into the option DTO and displayed those values.
  The common unknown case was source metadata with neither field populated:
  the option builder stopped at unknown despite available `tbr`/`vbr`/`abr`
  and duration. Merged pairs also lacked a safe estimate when either stream
  omitted its size. The genuine yt-dlp metadata sample returned exact and
  approximate values for some formats, but this cannot be assumed for every
  quality or extractor.
- **No output-format model.** Options carried only an internal fixed
  `mergeOutputFormat`/`outputExt`, the public option DTO had no compatible
  container list, the queue input had no format, and the native-host validator
  accepted only `analysisId`/`optionId`/`force`. Changing container would have
  required either a silent substitution or transcoding.

## Implementation

- Added a pure, debounced renderer controller
  (`src/renderer/src/mediaAutoAnalyze.ts`). Complete http(s) URLs are analyzed
  after 450 ms, the same normalized URL is never queued twice, any URL change
  invalidates an older in-flight response, and the controller has no queue
  action. Invalid input is never sent. Failures and playlist errors stay in the
  normal error surface.
- The desktop Media tab no longer renders an Analyze button. The extension
  analyzes exactly once when the capture panel is explicitly opened (click,
  keyboard shortcut), never on page load, injection or hover. Reopening an
  already analyzed panel does not issue a duplicate request.
- Size selection is now exact `filesize` -> `filesize_approx` -> safe
  `bitrate x duration` estimate (yt-dlp bitrate fields are kbps and are
  converted to bits/sec). Exact single-stream values stay in `filesizeBytes`;
  estimates appear in `estimatedBytes`. A merged total is unknown unless both
  selected streams have a usable size, and any merged sum remains labelled as
  an estimate. The selected output/container's exact stream pairing determines
  the displayed and queued total.
- Added `outputFormats` to each verified option. The server computes actual
  video/audio format-ID pairs for Auto/MP4/MKV/WebM (for example an MP4 audio
  stream is paired with an H.264 video stream instead of claiming an
  incompatible Opus pairing). The queue input, shared/native-bridge parsers and
  C# native host carry an optional `outputFormat`.
- Explicit formats use FFmpeg only for remux/merge (`--remux-video` or
  `--merge-output-format`). Incompatible formats are omitted/disabled and the
  manager rejects them with `MEDIA_OUTPUT_FORMAT_UNSUPPORTED`; there is no
  fallback container, no silent quality change and no transcode.
- Both the Media tab and overlay now use all verified heights (highest first)
  plus the best audio-only option, with the verified best video selected by
  default. Advanced format details remain collapsed. Both send the same
  opaque option ID and output format through the same queue contract.

## Focused regression scenarios

| Scenario | Coverage |
| --- | --- |
| Size metadata | `tests/media-engine.test.ts`: exact beats approximation, approximation beats bitrate estimate, merged sum uses both streams and remains estimated, unknown stays unknown. |
| Renderer auto-analysis | `tests/media-auto-analyze.test.ts`: debounce, invalid input ignored, duplicate URL suppressed, stale result ignored, no queue path. |
| Extension workflow | `tests/extension-overlay.test.ts`: panel-open analysis once/no duplicate, all verified heights, best default, compatible output formats, incompatible format disabled, format sent with queue. |

Additional existing-contract checks were updated in `tests/media-contract.test.ts`,
`tests/media-args.test.ts` and `tests/media-jobs-manager.test.ts`.

## Verification run

| Command | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npx vitest run tests/media-auto-analyze.test.ts` | **1 passed** |
| `npx vitest run tests/media-engine.test.ts` | **49 passed** |
| Focused bridge/overlay/contracts/media-args/job/CSP files | **84 passed** |
| Changed native host compiled to a temp executable | passed |
| `node --check` on changed extension scripts; `git diff --check` | passed |

The genuine metadata-only yt-dlp check returned a 635-second public 4K sample
with 57 formats; the first sample URL tried was unavailable. In the existing
T3 fixture sidebar, entering that URL caused automatic analysis and displayed
2160p, lower resolutions, output format choices, and exact/estimated sizes.
That simulated preview did not verify Electron, Helium, aria2, or real transfers.
