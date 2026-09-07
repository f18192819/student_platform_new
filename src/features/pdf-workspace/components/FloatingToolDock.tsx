import { motion } from 'motion/react'
import type { WorkspacePanelId } from '../hooks/useFloatingWorkspacePanels'

type DockItem = {
  id: WorkspacePanelId
  label: string
  badge?: string | number | null
  disabled?: boolean
}

function DockIcon({ id }: { id: WorkspacePanelId }) {
  const common = {
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  if (id === 'related') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M9.5 14.5 14.5 9M7 17l-1 1a3.54 3.54 0 0 1-5-5l3-3a3.54 3.54 0 0 1 5 0M17 7l1-1a3.54 3.54 0 0 1 5 5l-3 3a3.54 3.54 0 0 1-5 0" /></svg>
  if (id === 'chat') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M21 12a8.5 8.5 0 0 1-9 8.5 10 10 0 0 1-4.2-.9L3 21l1.5-4.2A8.2 8.2 0 0 1 3 12a8.5 8.5 0 0 1 9-8.5A8.5 8.5 0 0 1 21 12Z" /><path {...common} d="M8 12h.01M12 12h.01M16 12h.01" /></svg>
  if (id === 'grading') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m5 12 4 4L19 6" /><path {...common} d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle {...common} cx="12" cy="12" r="8.5" /><path {...common} d="M12 7v5l3 2M4.5 5.5 2.8 7.2" /></svg>
}

export function FloatingToolDock({
  items,
  activePanels,
  pinnedPanels,
  onPreview,
  onLeave,
  onTogglePin,
}: {
  items: DockItem[]
  activePanels: Set<WorkspacePanelId>
  pinnedPanels: Set<WorkspacePanelId>
  onPreview: (panel: WorkspacePanelId) => void
  onLeave: (panel: WorkspacePanelId) => void
  onTogglePin: (panel: WorkspacePanelId) => void
}) {
  return (
    <nav className="reader-tool-dock" aria-label="阅读工具">
      {items.map((item) => {
        const active = activePanels.has(item.id)
        const accessibleLabel = item.badge ? `${item.label}${item.badge}` : item.label
        return (
          <motion.button
            key={item.id}
            type="button"
            className={active ? 'is-active' : ''}
            aria-label={accessibleLabel}
            aria-pressed={pinnedPanels.has(item.id)}
            disabled={item.disabled}
            onMouseEnter={() => onPreview(item.id)}
            onMouseLeave={() => onLeave(item.id)}
            onFocus={() => onPreview(item.id)}
            onBlur={() => onLeave(item.id)}
            onClick={() => onTogglePin(item.id)}
            animate={{ y: active ? -2 : 0 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="reader-tool-dock__icon"><DockIcon id={item.id} /></span>
            <span className="reader-tool-dock__label">{item.label}</span>
            {item.badge ? <span className="reader-tool-dock__badge">{item.badge}</span> : null}
          </motion.button>
        )
      })}
    </nav>
  )
}

