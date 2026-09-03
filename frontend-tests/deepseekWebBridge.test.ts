import assert from 'node:assert/strict'
import test from 'node:test'

import { askWithConfiguredVisionApi } from '../src/lib/ai.ts'
import { defaultApiConfig } from '../src/lib/apiConfig.ts'


test('DeepSeek Web doubt mode sends assembled context to the local backend only', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify({ text: 'bridge answer', provider: 'deepseek-web' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await askWithConfiguredVisionApi(
      '为什么这里取逆矩阵？',
      [{ id: 'current-page', title: '第 23 页', content: 'A 的逆矩阵', bucket: 'pinned', priority: 100 }],
      {
        ...defaultApiConfig,
        baseUrl: '',
        apiKey: '',
        doubtProvider: 'deepseek-web',
      },
      [],
      undefined,
      undefined,
      [{ id: 'm1', role: 'user', content: '上一轮问题', createdAt: new Date().toISOString() }],
    )

    assert.equal(result.answer, 'bridge answer')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/api\/deepseek-web\/chat$/)
    assert.match(String(calls[0].body.prompt), /第 23 页/)
    assert.match(String(calls[0].body.prompt), /上一轮问题/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('DeepSeek Web doubt mode rejects image attachments without paid API fallback', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new Error('must not be called')
  }) as typeof fetch
  try {
    await assert.rejects(
      askWithConfiguredVisionApi(
        '看图回答',
        'page context',
        { ...defaultApiConfig, doubtProvider: 'deepseek-web' },
        [{ name: 'page.png', dataUrl: 'data:image/png;base64,AA==' }],
      ),
      /暂不接收附件/,
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
