/**
 * Privacy-safe redaction for everything the app writes to its logs.
 *
 * The app has always promised never to log download URLs. A log file makes that
 * promise easier to break by accident, so every line passes through here on its
 * way in. The rules are intentionally blunt:
 *
 * - every URL loses its path, query and credentials and becomes
 *   `<scheme>://<host>/`, so only the site stays visible;
 * - the user's profile path becomes `%USERPROFILE%`; other absolute Windows,
 *   UNC or long POSIX paths keep only a file extension (`<path>.mkv`);
 * - cookie, token, secret and password values, `Authorization` headers and
 *   other credential-shaped query parameters become `[redacted]`;
 * - long opaque tokens (base64 blobs, bearer secrets) are masked.
 *
 * Redaction never throws: an internal failure returns a fixed placeholder
 * instead of the original text, so unexpected input cannot leak through.
 */

const PLACEHOLDER = '[redacted]'
const NO_REDACTION = '[log entry could not be redacted]'
const LINE_BREAK = ' ' + String.fromCharCode(0x23ce) + ' '

const BACKSLASH = String.fromCharCode(92)
const SLASH = String.fromCharCode(47)
const QUOTE = String.fromCharCode(39)
const DOUBLE_QUOTE = String.fromCharCode(34)
const BACKTICK = String.fromCharCode(96)

const URL_PATTERN = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`)\]]+/g

const CREDENTIAL_QUERY_PATTERN =
  /([?&;])(token|access_token|refresh_token|id_token|auth|authorization|sig|signature|key|api_key|apikey|cookie|session|sessionid|password|passwd|pwd|secret|code|hdnts|hdnea|jwt|expires|policy|acl)=[^&#\s"']*/gi

/** `Authorization: ...` and friends; the whole value is a credential. */
const AUTH_HEADER_PATTERN =
  /(authorization|proxy-authorization|www-authenticate)\s*[:=][^\r\n]*/gi

/** A Cookie header carries the whole jar: the rest of the line goes too. */
const COOKIE_HEADER_PATTERN = /(cookie|set-cookie)\s*[:=][^\r\n]*/gi

const BEARER_PATTERN = /(bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi

const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9\-._~+/]{40,}={0,2}/g

/** `NAME=value` where the name itself says the value is a secret. */
// The name may consist only of the keyword (`token=…`, `secret=…`,
// `password=…`) or carry a prefix/suffix (`DONDOWNLOAD_API_TOKEN`,
// `auth_password`). The leading word boundary keeps the match from starting
// in the middle of an unrelated word, while the group itself has no minimum
// length so an exact keyword is redacted too. `&` ends the value so a query
// string's later parameters are left to the query-parameter rule (and are not
// swallowed by one long assignment).
const ENV_VALUE_PATTERN =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_KEY|APIKEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)[^\s,;}&]+/gi

export interface RedactOptions {
  /**
   * The user's home directories. Everything under them becomes
   * `%USERPROFILE%`. More specific entries must come first.
   */
  userPaths?: readonly string[]
  /** Literal values to scrub anywhere (for example a proxy password). */
  secretValues?: readonly string[]
}

/** Lower-case, backslash-normalized form used for prefix matching only. */
function normalizeForMatch(value: string): string {
  return value.split(SLASH).join(BACKSLASH).replace(/\\+$/, '').toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function userPathPatterns(userPaths: readonly string[]): RegExp[] {
  const seen = new Set<string>()
  const patterns: RegExp[] = []
  for (const entry of userPaths) {
    const normalized = normalizeForMatch(entry)
    if (normalized.length < 3 || seen.has(normalized)) continue
    seen.add(normalized)
    // Either slash direction and any letter case: Windows paths are
    // case-insensitive and a log may quote a URL-decoded form.
    const body = escapeRegExp(normalized).split('\\\\').join('[\\\\/]')
    patterns.push(new RegExp(`${body}(?![a-z0-9_])`, 'gi'))
  }
  return patterns
}

function redactUserPaths(text: string, userPaths: readonly string[]): string {
  let next = text
  for (const pattern of userPathPatterns(userPaths)) {
    next = next.replace(pattern, '%USERPROFILE%')
  }
  return next
}

/** Collapse a URL to `<origin>/`, dropping path, query, fragment and userinfo. */
function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (raw: string) => {
    // Trailing sentence punctuation belongs to the prose, not to the URL.
    const trimmed = raw.replace(/[.,;:!?]+$/, '')
    const suffix = raw.slice(trimmed.length)
    try {
      const parsed = new URL(trimmed)
      const origin =
        parsed.origin === 'null' ? `${parsed.protocol}//` : `${parsed.origin}/`
      return `${origin}${suffix}`
    } catch {
      // Not parseable as a URL: keep only the origin-shaped prefix.
      const colon = trimmed.indexOf('://')
      const rest = colon >= 0 ? trimmed.slice(colon + 3) : trimmed
      const authority = rest.split(/[/?#]/)[0] ?? ''
      const host = authority.includes('@')
        ? authority.slice(authority.lastIndexOf('@') + 1)
        : authority
      return `${trimmed.slice(0, Math.max(colon, 0) + 3)}${host}${suffix}`
    }
  })
}

