export const WELCOME_PAGE: string

export function shouldOpenWelcome(details: unknown): boolean
export function siteHostLabel(value: unknown): string | null
export function siteEnableLabel(value: unknown): string

export interface ConnectionView {
  connected: boolean
  tone: 'on' | 'off' | 'error'
  title: string
  detail: string
  steps: string[]
}

export function connectionView(result: unknown): ConnectionView
export function popupConnectionLine(result: unknown): string
export function welcomeUrl(chromeApi: unknown): string
export function browserDownloadTakeoverCopy(): {
  title: string
  on: string
  off: string
  permission: string
}
export function siteOrigin(value: unknown): string | null
