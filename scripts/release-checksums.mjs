#!/usr/bin/env node
/**
 * Write dist/SHA256SUMS.txt for the NSIS installers in dist/.
 *
 * Usage:
 *   npm run build:installer
 *   npm run release:checksums
 *
 * Each line is `<sha256>  <filename>` (two spaces), which is the format the
 * application updater parses before it accepts a GitHub release asset.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const distDirectory = path.join(repositoryRoot, 'dist')
const installerPattern = /^DonDownload-\d+\.\d+\.\d+-x64-setup\.exe$/

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function main() {
  let names
  try {
    names = await readdir(distDirectory)
  } catch {
    throw new Error(`The dist directory does not exist: ${distDirectory}`)
  }

  const installers = names
    .filter((name) => installerPattern.test(name))
    .sort((left, right) => left.localeCompare(right))

  if (installers.length === 0) {
    throw new Error(
      'No DonDownload-<version>-x64-setup.exe files were found in dist/. Run npm run build:installer first.'
    )
  }

  const lines = []
  for (const name of installers) {
    const digest = await hashFile(path.join(distDirectory, name))
    lines.push(`${digest}  ${name}`)
  }

  const outputPath = path.join(distDirectory, 'SHA256SUMS.txt')
  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(
    `Wrote ${outputPath} for ${installers.length} installer${
      installers.length === 1 ? '' : 's'
    }.\n`
  )
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`release-checksums failed: ${detail}\n`)
  process.exitCode = 1
})