/** True when [start, end) lies inside a URL origin in `text`. */
function insideUrl(text: string, start: number, end: number): boolean {
  const schemeAt = text.slice(0, start + 3).lastIndexOf('://')
  if (schemeAt < 1) return false
  const after = text.slice(end)
  const stop = after.search(/[\s"'<>`]|$/)
  return stop !== 0
}

/**
 * Apply one header rule to prose only. The word "cookie" inside a host name
 * must not swallow the host, so matches inside a URL origin are left alone.
 */
function applyHeaderRule(text: string, source: RegExp): string {
  const global = new RegExp(source.source, `${source.flags.replace('g', '')}g`)
  return text.replace(
    global,
    (whole: string, name: unknown, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2]
      if (typeof offset === 'number' && insideUrl(text, offset, offset + whole.length)) {
        return whole
      }
      return `${String(name)}: ${PLACEHOLDER}`
    }
  )
}

/** Keep the extension only: profile and folder names are personal too. */
function redactPath(pathText: string): string {
  const trimmed = pathText.replace(/[.,;:!?]+$/, '')
  let last = -1
  for (let index = 0; index < trimmed.length; index += 1) {
    if (isPathSeparator(trimmed[index])) last = index
  }
  const base = trimmed.slice(last + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot) : ''
  if (!/^\.[A-Za-z0-9]{1,8}$/.test(extension)) return '<path>'
  return `<path>${extension}`
}

function isPathSeparator(character: string | undefined): boolean {
  return character === BACKSLASH || character === SLASH
}

/** True at the start of the text, after whitespace, or after whitespace-ish. */
function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1] ?? ''
  return /[\s(=]/.test(previous) || previous === QUOTE || previous === DOUBLE_QUOTE
}

/** End (exclusive) of a path starting at `start`. */
function pathEnd(text: string, start: number): number {
  // A space may be part of a folder name (`Holiday 2024`, `My Videos`), so a
  // path keeps going across spaces. Ordinary prose that merely follows a short
  // relative fragment is handled before a path is even recognised (see
  // `isPathStart`), so stopping at the first space would leak later segments.
  let end = start
  while (end < text.length && !stopsToken(text[end] ?? '')) end += 1
  // Trailing sentence punctuation is not part of a path.
  while (end > start && /[.,;:!?]/.test(text[end - 1] ?? '')) end -= 1
  return end
}


function stopsToken(character: string): boolean {
  return (
    /[\r\n<>|?*]/.test(character) ||
    character === QUOTE ||
    character === DOUBLE_QUOTE ||
    character === BACKTICK
  )
}

/**
 * True when a Windows drive path starts at `index`.
 *
 * A drive path is recognised even without a preceding boundary: an error can
 * quote one inside another token (`openD:\Data\x.zip`). `X://` is explicitly
 * not a path, so a URL that was already collapsed to its origin (`https://`)
 * is never mistaken for drive `s:\`. A clock time (`12:30`) has no separator
 * after the colon and is likewise left alone.
 */
