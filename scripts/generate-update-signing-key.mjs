#!/usr/bin/env node
/**
 * Generate an Ed25519 key pair for application-update authentication.
 *
 * Usage:
 *   node scripts/generate-update-signing-key.mjs <path-outside-the-repository>
 *
 * The private key is written as a PKCS#8 PEM and must stay secret. The public
 * key is printed as base64 SPKI DER to paste into UPDATE_SIGNING_PUBLIC_KEY in
 * src/shared/release.ts. The path is refused when it is inside this repository.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

function fail(message) {
  process.stderr.write(`generate-update-signing-key failed: ${message}\n`)
  process.exitCode = 1
}

async function main() {
  const argument = process.argv[2]
  if (!argument) {
    fail(
      'pass the private-key path, for example: node scripts/generate-update-signing-key.mjs C:\\secure\\dondownload-update-key.pem'
    )
    return
  }

  const target = path.resolve(argument)
  const relative = path.relative(repositoryRoot, target)
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    fail('the private key path must be outside this repository.')
    return
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })

  await mkdir(path.dirname(target), { recursive: true })
  try {
    await writeFile(target, pem, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail(`refusing to overwrite an existing file: ${target}`)
      return
    }
    throw error
  }

  process.stdout.write(`Wrote the private key to ${target}\n`)
  process.stdout.write(
    'Keep this file secret. Paste the following base64 SPKI DER into UPDATE_SIGNING_PUBLIC_KEY in src/shared/release.ts:\n'
  )
  process.stdout.write(`${publicDer.toString('base64')}\n`)
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error)
  fail(detail)
})
