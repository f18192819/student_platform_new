import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createFastPdfController } from '../src/lib/pdf-core/fastController'
import { pdfPageRenderPriority } from '../src/lib/pdf-core/renderPriority'

test('fast controller only resolves the requested page before becoming ready', async () => {
  const requested: number[] = []
  const page = { getViewport: () => ({ width: 600, height: 800 }) }
  const pdf = {
    numPages: 120,
    getPage: async (number: number) => { requested.push(number); return page },
    loadingTask: { destroy: async () => undefined },
  }
  const controller = await createFastPdfController(pdf as never, { initialPage: 20 })
  assert.deepEqual(requested, [20])
  assert.equal(controller.pageSizes?.filter(Boolean).length, 1)
  assert.deepEqual(await controller.getPageSize?.(21), { width: 600, height: 800 })
  assert.deepEqual(requested, [20, 21])
})

test('visual priority is current, next, then previous', () => {
  const ready = new Set<number>()
  assert.equal(pdfPageRenderPriority(20, 20, 100, page => ready.has(page)), 0)
  assert.equal(pdfPageRenderPriority(21, 20, 100, page => ready.has(page)), null)
  ready.add(20)
  assert.equal(pdfPageRenderPriority(21, 20, 100, page => ready.has(page)), 1)
  assert.equal(pdfPageRenderPriority(19, 20, 100, page => ready.has(page)), null)
  ready.add(21)
  assert.equal(pdfPageRenderPriority(19, 20, 100, page => ready.has(page)), 2)
})

test('upload and restore critical paths do not use full text extraction', () => {
  const source = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  const upload = source.slice(source.indexOf('const handlePdfChange'), source.indexOf('const handleInspectPageDoubts'))
  assert.doesNotMatch(upload, /extractPdfPreview\(/)
  assert.match(upload, /openPdfPreviewFromBuffer\(buffer\)/)
  assert.match(source, /openPdfPreviewFromUrl/)
})
