import { DONDOWNLOAD_EXTENSION_ID } from './extensionId'

/**
 * Renderer-safe status for the zero-config browser bridge registration.
 * `lastError` is a short, non-sensitive message; it never contains URLs or
 * payload data.
 */
export interface BrowserExtensionBrowserStatus {
  browser: 'Chrome' | 'Helium' | 'Edge'
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
  extensionFolder: string
  extensionId: string
  lastError: string | null
}

export const NATIVE_HOST_NAME = 'com.dondownload.bridge'

export const CHROME_NATIVE_HOST_REGISTRY_KEY =
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dondownload.bridge'

export const EDGE_NATIVE_HOST_REGISTRY_KEY =
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.dondownload.bridge'

/** Fixed origin written to every manifest. Wildcards are never accepted. */
export const DONDOWNLOAD_NATIVE_HOST_ORIGIN = `chrome-extension://${DONDOWNLOAD_EXTENSION_ID}/`
