/**
 * Pure keyboard-shortcut matching for the app shell.
 *
 * The renderer owns one window-level keydown handler; this module decides
 * whether an event should trigger a global shortcut. It deliberately knows
 * nothing about React so every rule is unit-testable.
 */

export type ShortcutId =
  | 'add'
  | 'paste-add'
  | 'settings'
  | 'batches'
  | 'focus-search'
  | 'shortcuts-help'
  | 'undo'
  | 'clear-list'
  | 'escape'

export interface ShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** What the shell currently has open; dialogs and menus own their keys. */
export interface ShortcutContext {
  /** An Add/Scan/Confirm/Shortcuts dialog is open. */
  dialogOpen: boolean
  /** The row context menu is open. */
  menuOpen: boolean
  /** The event target is a text field or contenteditable host. */
  isTyping: boolean
  /** The current page, when the shell has one. */
  page?: 'library' | 'batches' | 'settings'
  /** A paste event (clipboard payload available) rather than a keydown. */
  isPaste?: boolean
}

/**
 * Whether the event target is a place where the user is typing. Global
 * shortcuts must never steal keys from these; Escape keeps working.
 */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined
): boolean {
  if (!target) return false
  if (target.isContentEditable === true) return true
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Map an event to the global shortcut it would trigger, or null.
 *
 * Rules:
 * - Typing targets never trigger anything (Escape is handled separately).
 * - Open dialogs/menus swallow every global shortcut.
 * - Ctrl+N / Ctrl+, / Ctrl+B / Ctrl+F use Ctrl or Cmd.
 * - Ctrl+V only counts as paste-add when no dialog is open.
 * - Ctrl+Z maps to undo; the caller only acts while an undo toast is open.
 * - Ctrl+Shift+L clears the list of finished and failed entries.
 * - `?` (Shift+/) opens the shortcut help; plain `/` focuses search.
 * - Escape leaves Settings/Batches back to the library.
 */
export function matchShortcut(
  event: ShortcutEvent,
  context: ShortcutContext
): ShortcutId | null {
  const key = event.key
  const mod = event.ctrlKey || event.metaKey

  if (context.isPaste === true) {
    if (context.dialogOpen || context.menuOpen) return null
    if (context.isTyping) return null
    return 'paste-add'
  }

  // Escape is allowed while a dialog is open: those components close
  // themselves, so the shell must not also act on it.
  if (key === 'Escape') {
    if (context.dialogOpen || context.menuOpen) return null
    if (context.page === 'settings' || context.page === 'batches') {
      return 'escape'
    }
    return null
  }

  if (context.dialogOpen || context.menuOpen) return null
  if (context.isTyping) return null
  if (event.altKey) return null

  if (mod && !event.shiftKey) {
    switch (key.toLowerCase()) {
      case 'n':
        return 'add'
      case ',':
        return 'settings'
      case 'b':
        return 'batches'
      case 'f':
        return 'focus-search'
      case 'z':
        return 'undo'
      case 'v':
        // Ctrl+V is a paste event, not a keydown; handled above.
        return null
      default:
        return null
    }
  }

  if (mod && event.shiftKey && key.toLowerCase() === 'l') {
    return 'clear-list'
  }

  if (mod) return null

  if (key === '?' || (key === '/' && event.shiftKey)) return 'shortcuts-help'
  if (key === '/') return 'focus-search'
  return null
}

/** First http(s) URL inside pasted text, or null. */
export function firstHttpUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i)
  if (!match) return null
  const candidate = match[0].replace(/[),.;:!?]+$/, '')
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

export interface ShortcutHelpEntry {
  keys: string[]
  /** Additional key sets that do the same thing, shown after an "or". */
  alt?: string[][]
  label: string
}

export interface ShortcutHelpSection {
  title: string
  entries: ShortcutHelpEntry[]
}

/** Content of the "Keyboard shortcuts" dialog. */
export const SHORTCUT_HELP: readonly ShortcutHelpSection[] = [
  {
    title: 'App',
    entries: [
      { keys: ['Ctrl', 'N'], label: 'Add download' },
      { keys: ['Ctrl', 'V'], label: 'Add the link on your clipboard' },
      { keys: ['Ctrl', ','], label: 'Open settings' },
      { keys: ['Ctrl', 'B'], label: 'Show batches' },
      { keys: ['Ctrl', 'F'], alt: [['/']], label: 'Search downloads' },
      { keys: ['?'], label: 'Show this list' }
    ]
  },
  {
    title: 'Downloads list',
    entries: [
      { keys: ['↑', '↓'], label: 'Move between downloads' },
      { keys: ['Home', 'End'], label: 'Jump to the first or last download' },
      { keys: ['Ctrl', 'A'], label: 'Select all downloads' },
      { keys: ['Enter'], label: 'Open the selected download' },
      { keys: ['Space'], label: 'Pause or resume the focused download' },
      { keys: ['Delete'], label: 'Remove the selected downloads' },
      { keys: ['Ctrl', 'Shift', 'L'], label: 'Clear the list (files are kept)' },
      { keys: ['Ctrl', 'Z'], label: 'Undo remove' },
      { keys: ['Shift', 'F10'], label: 'Open the context menu' },
      { keys: ['Esc'], label: 'Clear the selection or go back' }
    ]
  }
]
