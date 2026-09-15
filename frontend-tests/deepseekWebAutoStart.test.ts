import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { startDeepSeekWebBridge } from '../src/lib/apiConfig'

test('DeepSeek Web auto-start calls the main backend start endpoint', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ started: true, ready: true, pid: 123 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await startDeepSeekWebBridge('http://127.0.0.1:8765')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /\/api\/deepseek-web\/start$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('login action starts the Bridge before asking it to open the browser', () => {
  const source = readFileSync('src/pages/ApiConfigPage.tsx', 'utf8')
  const handler = source.slice(source.indexOf('const openDeepSeekLogin'), source.indexOf('const updateModelDiscovery'))
  assert.ok(handler.indexOf('startDeepSeekWebBridge') < handler.indexOf('openDeepSeekWebBridge'))
  assert.match(handler, /正在启动 DeepSeek Web Bridge/)
})
