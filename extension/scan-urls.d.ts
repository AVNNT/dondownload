export const MAX_SCAN_URLS: number

export interface ParsedScanUrlList {
  urls: string[]
  duplicates: number
  invalid: string[]
  overLimit: number
}

export interface ScanOriginGroup {
  origin: string
  urls: string[]
}

export interface ScanSendEntry {
  origin: string
  url: string
  cookie?: string
}

export interface ScanSend {
  url: string
  cookie?: string
}

export function parseScanUrlList(
  value: unknown,
  maximum?: number
): ParsedScanUrlList
export function groupScanUrlsByOrigin(urls: unknown): ScanOriginGroup[]
export function buildScanSends(entries: unknown): ScanSend[]
