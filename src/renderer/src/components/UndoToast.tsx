import { useEffect, useRef, useState, type JSX } from 'react'

export interface UndoToastProps {
  /** Human label of what was removed, e.g. a title or "3 downloads". */
  label: string
  /** Undo window in milliseconds. */
  durationMs: number
  onUndo: () => void
  /** Esc commits the removal immediately. */
  onDismiss: () => void
  /** The countdown ran out; commit the removal now. */
  onExpire: () => void
}

/**
 * Bottom-center "Removed …" toast with an Undo button and a thin countdown
 * line. Hovering (or focusing the Undo button) pauses the countdown; leaving
 * resumes it from where it stopped. The caller commits on `onExpire`.
 */
export function UndoToast({
  label,
  durationMs,
  onUndo,
  onDismiss,
  onExpire
}: UndoToastProps): JSX.Element {
  const [paused, setPaused] = useState(false)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [remaining, setRemaining] = useState(durationMs)
  const undoRef = useRef<HTMLButtonElement | null>(null)

  // Count down in small steps so pausing keeps the elapsed time.
  useEffect(() => {
    if (paused) return
    const timer = window.setInterval(() => {
      const left = remaining - (Date.now() - startedAt)
      if (left <= 0) {
        window.clearInterval(timer)
        onExpire()
        return
      }
      setRemaining(left)
    }, 100)
    return () => window.clearInterval(timer)
  }, [paused, startedAt, remaining, onExpire])

  const setPausedState = (next: boolean): void => {
    setPaused((current) => {
      if (current === next) return current
      if (next) {
        setRemaining((left) => Math.max(0, left - (Date.now() - startedAt)))
      } else {
        setStartedAt(Date.now())
      }
      return next
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const progress = Math.max(0, Math.min(1, remaining / durationMs))

  return (
    <div
      role="status"
      aria-live="polite"
      className="no-drag fixed bottom-11 left-1/2 z-[70] w-[min(92vw,380px)] -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-[var(--surface-card)] shadow-xl shadow-black/50"
      onMouseEnter={() => setPausedState(true)}
      onMouseLeave={() => setPausedState(false)}
      onFocus={() => setPausedState(true)}
      onBlur={() => setPausedState(false)}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-400"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
        </span>
        <p
          className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300"
          title={label}
        >
          Removed <span className="font-semibold text-zinc-100">{label}</span>
        </p>
        <button
          ref={undoRef}
          type="button"
          onClick={onUndo}
          className="h-7 shrink-0 rounded-md bg-accent-500 px-2.5 text-[11.5px] font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300"
        >
          Undo
        </button>
      </div>
      <div
        aria-hidden="true"
        className="h-[2px] w-full bg-white/[0.06]"
        data-paused={paused ? 'true' : 'false'}
      >
        <div
          className="h-full bg-accent-500/70 transition-[width] duration-100 ease-linear"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  )
}
