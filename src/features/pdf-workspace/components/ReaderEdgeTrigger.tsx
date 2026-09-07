import type { WorkspacePanelId } from '../hooks/useFloatingWorkspacePanels'

export function ReaderEdgeTrigger({
  side,
  panel,
  label,
  onPreview,
  onLeave,
  onPin,
}: {
  side: 'left' | 'right'
  panel: WorkspacePanelId
  label: string
  onPreview: (panel: WorkspacePanelId) => void
  onLeave: (panel: WorkspacePanelId) => void
  onPin: (panel: WorkspacePanelId) => void
}) {
  return (
    <button
      type="button"
      className={`reader-edge-trigger reader-edge-trigger--${side}`}
      aria-label={label}
      onMouseEnter={() => onPreview(panel)}
      onMouseLeave={() => onLeave(panel)}
      onFocus={() => onPreview(panel)}
      onBlur={() => onLeave(panel)}
      onClick={() => onPin(panel)}
    ><span>{label}</span></button>
  )
}
