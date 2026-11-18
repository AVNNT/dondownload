#!/usr/bin/env node
/**
 * Idempotent DonDownload release runner.
 *
 * Usage:
 *   npm run release              # build installer, extension packages, checksums + signature, dry run
 *   npm run release -- --publish # the same, then tag, push the tag and create a DRAFT GitHub release
 *   node scripts/release.mjs --ci --publish
 *                                # the CI form used by .github/workflows/release.yml:
 *                                # skip the "on master and in sync with origin" check,
 *                                # require the already-pushed tag to point at HEAD
 *
 * `scripts/stage-vendor.ps1` downloads each pinned third-party archive from its
 * official upstream URL, verifies a hard-coded SHA-256 and extracts it, so the
 * installer is reproducible on a clean Windows runner or a GitHub Actions
 * `windows-latest` host. CI supplies the update signing key through the
 * `UPDATE_SIGNING_KEY` secret.
 *
 * This script never signs the installer with an Authenticode certificate: the
 * installer stays unsigned until the code-signing blocker in
 * docs/release-readiness.md is resolved.
 *
 * Ordering matters: the extension packages are built before `release-checksums`
 * so SHA256SUMS.txt covers them, and SHA256SUMS.txt is signed only after every
 * checksummed asset exists.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  THIRD_PARTY_SOURCES_ASSET_NAME,
  buildReleaseAssetList,
  createZipArchive,
  extensionAssetNames,
  extractChangelogSection,
  installerBlockmapAssetName,
  releaseTag,
  renderThirdPartySourcesText,
  selectExtensionFiles
} from './release-lib.mjs'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const distDirectory = path.join(repositoryRoot, 'dist')
const extensionDirectory = path.join(repositoryRoot, 'extension')
const changelogPath = path.join(repositoryRoot, 'CHANGELOG.md')
const packageJsonPath = path.join(repositoryRoot, 'package.json')

const RELEASE_HOME_DIRECTORY = path.join(
  os.homedir(),
  '.dondownload-release'
)
const DEFAULT_SIGNING_KEY_PATH = path.join(
  RELEASE_HOME_DIRECTORY,
  'update-signing-key.pem'
)
const DEFAULT_SOURCES_DIRECTORY = path.join(RELEASE_HOME_DIRECTORY, 'sources')

/**
 * GPL-covered components shipped in the installer. Versions, paths and the
 * pinned upstream release assets mirror scripts/stage-vendor.ps1 and
 * docs/licensing-release-audit.md; update all three together when a bundled
 * tool is bumped.
 */
const GPL_COMPONENTS = [
  {
    name: 'aria2',
    version: '1.37.0',
    license: 'GPL-2.0-or-later',
    sourceUrl:
      'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2',
    buildInfo:
      'Windows build inputs and linked libraries are inventoried in docs/licensing-release-audit.md.',
    binary: 'resources/vendor/aria2/aria2c.exe',
    binaryUrl:
      'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip',
    binarySha256:
      '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288'
  },
  {
    name: 'FFmpeg (Gyan essentials build)',
    version: '9.0.2, source commit 946fcce07b',
    license: 'GPL-3.0-or-later',
    sourceUrl: 'https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz',
    buildInfo:
      'Gyan build scripts and configuration: https://www.gyan.dev/ffmpeg/builds/ . Preserve the build README shipped in third-party/licenses/.',
    binary: 'resources/vendor/ffmpeg/ffmpeg.exe',
    binaryUrl:
      'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
    binarySha256:
      '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
  },
  {
    name: 'ffprobe (Gyan essentials build)',
    version: '9.0.2, source commit 946fcce07b',
    license: 'GPL-3.0-or-later',
    sourceUrl: 'https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz',
    buildInfo:
      'Not staged or invoked by DonDownload; listed for completeness only. See docs/licensing-release-audit.md.',
    binary: 'not shipped'
  }
]

