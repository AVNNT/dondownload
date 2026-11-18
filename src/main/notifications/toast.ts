/**
 * Pure Windows toast XML for a completion notification.
 *
 * Electron's `actions` option is not available on Windows, so the two buttons
 * are described in raw toast XML. Windows activation types:
 *
 * - `foreground` activates the app (its existing AUMID + COM toast activator)
 *   instead of launching a protocol handler. While the app is running Electron
 *   raises the in-process WinRT activation and dispatches it to the live
 *   notification object.
 * - The `arguments` shape is the structured form Electron maps back to its
 *   `action` event (`type=action&action=<index>&tag=<notification id>`), which
 *   lets the notification service know which button was pressed.
 *
 * No path, URL or download id is ever written into the XML. The tag only names
 * the transient notification object; the service keeps the opaque job id and
 * resolves the real path in the main process.
 */

/** Index Electron reports for "Open". */
export const TOAST_ACTION_OPEN = 0
/** Index Electron reports for "Show in folder". */
export const TOAST_ACTION_SHOW = 1

export interface CompletionToastInput {
  title: string
  body: string
  /** Must match the `id` passed to Electron's Notification. */
  notificationId: string
  openLabel?: string
  showLabel?: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Windows toast tags must be short and alphanumeric for older builds. */
export function notificationTag(sequence: number, salt: string): string {
  return `dd${sequence.toString(36)}${salt.replace(/[^a-z0-9]/gi, '').toLowerCase()}`
}

function actionArguments(notificationId: string, action: number): string {
  return `type=action&action=${action}&tag=${notificationId}`
}

function actionXml(
  label: string,
  notificationId: string,
  action: number
): string {
  return [
    '      <action',
    `        content="${escapeXml(label)}"`,
    '        activationType="foreground"',
    `        arguments="${escapeXml(actionArguments(notificationId, action))}"`,
    '      />'
  ].join('\n')
}

/**
 * Build the complete `<toast>` document. `title` and `body` are user-visible
 * text (filename, never a path) and are escaped for the XML text nodes.
 */
export function buildCompletionToastXml(
  input: CompletionToastInput
): string {
  const openLabel = input.openLabel ?? 'Open'
  const showLabel = input.showLabel ?? 'Show in folder'

  return [
    '<toast>',
    '  <visual>',
    '    <binding template="ToastGeneric">',
    `      <text>${escapeXml(input.title)}</text>`,
    `      <text>${escapeXml(input.body)}</text>`,
    '    </binding>',
    '  </visual>',
    '  <actions>',
    actionXml(openLabel, input.notificationId, TOAST_ACTION_OPEN),
    actionXml(showLabel, input.notificationId, TOAST_ACTION_SHOW),
    '  </actions>',
    '</toast>'
  ].join('\n')
}
