import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DONDOWNLOAD_EXTENSION_ID,
  DONDOWNLOAD_FIREFOX_ADDON_ID,
  extensionIdFromDigestHex,
  isExtensionId,
  isFirefoxAddonId
} from '../src/shared/extensionId'

interface Manifest {
  key?: string
  allowed_origins?: string[]
  browser_specific_settings?: { gecko?: { id?: string } }
}

describe('stable extension ID', () => {
  it('recomputes the pinned ID from the manifest public key', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as Manifest

    expect(typeof manifest.key).toBe('string')
    const der = Buffer.from(manifest.key ?? '', 'base64')
    expect(der.length).toBeGreaterThan(200)
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32)
    const computed = extensionIdFromDigestHex(digest)

    expect(computed).toBe(DONDOWNLOAD_EXTENSION_ID)
    expect(computed).toMatch(/^[a-p]{32}$/)
  })

  it('rejects non-ID values and non-hex digest prefixes', () => {
    expect(isExtensionId(DONDOWNLOAD_EXTENSION_ID)).toBe(true)
    expect(isExtensionId('*')).toBe(false)
    expect(isExtensionId('abc')).toBe(false)
    expect(() => extensionIdFromDigestHex('zzzz')).toThrow()
  })

  it('keeps the Firefox add-on ID in the manifest and the native host in sync', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as Manifest

    expect(manifest.browser_specific_settings?.gecko?.id).toBe(
      DONDOWNLOAD_FIREFOX_ADDON_ID
    )
    expect(isFirefoxAddonId(DONDOWNLOAD_FIREFOX_ADDON_ID)).toBe(true)
    for (const invalid of ['*', 'not-an-id', `${'a'.repeat(256)}@b.c`, 'a@']) {
      expect(isFirefoxAddonId(invalid)).toBe(false)
    }
  })
})
