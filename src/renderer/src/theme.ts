import type { AppTheme } from '@shared/settings'

/**
 * Apply a theme to the renderer only. CSS tokens and `color-scheme` switch in
 * place; React state, downloads and aria2 keep running untouched.
 */
export function applyRendererTheme(theme: AppTheme): void {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
}
