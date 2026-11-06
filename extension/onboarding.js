// Pure welcome/popup view logic. Keeping the copy and classification here lets
// the extension tests cover the onboarding contract without a DOM or browser.

import { originFromUrl } from './site-policy.js'

export const WELCOME_PAGE = 'welcome.html'

/** The welcome page is opened only for a fresh extension install. */
export function shouldOpenWelcome(details) {
  return Boolean(details && details.reason === 'install')
}

/** Human host label for "Enable on <host>" including a non-default port. */
export function siteHostLabel(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.host || null
  } catch {
    return null
  }
}

export function siteEnableLabel(value) {
  const host = siteHostLabel(value)
  return host === null ? 'Enable on this site' : `Enable on ${host}`
}

/**
 * Turn a native probe result into one honest status block. Fix steps are
 * ordered and mention the desktop Settings repair action only when the bridge
 * itself appears to be missing.
 */
export function connectionView(result) {
  if (result && result.ok === true) {
    return {
      connected: true,
      tone: 'on',
      title: 'Connected to DonDownload',
      detail:
        'This browser can send downloads to the app. DonDownload keeps working from the tray after you close its window.',
      steps: []
    }
  }

  const code =
    result && result.error && typeof result.error.code === 'string'
      ? result.error.code
      : ''
  const notRegistered =
    code === 'NATIVE_HOST_NOT_REGISTERED' || code === 'NATIVE_HOST_FORBIDDEN'
  return {
    connected: false,
    tone: notRegistered ? 'error' : 'off',
    title: notRegistered
      ? 'DonDownload bridge is not registered'
      : 'DonDownload is not running yet',
    detail: notRegistered
      ? 'The browser could not find this extension in the app’s native messaging registration.'
      : 'Start the desktop app once, then check again. The app may be hidden in the tray.',
    steps: notRegistered
      ? [
          'Open DonDownload once and wait a few seconds.',
          'Click Retry below.',
          'If it still fails, open DonDownload Settings → Browser extension and choose Repair browser connection.'
        ]
      : [
          'Open DonDownload (the tray icon is enough).',
          'Click Retry below.'
        ]
  }
}

/** One-line popup status for the same probe result. */
export function popupConnectionLine(result) {
  const view = connectionView(result)
  return view.connected
    ? 'Connected to DonDownload.'
    : `${view.title}. Open DonDownload, then try again.`
}

/** Link target for the popup 'How to fix' action. */
export function welcomeUrl(chromeApi) {
  try {
    return chromeApi.runtime.getURL(WELCOME_PAGE)
  } catch {
    return WELCOME_PAGE
  }
}

/**
 * Copy for the browser download takeover switch. It is a download-manager
 * setting, not a media or per-site opt-in: one switch takes over normal
 * browser downloads (files and direct video/audio) with the browser's own
 * cookies for that URL.
 */
export function browserDownloadTakeoverCopy() {
  return {
    title: 'Download browser files with DonDownload',
    on: 'On. New browser downloads go to DonDownload with your browser sign-in.',
    off: 'Off. Browser downloads stay in the browser.',
    permission:
      'Turning this on asks once for the optional downloads and cookies permissions plus site access.'
  }
}

export function siteOrigin(value) {
  return originFromUrl(value)
}
