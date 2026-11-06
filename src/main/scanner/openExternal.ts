import { isIP } from 'node:net'
import { isPublicAddress } from '../net/publicTarget'

/**
 * Main-only validation for an "Open in browser" action.
 *
 * The renderer never receives the URL: it sends an opaque scan item ID and main
 * resolves the stored URL. This guard is the last step before
 * `shell.openExternal` and rejects anything that is not a plain public HTTP(S)
 * page (loopback, private, link-local, device and credential-bearing URLs).
 */
const MAX_OPEN_URL_LENGTH = 4096

export function isPublicOpenableUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OPEN_URL_LENGTH ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.hostname.length === 0) return false

  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.includes('%')) return false
  const family = isIP(host)
  if (family !== 0 && !isPublicAddress(host)) return false
  return true
}
