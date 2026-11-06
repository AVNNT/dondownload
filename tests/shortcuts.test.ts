import { describe, expect, it } from 'vitest'
import {
  firstHttpUrl,
  isTypingTarget,
  matchShortcut,
  SHORTCUT_HELP,
  type ShortcutContext,
  type ShortcutEvent
} from '../src/renderer/src/lib/shortcuts'

function key(
  value: string,
  modifiers: Partial<ShortcutEvent> = {}
): ShortcutEvent {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers
  }
}

const IDLE: ShortcutContext = {
  dialogOpen: false,
  menuOpen: false,
  isTyping: false,
  page: 'library'
}

describe('matchShortcut', () => {
  it('maps the app-level shortcuts', () => {
    expect(matchShortcut(key('n', { ctrlKey: true }), IDLE)).toBe('add')
    expect(matchShortcut(key('N', { ctrlKey: true }), IDLE)).toBe('add')
    expect(matchShortcut(key(',', { ctrlKey: true }), IDLE)).toBe('settings')
    expect(matchShortcut(key('b', { ctrlKey: true }), IDLE)).toBe('batches')
    expect(matchShortcut(key('f', { ctrlKey: true }), IDLE)).toBe('focus-search')
  })

  it('accepts Cmd as the modifier on macOS', () => {
    expect(matchShortcut(key('n', { metaKey: true }), IDLE)).toBe('add')
    expect(matchShortcut(key(',', { metaKey: true }), IDLE)).toBe('settings')
  })

  it('opens the shortcut list for ? and Shift+/', () => {
    expect(matchShortcut(key('?', { shiftKey: true }), IDLE)).toBe(
      'shortcuts-help'
    )
    expect(matchShortcut(key('/', { shiftKey: true }), IDLE)).toBe(
      'shortcuts-help'
    )
  })

  it('focuses search for a bare slash', () => {
    expect(matchShortcut(key('/'), IDLE)).toBe('focus-search')
  })

  it('leaves Settings and Batches on Escape', () => {
    expect(matchShortcut(key('Escape'), { ...IDLE, page: 'settings' })).toBe(
      'escape'
    )
    expect(matchShortcut(key('Escape'), { ...IDLE, page: 'batches' })).toBe(
      'escape'
    )
    expect(matchShortcut(key('Escape'), IDLE)).toBeNull()
  })

  it('never fires while typing, except Escape', () => {
    const typing: ShortcutContext = { ...IDLE, isTyping: true }
    expect(matchShortcut(key('n', { ctrlKey: true }), typing)).toBeNull()
    expect(matchShortcut(key('?', { shiftKey: true }), typing)).toBeNull()
    expect(matchShortcut(key('/'), typing)).toBeNull()
    expect(
      matchShortcut(key('Escape'), { ...typing, page: 'settings' })
    ).toBe('escape')
  })

  it('never fires while a dialog or menu is open', () => {
    const dialog: ShortcutContext = { ...IDLE, dialogOpen: true }
    const menu: ShortcutContext = { ...IDLE, menuOpen: true }
    for (const context of [dialog, menu]) {
      expect(matchShortcut(key('n', { ctrlKey: true }), context)).toBeNull()
      expect(matchShortcut(key('?', { shiftKey: true }), context)).toBeNull()
      expect(
        matchShortcut(key('Escape'), { ...context, page: 'settings' })
      ).toBeNull()
    }
  })

  it('ignores Alt-modified combinations', () => {
    expect(
      matchShortcut(key('n', { ctrlKey: true, altKey: true }), IDLE)
    ).toBeNull()
  })

  it('treats a paste event as paste-add only outside dialogs and inputs', () => {
    expect(matchShortcut(key('v', { ctrlKey: true }), IDLE)).toBeNull()
    expect(matchShortcut(key('v'), { ...IDLE, isPaste: true })).toBe(
      'paste-add'
    )
    expect(
      matchShortcut(key('v'), { ...IDLE, isPaste: true, dialogOpen: true })
    ).toBeNull()
    expect(
      matchShortcut(key('v'), { ...IDLE, isPaste: true, isTyping: true })
    ).toBeNull()
  })

  it('maps undo to Ctrl+Z', () => {
    expect(matchShortcut(key('z', { ctrlKey: true }), IDLE)).toBe('undo')
    expect(matchShortcut(key('Z', { ctrlKey: true }), IDLE)).toBe('undo')
    expect(matchShortcut(key('z', { metaKey: true }), IDLE)).toBe('undo')
    // Shift+Ctrl+Z is redo, not undo; typing and dialogs keep their own undo.
    expect(matchShortcut(key('z', { ctrlKey: true, shiftKey: true }), IDLE)).toBeNull()
    expect(
      matchShortcut(key('z', { ctrlKey: true }), { ...IDLE, isTyping: true })
    ).toBeNull()
    expect(
      matchShortcut(key('z', { ctrlKey: true }), { ...IDLE, dialogOpen: true })
    ).toBeNull()
  })

  it('ignores unrelated keys', () => {
    expect(matchShortcut(key('x'), IDLE)).toBeNull()
    expect(matchShortcut(key('a', { ctrlKey: true }), IDLE)).toBeNull()
    expect(matchShortcut(key('Enter'), IDLE)).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('detects inputs, textareas, selects and contenteditable', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'input' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(
      true
    )
  })

  it('treats buttons, rows and null as non-typing', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })
})

describe('firstHttpUrl', () => {
  it('extracts the first http(s) URL from text', () => {
    expect(firstHttpUrl('see https://example.com/a.zip now')).toBe(
      'https://example.com/a.zip'
    )
    expect(firstHttpUrl('http://example.com')).toBe('http://example.com/')
  })

  it('trims trailing punctuation', () => {
    expect(firstHttpUrl('(https://example.com/file.iso).')).toBe(
      'https://example.com/file.iso'
    )
  })

  it('rejects text without a web URL', () => {
    expect(firstHttpUrl('no link here')).toBeNull()
    expect(firstHttpUrl('file:///C:/secret.txt')).toBeNull()
    expect(firstHttpUrl('')).toBeNull()
  })
})

describe('SHORTCUT_HELP', () => {
  it('documents the app and list shortcuts', () => {
    const labels = SHORTCUT_HELP.flatMap((section) =>
      section.entries.map((entry) => entry.label)
    )
    expect(labels.length).toBeGreaterThan(10)
    const keys = SHORTCUT_HELP.flatMap((section) =>
      section.entries.flatMap((entry) => [
        ...entry.keys,
        ...(entry.alt ?? []).flat()
      ])
    )
    for (const expected of [
      'Ctrl',
      'N',
      'V',
      'B',
      'F',
      '?',
      '↑',
      '↓',
      'Home',
      'End',
      'A',
      'Enter',
      'Space',
      'Delete',
      'F10',
      'Esc'
    ]) {
      expect(keys).toContain(expected)
    }
  })

  it('lists search downloads once with both key combinations', () => {
    const search = SHORTCUT_HELP.flatMap((section) => section.entries).filter(
      (entry) => entry.label === 'Search downloads'
    )
    expect(search).toHaveLength(1)
    expect(search[0]?.keys).toEqual(['Ctrl', 'F'])
    expect(search[0]?.alt).toEqual([['/']])
  })

  it('documents undo for removing downloads', () => {
    const entries = SHORTCUT_HELP.flatMap((section) => section.entries)
    const undo = entries.filter((entry) => entry.label === 'Undo remove')
    expect(undo).toHaveLength(1)
    expect(undo[0]?.keys).toEqual(['Ctrl', 'Z'])
  })
})
