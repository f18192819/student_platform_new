import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const canvasSource = readFileSync('src/components/PdfPreviewCanvas.tsx', 'utf8')
const cssSource = readFileSync('src/App.css', 'utf8')

test('user scrolling reports the visible page without becoming a scroll command', () => {
  assert.match(canvasSource, /pageChangeFromUserScrollRef\.current = nextPage[\s\S]*requestVisiblePageChange\(nextPage\)/)
  assert.match(canvasSource, /pageChangeFromUserScrollRef\.current === currentPage[\s\S]*reportedVisiblePageRef\.current = currentPage[\s\S]*return/)
})

test('programmatic page navigation has an explicit one-shot intent', () => {
  assert.match(canvasSource, /type PendingPageNavigation/)
  assert.match(canvasSource, /pendingNavigationRef = useRef<PendingPageNavigation \| null>/)
  assert.match(canvasSource, /const consumePendingPageNavigation = \(\) =>/)
  assert.match(canvasSource, /pendingNavigationRef\.current = null/)
})

test('render completion never unconditionally repositions the viewport', () => {
  const handler = canvasSource.slice(
    canvasSource.indexOf('const handlePageRendered'),
    canvasSource.indexOf('const firstRenderedPage'),
  )
  assert.doesNotMatch(handler, /scrollTop\s*=/)
  assert.doesNotMatch(handler, /scrollTo\(/)
})

test('viewport resize is RAF-coalesced and restores a normalized reading anchor', () => {
  assert.match(canvasSource, /resizeRafRef\.current = window\.requestAnimationFrame\(commitWidth\)/)
  assert.match(canvasSource, /type ViewportAnchor = \{[\s\S]*normalizedY: number/)
  assert.match(canvasSource, /pendingViewportAnchorRef\.current = captureViewportAnchor\(\)/)
  assert.match(canvasSource, /restoreViewportAnchor\(anchor\)/)
})

test('placeholder and mounted page share one surface-size formula', () => {
  assert.match(canvasSource, /const expectedSurfaceSize = getExpectedPageSurfaceSize\(/)
  assert.match(canvasSource, /expectedWidth=\{expectedSurfaceSize\?\.width\}/)
  assert.match(canvasSource, /width: `\$\{expectedSurfaceSize\.width\}px`/)
  assert.match(canvasSource, /height: `\$\{expectedSurfaceSize\.height\}px`/)
})

test('question changes originating from scroll do not create an anchor navigation', () => {
  assert.match(canvasSource, /questionChangeFromUserScrollRef\.current === questionId/)
  assert.match(canvasSource, /pendingQuestionAnchorRef\.current = null[\s\S]*return/)
  assert.match(canvasSource, /pendingQuestionAnchorRef\.current === selectedHomeworkQuestion\.id/)
})

test('reader owns scroll preservation instead of browser scroll anchoring', () => {
  assert.match(cssSource, /\.pdf-stage__viewport\s*\{[\s\S]*overflow-anchor:\s*none/)
  assert.match(cssSource, /\.pdf-stage__stack\s*\{[\s\S]*overflow-anchor:\s*none/)
})

test('zoom can exceed 100 percent while preserving the current reading anchor', () => {
  assert.match(canvasSource, /const displayScale = zoom \* fitScale/)
  assert.doesNotMatch(canvasSource, /const displayScale = Math\.min\(1, zoom \* fitScale\)/)
  assert.match(canvasSource, /runZoomCommand\(onZoomIn\)/)
  assert.match(canvasSource, /pendingViewportAnchorRef\.current = captureViewportAnchor\(\)/)
})

test('mixed-size geometry prefetch waits for visual ready and preserves the viewport anchor', () => {
  assert.match(canvasSource, /visualPages\.pages\.has\(currentPage\)[\s\S]*prefetchPdfPageSizes/)
  assert.match(canvasSource, /pendingViewportAnchorRef\.current = captureViewportAnchor\w*\(\)[\s\S]*setGeometryVersion/)
  assert.match(canvasSource, /\[geometryVersion, zoom\]/)
})
