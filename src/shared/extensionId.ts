/**
 * The unpacked extension's stable ID, derived from the public key pinned in
 * `extension/manifest.json`. Chromium maps the first 16 bytes of the SHA-256
 * digest of the DER SubjectPublicKeyInfo to the `a`-`p` alphabet, and the
 * resulting ID no longer depends on the folder the extension is loaded from.
 *
 * The manifest's private key was discarded after generating the public half;
 * only the public key is committed here. `tests/extension-id.test.ts`
 * recomputes this value from the manifest so the two can never drift.
 */
export const DONDOWNLOAD_EXTENSION_ID = 'mikinloaillialkiannpcejdbmfbljhm'

/** Exact native messaging origin for the stable extension ID. */
export const DONDOWNLOAD_EXTENSION_ORIGIN = `chrome-extension://${DONDOWNLOAD_EXTENSION_ID}/`

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/

/** True only for an exact 32-character Chromium extension ID. */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && EXTENSION_ID_PATTERN.test(value)
}

/**
 * Map a 32-character lowercase hex SHA-256 prefix to Chromium's a-p extension
 * ID alphabet.
 */
export function extensionIdFromDigestHex(hex: string): string {
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error('Expected a 32-character lowercase hex SHA-256 prefix.')
  }
  return hex.replace(/[0-9a-f]/g, (character) =>
    String.fromCharCode(97 + Number.parseInt(character, 16))
  )
}

/** Exact `chrome-extension://<id>/` origin for a validated extension ID. */
export function extensionOrigin(value: unknown): string | null {
  return isExtensionId(value) ? `chrome-extension://${value}/` : null
}
