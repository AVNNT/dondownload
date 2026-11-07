import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GLOBAL_SPEED_LIMIT_BPS,
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  DEFAULT_PER_HOST_CONNECTIONS,
  MAX_PER_HOST_CONNECTIONS
} from '../src/shared/settings'
import { buildAria2Args } from '../src/main/aria2/args'

describe('buildAria2Args', () => {
  it('binds RPC to loopback with a discrete port and secret', () => {
    const args = buildAria2Args({
      port: 45678,
      secret: 'test-secret',
      downloadDir: 'C:\\Users\\Test\\Downloads\\DonDownload'
    })

    expect(args).toContain('--enable-rpc=true')
    expect(args).toContain('--rpc-listen-all=false')
    expect(args).toContain('--rpc-listen-port=45678')
    expect(args).toContain('--rpc-secret=test-secret')
    expect(args).toContain('--rpc-allow-origin-all=false')
    expect(args).toContain('--dir=C:\\Users\\Test\\Downloads\\DonDownload')
    expect(args).toContain('--no-conf=true')
  })

  it('keeps bounded retry and safe file handling options', () => {
    const args = buildAria2Args({ port: 1, secret: 's', downloadDir: 'D:\\x' })

    expect(args).toContain('--max-tries=3')
    expect(args).toContain('--retry-wait=2')
    expect(args).toContain('--allow-overwrite=false')
    expect(args).toContain('--auto-file-renaming=true')
    expect(args).toContain('--check-certificate=true')
    expect(args).toContain('--file-allocation=none')
  })

  it('launches with the shared default global download limits', () => {
    const args = buildAria2Args({ port: 1, secret: 's', downloadDir: 'D:\\x' })

    expect(args).toContain(
      `--max-concurrent-downloads=${DEFAULT_MAX_CONCURRENT_DOWNLOADS}`
    )
    expect(args).toContain(
      `--max-connection-per-server=${DEFAULT_PER_HOST_CONNECTIONS}`
    )
    expect(args).toContain(
      `--max-overall-download-limit=${DEFAULT_GLOBAL_SPEED_LIMIT_BPS}`
    )
    // aria2 may raise the live concurrency itself; per-host stays polite.
    expect(args).toContain('--optimize-concurrent-downloads=true')
    expect(args).toContain('--min-split-size=1M')
    // 16 is aria2's hard cap and the new default.
    expect(args).toContain('--max-connection-per-server=16')
    expect(DEFAULT_PER_HOST_CONNECTIONS).toBe(16)
  })

  it('uses the measured sequential-write download profile', () => {
    const args = buildAria2Args({ port: 1, secret: 's', downloadDir: 'D:\\x' })

    // Loopback 1 GiB measurements: in-order pieces plus no disk cache beat the
    // previous out-of-order/16M-cache profile without changing the per-host
    // connection ceiling.
    expect(args).toContain('--stream-piece-selector=inorder')
    expect(args).toContain('--disk-cache=0')
    expect(args).not.toContain('--disk-cache=32M')
    expect(args).not.toContain('--disk-cache=64M')
    expect(args).not.toContain('--enable-http-pipelining=true')
  })

  it('keeps the split ceiling above every configurable per-host limit', () => {
    const args = buildAria2Args({ port: 1, secret: 's', downloadDir: 'D:\\x' })
    const split = args.find((arg) => arg.startsWith('--split='))

    // aria2 clamps split to the live max-connection-per-server value. The
    // launch value must not cap a persisted per-host setting; each download
    // sets `split` to its own effective connection count.
    expect(split).toBe(`--split=${MAX_PER_HOST_CONNECTIONS}`)
    expect(MAX_PER_HOST_CONNECTIONS).toBeGreaterThanOrEqual(
      DEFAULT_PER_HOST_CONNECTIONS
    )
  })
})
