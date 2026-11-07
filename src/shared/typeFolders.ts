/**
 * IDM-style "sort downloads into folders by type".
 *
 * This module is renderer-safe and pure: it owns the single extension-to-folder
 * mapping and the small path-joining helper used by the main process. No file
 * system access happens here, and a disabled setting always returns the base
 * directory unchanged.
 */

export const TYPE_FOLDER_NAMES = [
  'Video',
  'Audio',
  'Images',
  'Archives',
  'Documents',
  'Programs'
] as const

export type TypeFolder = (typeof TYPE_FOLDER_NAMES)[number]

/**
 * Recognised extensions per folder. `.funscript` deliberately belongs to Video
 * even though it is not a media format: players expect the script next to its
 * video, with the same base name.
 */
const EXTENSIONS_BY_FOLDER: Readonly<Record<TypeFolder, readonly string[]>> = {
  Video: [
    'mp4',
    'mkv',
    'webm',
    'mov',
    'avi',
    'm4v',
    'ts',
    'flv',
    'wmv',
    'funscript'
  ],
  Audio: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac', 'wma'],
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'bmp', 'svg'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'xz', 'bz2', 'zst', 'iso'],
  Documents: [
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'txt',
    'rtf',
    'epub',
    'md',
    'csv',
    'odt'
  ],
  Programs: ['exe', 'msi', 'msix', 'apk', 'dmg', 'appimage']
}

const FOLDER_BY_EXTENSION: ReadonlyMap<string, TypeFolder> = new Map(
  TYPE_FOLDER_NAMES.flatMap((folder) =>
    EXTENSIONS_BY_FOLDER[folder].map(
      (extension) => [extension, folder] as const
    )
  )
)

/** The subfolder for a bare extension (`mp4`, `.MP4`), or null when unknown. */
export function typeFolderForExtension(extension: string): TypeFolder | null {
  const normalized = extension.trim().toLowerCase().replace(/^\./, '')
  return FOLDER_BY_EXTENSION.get(normalized) ?? null
}

/**
 * Last path extension of a filename or URL, without the dot and lowercased.
 * Query strings, fragments and both path separators are ignored.
 */
export function filenameExtension(filenameOrUrl: string): string {
  const withoutQuery = filenameOrUrl.split(/[?#]/, 1)[0] ?? ''
  const segment = withoutQuery.split(/[\\/]/).pop() ?? ''
  const dot = segment.lastIndexOf('.')
  if (dot <= 0 || dot === segment.length - 1) return ''
  return segment.slice(dot + 1).toLowerCase()
}

/** The type folder for a filename or URL, or null when it gets no subfolder. */
export function typeFolderForFilename(
  filenameOrUrl: string
): TypeFolder | null {
  return typeFolderForExtension(filenameExtension(filenameOrUrl))
}

/**
 * Join one type folder onto a download directory. Kept path-module free so the
 * shared contract can also be used by the renderer; the separator is inferred
 * from the existing directory, and Windows drive/UNC roots are preserved.
 */
export function typeFolderDirectory(
  baseDirectory: string,
  folder: TypeFolder
): string {
  const separator = baseDirectory.includes('\\') ? '\\' : '/'
  const trimmed = baseDirectory.replace(/[\\/]+$/, '')
  return `${trimmed}${separator}${folder}`
}

/**
 * Resolve the directory a new download should use. With sorting disabled (or
 * for an unknown extension) this is exactly the base default directory.
 */
export function resolveDownloadDirectory(
  baseDirectory: string,
  filenameOrUrl: string,
  sortByType: boolean
): string {
  if (!sortByType) return baseDirectory
  const folder = typeFolderForFilename(filenameOrUrl)
  return folder === null ? baseDirectory : typeFolderDirectory(baseDirectory, folder)
}
