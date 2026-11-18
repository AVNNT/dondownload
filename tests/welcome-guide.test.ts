import { describe, expect, it } from 'vitest'
import {
  FIREFOX_ADDONS_URL,
  WELCOME_RELEASES_URL,
  type WelcomeBrowserInfo
} from '../src/shared/welcome'
import {
  connectionLabel,
  detectedSummary,
  sharedConnectionNote,
  tutorialButtonLabel,
  tutorialSteps,
  tutorialUrl
} from '../src/renderer/src/lib/welcome'

function browser(
  overrides: Partial<WelcomeBrowserInfo> = {}
): WelcomeBrowserInfo {
  return {
    id: 'chrome',
    label: 'Chrome',
    engine: 'chromium',
    connected: true,
    connectionRow: 'Chrome',
    ...overrides
  }
}

describe('welcome guide copy', () => {
  it('uses the same three tutorial steps for every Chromium browser', () => {
    const steps = tutorialSteps('chromium')
    expect(steps).toHaveLength(3)
    expect(steps[0]?.label).toContain('chrome://extensions')
    expect(steps[1]?.label).toBe('Turn on Developer mode')
    expect(steps[2]?.label).toBe('Choose Load unpacked')
    expect(tutorialUrl('chromium')).toBe('chrome://extensions')
    expect(tutorialButtonLabel('chromium')).toBe('Show me how')
  })

  it('uses the temporary add-on flow for Firefox and Zen', () => {
    const steps = tutorialSteps('gecko')
    expect(steps).toHaveLength(3)
    expect(steps[0]?.label).toContain('about:debugging')
    expect(steps[1]?.label).toBe('Choose Load Temporary Add-on')
    expect(tutorialUrl('gecko')).toBe('about:debugging#/runtime/this-firefox')
    expect(tutorialButtonLabel('gecko')).toBe('Releases page')
  })

  it('explains shared connection rows for forks', () => {
    expect(sharedConnectionNote(browser({ id: 'brave' }))).toBe(
      'Uses the Chrome connection'
    )
    expect(sharedConnectionNote(browser({ id: 'zen', engine: 'gecko' }))).toBe(
      'Uses the Firefox connection'
    )
    expect(sharedConnectionNote(browser())).toBeNull()
  })

  it('labels connection state and summarises the detected list', () => {
    expect(connectionLabel(true)).toBe('Connected')
    expect(connectionLabel(false)).toBe('Needs setup')
    expect(detectedSummary([])).toBe('No supported browsers detected')
    expect(
      detectedSummary([
        browser({ connected: true }),
        browser({ id: 'firefox', connected: false })
      ])
    ).toBe('2 browsers found · 1 connected')
    expect(detectedSummary([browser()])).toBe('1 browser found · 1 connected')
  })

  it('keeps the Firefox add-on listing slot empty until it is published', () => {
    expect(FIREFOX_ADDONS_URL).toBeNull()
    expect(WELCOME_RELEASES_URL).toContain('releases/latest')
  })
})
