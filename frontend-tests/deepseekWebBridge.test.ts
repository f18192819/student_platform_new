import assert from 'node:assert/strict'
import test from 'node:test'

import { askWithConfiguredVisionApi, readDeepSeekWebStream } from '../src/lib/ai.ts'
import { defaultApiConfig } from '../src/lib/apiConfig.ts'


test('DeepSeek Web doubt mode streams assembled context from the local backend', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const tokens: string[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
    })
    return new Response([
      'data: {"type":"delta","content":"bridge "}\n\n',
      'data: {"type":"delta","content":"answer"}\n\n',
      'data: {"type":"done","content":"bridge answer"}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
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
      { onToken: (token) => tokens.push(token) },
      undefined,
      [{ id: 'm1', role: 'user', content: '上一轮问题', createdAt: new Date().toISOString() }],
    )

    assert.equal(result.answer, 'bridge answer')
    assert.deepEqual(tokens, ['bridge ', 'answer'])
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/api\/deepseek-web\/chat\/stream$/)
    assert.match(String(calls[0].body.prompt), /第 23 页/)
    assert.match(String(calls[0].body.prompt), /上一轮问题/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('DeepSeek Web stream replaces rewritten DOM snapshots and ignores malformed events', async () => {
  const snapshots: string[] = []
  const tokens: string[] = []
  const response = new Response([
    'data: {not-json}\n\n',
    'data: {"type":"delta","content":"abc"}\n\n',
    'data: {"type":"snapshot","content":"rewritten"}\n\n',
    'data: {"type":"delta","content":" tail"}\n\n',
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })

  const answer = await readDeepSeekWebStream(response, {
    onToken: (token) => tokens.push(token),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })

  assert.equal(answer, 'rewritten tail')
  assert.deepEqual(tokens, ['abc', ' tail'])
  assert.deepEqual(snapshots, ['rewritten'])
})

test('DeepSeek Web keeps the non-streaming bridge fallback for older local services', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/chat/stream')) return new Response('', { status: 404 })
    return new Response(JSON.stringify({ text: 'fallback answer' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const result = await askWithConfiguredVisionApi(
      'why',
      'page context',
      { ...defaultApiConfig, doubtProvider: 'deepseek-web' },
    )

    assert.equal(result.answer, 'fallback answer')
    assert.equal(urls.length, 2)
    assert.match(urls[0], /\/chat\/stream$/)
    assert.match(urls[1], /\/chat$/)
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