/** Map a local source archive name to the upstream location it came from. */
const SOURCE_ARCHIVE_ORIGINS = [
  {
    pattern: /^aria2-/i,
    sourceUrl:
      'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2'
  },
  {
    pattern: /^ffmpeg-?/i,
    sourceUrl: 'https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz'
  },
  {
    pattern: /^yt-dlp-/i,
    sourceUrl: 'https://github.com/yt-dlp/yt-dlp'
  },
  {
    pattern: /^deno-/i,
    sourceUrl: 'https://github.com/denoland/deno'
  }
]

function log(message) {
  process.stdout.write(`${message}\n`)
}

function warn(message) {
  process.stderr.write(`warning: ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...options
  })
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`)
  }
  return result
}

function runChecked(command, args, options = {}) {
  const result = run(command, args, options)
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim()
    fail(
      `${command} ${args.join(' ')} failed with exit code ${result.status}${
        detail ? `\n${detail}` : ''
      }`
    )
  }
  return result
}

function runInteractive(command, args, options = {}) {
  log(`$ ${command} ${args.join(' ')}`)
  // Node refuses to spawn .cmd files without a shell (CVE-2024-27980). Callers
  // pass fixed strings only, so a single shell command line is safe here.
  const viaShell = command.endsWith('.cmd')
  const result = viaShell
    ? spawnSync([command, ...args].join(' '), {
        cwd: repositoryRoot,
        stdio: 'inherit',
        shell: true,
        ...options
      })
    : spawnSync(command, args, {
        cwd: repositoryRoot,
        stdio: 'inherit',
        ...options
      })
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function git(args) {
  return runChecked('git', args)
}

async function fileExists(target) {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

async function readVersion() {
  const raw = await readFile(packageJsonPath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('package.json is not valid JSON.')
  }
  const version = parsed.version
  if (typeof version !== 'string') fail('package.json has no version string.')
  return version
}

async function resolveSigningKeyPath() {
  const configured = process.env.DONDOWNLOAD_UPDATE_SIGNING_KEY
  const candidate = configured
    ? path.resolve(configured)
    : DEFAULT_SIGNING_KEY_PATH
  if (!(await fileExists(candidate))) {
    const ciHint =
      process.env.GITHUB_ACTIONS === 'true'
        ? '\nIn GitHub Actions, add the private key as the UPDATE_SIGNING_KEY repository secret; the release workflow writes it to a temporary file.'
        : ''
    fail(
      `the update signing key is missing: ${candidate}\n` +
        'Generate it once outside this repository with\n' +
        '  node scripts/generate-update-signing-key.mjs "%USERPROFILE%\\.dondownload-release\\update-signing-key.pem"\n' +
        'and back it up. Set DONDOWNLOAD_UPDATE_SIGNING_KEY to use a different path.\n' +
        'A release without the key cannot be served as an authenticated update.' +
        ciHint
    )
  }
  return candidate
}

function sourcesDirectory() {
  const configured = process.env.DONDOWNLOAD_RELEASE_SOURCES_DIR
  return configured ? path.resolve(configured) : DEFAULT_SOURCES_DIRECTORY
}

/**
 * Refuse unless the working tree is clean. Locally the script also requires
 * master to match origin/master. In CI the tag has already been pushed, so the
 * branch/remote-sync check does not apply; the tag/HEAD check replaces it.
 */
function verifyGitState(ci) {
  if (!ci) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
    if (branch !== 'master') {
      fail(`releases are cut from master; the current branch is "${branch}".`)
    }
  }

  const status = git(['status', '--porcelain']).stdout.trim()
  if (status !== '') {
    fail(`the working tree is not clean:\n${status}`)
  }

  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  if (ci) {
    log(`git state ok: clean tree at ${head} (CI mode).`)
    return head
  }

  const fetched = run('git', ['fetch', '--quiet', 'origin', 'master'])
  if (fetched.status !== 0) {
    fail(
      `git fetch origin master failed; the release must be cut from an up-to-date master.\n${(
        fetched.stderr ?? ''
      ).trim()}`
    )
  }

  const remote = git(['rev-parse', 'origin/master']).stdout.trim()
  if (head !== remote) {
    fail(
      `HEAD ${head} is not in sync with origin/master ${remote}.\n` +
        'Pull or push first; a release tag must point at the published master commit.'
    )
  }
  log(`git state ok: master at ${head}.`)
  return head
}

/**
 * CI mode never creates or pushes a tag. The release workflow starts from a
 * pushed `v<version>` tag, so only confirm that the tag is this commit and that
 * the checked-out ref is that tag.
 */
function verifyCiTag(version, head) {
  const tag = releaseTag(version)
  // On a tag push GITHUB_REF_NAME is the tag; on workflow_dispatch it is the
  // branch the run started from, which says nothing about the checkout, so the
  // refs/tags check below is the authoritative one.
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    const refName = process.env.GITHUB_REF_NAME
    if (refName && refName !== tag) {
      fail(
        `the workflow was started from tag "${refName}" but package.json declares ${version} (tag ${tag}).`
      )
    }
  }
  const existing = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
  if (existing.status !== 0) {
    fail(
      `tag ${tag} does not exist in this checkout. The release workflow must run from the pushed tag.`
    )
  }
  const commit = existing.stdout.trim()
  if (commit !== head) {
    fail(
      `tag ${tag} points at ${commit}, not at HEAD ${head}. ` +
        'Refusing to build a release from a different commit.'
    )
  }
  log(`tag ${tag} matches HEAD ${commit}.`)
}

