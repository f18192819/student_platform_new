import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createFastPdfController } from '../src/lib/pdf-core/fastController'
import {
  clearPdfPreviewCache,
  DisposablePdfPreviewPromiseCache,
  disposePdfController,
  setBoundedPdfPreview,
} from '../src/lib/pdf-core/disposableCache'
import { createMineruHydrationGate, MINERU_FIRST_PAINT_GRACE_MS } from '../src/lib/pdf-core/mineruGate'
import { getPdfPageSizePrefetchOrder, prefetchPdfPageSizes } from '../src/lib/pdf-core/pageSizePrefetch'
import { withPdfPreviewFallback } from '../src/lib/pdf-core/preview'
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

test('page size requests are deduplicated and do not expand controller startup', async () => {
  const requested: number[] = []
  let resolvePage: (() => void) | null = null
  const pdf = {
    numPages: 120,
    getPage: async (number: number) => {
      requested.push(number)
      if (number === 21) await new Promise<void>((resolve) => { resolvePage = resolve })
      return { getViewport: () => ({ width: 600, height: number === 21 ? 900 : 800 }) }
    },
    destroy: async () => undefined,
  }
  const controller = await createFastPdfController(pdf as never, { initialPage: 20 })
  assert.deepEqual(requested, [20])
  const first = controller.getPageSize!(21)
  const second = controller.getPageSize!(21)
  assert.equal(first, second)
  resolvePage?.()
  assert.deepEqual(await first, { width: 600, height: 900 })
  assert.deepEqual(requested, [20, 21])
})

test('page size prefetch is ordered around the current page and skips known geometry', async () => {
  const pageSizes = Array.from({ length: 20 }, () => null as { width: number; height: number } | null)
  pageSizes[10] = { width: 600, height: 800 }
  const requested: number[] = []
  const controller = {
    pageCount: 20,
    markdown: '',
    pageSizes,
    getPage: async () => ({}) as never,
    getPageSize: async (pageNumber: number) => {
      requested.push(pageNumber)
      return { width: 600, height: 800 }
    },
  }
  assert.deepEqual(getPdfPageSizePrefetchOrder(controller, 10, 2), [9, 12, 8])
  await prefetchPdfPageSizes(controller, 10, 2)
  assert.deepEqual(requested, [9, 12, 8])
})

test('MinerU soft gate allows once on visual readiness or grace timeout', () => {
  let scheduled: (() => void) | null = null
  let delay = 0
  let allowed = 0
  const gate = createMineruHydrationGate(
    () => { allowed += 1 },
    undefined,
    (callback, timeout) => { scheduled = callback; delay = timeout; return 1 as never },
    () => undefined,
  )
  assert.equal(delay, MINERU_FIRST_PAINT_GRACE_MS)
  gate.allow()
  scheduled?.()
  assert.equal(allowed, 1)

  let timeoutAllowed = 0
  const timeoutGate = createMineruHydrationGate(
    () => { timeoutAllowed += 1 },
    undefined,
    (callback) => { scheduled = callback; return 2 as never },
    () => undefined,
  )
  scheduled?.()
  timeoutGate.allow()
  assert.equal(timeoutAllowed, 1)
})

test('PDF controllers are disposed once across LRU eviction and teardown', async () => {
  let disposed = 0
  const controller = { pageCount: 1, markdown: '', getPage: async () => ({}) as never, dispose: async () => { disposed += 1 } }
  const cache = new Map<string, { controller: typeof controller }>()
  setBoundedPdfPreview(cache, 'one', { controller }, 1)
  setBoundedPdfPreview(cache, 'two', { controller: { ...controller, dispose: async () => undefined } }, 1)
  clearPdfPreviewCache(cache)
  await disposePdfController(controller)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(disposed, 1)
})

test('workspace-owned cache entries are not disposed during replacement or eviction', async () => {
  let disposed = 0
  const first = { pageCount: 1, markdown: '', getPage: async () => ({}) as never, dispose: async () => { disposed += 1 } }
  const second = { pageCount: 1, markdown: '', getPage: async () => ({}) as never, dispose: async () => { disposed += 1 } }
  const cache = new Map<string, { controller: typeof first }>()
  setBoundedPdfPreview(cache, 'one', { controller: first }, 1, { disposeRemoved: false })
  setBoundedPdfPreview(cache, 'two', { controller: second }, 1, { disposeRemoved: false })
  clearPdfPreviewCache(cache, { disposeRemoved: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(disposed, 0)
})

test('URL preview falls back to a downloaded buffer after the primary open fails', async () => {
  const expected = { pageCount: 3 }
  const buffer = new ArrayBuffer(8)
  const result = await withPdfPreviewFallback(
    async () => { throw new Error('range failed') },
    async () => buffer,
    async (received) => {
      assert.equal(received, buffer)
      return expected
    },
  )
  assert.equal(result, expected)
})

test('URL preview preserves the primary error when no fallback buffer is available', async () => {
  const primaryError = new Error('range failed')
  await assert.rejects(
    withPdfPreviewFallback(
      async () => { throw primaryError },
      async () => null,
      async () => ({ pageCount: 0 }),
    ),
    primaryError,
  )
})

test('pending answer preview is disposed when it resolves after LRU eviction', async () => {
  let resolvePreview: ((value: { controller: { dispose: () => Promise<void> } }) => void) | null = null
  let disposed = 0
  const cache = new DisposablePdfPreviewPromiseCache<{ controller: { dispose: () => Promise<void> } }>(1)
  const pending = new Promise<{ controller: { dispose: () => Promise<void> } }>((resolve) => { resolvePreview = resolve })
  cache.set('old', pending)
  cache.set('new', Promise.resolve({ controller: { dispose: async () => undefined } }))
  resolvePreview?.({ controller: { dispose: async () => { disposed += 1 } } })
  await pending
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(disposed, 1)
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

test('visual priority releases neighbors after the render safety timeout', () => {
  const neverReady = () => false
  assert.equal(pdfPageRenderPriority(21, 20, 100, neverReady), null)
  assert.equal(pdfPageRenderPriority(19, 20, 100, neverReady), null)
  assert.equal(pdfPageRenderPriority(21, 20, 100, neverReady, true), 1)
  assert.equal(pdfPageRenderPriority(19, 20, 100, neverReady, true), 2)
})

test('upload and restore critical paths do not use full text extraction', () => {
  const source = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  const upload = source.slice(source.indexOf('const handlePdfChange'), source.indexOf('const handleInspectPageDoubts'))
  assert.doesNotMatch(upload, /extractPdfPreview\(/)
  assert.match(upload, /openPdfPreviewFromBuffer\(buffer\)/)
  assert.match(source, /openPdfPreviewFromUrlWithFallback/)
})

test('reader rendering gates neighbors on visual readiness with a timed safety release', () => {
  const source = readFileSync('src/components/PdfPreviewCanvas.tsx', 'utf8')
  const visualReady = source.slice(source.indexOf('const isPageVisualReady'), source.indexOf('const handlePageVisualReady'))
  assert.doesNotMatch(source, /pageRefs\.current\.clear\(\)/)
  assert.doesNotMatch(visualReady, /querySelector/)
  assert.match(source, /priority !== null/)
  assert.match(source, /prefetch-safety-release/)
  assert.match(source, /450/)
  assert.doesNotMatch(source, /contentVisibility/)
})
