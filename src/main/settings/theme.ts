import { DEFAULT_THEME, type AppTheme } from '@shared/settings'

/**
 * Native window colors for each renderer theme. The overlay color must match
 * the rendered header so the Windows caption buttons sit on the same surface;
 * the symbol color is chosen for contrast against that surface.
 */
export interface ThemeWindowColors {
  backgroundColor: string
  titleBarOverlay: {
    color: string
    symbolColor: string
    height: number
  }
}

export const TITLE_BAR_OVERLAY_HEIGHT = 40

export function themeWindowColors(theme: AppTheme): ThemeWindowColors {
  switch (theme) {
    case 'light':
      return {
        backgroundColor: '#f4f4f5',
        titleBarOverlay: {
          color: '#f4f4f5',
          symbolColor: '#18181b',
          height: TITLE_BAR_OVERLAY_HEIGHT
        }
      }
    case 'dark':
      return {
        backgroundColor: '#09090b',
        titleBarOverlay: {
          color: '#09090b',
          symbolColor: '#f4f4f5',
          height: TITLE_BAR_OVERLAY_HEIGHT
        }
      }
    case 'oled':
    default:
      return {
        backgroundColor: '#000000',
        titleBarOverlay: {
          color: '#000000',
          symbolColor: '#f4f4f5',
          height: TITLE_BAR_OVERLAY_HEIGHT
        }
      }
  }
}

/** Structural port so tests do not need a real Electron BrowserWindow. */
export interface ThemeWindow {
  setBackgroundColor?: (color: string) => void
  setTitleBarOverlay?: (options: {
    color: string
    symbolColor: string
    height: number
  }) => void
}

/**
 * Apply the native window surface immediately. The renderer independently
 * applies the same theme through `data-theme`, so no reload, navigation or
 * aria2/download restart is involved.
 */
export function applyThemeToWindow(
  window: ThemeWindow | null | undefined,
  theme: AppTheme = DEFAULT_THEME
): ThemeWindowColors {
  const colors = themeWindowColors(theme)
  if (!window) return colors
  window.setBackgroundColor?.(colors.backgroundColor)
  window.setTitleBarOverlay?.(colors.titleBarOverlay)
  return colors
}