function buildInstaller() {
  log('Building the Windows installer (this stages vendor binaries locally)…')
  runInteractive(npmCommand(), ['run', 'build:installer'])
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), {
    withFileTypes: true
  })
  const files = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relative)))
    } else if (entry.isFile()) {
      files.push(relative)
    }
  }
  return files
}

/**
 * Build the Chromium zip and the unsigned Firefox xpi. Both contain the same
 * files with `manifest.json` at the archive root; the image and CSS assets are
 * included, and `.d.ts`/test/source-map files are not.
 */
async function buildExtensionPackages(version) {
  const relativePaths = selectExtensionFiles(
    await listFiles(extensionDirectory)
  )
  if (relativePaths.length === 0) {
    fail(`no extension files were found in ${extensionDirectory}.`)
  }
  const entries = []
  for (const relativePath of relativePaths) {
    entries.push({
      path: relativePath,
      data: await readFile(
        path.join(extensionDirectory, ...relativePath.split('/'))
      )
    })
  }
  const archive = createZipArchive(entries)
  const names = extensionAssetNames(version)
  const outputs = []
  for (const name of [names.chromium, names.firefox]) {
    const target = path.join(distDirectory, name)
    await writeFile(target, archive)
    outputs.push(target)
  }
  log(
    `Packaged ${relativePaths.length} extension files into ${names.chromium} and ${names.firefox}.`
  )
  return outputs
}

/**
 * Write and sign dist/SHA256SUMS.txt. The signing key path is passed through the
 * environment so the checksum script owns the signing implementation; the file
 * already covers the extension packages built above.
 */
function writeChecksums(signingKeyPath) {
  log('Hashing and signing release assets…')
  runInteractive(process.execPath, ['scripts/release-checksums.mjs'], {
    env: {
      ...process.env,
      DONDOWNLOAD_UPDATE_SIGNING_KEY: signingKeyPath
    }
  })
}

async function sha256File(target) {
  const bytes = await readFile(target)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Optional GPL source archives the release owner keeps outside the repository.
 * Nothing is downloaded here; the directory is simply scanned.
 */
async function collectSourceArchives() {
  const directory = sourcesDirectory()
  let names
  try {
    names = await readdir(directory)
  } catch {
    warn(
      `no local source archive directory at ${directory}; THIRD-PARTY-SOURCES.txt will note the gap.`
    )
    return []
  }

  const archives = []
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const fullPath = path.join(directory, name)
    const info = await stat(fullPath)
    if (!info.isFile()) continue
    const origin = SOURCE_ARCHIVE_ORIGINS.find(({ pattern }) =>
      pattern.test(name)
    )
    archives.push({
      name,
      path: fullPath,
      sizeBytes: info.size,
      sha256: await sha256File(fullPath),
      sourceUrl: origin?.sourceUrl ?? ''
    })
  }
  if (archives.length === 0) {
    warn(`no source archives were found in ${directory}.`)
  } else {
    log(`Found ${archives.length} local source archive(s) in ${directory}.`)
  }
  return archives
}

