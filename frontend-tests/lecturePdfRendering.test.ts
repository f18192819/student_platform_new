import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const canvasSource = readFileSync('src/components/PdfPreviewCanvas.tsx', 'utf8')
const workspaceSource = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')

test('stored lecture pages use the cached server image path', () => {
  assert.match(workspaceSource, /resolveKnowledgePdfPageImageUrl/)
  assert.match(workspaceSource, /pageImageUrl=\{resolveLecturePageImage\}/)
  assert.match(
    canvasSource,
    /context\.drawImage\(event\.currentTarget, 0, 0, canvas\.width, canvas\.height\)/,
  )
})

test('the reader only mounts canvases around the active page', () => {
  assert.match(canvasSource, /Math\.abs\(pageNumber - currentPage\) <= 1/)
  assert.match(canvasSource, /pdf-stage__page-surface--placeholder/)
})
