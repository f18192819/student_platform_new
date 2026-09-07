import { useEffect, type ReactNode } from 'react'
import { FloatingToolDock } from './FloatingToolDock'
import { FloatingWorkspacePanel } from './FloatingWorkspacePanel'
import { ReaderEdgeTrigger } from './ReaderEdgeTrigger'
import { useFloatingWorkspacePanels, type WorkspacePanelId } from '../hooks/useFloatingWorkspacePanels'
import '../styles/reader-floating-ui.css'

type PanelDefinition = {
  title: string
  side: 'left' | 'right' | 'bottom'
  content: ReactNode
  role: 'dialog' | 'complementary' | 'region'
  autoPinOnInteract?: boolean
}

export function ReaderWorkspaceLayout({
  children,
  relatedPanel,
  chatPanel,
  gradingPanel,
  historyPanel,
  gradingBadge,
  historyBadge,
  gradingPinRequest = 0,
}: {
  children: ReactNode
  relatedPanel: ReactNode
  chatPanel: ReactNode
  gradingPanel?: ReactNode
  historyPanel?: ReactNode
  gradingBadge?: string | number | null
  historyBadge?: string | number | null
  gradingPinRequest?: number
}) {
  const panels = useFloatingWorkspacePanels()

  useEffect(() => {
    if (gradingPinRequest > 0 && gradingPanel) panels.pinPanel('grading')
  // pinPanel is stable; the request counter intentionally owns this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradingPinRequest, gradingPanel])

  const definitions: Record<WorkspacePanelId, PanelDefinition> = {
    related: { title: '关联资料', side: 'left', content: relatedPanel, role: 'complementary' },
    chat: { title: 'AI 助手', side: 'right', content: chatPanel, role: 'complementary' },
    grading: { title: '批改详情', side: 'right', content: gradingPanel, role: 'dialog', autoPinOnInteract: true },
    history: { title: '历史作答', side: 'bottom', content: historyPanel, role: 'region' },
  }
  const activeDefinition = panels.activePanel ? definitions[panels.activePanel] : null
  const activeContent = activeDefinition?.content
  const items = [
    { id: 'related' as const, label: '关联资料' },
    { id: 'chat' as const, label: 'AI 助手' },
    { id: 'grading' as const, label: '批改', badge: gradingBadge, disabled: !gradingPanel },
    { id: 'history' as const, label: '历史', badge: historyBadge, disabled: !historyPanel },
  ]

  return (
    <section className="reader-workspace">
      <div className="reader-workspace__stage">{children}</div>
      <ReaderEdgeTrigger side="left" panel="related" label="打开关联资料" onPreview={panels.previewPanel} onLeave={panels.schedulePanelClose} onPin={panels.togglePinnedPanel} />
      <ReaderEdgeTrigger side="right" panel="chat" label="打开 AI 助手" onPreview={panels.previewPanel} onLeave={panels.schedulePanelClose} onPin={panels.togglePinnedPanel} />
      {panels.activePanel && activeDefinition && activeContent ? (
        <FloatingWorkspacePanel
          key={panels.activePanel}
          open
          side={activeDefinition.side}
          title={activeDefinition.title}
          role={activeDefinition.role}
          pinned={panels.pinnedPanel === panels.activePanel}
          autoPinOnInteract={activeDefinition.autoPinOnInteract}
          onEnter={panels.keepPanelOpen}
          onLeave={panels.schedulePanelClose}
          onClose={panels.closePanel}
          onPin={() => panels.pinPanel(panels.activePanel!)}
        >{activeContent}</FloatingWorkspacePanel>
      ) : null}
      <FloatingToolDock
        items={items}
        activePanel={panels.activePanel}
        pinnedPanel={panels.pinnedPanel}
        onPreview={panels.previewPanel}
        onLeave={panels.schedulePanelClose}
        onTogglePin={panels.togglePinnedPanel}
      />
    </section>
  )
}

