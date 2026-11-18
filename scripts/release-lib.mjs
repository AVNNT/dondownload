/**
 * Pure helpers for the local release pipeline.
 *
 * `scripts/release.mjs` and `scripts/release-checksums.mjs` own all file and
 * process work; everything here is deterministic and free of I/O so unit tests
 * can cover the release contract without building an installer.
 *
 * The asset names must stay in sync with `electron-builder.yml`
 * (`artifactName: DonDownload-${version}-${arch}-setup.${ext}`) and with the
 * updater in `src/main/appUpdate/checker.ts` (`INSTALLER_PATTERN`).
 */
import { deflateRawSync } from 'node:zlib'

/** Strict `X.Y.Z` (optionally prerelease) release version. */
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const INSTALLER_ASSET_PATTERN =
  /^DonDownload-(\d+\.\d+\.\d+)-x64-setup\.exe$/
export const EXTENSION_ASSET_PATTERN =
  /^dondownload-extension-(?:chromium|firefox)-(\d+\.\d+\.\d+)\.(?:zip|xpi)$/

export const CHECKSUMS_ASSET_NAME = 'SHA256SUMS.txt'
export const CHECKSUMS_SIGNATURE_ASSET_NAME = 'SHA256SUMS.txt.sig'
export const THIRD_PARTY_SOURCES_ASSET_NAME = 'THIRD-PARTY-SOURCES.txt'

/** Directories and file kinds that never belong in an extension package. */
const EXCLUDED_EXTENSION_SUFFIXES = [
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.map',
  '.test.js',
  '.test.mjs',
  '.test.ts',
  '.spec.js',
  '.spec.ts'
]

