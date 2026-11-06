import type { JSX } from 'react'
import type { Aria2State } from '@shared/types'
import { Icon } from './Icon'

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

  const isStarting = aria2.status === 'starting' || aria2.status === 'stopped'

  if (isStarting) {
    return (
      <div
        role="status"
        className="mx-4 mt-2.5 flex items-center gap-2.5 rounded-lg border border-accent-400/30 bg-accent-400/[0.08] px-3 py-2 text-[12.5px] text-zinc-200"
      >
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-accent-400"
        />
        <span className="min-w-0">
          <span className="font-semibold text-zinc-100">
            Starting the download engine…
          </span>{' '}
          <span className="text-zinc-400">
            downloads continue in a moment.
          </span>
          {aria2.message ? (
            <span className="text-zinc-400"> {aria2.message}</span>
          ) : null}
        </span>
      </div>
    )
  }

  return (
    <div
      role="alert"
      className="mx-4 mt-2.5 flex items-center gap-2.5 rounded-lg border border-red-400/30 bg-red-400/[0.06] px-3 py-2 text-[12.5px] text-red-200"
    >
      <span aria-hidden="true" className="flex shrink-0 text-red-400">
        <Icon name="alert" size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">aria2 is not available</span>
        {aria2.message ? (
          <span className="text-red-300/80"> — {aria2.message}</span>
        ) : null}
        {aria2.hint ? (
          <span className="text-red-300/70"> {aria2.hint}</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onRetry}
        disabled={restarting}
        className="h-7 shrink-0 rounded-md border border-red-300/30 px-2.5 text-[11.5px] font-semibold text-red-200 transition hover:bg-red-300/10 disabled:opacity-50"
      >
        {restarting ? 'Restarting…' : 'Retry'}
      </button>
    </div>
  )
}
