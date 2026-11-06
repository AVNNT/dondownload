import { LOGIN_ITEM_ARGS } from '@shared/desktopSettings'

/**
 * Launch-at-login is only meaningful for an installed build. Development
 * (`app.isPackaged === false`) must never write a login item pointing at the
 * Electron binary or the repository.
 */
export function shouldManageLoginItem(input: {
  isPackaged: boolean
  platform: NodeJS.Platform
}): boolean {
  return input.isPackaged && input.platform === 'win32'
}

export interface LoginItemSettings {
  openAtLogin: boolean
  path: string
  args: string[]
}

/** Exact `app.setLoginItemSettings` payload; the hidden flag reuses startup. */
export function loginItemSettings(
  execPath: string,
  enabled: boolean
): LoginItemSettings {
  return {
    openAtLogin: enabled,
    path: execPath,
    args: [...LOGIN_ITEM_ARGS]
  }
}
