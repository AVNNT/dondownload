import os from 'node:os'

/**
 * Run a helper process (aria2, yt-dlp) below normal CPU priority so downloads
 * never compete with games or the foreground app. On Windows, processes it
 * starts (ffmpeg under yt-dlp) inherit the below-normal class. Network and
 * disk throughput are unaffected; only CPU scheduling yields first.
 */
export function lowerProcessPriority(pid: number | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // The process may have exited already, or the OS refused; keep defaults.
  }
}