/** Throw unless `version` is a supported release version. */
export function requireReleaseVersion(version) {
  if (typeof version !== 'string' || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Unsupported release version: ${String(version)}`)
  }
  return version
}

/** `1.0.0` -> `v1.0.0`. The updater accepts both forms; releases use `v`. */
export function releaseTag(version) {
  return `v${requireReleaseVersion(version)}`
}

/**
 * True when `tag` is exactly the release tag for `version`. The CI release
 * workflow uses this to refuse a tag that does not match `package.json`.
 */
export function releaseTagMatchesVersion(tag, version) {
  if (typeof tag !== 'string' || typeof version !== 'string') return false
  try {
    return tag === releaseTag(version)
  } catch {
    return false
  }
}

/** `DonDownload-1.0.0-x64-setup.exe` */
export function installerAssetName(version) {
  return `DonDownload-${requireReleaseVersion(version)}-x64-setup.exe`
}

/** `DonDownload-1.0.0-x64-setup.exe.blockmap` */
export function installerBlockmapAssetName(version) {
  return `${installerAssetName(version)}.blockmap`
}

/**
 * The two extension packages: a Chromium "load unpacked" zip and an unsigned
 * Firefox `.xpi`. Both contain the same files with `manifest.json` at the root.
 */
export function extensionAssetNames(version) {
  const safe = requireReleaseVersion(version)
  return {
    chromium: `dondownload-extension-chromium-${safe}.zip`,
    firefox: `dondownload-extension-firefox-${safe}.xpi`
  }
}

/** True for a file name the checksum file hashes (installer or extension). */
export function isChecksummedAssetName(name) {
  return INSTALLER_ASSET_PATTERN.test(name) || EXTENSION_ASSET_PATTERN.test(name)
}

/**
 * Split dist file names into installers and extension packages, sorted, with
 * installers first. The updater scans every line for its installer, but keeping
 * the installer first also keeps simple external parsers working.
 */
export function selectChecksumFiles(names) {
  const installers = names
    .filter((name) => INSTALLER_ASSET_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right))
  const extensions = names
    .filter((name) => EXTENSION_ASSET_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right))
  return { installers, extensions, all: [...installers, ...extensions] }
}

/** True when an extension file should be packaged into the zip/xpi. */
export function isExtensionPackageFile(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.startsWith('../')) return false
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) {
    return false
  }
  const base = segments[segments.length - 1]
  if (base === undefined || base.startsWith('.')) return false
  const lower = base.toLowerCase()
  return !EXCLUDED_EXTENSION_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/** Filter and sort repository-relative extension file paths for packaging. */
export function selectExtensionFiles(relativePaths) {
  return relativePaths
    .map((relativePath) => relativePath.replace(/\\/g, '/'))
    .filter((relativePath) => isExtensionPackageFile(relativePath))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Every asset a GitHub release for `version` must carry, as dist-relative
 * names. Source archives are optional and are appended unchanged.
 */
export function buildReleaseAssetList(options) {
  const version = requireReleaseVersion(options.version)
  const names = [installerAssetName(version)]
  if (options.hasBlockmap === true) {
    names.push(installerBlockmapAssetName(version))
  }
  const extension = extensionAssetNames(version)
  names.push(extension.chromium, extension.firefox)
  names.push(CHECKSUMS_ASSET_NAME, CHECKSUMS_SIGNATURE_ASSET_NAME)
  names.push(THIRD_PARTY_SOURCES_ASSET_NAME)
  for (const archive of options.sourceArchives ?? []) {
    if (typeof archive !== 'string' || archive.length === 0) {
      throw new Error('A source archive name must be a non-empty string.')
    }
    names.push(archive)
  }
  return names
}

/* ------------------------------------------------------------------------- *
 * Minimal deterministic ZIP writer.
 *
 * Node has no built-in zip creation, and a few hundred lines of well-understood
 * ZIP structure is preferable to a new dependency in a release script. Entries
 * are deflated (or stored when deflating does not help) with a fixed 1980-01-01
 * timestamp so the same inputs always produce identical bytes.
 * ------------------------------------------------------------------------- */

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_VERSION_NEEDED = 20
const ZIP_FLAG_UTF8 = 1 << 11
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8
const ZIP_DOS_DATE = 0x0021 // 1980-01-01
const ZIP_DOS_TIME = 0x0000
const ZIP_UNIX_REGULAR_FILE = 0o100644

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** Standard ZIP CRC-32 of `bytes`, as an unsigned 32-bit number. */
export function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function isSafeArchivePath(entryPath) {
  if (entryPath.length === 0 || entryPath.length > 4096) return false
  if (entryPath.includes('\\')) return false
  if (entryPath.startsWith('/') || /^[A-Za-z]:/.test(entryPath)) return false
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
  if (/[\u0000-\u001f\u007f]/.test(entryPath)) return false
  const segments = entryPath.split('/')
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..'
  )
}

/**
 * Build a ZIP archive from `[{ path, data }]` entries. Paths must be relative
 * and use `/` separators. Directory entries are not written.
 */
export function createZipArchive(entries) {
  const prepared = entries
    .map((entry) => {
      const entryPath = String(entry.path)
      if (!isSafeArchivePath(entryPath)) {
        throw new Error(`Unsafe archive entry path: ${entryPath}`)
      }
      const data = Buffer.from(entry.data)
      const deflated = deflateRawSync(data, { level: 9 })
      const useDeflate = deflated.byteLength < data.byteLength
      return {
        nameBytes: Buffer.from(entryPath, 'utf8'),
        crc: crc32(data),
        method: useDeflate ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORED,
        stored: useDeflate ? deflated : data,
        uncompressedSize: data.byteLength
      }
    })
    .sort((left, right) => left.nameBytes.compare(right.nameBytes))

  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of prepared) {
    const local = Buffer.alloc(30)
    local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(ZIP_VERSION_NEEDED, 4)
    local.writeUInt16LE(ZIP_FLAG_UTF8, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(ZIP_DOS_TIME, 10)
    local.writeUInt16LE(ZIP_DOS_DATE, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.stored.byteLength, 18)
    local.writeUInt32LE(entry.uncompressedSize, 22)
    local.writeUInt16LE(entry.nameBytes.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, entry.nameBytes, entry.stored)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE((3 << 8) | ZIP_VERSION_NEEDED, 4) // made by UNIX
    central.writeUInt16LE(ZIP_VERSION_NEEDED, 6)
    central.writeUInt16LE(ZIP_FLAG_UTF8, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(ZIP_DOS_TIME, 12)
    central.writeUInt16LE(ZIP_DOS_DATE, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.stored.byteLength, 20)
    central.writeUInt32LE(entry.uncompressedSize, 24)
    central.writeUInt16LE(entry.nameBytes.byteLength, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE((ZIP_UNIX_REGULAR_FILE << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, entry.nameBytes)

    offset += local.byteLength + entry.nameBytes.byteLength + entry.stored.byteLength
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(prepared.length, 8)
  end.writeUInt16LE(prepared.length, 10)
  end.writeUInt32LE(centralDirectory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, end])
}

/**
 * Extract the release-notes body for `version` from a Keep-a-Changelog file.
 * Returns null when the section is missing or empty.
 */
export function extractChangelogSection(markdown, version) {
  if (typeof markdown !== 'string') return null
  const safe = requireReleaseVersion(version)
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const escaped = safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^##\\s+(?:\\[)?v?${escaped}(?:\\])?(?:\\s|$)`)
  const start = lines.findIndex((line) => heading.test(line.trimEnd()))
  if (start < 0) return null

  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^##\s+/.test(line)) break
    body.push(line)
  }
  while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift()
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') {
    body.pop()
  }
  return body.length === 0 ? null : `${body.join('\n')}\n`
}

