import { useEffect, useRef, useState, type JSX } from 'react'
import { createCountdown, type Countdown } from '../lib/countdown'

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
  const [remaining, setRemaining] = useState(durationMs)
  const undoRef = useRef<HTMLButtonElement | null>(null)
  // Deadline-based countdown: the remaining time is always derived from the
  // clock, so ticking never compounds and pausing keeps the elapsed time.
  const countdownRef = useRef<Countdown | null>(null)
  const expiredRef = useRef(false)
  const onExpireRef = useRef(onExpire)

  const getCountdown = (): Countdown => {
    countdownRef.current ??= createCountdown({
      durationMs,
      now: Date.now()
    })
    return countdownRef.current
  }

  useEffect(() => {
    onExpireRef.current = onExpire
  }, [onExpire])

  useEffect(() => {
    if (paused) return
    const countdown = getCountdown()
    const tick = (): void => {
      const left = countdown.remaining(Date.now())
      setRemaining(left)
      if (left <= 0) {
        window.clearInterval(timer)
        // Guarded so a late tick can never commit the removal twice.
        if (!expiredRef.current) {
          expiredRef.current = true
          onExpireRef.current()
        }
      }
    }
    const timer = window.setInterval(tick, 100)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the countdown is created once and lives in a ref
  }, [paused])

  const setPausedState = (next: boolean): void => {
    const countdown = getCountdown()
    if (next === countdown.paused()) return
    if (next) countdown.pause(Date.now())
    else countdown.resume(Date.now())
    setPaused(next)
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

  const progress =
    durationMs > 0 ? Math.max(0, Math.min(1, remaining / durationMs)) : 0

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
