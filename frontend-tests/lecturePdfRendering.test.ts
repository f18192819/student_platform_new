import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const canvasSource = readFileSync('src/components/PdfPreviewCanvas.tsx', 'utf8')
const workspaceSource = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
const appCssSource = readFileSync('src/App.css', 'utf8')
const readerCssSource = readFileSync('src/features/pdf-workspace/styles/reader-floating-ui.css', 'utf8')

test('stored lecture pages use the cached server image path', () => {
  assert.match(workspaceSource, /resolveKnowledgePdfPageImageUrl/)
  assert.match(workspaceSource, /pageImageUrl=\{resolveLecturePageImage\}/)
  assert.match(
    canvasSource,
    /context\.drawImage\(image, 0, 0, canvas\.width, canvas\.height\)/,
  )
})

test('the reader only mounts canvases around the active page', () => {
  assert.match(canvasSource, /Math\.abs\(pageNumber - currentPage\) <= 1/)
  assert.match(canvasSource, /pdf-stage__page-surface--placeholder/)
  assert.match(canvasSource, /pdfPageRenderPriority/)
  assert.match(canvasSource, /renderTask = page\.render/)
  assert.doesNotMatch(canvasSource, /if \(!fallbackImageUrl\)/)
})

test('an unready PDF canvas is hidden and controller changes cannot reuse its bitmap', () => {
  assert.match(canvasSource, /setPageData\(null\)[\s\S]*setVisualReady\(false\)[\s\S]*setRasterReady\(false\)/)
  assert.match(canvasSource, /visibility: pageData && visualReady \? 'visible' : 'hidden'/)
  assert.match(canvasSource, /data-visual-ready=\{pageData && visualReady \? 'true' : 'false'\}/)
  assert.match(canvasSource, /key=\{`\$\{getPdfControllerId\(pdfController\)\}:\$\{pageNumber\}`\}/)
  assert.match(appCssSource, /\.pdf-stage__page-canvas\s*\{[\s\S]*visibility:\s*hidden/)
})

test('the page surface owns shadow and scales both axes from current-page geometry', () => {
  assert.doesNotMatch(readerCssSource, /pdf-stage__page-canvas\s*\{[^}]*box-shadow/)
  const surfaceRule = appCssSource.match(/\.pdf-stage__page-surface\s*\{[^}]*\}/)?.[0] ?? ''
  assert.doesNotMatch(surfaceRule, /max-width:\s*100%/)
  assert.match(canvasSource, /getFallbackRenderedPageWidth\(pdfController, currentPage\)/)
  assert.match(canvasSource, /renderedPagesRef\.current\.get\(currentPage\)\?\.width/)
  assert.match(canvasSource, /width: `\$\{pageData\.width \* displayScale\}px`[\s\S]*height: `\$\{pageData\.height \* displayScale\}px`/)
})
