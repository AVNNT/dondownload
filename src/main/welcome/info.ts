import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type { WelcomeBrowserInfo, WelcomeInfo } from '@shared/welcome'
import type { DetectedBrowser } from '../browsers/detect'

export interface WelcomeInfoInput {
  downloadDir: string
  browsers: readonly DetectedBrowser[]
  /** Existing Settings → Browser extension status, or null when unavailable. */
  extension: BrowserExtensionStatus | null
}

/**
 * Join detected browsers with the existing native-messaging registration state.
 * This is the only place a browser row and a connection row are matched, so a
 * Chromium fork (Brave) and a Firefox fork (Zen) reuse the registration that
 * already exists instead of inventing a second status source.
 */
export function buildWelcomeInfo(input: WelcomeInfoInput): WelcomeInfo {
  const connectedRows = new Set<string>()
  for (const browser of input.extension?.browsers ?? []) {
    if (browser.registered) connectedRows.add(browser.browser)
  }

  const browsers: WelcomeBrowserInfo[] = input.browsers.map((browser) => ({
    id: browser.id,
    label: browser.label,
    engine: browser.engine,
    connected: connectedRows.has(browser.connectionRow),
    connectionRow: browser.connectionRow
  }))

  return {
    downloadDir: input.downloadDir,
    browsers,
    // The installer copies `extension/` to resources, and a development build
    // serves the repository copy. Without a registrar (smoke runs) there is no
    // folder to point at, so the guide offers the releases fallback.
    extensionBundled: input.extension !== null
  }
}
