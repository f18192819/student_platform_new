import type { ApiConfig } from '../../types'
import { buildEmbeddingApiUrl } from './urls'

const EMBEDDING_BATCH_SIZE = 16

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || !right.length || left.length !== right.length) {
    return -1
  }

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }

  if (!leftNorm || !rightNorm) {
    return -1
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

async function fetchEmbeddingBatch(config: ApiConfig, inputs: string[], model = config.embeddingModel) {
  const response = await fetch(buildEmbeddingApiUrl(config.embeddingBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.embeddingApiKey.trim()}`,
    },
    body: JSON.stringify({
      model,
      input: inputs,
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as {
    data?: Array<{
      embedding?: number[]
      index?: number
    }>
    error?: {
      message?: string
    }
    detail?: string
  }

  if (!response.ok) {
    const reason = payload.error?.message || payload.detail || `HTTP ${response.status}`
    throw new Error(`Embedding request failed: ${reason}`)
  }

  const data = Array.isArray(payload.data) ? payload.data : []
  const embeddings = data
    .slice()
    .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
    .map((item) => (Array.isArray(item.embedding) ? item.embedding.map((value) => Number(value)) : []))

  if (embeddings.length !== inputs.length || embeddings.some((embedding) => !embedding.length)) {
    throw new Error('Embedding model returned invalid vectors.')
  }

  return embeddings
}

async function fetchEmbeddingsAdaptive(
  config: ApiConfig,
  inputs: string[],
  model = config.embeddingModel,
): Promise<number[][]> {
  try {
    return await fetchEmbeddingBatch(config, inputs, model)
  } catch (error) {
    if (inputs.length <= 1) {
      throw error
    }

    const midpoint = Math.ceil(inputs.length / 2)
    const left: number[][] = await fetchEmbeddingsAdaptive(config, inputs.slice(0, midpoint), model)
    const right: number[][] = await fetchEmbeddingsAdaptive(config, inputs.slice(midpoint), model)
    return [...left, ...right]
  }
}

export async function fetchEmbeddings(config: ApiConfig, inputs: string[], model = config.embeddingModel) {
  const embeddings: number[][] = []

  for (let index = 0; index < inputs.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = inputs.slice(index, index + EMBEDDING_BATCH_SIZE)
    const nextEmbeddings = await fetchEmbeddingsAdaptive(config, batch, model)
    embeddings.push(...nextEmbeddings)
  }

  return embeddings
}
