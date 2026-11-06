import { describe, expect, it, vi } from 'vitest'
import {
  APP_THEMES,
  DEFAULT_THEME,
  defaultDownloadSettings,
  parseDownloadSettings
} from '../src/shared/settings'
import {
  TITLE_BAR_OVERLAY_HEIGHT,
  applyThemeToWindow,
  themeWindowColors
} from '../src/main/settings/theme'

describe('desktop theme contract', () => {
  it('defaults to OLED for new users and accepts every shared theme', () => {
    expect(DEFAULT_THEME).toBe('oled')
    expect(defaultDownloadSettings().theme).toBe('oled')
    expect(APP_THEMES).toEqual(['oled', 'dark', 'light'])
    for (const theme of APP_THEMES) {
      expect(
        parseDownloadSettings({
          ...defaultDownloadSettings(),
          theme
        }).theme
      ).toBe(theme)
    }
  })

  it('maps native title bar colors with readable caption controls', () => {
    const oled = themeWindowColors('oled')
    expect(oled).toEqual({
      backgroundColor: '#000000',
      titleBarOverlay: {
        color: '#000000',
        symbolColor: '#f4f4f5',
        height: TITLE_BAR_OVERLAY_HEIGHT
      }
    })

    const dark = themeWindowColors('dark')
    expect(dark.titleBarOverlay.color).toBe(dark.backgroundColor)
    expect(dark.titleBarOverlay.symbolColor).toBe('#f4f4f5')

    const light = themeWindowColors('light')
    expect(light.titleBarOverlay.color).toBe(light.backgroundColor)
    expect(light.titleBarOverlay.symbolColor).toBe('#18181b')
  })

  it('sizes the overlay to the renderer header row', () => {
    // The header row is `h-14` (56px); the caption buttons must match it.
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(56)
    for (const theme of APP_THEMES) {
      expect(themeWindowColors(theme).titleBarOverlay.height).toBe(56)
    }
  })

  it('updates the native window immediately and tolerates a closed window', () => {
    const window = {
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn()
    }

    expect(applyThemeToWindow(window, 'light')).toEqual(
      themeWindowColors('light')
    )
    expect(window.setBackgroundColor).toHaveBeenCalledWith('#f4f4f5')
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith(
      themeWindowColors('light').titleBarOverlay
    )

    expect(() => applyThemeToWindow(null, 'dark')).not.toThrow()
  })
})