/**
 * Plain-text written offer / pointer that ships next to the installer. It lists
 * every GPL-covered component with its exact shipped version, the upstream
 * source location and, when the release owner attached archives locally, the
 * SHA-256 of each attached archive.
 */
export function renderThirdPartySourcesText(input) {
  const version = requireReleaseVersion(input.version)
  const lines = [
    `DonDownload ${version} - third-party corresponding source`,
    '',
    'This file records where the corresponding source for the GPL-covered',
    'components shipped in this release can be obtained. It is a pointer and a',
    'written-offer summary, not a legal opinion.',
    '',
    'The DonDownload application itself is MIT licensed. Each bundled program',
    'below keeps its own license; see licenses/THIRD_PARTY_NOTICES.md inside the',
    `installer and docs/licensing-release-audit.md in the source repository.`,
    '',
    'GPL-covered components',
    '----------------------'
  ]

  for (const component of input.components) {
    lines.push(
      '',
      `${component.name} ${component.version}`,
      `  License: ${component.license}`,
      `  Upstream source: ${component.sourceUrl}`
    )
    if (component.buildInfo) {
      lines.push(`  Build information: ${component.buildInfo}`)
    }
    lines.push(`  Shipped binary: ${component.binary}`)
    if (component.binaryUrl) {
      lines.push(
        `  Shipped binary download: ${component.binaryUrl}${
          component.binarySha256 ? ` (SHA-256 ${component.binarySha256})` : ''
        }`
      )
    }
  }

  lines.push('', 'Attached source archives', '------------------------')
  const archives = input.sourceArchives ?? []
  if (archives.length === 0) {
    lines.push(
      '',
      'No source archive was attached to this release build. The release owner',
      'must attach reviewed corresponding-source archives under',
      '"<release assets>" before this release is distributed, or arrange a',
      'valid written offer for the exact shipped binaries.'
    )
  } else {
    for (const archive of archives) {
      lines.push(
        '',
        `${archive.name} (${archive.sizeBytes} bytes)`,
        `  SHA-256: ${archive.sha256}`,
        archive.sourceUrl
          ? `  Upstream source: ${archive.sourceUrl}`
          : '  Upstream source: not mapped; supplied by the release owner'
      )
    }
  }

  lines.push(
    '',
    'Requesting source',
    '-----------------',
    '',
    'If a source archive above is missing or unreadable, request the complete',
    'corresponding source for the exact shipped binaries from the DonDownload',
    'release owner through the repository issue tracker at',
    'https://github.com/AVNNT/dondownload/issues. This offer is valid for at',
    'least three years after the release was published.',
    ''
  )
  return lines.join('\n')
}
