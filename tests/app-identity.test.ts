import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_USER_MODEL_ID } from '../src/shared/appIdentity'

/**
 * Windows toast buttons only activate while the process AUMID and the
 * installer's shortcut AUMID are identical. electron-builder uses `appId` for
 * the NSIS shortcut's AppUserModelID, so both must match this constant.
 */
describe('Windows application identity', () => {
  it('keeps the main-process AUMID on the documented app id', () => {
    expect(APP_USER_MODEL_ID).toBe('com.dondownload.app')
  })

  it('matches the installer appId and creates shortcuts', () => {
    const yml = readFileSync(
      path.join(process.cwd(), 'electron-builder.yml'),
      'utf8'
    )
    expect(yml).toMatch(
      new RegExp(`^appId:\\s*${APP_USER_MODEL_ID}\\s*$`, 'm')
    )
    expect(yml).toMatch(/^\s*createStartMenuShortcut:\s*true\s*$/m)
    expect(yml).toMatch(/^\s*createDesktopShortcut:\s*true\s*$/m)
  })
})
