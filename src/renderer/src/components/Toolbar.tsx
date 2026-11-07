import { useEffect, useRef, type JSX } from 'react'
import type { SortDirection, SortKey, StatusFilterId } from '../lib/unified'
import { SORT_KEYS, SORT_LABELS } from '../lib/unified'
import { Icon } from './Icon'

/**
 * Filter chips surface the status filter as the mockup does: All, Active, Done
 * and Failed. The underlying `StatusFilterId` values stay unchanged — the
 * "queued" bucket simply has no chip, matching the mockup's four chips.
 */
const FILTER_CHIPS: ReadonlyArray<{ id: StatusFilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Done' },
  { id: 'failed', label: 'Failed' }
]

interface ToolbarProps {
  query: string
  onQueryChange: (value: string) => void
  statusFilter: StatusFilterId
  onStatusFilterChange: (value: StatusFilterId) => void
  statusCounts: Record<StatusFilterId, number>
  sortKey: SortKey
  sortDirection: SortDirection
  onSortKeyChange: (key: SortKey) => void
  onToggleSortDirection: () => void
  canPauseAll: boolean
  canResumeAll: boolean
  onPauseAll: () => void
  onResumeAll: () => void
  /** Shown as a ghost button when the "Done" chip is active. */
  canClearCompleted: boolean
  onClearCompleted: () => void
  /** Removes every finished or failed entry; files on disk are kept. */
  canClearList: boolean
  onClearList: () => void
}

export function Toolbar({
  query,
  onQueryChange,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  sortKey,
  sortDirection,
  onSortKeyChange,
  onToggleSortDirection,
  canPauseAll,
  canResumeAll,
  onPauseAll,
  onResumeAll,
  canClearCompleted,
  onClearCompleted,
  canClearList,
  onClearList
}: ToolbarProps): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 pb-1 pt-2">
      <div className="relative min-w-[150px] max-w-[480px] flex-1">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
        >
          <Icon name="search" size={15} />
        </span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search downloads  /"
          aria-label="Search downloads"
          spellCheck={false}
          autoComplete="off"
          className="h-[34px] w-full rounded-lg border border-white/10 surface-card pl-9 pr-12 text-[13px] text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-accent-400/60 focus:ring-2 focus:ring-accent-400/15"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 px-1.5 py-px text-[10.5px] leading-4 text-zinc-500 lg:inline"
        >
          Ctrl K
        </span>
      </div>

      {FILTER_CHIPS.map((chip) => {
        const active = statusFilter === chip.id
        const count = statusCounts[chip.id]
        const failed = chip.id === 'failed'
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => onStatusFilterChange(chip.id)}
            aria-pressed={active}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition ${
              active
                ? 'border-white/10 bg-zinc-800/60 text-zinc-100'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {chip.label}
            <span
              className={`text-[11.5px] font-medium tabular-nums ${
                failed
                  ? 'text-red-400'
                  : active
                    ? 'text-zinc-400'
                    : 'text-zinc-500'
              }`}
            >
              {count}
            </span>
          </button>
        )
      })}

      <div className="ml-auto flex items-center gap-1">
        <label className="flex items-center gap-1.5">
          <span className="text-[12px] text-zinc-500">Sort</span>
          <select
            aria-label="Sort downloads"
            value={sortKey}
            onChange={(event) => onSortKeyChange(event.target.value as SortKey)}
            className="h-7 cursor-pointer rounded-md border border-transparent bg-transparent px-1 text-[12px] font-medium text-zinc-200 outline-none transition hover:border-white/10 hover:bg-white/5 focus:border-accent-400/60"
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onToggleSortDirection}
          aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
          title={`Currently ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
        >
          {sortDirection === 'asc' ? '↑' : '↓'}
        </button>
      </div>

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
      {statusFilter === 'completed' ? (
        <ToolbarTextAction
          label="Clear finished"
          title="Remove the completed entries from the list. Files on disk are kept."
          disabled={!canClearCompleted}
          onClick={onClearCompleted}
        />
      ) : null}
      <ToolbarTextAction
        label="Clear list"
        title="Remove finished and failed entries from the list. Files on disk are kept."
        disabled={!canClearList}
        onClick={onClearList}
      />
    </div>
  )
}

/** Ghost text button used by the list-clearing actions on the right. */
function ToolbarTextAction({
  label,
  title,
  disabled,
  onClick
}: {
  label: string
  title: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 text-[12px] font-semibold text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {label}
    </button>
  )
}

function ToolbarAction({
  icon,
  label,
  disabled,
  onClick
}: {
  icon: 'pause' | 'play'
  label: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 text-zinc-300 transition hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon name={icon} size={14} />
    </button>
  )
}
