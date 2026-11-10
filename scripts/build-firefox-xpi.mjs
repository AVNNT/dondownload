// Build the Firefox/Zen add-on (.xpi) from extension/.
//
// The shared manifest keeps webRequest/webRequestBlocking optional because
// Chromium MV3 has no blocking webRequest. Firefox has no
// downloads.onDeterminingFilename, so its only way to hold a download before it
// starts is the blocking webRequest listener in extension/firefox-hold.js. The
// Firefox build makes both permissions required, so they are granted at install
// and the hand-off works with no extra permission step.
//
// Usage: node scripts/build-firefox-xpi.mjs [outDir]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'extension')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'firefox'))
const FIREFOX_REQUIRED = ['webRequest', 'webRequestBlocking']

export function firefoxManifest(manifest) {
  const next = structuredClone(manifest)
  next.permissions = [...new Set([...(next.permissions ?? []), ...FIREFOX_REQUIRED])]
  next.optional_permissions = (next.optional_permissions ?? []).filter(
    (permission) => !FIREFOX_REQUIRED.includes(permission)
  )
  // Chromium-only keys that Firefox only warns about.
  delete next.key
  delete next.minimum_chrome_version
  if (next.background) delete next.background.service_worker
  return next
}

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('extension/manifest.json has no browser_specific_settings.gecko.id')
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dondownload-xpi-'))
  try {
    fs.cpSync(source, staging, {
      recursive: true,
      // Type declarations are for the repo's tests, not the browser.
      filter: (file) => !file.endsWith('.d.ts')
    })
    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      JSON.stringify(firefoxManifest(manifest), null, 2) + '\n'
    )
    fs.mkdirSync(outDir, { recursive: true })
    const xpi = path.join(outDir, `dondownload-firefox-${manifest.version}.xpi`)
    fs.rmSync(xpi, { force: true })
    // bsdtar (bundled with Windows 10+) writes forward-slash zip entries,
    // which Firefox requires; Compress-Archive on PowerShell 5.1 does not.
    // Use Windows' own bsdtar: a Git Bash PATH puts GNU tar (no zip) first.
    const tar = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
    execFileSync(tar, ['--format', 'zip', '-c', '-f', xpi, '-C', staging, ...fs.readdirSync(staging)], {
      stdio: 'inherit'
    })
    console.log(`Built ${xpi}`)
    return xpi
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build()
}
