import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * These services must stay importable from a plain Node process so a future
 * tray-only background host can reuse them without Electron. Electron access
 * goes through the injected `CoreHost`; only `electronHost.ts` may import it.
 */
const CORE_MODULES = [
  'src/main/aria2/locator.ts',
  'src/main/downloads/manager.ts',
  'src/main/batches/manager.ts',
  'src/main/mediaJobs/manager.ts',
  'src/main/notifications/service.ts'
]

const ELECTRON_IMPORT = /(?:from\s*|require\(\s*)['"]electron['"]/

function sourceOf(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8'
  )
}

describe('core services do not depend on electron', () => {
  it.each(CORE_MODULES)('%s has no electron import', (relativePath) => {
    expect(sourceOf(relativePath)).not.toMatch(ELECTRON_IMPORT)
  })

  it('imports every core module without an electron mock', async () => {
    const locator = await import('../src/main/aria2/locator')
    const downloads = await import('../src/main/downloads/manager')
    const batches = await import('../src/main/batches/manager')
    const mediaJobs = await import('../src/main/mediaJobs/manager')
    const notifications = await import('../src/main/notifications/service')

    expect(typeof locator.locateAria2c).toBe('function')
    expect(typeof downloads.DownloadManager).toBe('function')
    expect(typeof batches.BatchManager).toBe('function')
    expect(typeof mediaJobs.MediaJobsManager).toBe('function')
    expect(typeof notifications.CompletionNotificationService).toBe('function')
  })
})
