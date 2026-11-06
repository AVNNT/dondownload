import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import type { ContextAction, RowActionId } from '../lib/actions'

interface ContextMenuProps {
  x: number
  y: number
  actions: readonly ContextAction[]
  onSelect: (id: RowActionId) => void
  onClose: () => void
}

const SEPARATOR_BEFORE = new Set<RowActionId>(['pause', 'retry', 'remove'])

export function ContextMenu({
  x,
  y,
  actions,
  onSelect,
  onClose
}: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const first = menu.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)'
    )
    first?.focus()
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const width = 228
  const estimatedHeight = actions.length * 32 + 24
  const left = Math.max(
    8,
    Math.min(x, (typeof window === 'undefined' ? width : window.innerWidth) - width - 8)
  )
  const top = Math.max(
    8,
    Math.min(
      y,
      (typeof window === 'undefined' ? estimatedHeight : window.innerHeight) -
        estimatedHeight -
        8
    )
  )

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const menu = menuRef.current
    if (!menu) return
    const items = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
    )
    const index = items.findIndex((item) => item === document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Download actions"
      onKeyDown={handleKeyDown}
      style={{ left, top }}
      className="no-drag fixed z-50 w-[228px] rounded-xl border border-white/10 bg-[var(--surface-card)] p-1 shadow-2xl shadow-black/60"
    >
      {actions.map((action) => (
        <div key={action.id}>
          {SEPARATOR_BEFORE.has(action.id) ? (
            <div role="separator" className="my-1 border-t border-white/[0.07]" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={!action.enabled}
            onClick={() => onSelect(action.id)}
            className={`flex h-8 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-[11.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-30 ${
              action.danger
                ? 'text-red-300 hover:bg-red-400/10 hover:text-red-200'
                : 'text-zinc-200 hover:bg-white/5 hover:text-white'
            }`}
          >
            <span>{action.label}</span>
            {action.hint ? (
              <span className="text-[11px] text-zinc-600">{action.hint}</span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  )
}