async function writeThirdPartySources(version, sourceArchives) {
  const target = path.join(distDirectory, THIRD_PARTY_SOURCES_ASSET_NAME)
  await writeFile(
    target,
    renderThirdPartySourcesText({
      version,
      components: GPL_COMPONENTS,
      sourceArchives
    }),
    'utf8'
  )
  log(`Wrote ${target}.`)
  return target
}

/**
 * Resolve every asset to an absolute path and refuse to continue while one is
 * missing, so a draft release is never created with a partial asset set.
 */
async function collectAssets(version, sourceArchives) {
  const hasBlockmap = await fileExists(
    path.join(distDirectory, installerBlockmapAssetName(version))
  )
  if (!hasBlockmap) {
    warn(
      `no ${installerBlockmapAssetName(version)} in dist; it is optional for a full download.`
    )
  }
  const names = buildReleaseAssetList({
    version,
    hasBlockmap,
    sourceArchives: sourceArchives.map((archive) => archive.name)
  })

  const assets = []
  for (const name of names) {
    const source = sourceArchives.find((archive) => archive.name === name)
    const absolute = source ? source.path : path.join(distDirectory, name)
    if (!(await fileExists(absolute))) {
      fail(`expected release asset is missing: ${absolute}`)
    }
    assets.push({ name, path: absolute })
  }
  return assets
}

async function writeReleaseNotes(version) {
  const target = path.join(distDirectory, `release-notes-${releaseTag(version)}.md`)
  let notes = null
  try {
    notes = extractChangelogSection(await readFile(changelogPath, 'utf8'), version)
  } catch {
    // A missing CHANGELOG.md is not fatal; fall back to placeholder notes.
  }
  if (notes === null) {
    warn(
      `CHANGELOG.md has no "## [${version}]" section; writing placeholder release notes.`
    )
    notes =
      `DonDownload ${version}\n\n` +
      'See CHANGELOG.md in the repository for the changes in this release.\n'
  }
  await writeFile(target, notes, 'utf8')
  log(`Wrote ${target}.`)
  return target
}

