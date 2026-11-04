import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionDir = path.join(process.cwd(), 'extension')

interface ExtensionManifest {
  manifest_version: number
  permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  background?: { service_worker?: string; type?: string }
  action?: { default_popup?: string }
  content_scripts?: unknown[]
}

async function readManifest(): Promise<ExtensionManifest> {
  return JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')) as ExtensionManifest
}

describe('browser extension manifest', () => {
  it('is Manifest V3 with only the minimal manual-capture and overlay-scoped permissions', async () => {
    const manifest = await readManifest()
    expect(manifest.manifest_version).toBe(3)
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      'activeTab',
      'contextMenus',
      'nativeMessaging',
      'scripting',
      'storage'
    ])
    expect(manifest.host_permissions).toBeUndefined()
    expect(manifest.content_scripts).toBeUndefined()
    expect(manifest.background?.service_worker).toBe('background.js')
    expect(manifest.action?.default_popup).toBe('popup.html')
  })

  it('declares optional HTTP(S) host patterns but no always-on or all-sites access', async () => {
    const manifest = await readManifest()
    expect([...(manifest.optional_host_permissions ?? [])].sort()).toEqual([
      'http://*/*',
      'https://*/*'
    ])
    const raw = await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')
    expect(raw).not.toContain('<all_urls>')
    expect(raw).not.toContain('"host_permissions"')
  })

  it('does not request downloads, webRequest, notifications or tab interception', async () => {
    const manifest = await readManifest()
    const requested = new Set(manifest.permissions ?? [])
    for (const forbidden of [
      'downloads',
      'webRequest',
      'webRequestBlocking',
      'notifications',
      'tabs',
      'cookies',
      'history',
      'management'
    ]) {
      expect(requested.has(forbidden)).toBe(false)
    }
  })

  it('ships the popup, background worker, native client and overlay files', () => {
    for (const file of [
      'manifest.json',
      'background.js',
      'bridge.js',
      'media-bridge.js',
      'media-contract.js',
      'popup.html',
      'popup.js',
      'popup.css',
      'site-policy.js',
      'overlay-core.js',
      'overlay.js',
      'overlay-controller.js'
    ]) {
      expect(existsSync(path.join(extensionDir, file))).toBe(true)
    }
  })
})
