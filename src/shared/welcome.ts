/**
 * First-start welcome guide contract.
 *
 * Everything here is renderer-safe: folders are the only path-shaped value and
 * are shown to the user, never accepted from them. Browser detection happens in
 * the main process; the renderer receives only labels, engines and the existing
 * native-messaging connection state.
 */

/** Public releases page used as the extension fallback and browser install link. */
export const WELCOME_RELEASES_URL =
  'https://github.com/AVNNT/dondownload/releases/latest'

/**
 * Firefox add-on listing. It is not published yet, so the guide links to the
 * releases page. Keep this constant in place so enabling the listing is a
 * one-line change.
 */
export const FIREFOX_ADDONS_URL: string | null = null

/** Address the user must type in a Chromium browser; apps cannot open it. */
export const CHROMIUM_EXTENSIONS_URL = 'chrome://extensions'

/** Address for the temporary add-on flow in Firefox and Zen. */
export const FIREFOX_DEBUGGING_URL =
  'about:debugging#/runtime/this-firefox'

export const BROWSER_ENGINES = ['chromium', 'gecko'] as const
export type BrowserEngine = (typeof BROWSER_ENGINES)[number]

export const DETECTED_BROWSER_IDS = [
  'chrome',
  'edge',
  'brave',
  'helium',
  'firefox',
  'zen'
] as const
export type DetectedBrowserId = (typeof DETECTED_BROWSER_IDS)[number]

/** Which registered native-messaging row carries a browser's connection. */
export type WelcomeConnectionRow = 'Chrome' | 'Edge' | 'Helium' | 'Firefox'

export interface WelcomeBrowserInfo {
  id: DetectedBrowserId
  label: string
  engine: BrowserEngine
  /** True when the existing native-messaging registration is in place. */
  connected: boolean
  /**
   * The Settings → Browser extension row this browser uses. Chromium forks
   * such as Brave share Chrome's registration and Zen shares Firefox's.
   */
  connectionRow: WelcomeConnectionRow
}

export interface WelcomeInfo {
  /** Folder new downloads land in. Display only; there is no folder picker. */
  downloadDir: string
  /** Installed browsers, in a stable display order. Empty when none matched. */
  browsers: WelcomeBrowserInfo[]
  /** True when this install ships the unpacked extension folder. */
  extensionBundled: boolean
}

/** Number of guide steps: downloads, browser connection, finishing tips. */
export const WELCOME_STEP_COUNT = 3
