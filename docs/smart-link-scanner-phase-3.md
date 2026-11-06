# Smart Link Scanner phase 3: funscript pairing and post-download rename

Status: implementation note. No live-site tests were run. Nothing is pushed.

## What phase 3 adds

- **Pairing in the scan session.** `.funscript` items are grouped with the
  existing pure helpers (`groupScriptSets`) using Discourse post numbers and
  matched to resolved video page links with `matchSetsToVideos` (title tokens +
  same-post bonus). Each published `ScanSession` now carries an optional
  `scriptSets` array. It is recomputed from the current items on every snapshot,
  so a video that resolves later immediately claims its set. The DTO contains a
  stable set ID, display base, post number, axes, variants, `missingMain`,
  conflicts, the matched video item ID (or null), an `ambiguous` flag, a score
  `matchBucket` (no raw floats), each original file name and a preview target
  name. No source URL, directory or absolute path is included.
- **Renderer UI.** Every resolved video card has a "Matching scripts" section:
  a set dropdown (clear/change), axis checkboxes, a primary-version radio when
  variants exist, a rename toggle (default on), an inline list of
  `original → planned name`, and warnings for missing main, conflicts, ambiguous
  matches and conflicting planned names. "Download video + scripts" selects the
  video and the chosen script files together. The Scripts group renders each
  set as one expandable row with axis chips, per-file checkboxes, "Select all
  axes" and "Download scripts with original names".
- **Strict queue extension.** `scan:queue-selection` accepts an optional
  `pairings` array of
  `{ videoItemId, setId, scriptItemIds[], primaryVariant|null, rename }` while
  remaining backward compatible with the old shape. Parsing rejects extra keys,
  duplicates and malformed IDs. The session validates that every referenced item
  belongs to that scan and selection, the video is a resolved page link, every
  script belongs to the named set, and a script is claimed by only one pairing.
- **Same folder, no moves.** Paired scripts are downloaded through a new
  main-only `DownloadManager.addScanFile(input, directory)` path directly into
  the scanner's video output folder (`downloadDir/Media`). The directory must
  resolve inside the normal download root. Download records keep that directory
  for retry/resume. Unpaired scripts keep using the normal download root.
- **Post-completion rename.** The batch manager keeps the pairing in memory
  only. When the video and every chosen script are terminal, it calls
  `src/main/scanner/pairRename.ts`, which plans names with
  `planRenamesForFiles` (the same rules as `planRenames`) using the actual video
  filename and the chosen primary variant. It renames only inside the video
  folder, rejects any video/script/target that resolves outside the download
  root, and never creates a directory or moves a file between folders. Results
  appear on the script items as "Renamed to match video" or
  "Rename skipped: …".

## Rename, collision and restart decisions

- **All-or-nothing.** If any paired script is not `complete`, is missing or
  cannot be located, none of that set is renamed.
- **Never overwrite.** If a planned target already exists and is not another
  source in the same plan, the whole set is skipped with
  "Rename skipped: a matching script file already exists." We deliberately do
  not append ` (1)` / ` (2)`: such a name would not be auto-loaded by funscript
  players and would hide the conflict. Renames that would overwrite another
  source in the same plan use unique temporary names in the same folder.
- **No cross-folder moves.** If a script somehow ends up in a different folder
  than the video (for example yt-dlp created a nested output directory), the
  set is skipped with "Rename skipped: a paired script is not in the video
  folder."
- **Rename off.** The scripts were already downloaded next to the video; they
  keep their original names and the item label says so.
- **Restart.** Pairing state is memory-only and contains no sensitive data. A
  graceful shutdown while a pair is still pending writes
  "Rename skipped: DonDownload stopped before the scripts finished." to the
  script items. After a hard crash the pending pair is gone and the downloaded
  scripts simply keep their original names; no automatic rename is attempted on
  restart.
- **Retry.** A pair settles once. Retrying a failed script does not restart the
  rename automatically; the item label keeps the skip reason and the user can
  rename manually or queue a fresh scan.

## Limits and trade-offs

- Pairing only targets resolved video page links (`category: video`,
  `kind: page-link`, `status: ready`); direct video files and audio are not
  pairing targets.
- The planned preview uses the video's display title; the real rename uses the
  filename yt-dlp reports, which may differ in sanitization.
- A set can be paired with only one video per queue call; unit/compound video
  files are not synthesized from axes.
