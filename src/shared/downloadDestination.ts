/**
 * A folder the user chose for one download. The raw path is shown only for
 * confirmation; the renderer sends the opaque token back with the add request,
 * and main resolves it to the already-validated directory.
 */
export interface DownloadFolderChoice {
  token: string
  path: string
}

export const DOWNLOAD_DESTINATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function isDownloadDestinationToken(
  value: unknown
): value is string {
  return (
    typeof value === 'string' && DOWNLOAD_DESTINATION_TOKEN_PATTERN.test(value)
  )
}
