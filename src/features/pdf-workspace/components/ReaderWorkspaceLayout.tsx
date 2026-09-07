import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { FloatingToolDock } from './FloatingToolDock'
import { ReaderEdgeTrigger } from './ReaderEdgeTrigger'
import { WorkspacePanel } from './WorkspacePanel'
import { useFloatingWorkspacePanels, type WorkspacePanelId } from '../hooks/useFloatingWorkspacePanels'
import '../styles/reader-floating-ui.css'

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
  const { left, right, bottom } = panels.layout

  useEffect(() => {
    if (gradingPinRequest > 0 && gradingPanel) panels.pinPanel('grading')
  }, [gradingPanel, gradingPinRequest, panels.pinPanel])

  const rightContent = right.panel === 'grading' ? gradingPanel : right.panel === 'chat' ? chatPanel : null
  const rightTitle = right.panel === 'grading' ? '批改详情' : 'AI 助手'
  const rightWidth = right.panel === 'grading'
    ? 'clamp(420px, 32vw, 520px)'
    : right.panel === 'chat'
      ? 'clamp(380px, 28vw, 460px)'
      : '0px'
  const style = {
    '--reader-left-width': left.panel ? 'clamp(280px, 22vw, 360px)' : '0px',
    '--reader-right-width': rightWidth,
    '--reader-history-height': bottom.panel ? 'clamp(240px, 30vh, 310px)' : '0px',
  } as CSSProperties
  const activePanels = new Set<WorkspacePanelId>(
    [left.panel, right.panel, bottom.panel].filter(Boolean) as WorkspacePanelId[],
  )
  const pinnedPanels = new Set<WorkspacePanelId>(
    [left.pinned ? left.panel : null, right.pinned ? right.panel : null, bottom.pinned ? bottom.panel : null]
      .filter(Boolean) as WorkspacePanelId[],
  )
  const items = [
    { id: 'related' as const, label: '关联资料' },
    { id: 'chat' as const, label: 'AI 助手' },
    { id: 'grading' as const, label: '批改', badge: gradingBadge, disabled: !gradingPanel },
    { id: 'history' as const, label: '历史', badge: historyBadge, disabled: !historyPanel },
  ]

  return (
    <section
      className={`reader-workspace${left.panel ? ' has-left' : ''}${right.panel ? ' has-right' : ''}${bottom.panel ? ' has-bottom' : ''}`}
      data-layout-mode={panels.mode}
      data-right-panel={right.panel ?? 'none'}
      style={style}
    >
      <div className="reader-workspace__main">
        <div className="reader-workspace__left" data-open={Boolean(left.panel)}>
          <WorkspacePanel
            panelKey={left.panel}
            placement="left"
            title="关联资料"
            pinned={left.pinned}
            onEnter={() => panels.keepPanelOpen('related')}
            onLeave={() => panels.schedulePanelClose('related')}
            onClose={() => panels.closePanel('related')}
            onPin={() => panels.pinPanel('related')}
          >{relatedPanel}</WorkspacePanel>
        </div>

        <div className="reader-workspace__stage-frame">
          <div className="reader-workspace__stage">{children}</div>
          <ReaderEdgeTrigger side="left" panel="related" label="打开关联资料" onPreview={panels.previewPanel} onLeave={panels.schedulePanelClose} onPin={panels.togglePinnedPanel} />
          <ReaderEdgeTrigger side="right" panel="chat" label="打开 AI 助手" onPreview={panels.previewPanel} onLeave={panels.schedulePanelClose} onPin={panels.togglePinnedPanel} />
          <FloatingToolDock
            items={items}
            activePanels={activePanels}
            pinnedPanels={pinnedPanels}
            onPreview={panels.previewPanel}
            onLeave={panels.schedulePanelClose}
            onTogglePin={panels.togglePinnedPanel}
          />
        </div>

        <div className="reader-workspace__right" data-open={Boolean(right.panel)}>
          <WorkspacePanel
            panelKey={rightContent ? right.panel : null}
            placement="right"
            title={rightTitle}
            pinned={right.pinned}
            role={right.panel === 'grading' ? 'dialog' : 'complementary'}
            autoPinOnInteract={right.panel === 'grading'}
            onEnter={() => right.panel && panels.keepPanelOpen(right.panel)}
            onLeave={() => right.panel && panels.schedulePanelClose(right.panel)}
            onClose={() => right.panel && panels.closePanel(right.panel)}
            onPin={() => right.panel && panels.pinPanel(right.panel)}
          >{rightContent}</WorkspacePanel>
        </div>
      </div>

      <div className="reader-workspace__bottom" data-open={Boolean(bottom.panel)}>
        <WorkspacePanel
          panelKey={historyPanel ? bottom.panel : null}
          placement="bottom"
          title="历史作答"
          pinned={bottom.pinned}
          role="region"
          onEnter={() => panels.keepPanelOpen('history')}
          onLeave={() => panels.schedulePanelClose('history')}
          onClose={() => panels.closePanel('history')}
          onPin={() => panels.pinPanel('history')}
        >{historyPanel}</WorkspacePanel>
      </div>
    </section>
  )
}
