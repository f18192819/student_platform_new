import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  KNOWLEDGE_LIBRARY_TIMEOUT_MS,
  withKnowledgeLibraryTimeout,
} from '../src/lib/knowledgeLibraryTimeout.ts'
import { KnowledgeLibraryConnectionError } from '../src/features/knowledge-library/KnowledgeLibraryConnectionError.tsx'

test('knowledge library request has a seven-second default limit', () => {
  assert.equal(KNOWLEDGE_LIBRARY_TIMEOUT_MS, 7_000)
})

test('knowledge library timeout aborts the in-flight request', async () => {
  let signal: AbortSignal | undefined
  await assert.rejects(
    withKnowledgeLibraryTimeout(
      async (requestSignal) => {
        signal = requestSignal
        await new Promise<void>((_, reject) => {
          requestSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
      10,
    ),
    /本地后端暂时不可用/,
  )
  assert.equal(signal?.aborted, true)
})

test('completed knowledge library request is not aborted', async () => {
  let signal: AbortSignal | undefined
  const result = await withKnowledgeLibraryTimeout(async (requestSignal) => {
    signal = requestSignal
    return 'loaded'
  }, 100)
  assert.equal(result, 'loaded')
  assert.equal(signal?.aborted, false)
})

test('failed library load exposes a reconnect action instead of the loading spinner', () => {
  const html = renderToStaticMarkup(createElement(KnowledgeLibraryConnectionError, { onRetry() {} }))
  assert.match(html, /本地后端暂时不可用/)
  assert.match(html, /重新连接/)
  assert.match(html, /role="alert"/)
})
