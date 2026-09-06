import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  clampPdfPage,
  clampPdfZoom,
  getOrCreateCachedPdfPreview,
  loadUserAnswerPdfPreview,
} from '../src/features/question-answer/userAnswerPdfPreviewModel'

test('PDF asset fetches a buffer and passes it to the shared PDF extractor', async () => {
  const controller = new AbortController()
  const expected = { pageCount: 2, controller: { pageCount: 2 } }
  let receivedName = ''
  let receivedBytes = 0
  const result = await loadUserAnswerPdfPreview(
    '/answer.pdf',
    'answer.pdf',
    controller.signal,
    async (buffer, fileName) => {
      receivedName = fileName
      receivedBytes = buffer.byteLength
      return expected as never
    },
    async (_input, init) => {
      assert.equal(init?.signal, controller.signal)
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    },
  )

  assert.equal(receivedName, 'answer.pdf')
  assert.equal(receivedBytes, 3)
  assert.equal(result.pageCount, 2)
})

test('two-page navigation and zoom stay inside reader bounds', () => {
  assert.equal(clampPdfPage(2, 2), 2)
  assert.equal(clampPdfPage(3, 2), 2)
  assert.equal(clampPdfPage(0, 2), 1)
  assert.equal(clampPdfZoom(0.2), 0.5)
  assert.equal(clampPdfZoom(1.24), 1.24)
  assert.equal(clampPdfZoom(3), 2)
})

test('the same attempt asset reuses its completed PDF preview request', async () => {
  const cache = new Map<string, Promise<{ pageCount: number }>>()
  let loads = 0
  const load = () => {
    loads += 1
    return Promise.resolve({ pageCount: 2 })
  }

  const first = getOrCreateCachedPdfPreview(cache, 'attempt-1:asset-1', load)
  const second = getOrCreateCachedPdfPreview(cache, 'attempt-1:asset-1', load)

  assert.equal(first, second)
  assert.equal((await second).pageCount, 2)
  assert.equal(loads, 1)
})

test('asset switch can abort an obsolete PDF fetch', async () => {
  const controller = new AbortController()
  let observedSignal: AbortSignal | null = null
  const pending = loadUserAnswerPdfPreview(
    '/old-answer.pdf',
    'old-answer.pdf',
    controller.signal,
    async () => ({}) as never,
    async (_input, init) => {
      observedSignal = init?.signal ?? null
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    },
  )

  controller.abort()
  await assert.rejects(pending, (error: unknown) => (
    error instanceof DOMException && error.name === 'AbortError'
  ))
  assert.equal(observedSignal?.aborted, true)
})

test('PDF 404 becomes a lightweight reader error', async () => {
  await assert.rejects(
    loadUserAnswerPdfPreview(
      '/missing.pdf',
      'missing.pdf',
      new AbortController().signal,
      async () => ({}) as never,
      async () => new Response('', { status: 404 }),
    ),
    /PDF 加载失败（404）/,
  )
})

test('answer viewer uses readonly PDF.js preview without iframe or visible asset filename', () => {
  const viewer = readFileSync(
    'src/features/question-answer/QuestionAnswerViewer.tsx', 'utf8',
  )
  const preview = readFileSync(
    'src/features/question-answer/UserAnswerPdfPreview.tsx', 'utf8',
  )

  assert.doesNotMatch(viewer, /<iframe/)
  assert.match(viewer, /<UserAnswerPdfPreview/)
  assert.match(viewer, /<img src=\{selectedAssetUrl\} alt=\{selectedAsset\.filename\} \/>/)
  assert.doesNotMatch(viewer, /selectedAsset\.filename\}<\/span>/)
  assert.match(preview, /extractPdfPreviewFromBuffer/)
  assert.match(preview, /variant="readonly"/)
  assert.match(preview, /abortController\.abort\(\)/)
  assert.match(viewer, /assetKey=\{`\$\{selected\.id\}:\$\{selectedAsset\.id\}`\}/)
  assert.match(viewer, /cache=\{pdfPreviewCacheRef\.current\}/)
})
