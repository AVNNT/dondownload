#!/usr/bin/env node
/**
 * Write dist/SHA256SUMS.txt for the release installers and extension packages
 * in dist/.
 *
 * Usage:
 *   npm run build:installer
 *   npm run release:checksums
 *
 * Each line is `<sha256>  <filename>` (two spaces), which is the format the
 * application updater parses before it accepts a GitHub release asset. The
 * installer lines come first; extension packages are appended so a simple
 * parser that stops at the first line still sees the installer.
 *
 * When DONDOWNLOAD_UPDATE_SIGNING_KEY points to a PKCS#8 PEM Ed25519 private
 * key, the exact bytes of SHA256SUMS.txt are signed and the base64 signature is
 * written to SHA256SUMS.txt.sig. Without it the release cannot be served as an
 * automatic update.
 *
 * Run this only after every checksummed asset exists: changing any asset after
 * signing invalidates the published signature.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectChecksumFiles } from './release-lib.mjs'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const distDirectory = path.join(repositoryRoot, 'dist')

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

  const { installers, extensions, all } = selectChecksumFiles(names)

  if (installers.length === 0) {
    throw new Error(
      'No DonDownload-<version>-x64-setup.exe files were found in dist/. Run npm run build:installer first.'
    )
  }
  if (extensions.length === 0) {
    process.stderr.write(
      'Warning: no dondownload-extension-<browser>-<version> packages were found in dist/, so ' +
        'SHA256SUMS.txt covers the installers only. Run npm run release to build them.\n'
    )
  }

  const lines = []
  for (const name of all) {
    const digest = await hashFile(path.join(distDirectory, name))
    lines.push(`${digest}  ${name}`)
  }

  const outputPath = path.join(distDirectory, 'SHA256SUMS.txt')
  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(
    `Wrote ${outputPath} for ${installers.length} installer${
      installers.length === 1 ? '' : 's'
    } and ${extensions.length} extension package${
      extensions.length === 1 ? '' : 's'
    }.\n`
  )

  const signingKeyPath = process.env.DONDOWNLOAD_UPDATE_SIGNING_KEY
  if (!signingKeyPath) {
    process.stderr.write(
      'Warning: DONDOWNLOAD_UPDATE_SIGNING_KEY is not set, so SHA256SUMS.txt.sig was not written. ' +
        'The application updater refuses releases without a valid signature.\n'
    )
    return
  }

  let key
  try {
    key = createPrivateKey(await readFile(path.resolve(signingKeyPath), 'utf8'))
  } catch {
    throw new Error(
      `The update signing key could not be read: ${path.resolve(signingKeyPath)}`
    )
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('The update signing key must be an Ed25519 private key.')
  }

  const sumsBytes = await readFile(outputPath)
  const signaturePath = `${outputPath}.sig`
  await writeFile(
    signaturePath,
    `${sign(null, sumsBytes, key).toString('base64')}\n`,
    'utf8'
  )
  process.stdout.write(`Wrote ${signaturePath}.\n`)
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`release-checksums failed: ${detail}\n`)
  process.exitCode = 1
})
