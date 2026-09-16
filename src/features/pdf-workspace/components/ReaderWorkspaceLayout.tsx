import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { ReaderActivityBar } from './ReaderActivityBar'
import { WorkspacePanel } from './WorkspacePanel'
import { useReaderWorkspacePanels } from '../hooks/useReaderWorkspacePanels'
import '../styles/reader-floating-ui.css'

export function ReaderWorkspaceLayout({
  children,
  relatedPanel,
  chatPanel,
  gradingPanel,
  historyPanel,
  gradingBadge,
  historyBadge,
  historyTitle = '历史作答',
  historyLabel = '历史',
  gradingPinRequest = 0,
}: {
  children: ReactNode
  relatedPanel: ReactNode
  chatPanel: ReactNode
  gradingPanel?: ReactNode
  historyPanel?: ReactNode
  gradingBadge?: string | number | null
  historyBadge?: string | number | null
  historyTitle?: string
  historyLabel?: string
  gradingPinRequest?: number
}) {
  const panels = useReaderWorkspacePanels()
  const { left, right } = panels.layout
  const { openPanel } = panels

  useEffect(() => {
    if (gradingPinRequest > 0 && gradingPanel) openPanel('grading')
  }, [gradingPanel, gradingPinRequest, openPanel])

  const leftContent = left.panel === 'grading'
    ? gradingPanel
    : left.panel === 'history'
      ? historyPanel
      : left.panel === 'related'
        ? relatedPanel
        : null
  const leftTitle = left.panel === 'grading'
    ? '批改详情'
    : left.panel === 'history'
      ? historyTitle
      : '习题关联'
  const style = {
    '--reader-left-width': left.panel
      ? left.panel === 'grading' ? 'clamp(360px, 27vw, 460px)' : 'clamp(280px, 22vw, 360px)'
      : '0px',
    '--reader-right-width': right.panel ? 'clamp(360px, 27vw, 460px)' : '0px',
  } as CSSProperties
  const leftItems = [
    { id: 'related' as const, label: '习题关联' },
    { id: 'grading' as const, label: '批改', badge: gradingBadge, disabled: !gradingPanel },
    { id: 'history' as const, label: historyLabel, badge: historyBadge, disabled: !historyPanel },
  ]

  return (
    <section
      className={`reader-workspace${left.panel ? ' has-left' : ''}${right.panel ? ' has-right' : ''}`}
      data-layout-mode={panels.mode}
      data-right-panel={right.panel ?? 'none'}
      style={style}
    >
      <div className="reader-workspace__main">
        <div className="reader-workspace__activity reader-workspace__activity--left">
          <ReaderActivityBar
            side="left"
            items={leftItems}
            activePanel={left.panel}
            onToggle={panels.togglePanel}
            showSettings
          />
        </div>
        <div className="reader-workspace__left" data-open={Boolean(left.panel)}>
          <WorkspacePanel
            panelKey={leftContent ? left.panel : null}
            placement="left"
            title={leftTitle}
            eyebrow="工具"
            onClose={() => left.panel && panels.closePanel(left.panel)}
          >{leftContent}</WorkspacePanel>
        </div>

        <div className="reader-workspace__stage-frame">
          <div className="reader-workspace__stage">{children}</div>
        </div>

        <div className="reader-workspace__right" data-open={Boolean(right.panel)}>
          <WorkspacePanel
            panelKey={right.panel}
            placement="right"
            title="AI 助手"
            eyebrow="对话"
            onClose={() => panels.closePanel('chat')}
          >{chatPanel}</WorkspacePanel>
        </div>
        <div className="reader-workspace__activity reader-workspace__activity--right">
          <ReaderActivityBar
            side="right"
            items={[{ id: 'chat', label: 'AI 助手' }]}
            activePanel={right.panel}
            onToggle={panels.togglePanel}
          />
        </div>
      </div>
    </section>
  )
}
