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
  /** Exact upstream release asset the shipped binary was extracted from. */
  binaryUrl?: string
  binarySha256?: string
}

export interface ThirdPartySourcesInput {
  version: string
  components: GplComponentEntry[]
  sourceArchives?: SourceArchiveEntry[]
}

export function requireReleaseVersion(version: unknown): string
export function releaseTag(version: string): string
export function releaseTagMatchesVersion(tag: string, version: string): boolean
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

export const AMO_SIGNING_CHANNEL: string
export const WEB_EXT_VERSION: string
export const AMO_APPROVAL_TIMEOUT_MS: number
export const AMO_CREDENTIAL_ENV_VARS: string[]
export const AMO_SIGNATURE_ENTRIES: string[]

export interface AmoCredentials {
  apiKey: string
  apiSecret: string
}

export interface AmoSigningOptions {
  credentials?: AmoCredentials | null
  ci?: boolean
  publish?: boolean
  skipAmo?: boolean
}

export type AmoSigningPlan =
  | { action: 'sign'; reason: 'credentials' }
  | { action: 'skip'; reason: 'skip-flag' | 'missing-credentials' }

export function readAmoCredentials(env?: Record<string, string | undefined>): AmoCredentials | null
export function planAmoSigning(options: AmoSigningOptions): AmoSigningPlan
export function amoSignArguments(options: {
  sourceDirectory: string
  artifactsDirectory: string
}): string[]
export function amoSignEnvironment(
  credentials: AmoCredentials,
  env?: Record<string, string | undefined>
): Record<string, string | undefined>
export function listZipEntryNames(bytes: Uint8Array): string[]
export function findAmoSignatureEntry(entryNames: readonly string[]): string | null
