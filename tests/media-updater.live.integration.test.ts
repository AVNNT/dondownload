import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createYtdlpUpdater } from '../src/main/media/updater'

/**
 * Optional live check. The regular test command skips it, so no test run ever
 * touches the network. Run it explicitly with:
 *
 *   $env:DONDOWNLOAD_LIVE_YTDLP_UPDATE='1'
 *   npx vitest run tests/media-updater.live.integration.test.ts
 *
 * A fresh temporary userData directory is used and removed afterwards; the
 * real `%APPDATA%\dondownload` directory is never read or written.
 */
const runLive = process.env.DONDOWNLOAD_LIVE_YTDLP_UPDATE === '1'
const live = runLive ? describe : describe.skip

live('live yt-dlp updater check', () => {
  it(
    'reports up to date or downloads and verifies the current release',
    async () => {
      const userData = await mkdtemp(
        path.join(os.tmpdir(), 'dondownload-live-ytdlp-')
      )
      try {
        const updater = createYtdlpUpdater({
          userDataPath: userData,
          appVersion: '0.1.0-live-check',
          // An empty app directory means there is no bundled version, so the
          // updater downloads and verifies the real GitHub release.
          cwd: userData,
          env: { PATH: '' },
          platform: process.platform,
          autoUpdateAllowed: true
        })

        const state = await updater.check({ force: true })
        expect(['updated', 'up-to-date']).toContain(state.status)
        expect(state.currentVersion).not.toBeNull()
        expect(state.message).not.toMatch(/https?:\/\//i)
      } finally {
        await rm(userData, { recursive: true, force: true })
      }
    },
    5 * 60_000
  )
})
