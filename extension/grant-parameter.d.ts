export const GRANT_PARAM: 'grant'

export function parseGrantParameter(value: unknown): string | null

export function readGrantParameter(search: unknown): {
  present: boolean
  origin: string | null
}

export function grantPageUrl(baseUrl: unknown, origin: unknown): string | null
