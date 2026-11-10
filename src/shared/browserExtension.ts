import {
  DONDOWNLOAD_EXTENSION_ID,
  DONDOWNLOAD_FIREFOX_ADDON_ID
} from './extensionId'

/**
 * Renderer-safe status for the zero-config browser bridge registration.
 * `lastError` is a short, non-sensitive message; it never contains URLs or
 * payload data.
 */
export interface BrowserExtensionBrowserStatus {
  browser: 'Chrome' | 'Helium' | 'Edge' | 'Firefox'
  registered: boolean
  /** Current-user registry key used by this browser. */
  registryKey: string
  /** True when the key is shared with another row (Helium shares Chrome's). */
  shared: boolean
}

export interface BrowserExtensionStatus {
  /** True only when every required current-user key matches the manifest. */
  registered: boolean
  browsers: BrowserExtensionBrowserStatus[]
  hostPath: string
  manifestPath: string
  allowedOrigins: string[]
  /** Firefox reads `allowed_extensions` from its own app manifest. */
  firefoxManifestPath: string
  firefoxAddonId: string
  allowedExtensions: string[]
  extensionFolder: string
  extensionId: string
  lastError: string | null
}

export const NATIVE_HOST_NAME = 'com.dondownload.bridge'

export const CHROME_NATIVE_HOST_REGISTRY_KEY =
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dondownload.bridge'

export const EDGE_NATIVE_HOST_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.dondownload.bridge'

export const FIREFOX_NATIVE_HOST_REGISTRY_KEY =
  'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.dondownload.bridge'

/** Fixed origin written to every manifest. Wildcards are never accepted. */
export const DONDOWNLOAD_NATIVE_HOST_ORIGIN = `chrome-extension://${DONDOWNLOAD_EXTENSION_ID}/`

/** Fixed add-on ID written to the Firefox app manifest's allowed_extensions. */
export const DONDOWNLOAD_NATIVE_HOST_ADDON = DONDOWNLOAD_FIREFOX_ADDON_ID
