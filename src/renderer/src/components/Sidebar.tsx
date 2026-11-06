import type { JSX } from 'react'
import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  STATUS_FILTER_IDS,
  STATUS_FILTER_LABELS,
  type CategoryId,
  type StatusFilterId
} from '../lib/unified'
import { Icon, type IconName } from './Icon'

const CATEGORY_ICON: Record<CategoryId, IconName> = {
  all: 'download',
  video: 'video',
  audio: 'audio',
  documents: 'document',
  programs: 'program',
  compressed: 'archive',
  other: 'other'
}

const STATUS_ICON: Record<StatusFilterId, IconName> = {
  all: 'layers',
  active: 'active',
  queued: 'clock',
  completed: 'check',
  failed: 'alert'
}

export type SidebarPage = 'library' | 'batches' | 'settings'

interface SidebarProps {
  page: SidebarPage
  category: CategoryId
  status: StatusFilterId
  categoryCounts: Record<CategoryId, number>
  statusCounts: Record<StatusFilterId, number>
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectCategory: (category: CategoryId) => void
  onSelectStatus: (status: StatusFilterId) => void
  onSelectPage: (page: SidebarPage) => void
}

export function Sidebar({
  page,
  category,
  status,
  categoryCounts,
  statusCounts,
  collapsed,
  onToggleCollapsed,
  onSelectCategory,
  onSelectStatus,
  onSelectPage
}: SidebarProps): JSX.Element {
  const labelClass = collapsed ? 'hidden' : 'hidden min-[901px]:block'
  const countClass = collapsed ? 'hidden' : 'hidden min-[901px]:inline'

  return (
    <aside
      aria-label="Library navigation"
      className={`flex shrink-0 flex-col border-r border-white/[0.07] surface-soft transition-[width] duration-200 ${
        collapsed ? 'w-[52px]' : 'w-[52px] min-[901px]:w-[200px]'
      }`}
    >
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Library">
        <p
          className={`px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-600 ${labelClass}`}
        >
          Categories
        </p>
        <ul className="space-y-0.5">
          {CATEGORY_IDS.map((id) => (
            <li key={id}>
              <SidebarButton
                icon={CATEGORY_ICON[id]}
                label={CATEGORY_LABELS[id]}
                count={categoryCounts[id]}
                active={page === 'library' && category === id}
                compact={collapsed}
                labelClass={labelClass}
                countClass={countClass}
                onClick={() => onSelectCategory(id)}
                current={page === 'library' && category === id}
              />
            </li>
          ))}
        </ul>

        <p
          className={`px-2 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-600 ${labelClass}`}
        >
          Status
        </p>
        <ul className="space-y-0.5">
          {STATUS_FILTER_IDS.map((id) => {
            if (id === 'all') {
              return (
                <li key={id}>
                  <SidebarButton
                    icon={STATUS_ICON[id]}
                    label="All statuses"
                    count={statusCounts.all}
                    active={page === 'library' && status === 'all'}
                    compact={collapsed}
                    labelClass={labelClass}
                    countClass={countClass}
                    onClick={() => {
                      onSelectPage('library')
                      onSelectStatus('all')
                    }}
                    current={page === 'library' && status === 'all'}
                  />
                </li>
              )
            }
            return (
              <li key={id}>
                <SidebarButton
                  icon={STATUS_ICON[id]}
                  label={STATUS_FILTER_LABELS[id]}
                  count={statusCounts[id]}
                  active={page === 'library' && status === id}
                  compact={collapsed}
                  labelClass={labelClass}
                  countClass={countClass}
                  onClick={() => {
                    onSelectPage('library')
                    onSelectStatus(id)
                  }}
                  current={page === 'library' && status === id}
                />
              </li>
            )
          })}
        </ul>

        <div className="mx-2 my-3 border-t border-white/[0.07]" />

        <ul className="space-y-0.5">
          <li>
            <SidebarButton
              icon="layers"
              label="Batches"
              active={page === 'batches'}
              compact={collapsed}
              labelClass={labelClass}
              countClass={countClass}
              onClick={() => onSelectPage('batches')}
              current={page === 'batches'}
            />
          </li>
          <li>
            <SidebarButton
              icon="settings"
              label="Settings"
              active={page === 'settings'}
              compact={collapsed}
              labelClass={labelClass}
              countClass={countClass}
              onClick={() => onSelectPage('settings')}
              current={page === 'settings'}
            />
          </li>
        </ul>
      </nav>

      <div className="hidden border-t border-white/[0.07] p-2 min-[901px]:block">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className="flex h-8 w-full items-center justify-center gap-2 rounded-lg text-[11px] font-medium text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
        >
          <Icon
            name={collapsed ? 'chevron-right' : 'chevron-left'}
            size={15}
          />
          <span className={labelClass}>{collapsed ? 'Expand' : 'Collapse'}</span>
        </button>
      </div>
    </aside>
  )
}

function SidebarButton({
  icon,
  label,
  count,
  active,
  compact,
  labelClass,
  countClass,
  onClick,
  current
}: {
  icon: IconName
  label: string
  count?: number
  active: boolean
  compact: boolean
  labelClass: string
  countClass: string
  onClick: () => void
  current: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      aria-current={current ? 'page' : undefined}
      className={`group flex h-8 w-full items-center justify-center gap-2 rounded-lg px-0 text-left text-[12px] font-medium transition min-[901px]:justify-start min-[901px]:px-2 ${
        active
          ? 'bg-emerald-400/10 text-emerald-200 shadow-[inset_2px_0_0_0_rgb(52_211_153_/_0.85)]'
          : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
      }`}
    >
      <Icon
        name={icon}
        size={16}
        className={active ? 'text-emerald-300' : 'text-zinc-500 group-hover:text-zinc-300'}
      />
      <span className={`min-w-0 flex-1 truncate ${labelClass}`}>{label}</span>
      {typeof count === 'number' ? (
        <span
          className={`shrink-0 rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${
            active
              ? 'bg-emerald-400/15 text-emerald-200'
              : 'bg-white/[0.05] text-zinc-500'
          } ${countClass}`}
        >
          {count}
        </span>
      ) : null}
    </button>
  )
}
