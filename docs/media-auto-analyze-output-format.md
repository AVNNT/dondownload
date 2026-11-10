# Media auto-analysis and output-format workflow

Status: implementation note for the focused media workflow change. No installer
was rebuilt, nothing was pushed or committed, and no Electron/Helium window was
launched for this work.

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
- **Incomplete size metadata path.** `src/main/media/formats.ts` already
  preferred exact `filesize` over `filesize_approx`, but when both were absent
  it returned unknown even though yt-dlp had reported bitrate and duration.
  Merged options summed display sizes only when both streams had a reported
  size; there was no safe bitrate fallback for a missing half.
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
  `bitrate x duration` estimate. Exact values stay in `filesizeBytes`; only the
  displayed `estimatedBytes` carries approximations/estimates. A merged total
  is unknown unless both streams have a usable size, and any merged sum remains
  labelled as an estimate.
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
| `npx tsc --noEmit -p tsconfig.node.json` | passed |
| `npx tsc --noEmit -p tsconfig.web.json` | passed |
| `npx vitest run` on the 5 focused media/contract files | **94 passed**, 1.13 s |
| `npx vitest run` on the 5 extension/native-bridge/preview files | **112 passed**, 0.41 s |
| `npm run build` (typecheck + main/preload/renderer bundles) | passed |
| `node --check` on changed extension scripts | passed |

The actual yt-dlp terminal metadata check and the sidebar preview interaction are
intentionally left to the integrating parent.
