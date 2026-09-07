import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const layoutSource = readFileSync('src/features/pdf-workspace/components/ReaderWorkspaceLayout.tsx', 'utf8')
const hookSource = readFileSync('src/features/pdf-workspace/hooks/useFloatingWorkspacePanels.ts', 'utf8')
const panelSource = readFileSync('src/features/pdf-workspace/components/WorkspacePanel.tsx', 'utf8')
const dockSource = readFileSync('src/features/pdf-workspace/components/FloatingToolDock.tsx', 'utf8')
const readerCss = readFileSync('src/features/pdf-workspace/styles/reader-floating-ui.css', 'utf8')

test('reader workspace reflows through left, stage, right and bottom layout slots', () => {
  assert.match(layoutSource, /reader-workspace__main/)
  assert.match(layoutSource, /reader-workspace__left/)
  assert.match(layoutSource, /reader-workspace__stage-frame/)
  assert.match(layoutSource, /reader-workspace__right/)
  assert.match(layoutSource, /reader-workspace__bottom/)
  assert.match(layoutSource, /WorkspacePanel/)
  assert.doesNotMatch(layoutSource, /from ['"][^'"]*\/FloatingWorkspacePanel['"]/)
  assert.doesNotMatch(layoutSource, /<FloatingWorkspacePanel/)
  assert.match(readerCss, /grid-template-columns: var\(--reader-left-width\) minmax\(520px, 1fr\) var\(--reader-right-width\)/)
  assert.match(readerCss, /grid-template-rows: minmax\(0, 1fr\) var\(--reader-history-height\)/)
})

test('left and right workspace state can coexist while chat and grading share one right slot', () => {
  assert.match(hookSource, /left: PanelState<'related'>/)
  assert.match(hookSource, /right: PanelState<'chat' \| 'grading'>/)
  assert.match(hookSource, /bottom: PanelState<'history'>/)
  assert.match(layoutSource, /right\.panel === 'grading'/)
  assert.match(layoutSource, /right\.panel === 'chat'/)
  assert.match(layoutSource, /left\.panel, right\.panel, bottom\.panel/)
  assert.match(layoutSource, /clamp\(280px, 22vw, 360px\)/)
  assert.match(layoutSource, /clamp\(380px, 28vw, 460px\)/)
  assert.match(layoutSource, /clamp\(420px, 32vw, 520px\)/)
})

test('workspace previews, pins, closes and adapts without remounting the reading stage', () => {
  assert.match(hookSource, /OPEN_DELAY_MS = 150/)
  assert.match(hookSource, /CLOSE_DELAY_MS = 380/)
  assert.match(hookSource, /mode !== 'wide'/)
  assert.match(hookSource, /mode === 'drawer'/)
  assert.match(hookSource, /event\.key !== 'Escape'/)
  assert.match(panelSource, /onPointerDownCapture=\{autoPinOnInteract \? onPin/)
  assert.match(layoutSource, /<div className="reader-workspace__stage">\{children\}<\/div>/)
  assert.match(readerCss, /transition: grid-template-columns var\(--reader-motion-layout\)/)
  assert.doesNotMatch(readerCss.split('@media (max-width: 899px)')[0], /\.reader-workspace__left[^}]*position: absolute/s)
})

test('dock follows the central stage and mobile panels become touch drawers', () => {
  assert.match(layoutSource, /reader-workspace__stage-frame[\s\S]*FloatingToolDock/)
  assert.match(dockSource, /activePanels: Set<WorkspacePanelId>/)
  assert.match(dockSource, /aria-label=\{accessibleLabel\}/)
  assert.match(dockSource, /aria-pressed=\{pinnedPanels\.has\(item\.id\)\}/)
  assert.match(readerCss, /@media \(max-width: 899px\)/)
  assert.match(readerCss, /height: min\(72vh, 680px\)/)
  assert.match(readerCss, /@media \(prefers-reduced-motion: reduce\)/)
})
