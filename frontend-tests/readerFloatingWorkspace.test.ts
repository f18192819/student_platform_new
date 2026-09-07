import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('reader workspace uses one overlay panel system without resizing the PDF stage', () => {
  const page = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  const layout = readFileSync('src/features/pdf-workspace/components/ReaderWorkspaceLayout.tsx', 'utf8')

  assert.doesNotMatch(page, /useReaderPanelResize/)
  assert.doesNotMatch(page, /panel-resizer/)
  assert.match(layout, /FloatingToolDock/)
  assert.match(layout, /FloatingWorkspacePanel/)
  assert.match(layout, /relatedPanel/)
  assert.match(layout, /chatPanel/)
  assert.match(layout, /gradingPanel/)
  assert.match(layout, /historyPanel/)
})

test('panel behavior distinguishes preview, pin, escape close and grading interaction pin', () => {
  const hook = readFileSync('src/features/pdf-workspace/hooks/useFloatingWorkspacePanels.ts', 'utf8')
  const panel = readFileSync('src/features/pdf-workspace/components/FloatingWorkspacePanel.tsx', 'utf8')
  const layout = readFileSync('src/features/pdf-workspace/components/ReaderWorkspaceLayout.tsx', 'utf8')

  assert.match(hook, /OPEN_DELAY_MS = 150/)
  assert.match(hook, /CLOSE_DELAY_MS = 380/)
  assert.match(hook, /event\.key !== 'Escape'/)
  assert.match(hook, /setPinnedPanel/)
  assert.match(panel, /onPointerDownCapture=\{autoPinOnInteract \? onPin/)
  assert.match(layout, /autoPinOnInteract: true/)
})

test('dock remains keyboard accessible and panels adapt to touch layouts', () => {
  const dock = readFileSync('src/features/pdf-workspace/components/FloatingToolDock.tsx', 'utf8')
  const css = readFileSync('src/features/pdf-workspace/styles/reader-floating-ui.css', 'utf8')

  assert.match(dock, /type="button"/)
  assert.match(dock, /aria-label=\{item\.label\}/)
  assert.match(dock, /aria-pressed=/)
  assert.match(css, /@media \(max-width: 900px\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.reader-floating-panel--bottom/)
})

