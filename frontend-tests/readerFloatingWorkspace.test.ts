import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const layoutSource = readFileSync('src/features/pdf-workspace/components/ReaderWorkspaceLayout.tsx', 'utf8')
const hookSource = readFileSync('src/features/pdf-workspace/hooks/useReaderWorkspacePanels.ts', 'utf8')
const panelSource = readFileSync('src/features/pdf-workspace/components/WorkspacePanel.tsx', 'utf8')
const activityBarSource = readFileSync('src/features/pdf-workspace/components/ReaderActivityBar.tsx', 'utf8')
const readerCss = readFileSync('src/features/pdf-workspace/styles/reader-floating-ui.css', 'utf8')
const appCss = readFileSync('src/App.css', 'utf8')

test('reader workspace uses IDE-style activity rails around collapsible side panels', () => {
  assert.match(layoutSource, /reader-workspace__main/)
  assert.match(layoutSource, /reader-workspace__activity--left/)
  assert.match(layoutSource, /reader-workspace__left/)
  assert.match(layoutSource, /reader-workspace__stage-frame/)
  assert.match(layoutSource, /reader-workspace__right/)
  assert.match(layoutSource, /reader-workspace__activity--right/)
  assert.match(layoutSource, /ReaderActivityBar/)
  assert.match(layoutSource, /WorkspacePanel/)
  assert.match(readerCss, /grid-template-columns: var\(--reader-rail-width\) var\(--reader-left-width\) minmax\(520px, 1fr\) var\(--reader-right-width\) var\(--reader-rail-width\)/)
  assert.doesNotMatch(layoutSource, /reader-workspace__bottom/)
})

test('classroom tools, grading and history live on the left while AI owns the right side', () => {
  assert.match(hookSource, /left: PanelState<'classroom' \| 'related' \| 'grading' \| 'history'>/)
  assert.match(hookSource, /right: PanelState<'chat'>/)
  assert.match(layoutSource, /left\.panel === 'classroom'/)
  assert.match(layoutSource, /id: 'classroom' as const, label: '课堂工具'/)
  assert.match(layoutSource, /left\.panel === 'grading'/)
  assert.match(layoutSource, /left\.panel === 'history'/)
  assert.match(layoutSource, /title="AI 助手"/)
  assert.match(layoutSource, /id: 'related' as const, label: '习题关联'/)
  assert.match(layoutSource, /clamp\(300px, 20vw, 350px\)/)
  assert.match(layoutSource, /clamp\(380px, 25vw, 440px\)/)
})

test('workspace opens by click, closes by repeat click or Escape, and keeps PDF mounted', () => {
  assert.match(hookSource, /useState<WorkspaceLayoutState>\(EMPTY_LAYOUT\)/)
  assert.doesNotMatch(hookSource, /WIDE_LAYOUT/)
  assert.match(hookSource, /const togglePanel/)
  assert.match(hookSource, /current\.panel === panel/)
  assert.match(hookSource, /mode !== 'wide'/)
  assert.match(hookSource, /event\.key !== 'Escape'/)
  assert.doesNotMatch(hookSource, /onMouseEnter|OPEN_DELAY_MS|CLOSE_DELAY_MS/)
  assert.match(panelSource, /aria-label=\{title\}/)
  assert.match(layoutSource, /<div className="reader-workspace__stage">\{children\}<\/div>/)
  assert.match(readerCss, /transition: grid-template-columns var\(--reader-motion-layout\)/)
  assert.doesNotMatch(readerCss.split('@media (max-width: 899px)')[0], /\.reader-workspace__left[^}]*position: absolute/s)
})

test('reader uses a full-height layout with readable controls and no legacy grid override', () => {
  assert.match(readerCss, /--reader-rail-width: 56px/)
  assert.match(readerCss, /grid-template-rows: 60px minmax\(0, 1fr\)/)
  assert.match(readerCss, /\.octopus-app-header--reader \{[^}]*height: 60px/s)
  assert.match(readerCss, /\.pdf-stage__viewport \{[^}]*padding: 24px 32px 76px/s)
  assert.doesNotMatch(readerCss, /\.reader-workspace\s*\{[^}]*transform:\s*scale\(/s)
  assert.doesNotMatch(readerCss, /\bzoom\s*:/)
  assert.doesNotMatch(appCss, /\.pdf-workspace__reader-grid\s*\{/)
  assert.match(appCss, /\.app-shell--reader-page\s*\{[^}]*padding-bottom:\s*0/s)
  assert.doesNotMatch(appCss, /\.app-shell--reader-page\s*\{[^}]*padding-bottom:\s*14px/s)
})

test('activity rails expose settings, accessible toggles and mobile drawers', () => {
  assert.match(activityBarSource, /to="\/settings\/api"/)
  assert.match(activityBarSource, /aria-pressed=\{active\}/)
  assert.match(activityBarSource, /active \? `收起\$\{item\.label\}` : `打开\$\{item\.label\}`/)
  assert.match(activityBarSource, /reader-activity-bar--\$\{side\}/)
  assert.match(readerCss, /@media \(max-width: 899px\)/)
  assert.match(readerCss, /width: min\(410px, calc\(100% - 128px\)\)/)
  assert.match(readerCss, /@media \(max-width: 640px\)/)
  assert.match(readerCss, /flex-direction: row/)
  assert.match(readerCss, /@media \(prefers-reduced-motion: reduce\)/)
})
