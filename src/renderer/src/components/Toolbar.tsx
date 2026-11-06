import type { JSX } from 'react'
import { formatSpeed } from '@shared/format'
import type { SortDirection, SortKey } from '../lib/unified'
import { SORT_KEYS, SORT_LABELS } from '../lib/unified'
import { Icon } from './Icon'

interface ToolbarProps {
  query: string
  onQueryChange: (value: string) => void
  sortKey: SortKey
  sortDirection: SortDirection
  onSortKeyChange: (key: SortKey) => void
  onToggleSortDirection: () => void
  runningCount: number
  speedBps: number
  completedCount: number
  canPauseAll: boolean
  canResumeAll: boolean
  onAdd: () => void
  onPauseAll: () => void
  onResumeAll: () => void
  onClearCompleted: () => void
}

export function Toolbar({
  query,
  onQueryChange,
  sortKey,
  sortDirection,
  onSortKeyChange,
  onToggleSortDirection,
  runningCount,
  speedBps,
  completedCount,
  canPauseAll,
  canResumeAll,
  onAdd,
  onPauseAll,
  onResumeAll,
  onClearCompleted
}: ToolbarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-3">
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-400 px-3 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
      >
        <Icon name="plus" size={15} strokeWidth={2.2} />
        Add
      </button>

      <div className="relative min-w-[170px] flex-1 sm:min-w-[220px]">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
        >
          <Icon name="search" size={15} />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search name, URL or host"
          aria-label="Search downloads"
          spellCheck={false}
          autoComplete="off"
          className="h-9 w-full rounded-lg border border-white/10 surface-input pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15"
        />
      </div>

      <label className="sr-only" htmlFor="download-sort">
        Sort downloads
      </label>
      <select
        id="download-sort"
        value={sortKey}
        onChange={(event) => onSortKeyChange(event.target.value as SortKey)}
        className="h-9 shrink-0 rounded-lg border border-white/10 surface-input px-2 text-[11px] text-zinc-300 outline-none transition focus:border-emerald-400/60"
      >
        {SORT_KEYS.map((key) => (
          <option key={key} value={key}>
            {SORT_LABELS[key]}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onToggleSortDirection}
        aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
        title={`Currently ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
        className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
      >
        {sortDirection === 'asc' ? '↑' : '↓'}
      </button>

      <span aria-hidden="true" className="mx-0.5 hidden h-5 w-px bg-white/10 sm:block" />

      <ToolbarAction
        icon="pause"
        label="Pause all"
        disabled={!canPauseAll}
        onClick={onPauseAll}
      />
      <ToolbarAction
        icon="play"
        label="Resume all"
        disabled={!canResumeAll}
        onClick={onResumeAll}
      />
      <ToolbarAction
        icon="trash"
        label="Clear completed"
        disabled={completedCount === 0}
        onClick={onClearCompleted}
        title="Remove completed history entries. Files stay on disk."
      />

      <div className="ml-auto flex shrink-0 items-center gap-3 pl-1 text-[11px] tabular-nums text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              runningCount > 0 ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600'
            }`}
          />
          <span className="text-zinc-300">{runningCount}</span>
          <span className="hidden sm:inline">active</span>
        </span>
        <span className="text-zinc-300">{formatSpeed(speedBps)}</span>
      </div>
    </div>
  )
}

function ToolbarAction({
  icon,
  label,
  disabled,
  onClick,
  title
}: {
  icon: 'pause' | 'play' | 'trash'
  label: string
  disabled: boolean
  onClick: () => void
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon name={icon} size={14} />
      <span className="hidden xl:inline">{label}</span>
    </button>
  )
}
