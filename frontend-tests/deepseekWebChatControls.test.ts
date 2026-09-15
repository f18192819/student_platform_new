import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('reader hides the model selector when doubt chat uses DeepSeek Web', () => {
  const workspace = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  assert.match(workspace, /showModelSelector=\{apiConfig\.doubtProvider === 'api'\}/)

  const chatPanel = readFileSync(
    'src/features/pdf-workspace/components/ChatPanel.tsx',
    'utf8',
  )
  assert.match(chatPanel, /showModelSelector \? \(/)
  assert.match(chatPanel, /showModelSelector = true/)
})
