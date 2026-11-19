import {
  DEFAULT_GLOBAL_SPEED_LIMIT_BPS,
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  DEFAULT_PER_HOST_CONNECTIONS,
  MAX_PER_HOST_CONNECTIONS
} from '@shared/settings'

export interface Aria2LaunchConfig {
  port: number
  secret: string
  downloadDir: string
}

/**
 * Build the aria2c argument vector. Inputs are fixed application values
 * (random port/secret, validated download directory) and are never passed
 * through a shell.
 */
export function buildAria2Args(config: Aria2LaunchConfig): string[] {
  return [
    '--enable-rpc=true',
    '--rpc-listen-all=false',
    '--rpc-listen-port=' + config.port,
    '--rpc-secret=' + config.secret,
    '--rpc-allow-origin-all=false',
    '--no-conf=true',
    '--dir=' + config.downloadDir,
    '--continue=true',
    '--max-concurrent-downloads=' + DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    // Let aria2 raise the live concurrency while bandwidth allows; the launch
    // value above stays the ceiling it may not exceed.
    '--optimize-concurrent-downloads=true',
    '--max-connection-per-server=' + DEFAULT_PER_HOST_CONNECTIONS,
    '--max-overall-download-limit=' + DEFAULT_GLOBAL_SPEED_LIMIT_BPS,
    // aria2 caps the requested split at the live --max-connection-per-server
    // value. Keep the launch ceiling at the largest configurable per-host
    // value so a persisted setting is never silently capped here; each
    // download sets `split` to its own effective connection count, and the
    // live setting (default 16) remains the politeness bound.
    '--split=' + MAX_PER_HOST_CONNECTIONS,
    '--min-split-size=1M',
    // Measured on the local loopback 1 GiB fixture: in-order piece selection
    // lets aria2 write the file sequentially with the same 16 parallel
    // connections, removing out-of-order write churn. It added ~38% throughput
    // (427 -> 590 MiB/s) and lowered time-to-first-byte. With sequential writes
    // the 16 MiB default disk cache only adds buffering/copy overhead, so the
    // cache is disabled (590 -> 676 MiB/s on the same fixture). The per-host
    // connection back-off is unaffected: it still lowers `split` and
    // `max-connection-per-server` per download.
    '--stream-piece-selector=inorder',
    '--disk-cache=0',
    '--file-allocation=none',
    '--allow-overwrite=false',
    '--auto-file-renaming=true',
    '--check-certificate=true',
    '--max-tries=3',
    '--retry-wait=2',
    '--connect-timeout=15',
    '--timeout=60',
    '--summary-interval=0',
    '--console-log-level=warn',
    '--download-result=hide',
    '--user-agent=DonDownload/1.3.3'
  ]
}