function isWindowsPathStart(text: string, index: number): boolean {
  const hasDrive =
    /[A-Za-z]/.test(text[index] ?? '') &&
    text[index + 1] === ':' &&
    isPathSeparator(text[index + 2])
  if (hasDrive) return !isPathSeparator(text[index + 3] ?? '')
  if (!isBoundary(text, index)) return false
  return (
    text[index] === BACKSLASH &&
    text[index + 1] === BACKSLASH &&
    /[A-Za-z0-9._$-]/.test(text[index + 2] ?? '')
  )
}

/** True when an absolute POSIX path starts at `index`. */
function isPosixPathStart(text: string, index: number): boolean {
  if (text[index] !== SLASH || !isBoundary(text, index)) return false
  // `https://host` is an origin, not a path; keep hosts intact.
  if (text[index - 1] === ':') return false
  if (text[index + 1] === SLASH || text[index + 2] === SLASH) return false
  return /[A-Za-z0-9._$-]/.test(text[index + 1] ?? '')
}

function redactAbsolutePaths(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    if (isWindowsPathStart(text, index) || isPosixPathStart(text, index)) {
      const end = pathEnd(text, index)
      result += redactPath(text.slice(index, end))
      index = end
      continue
    }
    result += text[index]
    index += 1
  }
  return result
}

function redactSecrets(text: string, secretValues: readonly string[]): string {
  let next = text
  for (const secret of secretValues) {
    if (secret.length < 4) continue
    next = next.split(secret).join(PLACEHOLDER)
  }
  return next
}

/**
 * Produce a log-safe single line. Never throws; an internal failure returns a
 * fixed placeholder rather than the unredacted input.
 */
export function redact(input: string, options: RedactOptions = {}): string {
  try {
    // One record per line keeps the file greppable and the tail bounded.
    let text = input.replace(/\r\n?/g, '\n').split('\n').join(LINE_BREAK)

    // Profile paths first: everything under them is the most sensitive text.
    text = redactUserPaths(text, options.userPaths ?? [])
    // URLs collapse to their origin, so the passes below cannot mistake a
    // path segment for a header value.
    text = redactUrls(text)
    text = applyHeaderRule(text, COOKIE_HEADER_PATTERN)
    text = applyHeaderRule(text, AUTH_HEADER_PATTERN)
    text = text.replace(
      CREDENTIAL_QUERY_PATTERN,
      (_whole: string, separator: string, name: string) =>
        `${separator}${name}=${PLACEHOLDER}`
    )
    text = text.replace(BEARER_PATTERN, (_whole: string, scheme: string) =>
      `${scheme} ${PLACEHOLDER}`
    )
    text = redactAbsolutePaths(text)
    text = redactSecrets(text, options.secretValues ?? [])
    text = text.replace(
      ENV_VALUE_PATTERN,
      (_whole: string, name: string, separator: string) =>
        `${name}${separator}${PLACEHOLDER}`
    )
    text = text.replace(OPAQUE_TOKEN_PATTERN, PLACEHOLDER)
    return text.trim()
  } catch {
    return NO_REDACTION
  }
}

/** A safe, bounded string form of an error or any thrown value. */
export function stringify(value: unknown): string {
  if (value instanceof Error) {
    const rawCode = (value as { code?: unknown }).code
    const code =
      typeof rawCode === 'string' || typeof rawCode === 'number'
        ? ` [${String(rawCode)}]`
        : ''
    return `${value.name}${code}: ${value.message}`
  }
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * Format one log call. `%s`/`%d` placeholders are filled from the extra
 * arguments, each redacted on its own; leftover arguments are appended so a
 * value is never silently dropped.
 */
export function formatLogMessage(
  message: string,
  args: readonly unknown[],
  options: RedactOptions = {}
): string {
  const parts = args.map((value) => redact(stringify(value), options))
  let index = 0
  const substituted =
    parts.length === 0
      ? message
      : message.replace(/%[sd]/g, () => {
          const replacement = parts[index] ?? ''
          index += 1
          return replacement
        })
  const withArgs =
    index < parts.length
      ? `${substituted} ${parts.slice(index).join(' ')}`
      : substituted
  return redact(withArgs, options)
}

/** Format an error for a log line without its stack or any payload. */
export function errorLine(error: unknown): string {
  return stringify(error)
}