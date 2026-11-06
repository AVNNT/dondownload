import type { JSX } from 'react'
import type { StatusTone } from '../lib/unified'

const TONE_STYLE: Record<StatusTone, string> = {
  active: 'border-accent-400/30 bg-accent-400/10 text-accent-300',
  queued: 'border-white/10 bg-white/[0.04] text-zinc-300',
  paused: 'border-zinc-600/70 bg-zinc-800/60 text-zinc-300',
  complete: 'border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300',
  warning: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  failed: 'border-red-400/30 bg-red-400/10 text-red-300'
}

const DOT_STYLE: Record<StatusTone, string> = {
  active: 'bg-accent-400',
  queued: 'bg-zinc-500',
  paused: 'bg-zinc-400',
  complete: 'bg-emerald-400',
  warning: 'bg-amber-400',
  failed: 'bg-red-400'
}

export function StatusBadge({
  label,
  tone
}: {
  label: string
  tone: StatusTone
}): JSX.Element {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.04em] ${TONE_STYLE[tone]}`}
      title={label}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_STYLE[tone]} ${
          tone === 'active' ? 'animate-pulse' : ''
        }`}
      />
      <span className="truncate">{label}</span>
    </span>
  )
}
