/**
 * A one-job browser Cookie belongs to the exact host and scheme it was
 * captured for. Redirects may change the path freely, but a cookie must never
 * be attached to another host (a CDN/S3 hop) or sent over plain HTTP when the
 * original request was HTTPS.
 *
 * `URL.host` includes the port, so a redirect to another port is treated as a
 * different origin as well.
 */
export function isCookieHopSafe(origin: URL, target: URL): boolean {
  return target.host === origin.host && target.protocol === origin.protocol
}
