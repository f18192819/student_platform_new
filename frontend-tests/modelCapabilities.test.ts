import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterModelsForSlot,
  partitionModelsForSlot,
  resolveModelUsageCapabilities,
  transformModelsDevPayload,
  type DiscoveredModel,
} from '../src/lib/modelCapabilities'

test('models.dev modalities map to chat and vision capabilities', () => {
  const registry = transformModelsDevPayload({
    provider: {
      models: {
        visual: {
          limit: { context: 128_000, output: 8_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    },
  })

  assert.deepEqual([...registry.visual.capabilities].sort(), ['chat', 'vision'])
  assert.equal(registry.visual.contextWindow, 128_000)
})

test('models.dev pure text generation maps to chat without vision', () => {
  const registry = transformModelsDevPayload({
    provider: {
      models: {
        text: {
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    },
  })

  assert.deepEqual([...registry.text.capabilities], ['chat'])
})

test('provider metadata has priority over conservative name heuristics', () => {
  const capabilities = resolveModelUsageCapabilities({
    id: 'looks-like-embedding-model',
    capabilities: ['chat'],
  })

  assert.deepEqual([...capabilities], ['chat'])
})

test('dedicated model names are not treated as chat models', () => {
  const models: DiscoveredModel[] = [
    { id: 'GLM-Embedding-3' },
    { id: 'text-embedding-3-small' },
    { id: 'GLM-Rerank' },
    { id: 'bge-reranker-v2' },
    { id: 'whisper-1' },
    { id: 'paraformer-zh' },
    { id: 'whisper-large-v3' },
    { id: 'unclassified-provider-model' },
  ]

  assert.deepEqual(filterModelsForSlot(models, 'text'), [])
  assert.deepEqual(filterModelsForSlot(models, 'embedding').map((model) => model.id), ['GLM-Embedding-3', 'text-embedding-3-small'])
  assert.deepEqual(filterModelsForSlot(models, 'rerank').map((model) => model.id), ['GLM-Rerank', 'bge-reranker-v2'])
  assert.deepEqual(filterModelsForSlot(models, 'asr').map((model) => model.id), ['whisper-1', 'paraformer-zh', 'whisper-large-v3'])
})

test('stable vision names are recognized without guessing generic chat models', () => {
  const models: DiscoveredModel[] = [
    { id: 'qwen2.5-vl-72b' },
    { id: 'internvl3' },
    { id: 'pixtral-large' },
    { id: 'DeepSeek-OCR' },
    { id: 'provider-custom-model' },
  ]

  assert.deepEqual(
    filterModelsForSlot(models, 'ocr').map((model) => model.id),
    ['qwen2.5-vl-72b', 'internvl3', 'pixtral-large', 'DeepSeek-OCR'],
  )
})

test('unknown models remain available outside the recommended group', () => {
  const models: DiscoveredModel[] = [
    { id: 'known-reranker' },
    { id: 'unknown-model' },
  ]

  const result = partitionModelsForSlot(models, 'rerank')

  assert.equal(result.total, 2)
  assert.deepEqual(result.recommended.map((model) => model.id), ['known-reranker'])
  assert.deepEqual(result.unknown.map((model) => model.id), ['unknown-model'])
})

test('ordinary text models do not enter OCR without explicit vision evidence', () => {
  const models: DiscoveredModel[] = [
    { id: 'deepseek-v3' },
    { id: 'qwen2.5-vl' },
  ]

  assert.deepEqual(filterModelsForSlot(models, 'ocr').map((model) => model.id), ['qwen2.5-vl'])
})
