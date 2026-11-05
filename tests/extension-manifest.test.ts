import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionDir = path.join(process.cwd(), 'extension')

interface ExtensionManifest {
  manifest_version: number
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  background?: { service_worker?: string; type?: string }
  icons?: Record<string, string>
  action?: {
    default_popup?: string
    default_icon?: Record<string, string>
  }
  options_ui?: { page?: string; open_in_tab?: boolean }
  commands?: Record<string, { description?: string; suggested_key?: unknown }>
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
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true })
    expect(manifest.commands?.['toggle-overlay']?.suggested_key).toBeUndefined()
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

  it('does not require downloads, webRequest, notifications or tab interception', async () => {
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

  it('declares downloads, webRequest and cookies only as optional permissions', async () => {
    const manifest = await readManifest()
    expect([...(manifest.optional_permissions ?? [])].sort()).toEqual([
      'cookies',
      'downloads',
      'webRequest'
    ])
    expect(manifest.permissions ?? []).not.toContain('downloads')
    expect(manifest.permissions ?? []).not.toContain('webRequest')
    expect(manifest.permissions ?? []).not.toContain('cookies')
    expect(manifest.permissions ?? []).not.toContain('notifications')
  })

  it('ships declared extension and toolbar icons at every size', async () => {
    const manifest = await readManifest()
    const icons = manifest.icons ?? {}
    expect(Object.keys(icons).sort()).toEqual(['128', '16', '32', '48'])

    for (const [size, file] of Object.entries(icons)) {
      const absolute = path.join(extensionDir, file)
      expect(existsSync(absolute), `${file} exists`).toBe(true)
      const png = await readFile(absolute)
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
      expect(png.readUInt32BE(16), `${file} width`).toBe(Number(size))
      expect(png.readUInt32BE(20), `${file} height`).toBe(Number(size))
    }

    const actionIcons = manifest.action?.default_icon ?? {}
    expect(actionIcons).toMatchObject({
      '16': icons['16'],
      '32': icons['32'],
      '48': icons['48']
    })
  })

  it('ships the popup, background worker, native client and overlay files', () => {
    for (const file of [
      'manifest.json',
      'background.js',
      'bridge.js',
      'capture-settings.js',
      'handoff-policy.js',
      'handoff.js',
      'media-bridge.js',
      'media-contract.js',
      'media-sniffer.js',
      'options.html',
      'options.css',
      'options.js',
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
