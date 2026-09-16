import { Link } from 'react-router-dom'
import type { WorkspacePanelId } from '../hooks/useReaderWorkspacePanels'

export type ReaderActivityItem = {
  id: WorkspacePanelId
  label: string
  badge?: string | number | null
  disabled?: boolean
}

function ActivityIcon({ id }: { id: WorkspacePanelId | 'settings' }) {
  const common = {
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  if (id === 'related') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path {...common} d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20M8 7h8M8 11h6" /></svg>
  if (id === 'chat') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M20.5 11.5a8 8 0 0 1-8.4 8 9.5 9.5 0 0 1-3.8-.8L4 20l1.4-3.8A7.7 7.7 0 0 1 4 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8 8Z" /><path {...common} d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01" /></svg>
  if (id === 'grading') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M6 3.5h9l3 3V21H6V3.5Z" /><path {...common} d="M15 3.5v3h3M9 11l2 2 4-4M9 17h6" /></svg>
  if (id === 'history') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path {...common} d="M4 4v4.5h4.5M12 7.5V12l3 2" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>
}

export function ReaderActivityBar({
  side,
  items,
  activePanel,
  onToggle,
  showSettings = false,
}: {
  side: 'left' | 'right'
  items: ReaderActivityItem[]
  activePanel: WorkspacePanelId | null
  onToggle: (panel: WorkspacePanelId) => void
  showSettings?: boolean
}) {
  return (
    <nav className={`reader-activity-bar reader-activity-bar--${side}`} aria-label={side === 'left' ? '阅读工具' : 'AI 助手'}>
      <div className="reader-activity-bar__primary">
        {items.map((item) => {
          const active = activePanel === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={active ? 'is-active' : ''}
              aria-label={active ? `收起${item.label}` : `打开${item.label}`}
              aria-pressed={active}
              disabled={item.disabled}
              onClick={() => onToggle(item.id)}
            >
              <span className="reader-activity-bar__indicator" aria-hidden="true" />
              <span className="reader-activity-bar__icon"><ActivityIcon id={item.id} /></span>
              <span className="reader-activity-bar__label">{item.label}</span>
              {item.badge ? <span className="reader-activity-bar__badge">{item.badge}</span> : null}
            </button>
          )
        })}
      </div>
      {showSettings ? (
        <Link className="reader-activity-bar__settings" to="/settings/api" aria-label="打开设置">
          <span className="reader-activity-bar__icon"><ActivityIcon id="settings" /></span>
          <span className="reader-activity-bar__label">设置</span>
        </Link>
      ) : null}
    </nav>
  )
}
