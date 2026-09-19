import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createChatStreamBatcher } from '../src/lib/chatStreaming.ts'

test('stream batcher joins deltas into one append flush', () => {
  const flushes: Array<{ content: string; mode: string }> = []
  const batcher = createChatStreamBatcher((content, mode) => flushes.push({ content, mode }), 1_000)

  batcher.append('abc')
  batcher.append('def')
  batcher.flush()

  assert.deepEqual(flushes, [{ content: 'abcdef', mode: 'append' }])
  batcher.dispose()
})

test('stream batcher treats a snapshot followed by deltas as one replacement', () => {
  const flushes: Array<{ content: string; mode: string }> = []
  const batcher = createChatStreamBatcher((content, mode) => flushes.push({ content, mode }), 1_000)

  batcher.append('stale')
  batcher.replace('abc')
  batcher.append('def')
  batcher.flush()

  assert.deepEqual(flushes, [{ content: 'abcdef', mode: 'replace' }])
  batcher.dispose()
})

test('reader chat no longer simulates a 14ms single-character typewriter', () => {
  const workspace = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  const streaming = readFileSync('src/lib/chatStreaming.ts', 'utf8')
  const aiJson = readFileSync('src/lib/ai-core/json.ts', 'utf8')
  const source = `${workspace}\n${streaming}\n${aiJson}`

  assert.doesNotMatch(source, /slice\(0,\s*1\)/)
  assert.doesNotMatch(source, /setTimeout\([^\n]*14/)
  assert.doesNotMatch(aiJson, /for \(const char of delta\)/)
  assert.match(aiJson, /onToken\?\.\(delta\)/)
  assert.match(streaming, /intervalMs = 40/)
})
