#!/usr/bin/env node
/**
 * Refuse to continue unless a release tag matches `v` + the package.json
 * version.
 *
 * Usage:
 *   node scripts/check-release-tag.mjs v1.0.0
 *
 * The GitHub Actions release workflow runs this before it builds anything, so
 * a tag pushed for the wrong version fails in seconds instead of after a full
 * installer build. The comparison lives in `release-lib.mjs`
 * (`releaseTagMatchesVersion`) so it is unit tested with the other release
 * helpers.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseTagMatchesVersion } from './release-lib.mjs'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

async function main() {
  const tag = process.argv[2]
  const raw = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  let version
  try {
    version = JSON.parse(raw).version
  } catch {
    throw new Error('package.json is not valid JSON.')
  }

  if (!releaseTagMatchesVersion(tag, version)) {
    process.stderr.write(
      `Release tag ${tag ?? '(missing)'} does not match v${version} from package.json.\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `Release tag ${tag} matches package.json version ${version}.\n`
  )
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`check-release-tag failed: ${detail}\n`)
  process.exitCode = 1
})
