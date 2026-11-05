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
    '--max-connection-per-server=' + DEFAULT_PER_HOST_CONNECTIONS,
    '--max-overall-download-limit=' + DEFAULT_GLOBAL_SPEED_LIMIT_BPS,
    // aria2 caps the requested split at the live --max-connection-per-server
    // value. Keep the launch ceiling at the largest configurable per-host
    // value so a persisted setting above 8 is not silently capped here; the
    // live setting (default 4) remains the actual politeness bound.
    '--split=' + MAX_PER_HOST_CONNECTIONS,
    '--min-split-size=1M',
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
    '--user-agent=DonDownload/0.1.0'
  ]
}
