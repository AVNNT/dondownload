/**
 * URL fragment policy.
 *
 * A fragment is normally a client-side anchor: it is never sent to a server and
 * it confuses file-name inference, so every normalizer drops it. MEGA is the one
 * exception. The decryption key of a public MEGA link lives in the fragment
 * (`https://mega.nz/file/<id>#<key>`), so dropping it turns a valid link into an
 * unusable one.
 *
 * This module is the single place that decides, and it also provides the
 * redaction used anywhere a MEGA URL could be logged or shown. The key must stay
 * in main-process memory only.
 */

const MEGA_HOSTNAMES: readonly string[] = ['mega.nz', 'mega.io', 'mega.co.nz']

/** True for a MEGA public-link host, with or without a `www.` prefix. */
export function isMegaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const bare = host.startsWith('www.') ? host.slice(4) : host
  return MEGA_HOSTNAMES.includes(bare)
}

/** True when a URL fragment carries data that must survive normalization. */
export function keepsUrlFragment(hostname: string): boolean {
  return isMegaHost(hostname)
}

/**
 * Drop the fragment from a URL for display or logging. Never throws, so it is
 * safe to apply to a value that was never validated.
 */
export function redactUrlFragment(value: string): string {
  const index = value.indexOf('#')
  return index === -1 ? value : value.slice(0, index)
}
