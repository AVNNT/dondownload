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
  it('is Manifest V3 with the minimal manual-capture permissions plus HTTP(S) site access', async () => {
    const manifest = await readManifest()
    expect(manifest.manifest_version).toBe(3)
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      'activeTab',
      'contextMenus',
      'downloads',
      'nativeMessaging',
      'scripting',
      'storage'
    ])
    expect(manifest.content_scripts).toBeUndefined()
    expect(manifest.background?.service_worker).toBe('background.js')
    expect(manifest.action?.default_popup).toBe('popup.html')
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true })
    expect(manifest.commands?.['toggle-overlay']?.suggested_key).toBeUndefined()
  })

  it('grants HTTP(S) site access at install so the all-sites switch is always on', async () => {
    const manifest = await readManifest()
    // "Use DonDownload on all sites" is always on, so the broad host patterns
    // are required permissions: no prompt and no toggle can remove them.
    expect([...(manifest.host_permissions ?? [])].sort()).toEqual([
      'http://*/*',
      'https://*/*'
    ])
    expect(manifest.optional_host_permissions ?? []).toEqual([])
    const raw = await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')
    expect(raw).not.toContain('<all_urls>')
    expect(raw).not.toContain('"optional_host_permissions"')
  })

  it('does not require webRequest, notifications or tab interception', async () => {
    const manifest = await readManifest()
    const requested = new Set(manifest.permissions ?? [])
    for (const forbidden of [
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

  it('requires downloads so hand-off works right after install', async () => {
    const manifest = await readManifest()
    // Browser hand-off is the feature the user installs for, so the permission
    // is granted with the extension instead of behind a button.
    expect(manifest.permissions ?? []).toContain('downloads')
    expect(manifest.optional_permissions ?? []).not.toContain('downloads')
  })

  it('declares webRequest and cookies only as optional permissions', async () => {
    const manifest = await readManifest()
    expect([...(manifest.optional_permissions ?? [])].sort()).toEqual([
      'cookies',
      'webRequest'
    ])
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
      'bounded-cache.js',
      'bridge.js',
      'browser-downloads.js',
      'capture-settings.js',
      'handoff-policy.js',
      'handoff.js',
      'gofile-capture.js',
      'gofile-collector.js',
      'gofile-scan.js',
      'media-bridge.js',
      'media-contract.js',
      'media-sniffer.js',
      'onboarding.js',
      'options.html',
      'options.css',
      'options.js',
      'popup.html',
      'popup.js',
      'popup.css',
      'site-enable.js',
      'site-policy.js',
      'overlay-core.js',
      'overlay-runtime.js',
      'overlay-ui.js',
      'overlay-qualities.js',
      'overlay-kvs.js',
      'overlay-capture.js',
      'overlay-bootstrap.js',
      'overlay.js',
      'overlay-controller.js',
      'welcome.html',
      'welcome.css',
      'welcome.js'
    ]) {
      expect(existsSync(path.join(extensionDir, file))).toBe(true)
    }
  })

  it('puts the two compact scan actions side by side and the images action on its own row', async () => {
    const html = await readFile(path.join(extensionDir, 'popup.html'), 'utf8')
    const acts = html.slice(
      html.indexOf('<div class="acts">'),
      html.indexOf('<button id="download-again"')
    )
    const order = ['id="scan-page"', 'id="scan-many"', 'id="scan-images"'].map((marker) =>
      acts.indexOf(marker)
    )
    expect(order).not.toContain(-1)
    expect([...order].sort((left, right) => left - right)).toEqual(order)

    const css = await readFile(path.join(extensionDir, 'popup.css'), 'utf8')
    expect(css).toMatch(/#scan-images\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/)
  })
})
