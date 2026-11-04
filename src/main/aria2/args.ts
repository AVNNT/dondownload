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
    '--max-concurrent-downloads=5',
    '--max-connection-per-server=8',
    '--split=8',
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
