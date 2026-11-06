/**
 * Clipboard link detection.
 *
 * This module is deliberately pure and never logs: the caller passes the raw
 * clipboard text and receives at most one URL. Only a single ordinary http(s)
 * URL is accepted; multi-line text, embedded whitespace, non-web schemes and
 * oversized strings are ignored. The app records links it copied itself so a
 * user-triggered "Copy link" can never open the download prompt.
 */

export const MAX_CLIPBOARD_URL_LENGTH = 2_048

export function detectClipboardUrl(
  rawText: string,
  lastSeen: string | null,
  isSelfCopied: (url: string) => boolean = () => false
): string | null {
  if (typeof rawText !== 'string') return null
  // `trim()` leaves internal newlines/spaces; a single URL has neither.
  const text = rawText.trim()
  if (text.length === 0) return null
  if (text.length > MAX_CLIPBOARD_URL_LENGTH) return null
  if (/\s/.test(text)) return null
  if (lastSeen !== null && lastSeen.trim() === text) return null
  if (isSelfCopied(text)) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username.length > 0 || url.password.length > 0) return null
  return text
}
