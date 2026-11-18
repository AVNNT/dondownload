/**
 * Hand-written types for `scripts/release-lib.mjs`, so TypeScript tests can
 * import the pure release helpers without enabling `allowJs` for the whole
 * project. Keep this in sync with the module's exports.
 */
export const RELEASE_VERSION_PATTERN: RegExp
export const INSTALLER_ASSET_PATTERN: RegExp
export const EXTENSION_ASSET_PATTERN: RegExp
export const CHECKSUMS_ASSET_NAME: string
export const CHECKSUMS_SIGNATURE_ASSET_NAME: string
export const THIRD_PARTY_SOURCES_ASSET_NAME: string

export interface ReleaseAssetNames {
  chromium: string
  firefox: string
}

export interface ChecksumFiles {
  installers: string[]
  extensions: string[]
  all: string[]
}

export interface ReleaseAssetListOptions {
  version: string
  hasBlockmap?: boolean
  sourceArchives?: string[]
}

export interface ZipEntryInput {
  path: string
  data: Uint8Array
}

export interface SourceArchiveEntry {
  name: string
  sizeBytes: number
  sha256: string
  sourceUrl: string
}

export interface GplComponentEntry {
  name: string
  version: string
  license: string
  sourceUrl: string
  buildInfo?: string
  binary: string
}

export interface ThirdPartySourcesInput {
  version: string
  components: GplComponentEntry[]
  sourceArchives?: SourceArchiveEntry[]
}

export function requireReleaseVersion(version: unknown): string
export function releaseTag(version: string): string
export function installerAssetName(version: string): string
export function installerBlockmapAssetName(version: string): string
export function extensionAssetNames(version: string): ReleaseAssetNames
export function isChecksummedAssetName(name: string): boolean
export function selectChecksumFiles(names: readonly string[]): ChecksumFiles
export function isExtensionPackageFile(relativePath: string): boolean
export function selectExtensionFiles(relativePaths: readonly string[]): string[]
export function buildReleaseAssetList(
  options: ReleaseAssetListOptions
): string[]
export function crc32(bytes: Uint8Array): number
export function createZipArchive(entries: ZipEntryInput[]): Buffer
export function extractChangelogSection(
  markdown: string,
  version: string
): string | null
export function renderThirdPartySourcesText(input: ThirdPartySourcesInput): string
