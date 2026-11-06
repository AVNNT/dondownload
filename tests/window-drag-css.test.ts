import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve(__dirname, '../src/renderer/src/styles.css'),
  'utf8'
)

/** Returns the declaration block for the first rule whose selector matches. */
function ruleBlock(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? null
}

describe('window drag regions', () => {
  it('makes the header content row draggable', () => {
    const block = ruleBlock('.window-app-header-content')
    expect(block).not.toBeNull()
    expect(block).toMatch(/(^|[;\s])-?(-webkit-)?app-region:\s*drag;/)
    expect(block).not.toMatch(/(^|[;\s])-?(-webkit-)?app-region:\s*no-drag;/)
  })

  it('keeps interactive header controls out of the drag region', () => {
    expect(css).toMatch(
      /\.window-app-header-content\s+:is\(\s*button,\s*a,\s*input,\s*select,\s*textarea,\s*\[role='button'\],\s*\[role='tab'\],\s*\[role='menu'\],\s*\[contenteditable='true'\]\s*\)\s*\{[^}]*app-region:\s*no-drag;/s
    )
  })

  it('provides a no-drag utility for overlays over the header', () => {
    const block = ruleBlock('.no-drag')
    expect(block).not.toBeNull()
    expect(block).toMatch(/app-region:\s*no-drag;/)
  })
})
