import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { UrlSizeProbe } from '@shared/types'
import {
  resolvePublicTargetAddresses,
  type PublicTargetLookup
} from './publicTarget'

export const URL_SIZE_TIMEOUT_MS = 5_000
const MAX_REDIRECTS = 5

/**
 * Bounded anonymous HEAD probe that reports a direct link's total bytes,
 * or null when the size cannot be known.
 *
 * The renderer reaches this through the `probe-url-size` IPC channel, so every
 * URL and every redirect hop is validated against the public-target policy
 * first: localhost, private, link-local, reserved and metadata addresses are
 * refused before a socket is opened. The connection is also pinned to the
 * addresses that were just validated, so a rebinding resolver cannot steer the
 * probe at a private address after the check. Any error, timeout, non-2xx
 * response or missing content-length fails closed to null.
 */
export async function probeUrlSize(
  url: string,
  options: {
    /** The public-target guard. Production always uses the system resolver. */
    lookup?: PublicTargetLookup
    /**
     * Overrides the socket target. Tests use it to reach a loopback fixture
     * through a public URL; production always pins the validated addresses.
     */
    connectLookup?: HeadConnectLookup
  } = {}
): Promise<UrlSizeProbe> {
  let current: URL
  try {
    current = new URL(url)
  } catch {
    return { size: null }
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return { size: null }
    }
    if (current.username || current.password) return { size: null }

    let connectLookup: HeadConnectLookup
    try {
      const addresses = await resolvePublicTargetAddresses(
        current.href,
        options.lookup
      )
      connectLookup = options.connectLookup ?? pinResolvedAddresses(addresses)
    } catch {
      return { size: null }
    }

    const response = await requestHead(current, connectLookup)
    if (response === null) return { size: null }
    if (isRedirect(response.status)) {
      const location = headerString(response.headers.location)
      if (location === null) return { size: null }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return { size: null }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { size: null }
      }
      current = next
      continue
    }
    if (response.status >= 200 && response.status < 300) {
      return { size: parseContentLength(response.headers['content-length']) }
    }
    return { size: null }
  }
  return { size: null }
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  )
}

type HeadConnectLookup = (
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | ReadonlyArray<{ address: string; family: number }>,
    family?: number
  ) => void
) => void

/**
 * Connect only to the addresses the public-target guard just approved. The
 * URL host is still used for SNI and the Host header; only the socket target
 * is fixed, which closes the check-then-resolve gap.
 */
function pinResolvedAddresses(
  addresses: readonly { address: string; family: number }[]
): HeadConnectLookup {
  return (_hostname, _options, callback) => {
    if (addresses.length === 0) {
      callback(
        Object.assign(new Error('No public address is available.'), {
          code: 'ENOTFOUND'
        }),
        [],
        0
      )
      return
    }
    // Node's client inspects the address list shape, not the family argument,
    // so every call (including the single-address one) gets the array form.
    callback(
      null,
      addresses.map(({ address, family }) => ({ address, family }))
    )
  }
}

interface HeadResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
}

function requestHead(
  target: URL,
  lookup: HeadConnectLookup
): Promise<HeadResponse | null> {
  const sendRequest =
    target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: HeadResponse | null): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let request: ReturnType<typeof httpRequest>
    try {
      // Explicit parts, not a URL object: node:http ignores `lookup` when the
      // options are a URL, which would drop the address pinning.
      request = sendRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: 'HEAD',
          agent: false,
          lookup: lookup as never
        },
        (response) => {
          // Only the headers are of interest; close the socket immediately.
          response.destroy()
          finish({
            status: response.statusCode ?? 0,
            headers: response.headers
          })
        }
      )
    } catch {
      finish(null)
      return
    }
    request.setTimeout(URL_SIZE_TIMEOUT_MS, () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
    request.end()
  })
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

function parseContentLength(
  value: string | string[] | undefined
): number | null {
  if (typeof value !== 'string') return null
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0) return null
  return size
}
