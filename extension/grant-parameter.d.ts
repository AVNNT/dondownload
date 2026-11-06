export const GRANT_PARAM: 'grant'
export const GRANT_COOKIES_PARAM: 'cookies'

export function parseGrantParameter(value: unknown): string | null

export function readGrantParameter(search: unknown): {
  present: boolean
  origin: string | null
  cookies: boolean
}

export function grantPageUrl(
  baseUrl: unknown,
  origin: unknown,
  options?: { cookies?: boolean }
): string | null
