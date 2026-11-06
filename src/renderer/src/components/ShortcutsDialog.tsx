import { Fragment, useEffect, useRef, type JSX } from 'react'
import { SHORTCUT_HELP } from '../lib/shortcuts'
import { useWheelScrollLock } from '../lib/useWheelScrollLock'
import { Icon } from './Icon'

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Read-only list of every keyboard shortcut. Matches ConfirmDialog's visual
 * language, traps Tab inside the dialog, closes on Escape or backdrop click,
 * and returns focus to whatever was focused before it opened.
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useWheelScrollLock(backdropRef)

  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus()
      }
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (dialog === null) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((element) => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={backdropRef}
      className="no-drag fixed inset-0 z-[60] flex items-center justify-center overscroll-contain bg-[rgb(0_0_0_/_0.55)] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="flex max-h-[min(80vh,640px)] w-full max-w-md flex-col rounded-xl border border-white/10 bg-[var(--surface-card)] shadow-2xl shadow-black/70"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
          <div>
            <h2
              id="shortcuts-title"
              className="text-sm font-semibold text-zinc-100"
            >
              Keyboard shortcuts
            </h2>
            <p className="mt-0.5 text-[11.5px] text-zinc-500">
              Press ? any time to show this list.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {SHORTCUT_HELP.map((section) => (
            <section key={section.title} className="mb-4 last:mb-0">
              <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {section.title}
              </h3>
              <dl className="flex flex-col gap-1">
                {section.entries.map((entry) => (
                  <div
                    key={`${section.title}-${entry.label}`}
                    className="flex items-center justify-between gap-3 rounded-md px-1 py-1"
                  >
                    <dt className="min-w-0 text-[12.5px] text-zinc-300">
                      {entry.label}
                    </dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {[entry.keys, ...(entry.alt ?? [])].map(
                        (combo, comboIndex) => (
                          <Fragment key={combo.join('+')}>
                            {comboIndex > 0 ? (
                              <span className="px-0.5 text-[10.5px] text-zinc-500">
                                or
                              </span>
                            ) : null}
                            {combo.map((value) => (
                              <kbd
                                key={value}
                                className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-px font-sans text-[10.5px] font-medium leading-4 text-zinc-400"
                              >
                                {value}
                              </kbd>
                            ))}
                          </Fragment>
                        )
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="flex justify-end border-t border-white/[0.07] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
