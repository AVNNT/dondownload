#!/usr/bin/env node
/**
 * Renders the authored SVGs to every platform asset the app and extension use.
 *
 * No image libraries are installed, so this drives the Chromium build that
 * Playwright already put on disk. Each size is rendered in a real transparent
 * page (`--default-background-color=00000000`) at exactly the requested pixel
 * size, then the ICO containers are assembled by hand from the PNG payloads
 * (Vista+ supports PNG-compressed ICO entries).
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 *   DONDOWNLOAD_CHROMIUM=/path/to/chrome node scripts/generate-icons.mjs
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const trayDir = path.join(root, 'src', 'main', 'assets')
const extensionIconsDir = path.join(root, 'extension', 'icons')

const APP_SIZES = [16, 24, 32, 48, 64, 128, 256]
const TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]
const EXTENSION_SIZES = [16, 32, 48, 128]

function localAppData() {
  return process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
}

/** Newest matching directory, by the numeric suffix in its name. */
function newestDirectory(parent, prefix) {
  if (!existsSync(parent)) return null
  const matches = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => ({
      name: entry.name,
      version: Number(entry.name.slice(prefix.length).replace(/\D.*$/, '')) || 0
    }))
    .sort((a, b) => b.version - a.version)
  return matches.length > 0 ? path.join(parent, matches[0].name) : null
}

function findChromium() {
  const explicit = process.env.DONDOWNLOAD_CHROMIUM
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`DONDOWNLOAD_CHROMIUM does not exist: ${explicit}`)
    }
    return explicit
  }

  const playwrightRoot = path.join(localAppData(), 'ms-playwright')
  const candidates = []

  const chromium = newestDirectory(playwrightRoot, 'chromium-')
  if (chromium) {
    candidates.push(path.join(chromium, 'chrome-win64', 'chrome.exe'))
    candidates.push(path.join(chromium, 'chrome-win32', 'chrome.exe'))
  }
  const headless = newestDirectory(playwrightRoot, 'chromium_headless_shell-')
  if (headless) {
    candidates.push(
      path.join(headless, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    )
  }

  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  candidates.push(
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  )

  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      'No headless Chromium found. Install the Playwright Chromium build or set DONDOWNLOAD_CHROMIUM.'
    )
  }
  return found
}

/** Return the pixel width/height from a PNG IHDR chunk. */
function pngSize(buffer, label) {
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${label} is not a PNG file`)
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${label} has no IHDR chunk`)
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function renderPng(chromium, svg, size, outputPath, workDir) {
  // The HTML page is exactly the icon viewport: no margin, no scrollbars and
  // a transparent root background, so the screenshot is the SVG alone.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${svg}</body></html>`
  const htmlPath = path.join(workDir, `icon-${size}.html`)
  writeFileSync(htmlPath, html, 'utf8')

  execFileSync(
    chromium,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--user-data-dir=${path.join(workDir, `profile-${size}`)}`,
      `--screenshot=${outputPath}`,
      pathToFileURL(htmlPath).href
    ],
    { stdio: 'pipe', timeout: 60_000, windowsHide: true }
  )

  const png = readFileSync(outputPath)
  const actual = pngSize(png, outputPath)
  if (actual.width !== size || actual.height !== size) {
    throw new Error(
      `Chromium rendered ${actual.width}x${actual.height}, expected ${size}x${size}`
    )
  }
  return png
}

/** Pack PNG payloads into an ICO with hand-written ICONDIR/ICONDIRENTRY. */
function buildIco(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sorted.length, 4)

  const entries = Buffer.alloc(16 * sorted.length)
  let offset = header.length + entries.length
  sorted.forEach((image, index) => {
    const entry = index * 16
    const dimension = image.size >= 256 ? 0 : image.size
    entries.writeUInt8(dimension, entry) // width (0 means 256)
    entries.writeUInt8(dimension, entry + 1) // height
    entries.writeUInt8(0, entry + 2) // palette count
    entries.writeUInt8(0, entry + 3) // reserved
    entries.writeUInt16LE(1, entry + 4) // color planes
    entries.writeUInt16LE(32, entry + 6) // bits per pixel
    entries.writeUInt32LE(image.data.length, entry + 8)
    entries.writeUInt32LE(offset, entry + 12)
    offset += image.data.length
  })

  return Buffer.concat([
    header,
    entries,
    ...sorted.map((image) => image.data)
  ])
}

function main() {
  const appSvg = readFileSync(path.join(buildDir, 'icon.svg'), 'utf8')
  const traySvg = readFileSync(path.join(buildDir, 'icon-tray.svg'), 'utf8')
  const chromium = findChromium()
  const workDir = mkdtempSync(path.join(tmpdir(), 'dondownload-icons-'))

  try {
    console.log(`Rendering with ${chromium}`)
    mkdirSync(trayDir, { recursive: true })
    mkdirSync(extensionIconsDir, { recursive: true })

    const appImages = APP_SIZES.map((size) => {
      const file = path.join(workDir, `app-${size}.png`)
      return {
        size,
        data: renderPng(chromium, appSvg, size, file, workDir)
      }
    })
    const appBySize = new Map(appImages.map((image) => [image.size, image.data]))

    writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(appImages))
    writeFileSync(path.join(buildDir, 'icon.png'), appBySize.get(256))
    // The main process imports this copy for the BrowserWindow/taskbar icon.
    writeFileSync(path.join(trayDir, 'icon.ico'), buildIco(appImages))

    const trayImages = TRAY_SIZES.map((size) => {
      const file = path.join(workDir, `tray-${size}.png`)
      return {
        size,
        data: renderPng(chromium, traySvg, size, file, workDir)
      }
    })
    writeFileSync(path.join(trayDir, 'tray.ico'), buildIco(trayImages))

    for (const size of EXTENSION_SIZES) {
      copyFileSync(
        path.join(workDir, `app-${size}.png`),
        path.join(extensionIconsDir, `icon${size}.png`)
      )
    }

    const describe = (file) =>
      `${path.relative(root, file)} (${readFileSync(file).length.toLocaleString()} bytes)`
    console.log(
      [
        `wrote ${describe(path.join(buildDir, 'icon.ico'))}`,
        `wrote ${describe(path.join(buildDir, 'icon.png'))}`,
        `wrote ${describe(path.join(trayDir, 'tray.ico'))}`,
        ...EXTENSION_SIZES.map((size) =>
          `wrote ${describe(path.join(extensionIconsDir, `icon${size}.png`))}`
        )
      ].join('\n')
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main()
