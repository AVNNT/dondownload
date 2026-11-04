import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionDir = path.join(process.cwd(), 'extension')

interface ExtensionManifest {
  manifest_version: number
  permissions?: string[]
  host_permissions?: string[]
  background?: { service_worker?: string; type?: string }
  action?: { default_popup?: string }
  content_scripts?: unknown[]
}

async function readManifest(): Promise<ExtensionManifest> {
  return JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')) as ExtensionManifest
}

describe('browser extension manifest', () => {
  it('is Manifest V3 with only the minimal manual-capture permissions', async () => {
    const manifest = await readManifest()
    expect(manifest.manifest_version).toBe(3)
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      'activeTab',
      'contextMenus',
      'nativeMessaging'
    ])
    expect(manifest.host_permissions).toBeUndefined()
    expect(manifest.content_scripts).toBeUndefined()
    expect(manifest.background?.service_worker).toBe('background.js')
    expect(manifest.action?.default_popup).toBe('popup.html')
  })

  it('does not request downloads, webRequest, notifications or tabs interception', async () => {
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
      'management',
      'scripting'
    ]) {
      expect(requested.has(forbidden)).toBe(false)
    }
  })

  it('ships the popup, background worker and native client files', () => {
    for (const file of [
      'manifest.json',
      'background.js',
      'bridge.js',
      'popup.html',
      'popup.js',
      'popup.css'
    ]) {
      expect(existsSync(path.join(extensionDir, file))).toBe(true)
    }
  })
})
