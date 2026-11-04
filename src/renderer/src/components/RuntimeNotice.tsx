import type { JSX } from 'react'
import type { Aria2State } from '@shared/types'

interface RuntimeNoticeProps {
  aria2: Aria2State
  restarting: boolean
  onRetry: () => void
}

export function RuntimeNotice({
  aria2,
  restarting,
  onRetry
}: RuntimeNoticeProps): JSX.Element | null {
  if (aria2.status === 'ready') {
    return null
  }

  const isFailure = aria2.status === 'unavailable' || aria2.status === 'error'
  const isStarting = aria2.status === 'starting' || aria2.status === 'stopped'

  return (
    <div
      role={isFailure ? 'alert' : 'status'}
      className={`mt-3 rounded-xl border px-4 py-3 text-xs leading-5 ${
        isFailure
          ? 'border-amber-400/25 bg-amber-400/5 text-amber-200'
          : 'border-white/10 bg-white/[0.02] text-zinc-400'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {isStarting ? 'Starting the download engine…' : 'aria2 is not available'}
          </p>
          {aria2.message ? (
            <p className="mt-0.5 break-words text-[11px] opacity-80">{aria2.message}</p>
          ) : null}
          {aria2.hint ? (
            <p className="mt-1 break-words text-[11px] opacity-70">{aria2.hint}</p>
          ) : null}
        </div>
        {isFailure ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={restarting}
            className="shrink-0 rounded-lg border border-amber-300/30 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-300/10 disabled:opacity-50"
          >
            {restarting ? 'Restarting…' : 'Retry aria2'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