/** Create the tag if needed and push it, without ever moving an existing tag. */
function ensureTag(version, head) {
  const tag = releaseTag(version)
  const existing = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
  if (existing.status === 0) {
    const commit = existing.stdout.trim()
    if (commit !== head) {
      fail(
        `tag ${tag} already exists at ${commit}, not at HEAD ${head}. ` +
          'Refusing to move a published release tag.'
      )
    }
    log(`Tag ${tag} already exists at HEAD.`)
  } else {
    runChecked('git', ['tag', tag])
    log(`Created tag ${tag}.`)
  }

  const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  const remoteLine = remote.stdout.trim()
  if (remoteLine === '') {
    runChecked('git', ['push', 'origin', `refs/tags/${tag}`])
    log(`Pushed tag ${tag} to origin.`)
    return
  }
  // An annotated tag is listed as its tag object; the peeled `^{}` line is the commit.
  const peeled = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`]).stdout.trim()
  const remoteSha = (peeled || remoteLine).split(/\s+/)[0]
  if (remoteSha !== head) {
    fail(
      `origin already has tag ${tag} at ${remoteSha}, not at HEAD ${head}.`
    )
  }
  log(`Tag ${tag} is already on origin.`)
}

function gh(args) {
  return run('gh', args)
}

/** Create the draft release, or refresh the assets of an existing draft. */
function publishDraftRelease(version, assets, notesPath) {
  const tag = releaseTag(version)
  const probe = gh(['release', 'view', tag, '--json', 'isDraft'])
  if (probe.status === 0) {
    let isDraft = false
    try {
      isDraft = JSON.parse(probe.stdout).isDraft === true
    } catch {
      fail(`could not read the existing GitHub release ${tag}.`)
    }
    if (!isDraft) {
      fail(
        `GitHub release ${tag} is already published. Refusing to change a ` +
          'published release; upload a new version instead.'
      )
    }
    log(`Draft release ${tag} exists; uploading assets with --clobber.`)
    runInteractive('gh', [
      'release',
      'upload',
      tag,
      ...assets.map((asset) => asset.path),
      '--clobber'
    ])
    return
  }

  const title = `DonDownload ${version}`
  log(`Creating draft GitHub release ${tag}.`)
  runInteractive('gh', [
    'release',
    'create',
    tag,
    '--draft',
    '--title',
    title,
    '--notes-file',
    notesPath,
    ...assets.map((asset) => asset.path)
  ])
}

function parseArguments(argv) {
  const options = { publish: false, ci: false, help: false }
  for (const argument of argv) {
    if (argument === '--publish') {
      options.publish = true
    } else if (argument === '--ci') {
      options.ci = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      fail(`unknown argument: ${argument}`)
    }
  }
  return options
}

function printHelp() {
  log(
    [
      'Usage: npm run release [-- --publish | --ci]',
      '',
      'Without --publish: build the installer, the extension packages and the',
      'signed checksum file, then print the exact assets and commands that a',
      'publish run would use. Nothing is tagged, pushed or uploaded.',
      '',
      'With --publish: the same build, then create and push the tag and create a',
      'DRAFT GitHub release with every asset. Publish the draft manually after',
      'review.',
      '',
      'With --ci (or when GITHUB_ACTIONS=true): skip the "on master and in sync',
      'with origin" check, require the already-pushed tag to point at HEAD, and',
      'never create or push a tag. .github/workflows/release.yml uses this form.',
      '--ci --publish drafts the GitHub release from the existing tag.'
    ].join('\n')
  )
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const ci = options.ci || process.env.GITHUB_ACTIONS === 'true'
  const version = await readVersion()
  const tag = releaseTag(version)
  log(
    ci
      ? `Preparing DonDownload ${version} (tag ${tag}) in CI mode.`
      : `Preparing DonDownload ${version} (tag ${tag}).`
  )

  const head = verifyGitState(ci)
  if (ci) {
    verifyCiTag(version, head)
  }
  const signingKeyPath = await resolveSigningKeyPath()
  log(`Using update signing key ${signingKeyPath}.`)
  if (options.publish) {
    runChecked('gh', ['--version'])
  }

  buildInstaller()
  await buildExtensionPackages(version)
  writeChecksums(signingKeyPath)

  const sourceArchives = await collectSourceArchives()
  await writeThirdPartySources(version, sourceArchives)
  const assets = await collectAssets(version, sourceArchives)
  const notesPath = await writeReleaseNotes(version)

  log('')
  log(`Release assets for ${tag}:`)
  for (const asset of assets) {
    log(`  ${asset.name}`)
  }
  log(`  (release notes: ${notesPath})`)

  if (!options.publish) {
    log('')
    log('Dry run: nothing was tagged, pushed or uploaded. A publish run would:')
    if (!ci) {
      log(`  git tag ${tag}`)
      log(`  git push origin refs/tags/${tag}`)
    }
    log(
      `  gh release create ${tag} --draft --title "DonDownload ${version}" --notes-file "${notesPath}" <assets>`
    )
    log('where <assets> are the files listed above.')
    log('')
    log('Re-run with --publish to create the draft release.')
    return
  }

  if (!ci) {
    ensureTag(version, head)
  }
  publishDraftRelease(version, assets, notesPath)
  log('')
  log(
    `Draft release ${tag} is ready. Review the assets on GitHub and publish it manually; ` +
      'drafts are invisible to the application updater.'
  )
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`release failed: ${detail}\n`)
  process.exitCode = 1
})
