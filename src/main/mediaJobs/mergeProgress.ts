/**
 * Byte progress for the ffmpeg merge phase of a media job.
 *
 * yt-dlp merges with stream copy, so the output file grows to roughly the sum
 * of the downloaded input parts. While the merge runs, its output lives in the
 * job's staging directory as `<name>.temp.<ext>`; sampling that file's size
 * against the known input total turns the previously opaque phase into real
 * progress. Only filesystem reads happen here — scheduling and publication stay
 * in the manager.
 */
import { promises as fs } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import path from 'node:path'
import type { MediaMergeProgress } from '@shared/media'

/** One sample a second is enough for a phase that lasts minutes. */
export const MERGE_PROGRESS_POLL_MS = 1_000

/** yt-dlp names the in-progress merge output `<name>.temp.<ext>`. */
const TEMP_MARKER = '.temp.'

/**
 * A staging directory can hold a leftover `.temp.` file from an earlier run;
 * only files touched around this merge's start are considered.
 */
const MTIME_SLACK_MS = 5_000

export interface MergeProgressProbe {
  /** Job output directory; yt-dlp merges inside a hidden staging subdirectory. */
  dir: string
  /** Merge start time (epoch ms); older temp files are ignored. */
  since: number
  /** Sum of the downloaded parts as reported by yt-dlp, when known. */
  totalBytes?: number | null
}

interface MergeTempFile {
  filePath: string
  directory: string
  size: number
  modifiedAt: number
}

async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch {
    // A missing or unreadable directory simply means "no sample yet".
    return []
  }
}

async function statFile(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}

function isMergeTempName(name: string): boolean {
  return name.includes(TEMP_MARKER)
}

/** The merge file's own stem: `Title.temp.mp4` -> `Title`. */
function stemOf(tempName: string): string {
  return tempName.split(TEMP_MARKER)[0] ?? ''
}

async function collectTempFiles(
  directory: string,
  entries: readonly Dirent[],
  since: number,
  found: MergeTempFile[]
): Promise<void> {
  for (const entry of entries) {
    if (!entry.isFile() || !isMergeTempName(entry.name)) continue
    const filePath = path.join(directory, entry.name)
    const stat = await statFile(filePath)
    if (stat === null || !stat.isFile()) continue
    if (stat.mtimeMs < since - MTIME_SLACK_MS) continue
    found.push({
      filePath,
      directory,
      size: stat.size,
      modifiedAt: stat.mtimeMs
    })
  }
}

/**
 * Newest `.temp.` file below the job's output directory. yt-dlp writes inside a
 * one-level staging directory, so the scan is deliberately shallow.
 */
async function findMergeTempFile(
  dir: string,
  since: number
): Promise<MergeTempFile | null> {
  const found: MergeTempFile[] = []
  const rootEntries = await readDirectory(dir)
  await collectTempFiles(dir, rootEntries, since, found)

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue
    const nested = path.join(dir, entry.name)
    await collectTempFiles(nested, await readDirectory(nested), since, found)
  }

  let newest: MergeTempFile | null = null
  for (const candidate of found) {
    if (newest === null || candidate.modifiedAt > newest.modifiedAt) {
      newest = candidate
    }
  }
  return newest
}

/**
 * Input total for the merge. yt-dlp's reported stream totals are authoritative;
 * when they are missing, the on-disk parts that share the temp file's stem are
 * summed instead.
 */
async function resolveMergeTotal(
  temp: MergeTempFile,
  reportedTotal: number | null
): Promise<number | null> {
  if (reportedTotal !== null && reportedTotal > 0) return reportedTotal

  const stem = stemOf(path.basename(temp.filePath))
  if (stem.length === 0) return null

  let total = 0
  for (const entry of await readDirectory(temp.directory)) {
    if (!entry.isFile() || isMergeTempName(entry.name)) continue
    if (entry.name !== stem && !entry.name.startsWith(`${stem}.`)) continue
    const stat = await statFile(path.join(temp.directory, entry.name))
    if (stat !== null && stat.isFile()) total += stat.size
  }
  return total > 0 ? total : null
}

/**
 * One merge-progress sample, or null while the merge output cannot be measured
 * yet (ffmpeg not started, staging directory not created, unknown total).
 */
export async function readMergeProgress(
  probe: MergeProgressProbe
): Promise<MediaMergeProgress | null> {
  const temp = await findMergeTempFile(probe.dir, probe.since)
  if (temp === null) return null

  const totalBytes = await resolveMergeTotal(temp, probe.totalBytes ?? null)
  if (totalBytes === null) return null

  return {
    completedBytes: Math.min(temp.size, totalBytes),
    totalBytes
  }
}
