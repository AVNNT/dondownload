import { lookup as nodeLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '../errors'

/**
 * Public-network target validation shared by the media analyzer and the direct
 * browser-capture queue. Both paths hand a URL to a network client (yt-dlp or
 * aria2), so they must reject localhost, private, link-local, reserved and
 * non-global addresses before any connection is attempted.
 */
export interface PublicLookupAddress {
  address: string
  family: number
}

export type PublicTargetLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<readonly PublicLookupAddress[]>

export function defaultPublicTargetLookup(
  hostname: string,
  options: { all: true; verbatim: true }
): Promise<readonly PublicLookupAddress[]> {
  return nodeLookup(hostname, options)
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map((entry) => Number(entry))
  const [a, b, c] = parts
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return false
  }

  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 192 && b === 31 && c === 196) return false
  if (a === 192 && b === 52 && c === 193) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 192 && b === 175 && c === 48) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

function ipv6IsPublic(address: string): boolean {
  const withoutZone = address.split('%')[0] ?? ''
  const normalized = withoutZone.toLowerCase()
  if (normalized.length === 0 || normalized === '::' || normalized === '::1') {
    return false
  }

  // Allow only global unicast 2000::/3. This excludes loopback, link-local,
  // unique-local, multicast, IPv4-mapped addresses and transition mechanisms.
  const first = normalized.split(':')[0]
  if (!first) return false
  const value = Number.parseInt(first, 16)
  if (!Number.isInteger(value)) return false
  if (value < 0x2000 || value > 0x3fff) return false
  if (value === 0x2002) return false
  if (value === 0x2001 && normalized.startsWith('2001:0:')) return false
  if (value === 0x2001) {
    const groups = normalized.split(':')
    const second = Number.parseInt(groups[1] || '0', 16)
    const third = Number.parseInt(groups[2] || '0', 16)
    if (second === 0x0db8) return false
    if (second === 0x0002 && third === 0) return false
    if ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020) {
      return false
    }
  }
  return true
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return ipv4IsPublic(address)
  if (family === 6) return ipv6IsPublic(address)
  return false
}

/**
 * Resolve the host and reject any address that is not globally routable.
 * DNS is checked once immediately before the network client starts; the
 * client resolves again through its own stack, so rebinding between the two
 * steps remains a residual risk that would require resolver pinning or a
 * controlled proxy to remove.
 */
export async function assertPublicTarget(
  url: string,
  lookup: PublicTargetLookup = defaultPublicTargetLookup
): Promise<void> {
  const parsed = new URL(url)
  let host = parsed.hostname
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  host = host.replace(/\.$/, '').toLowerCase()

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new AppError(
      'MEDIA_TARGET_NOT_PUBLIC',
      'Local and private network addresses are not supported.'
    )
  }

  if (host.includes('%')) {
    throw new AppError(
      'MEDIA_TARGET_NOT_PUBLIC',
      'Local and private network addresses are not supported.'
    )
  }

  const literalFamily = isIP(host)
  if (literalFamily !== 0) {
    if (!isPublicAddress(host)) {
      throw new AppError(
        'MEDIA_TARGET_NOT_PUBLIC',
        'Local and private network addresses are not supported.'
      )
    }
    return
  }

  let addresses: readonly PublicLookupAddress[]
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new AppError(
      'MEDIA_TARGET_UNRESOLVED',
      'The site address could not be resolved.'
    )
  }

  if (addresses.length === 0) {
    throw new AppError(
      'MEDIA_TARGET_UNRESOLVED',
      'The site address could not be resolved.'
    )
  }

  for (const entry of addresses) {
    if (!isPublicAddress(entry.address)) {
      throw new AppError(
        'MEDIA_TARGET_NOT_PUBLIC',
        'Local and private network addresses are not supported.'
      )
    }
  }
}
