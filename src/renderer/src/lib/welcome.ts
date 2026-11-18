import {
  CHROMIUM_EXTENSIONS_URL,
  FIREFOX_DEBUGGING_URL,
  type BrowserEngine,
  type WelcomeBrowserInfo
} from '@shared/welcome'

/** Short labels for the three guide steps and their progress rail. */
export const WELCOME_STEP_LABELS = ['Downloads', 'Browser', 'Ready'] as const

export const WELCOME_STEP_TITLES = [
  'Where downloads go',
  'Connect your browser',
  "You're set"
] as const

export interface GuideStep {
  label: string
  detail: string
}

/** True for a fork that reuses another row's connection state. */
export function sharedConnectionNote(
  browser: WelcomeBrowserInfo
): string | null {
  if (browser.id === 'brave') return 'Uses the Chrome connection'
  if (browser.id === 'zen') return 'Uses the Firefox connection'
  if (browser.id === 'helium') return 'Uses its own Chromium connection'
  return null
}

export function connectionLabel(connected: boolean): string {
  return connected ? 'Connected' : 'Needs setup'
}

/** Button copy describing what pressing "Show me how" will do. */
export function tutorialButtonLabel(engine: BrowserEngine): string {
  return engine === 'chromium' ? 'Show me how' : 'Releases page'
}

/** Address the user must type for this engine; apps cannot open these URLs. */
export function tutorialUrl(engine: BrowserEngine): string {
  return engine === 'chromium'
    ? CHROMIUM_EXTENSIONS_URL
    : FIREFOX_DEBUGGING_URL
}

export function tutorialSteps(engine: BrowserEngine): readonly GuideStep[] {
  if (engine === 'chromium') {
    return [
      {
        label: `Open ${CHROMIUM_EXTENSIONS_URL}`,
        detail: 'Type it in the address bar and press Enter.'
      },
      {
        label: 'Turn on Developer mode',
        detail: 'The switch sits in the top-right corner of that page.'
      },
      {
        label: 'Choose Load unpacked',
        detail: 'Select the extension folder opened in Explorer.'
      }
    ]
  }
  return [
    {
      label: `Open ${FIREFOX_DEBUGGING_URL}`,
      detail: 'Type it in the address bar and press Enter.'
    },
    {
      label: 'Choose Load Temporary Add-on',
      detail: 'Pick manifest.json in the extension folder.'
    },
    {
      label: 'Allow site access',
      detail: 'Open about:addons → Permissions to grant the sites you want.'
    }
  ]
}

/** Stable list summary used by the "no browsers detected" fallback. */
export function detectedSummary(browsers: readonly WelcomeBrowserInfo[]): string {
  if (browsers.length === 0) return 'No supported browsers detected'
  const connected = browsers.filter((browser) => browser.connected).length
  return `${browsers.length} browser${browsers.length === 1 ? '' : 's'} found · ${connected} connected`
}
