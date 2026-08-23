import type { ApiConfig } from '../types'

export type TokenizerFamily = 'cl100k' | 'deepseek'
export type ModelCapabilitySource = 'override' | 'runtime-registry' | 'bundled-registry' | 'fallback'
export type ContextTask = 'chat' | 'summary' | 'pipeline'

export type ModelCapability = {
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  tokenizer: TokenizerFamily
  source: ModelCapabilitySource
}

export type ModelContextBudget = ModelCapability & {
  outputReserveTokens: number
  safetyReserveTokens: number
  inputBudgetTokens: number
  compactionThresholdTokens: number
}

type RegistryCapability = {
  contextWindow: number
  maxOutputTokens: number
}

type ModelsDevPayload = Record<
  string,
  {
    models?: Record<
      string,
      {
        id?: string
        limit?: {
          context?: number
          output?: number
        }
      }
    >
  }
>

const MODELS_DEV_URL = 'https://models.dev/api.json'
const REGISTRY_CACHE_KEY = 'student-platform.model-capabilities.v1'
const REGISTRY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CONTEXT_WINDOW = 96_000
const DEFAULT_MAX_OUTPUT = 16_384
const DEFAULT_COMPACTION_THRESHOLD = 0.6

// Keep a small offline registry for the models used by this project. The
// runtime models.dev registry can enrich this list without making startup
// dependent on an external service.
const BUNDLED_REGISTRY: Record<string, RegistryCapability> = {
  'deepseek-v4-flash': { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  'deepseek-v4-pro': { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
  'deepseek-v3.2': { contextWindow: 131_072, maxOutputTokens: 32_768 },
  'deepseek-v3.1': { contextWindow: 131_072, maxOutputTokens: 32_768 },
  'deepseek-v3': { contextWindow: 131_072, maxOutputTokens: 32_768 },
  'deepseek-r1': { contextWindow: 131_072, maxOutputTokens: 32_768 },
  'minimax-m3': { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
  'minimax-m2.7': { contextWindow: 204_800, maxOutputTokens: 131_072 },
  'minimax-m2.5': { contextWindow: 204_800, maxOutputTokens: 131_072 },
  'minimax-m2': { contextWindow: 204_800, maxOutputTokens: 131_072 },
  'minimax-text-01': { contextWindow: 1_000_192, maxOutputTokens: 65_536 },
  'glm-4.7': { contextWindow: 204_800, maxOutputTokens: 131_072 },
  'glm-4.6v': { contextWindow: 131_072, maxOutputTokens: 32_768 },
  'glm-4.6': { contextWindow: 204_800, maxOutputTokens: 131_072 },
  'glm-4.5v': { contextWindow: 65_536, maxOutputTokens: 16_384 },
  'glm-4.5': { contextWindow: 131_072, maxOutputTokens: 98_304 },
  'glm-4-long': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'gpt-5': { contextWindow: 400_000, maxOutputTokens: 128_000 },
  'gpt-4.1': { contextWindow: 1_047_576, maxOutputTokens: 32_768 },
  'gpt-4o': { contextWindow: 128_000, maxOutputTokens: 16_384 },
  'claude-opus-4': { contextWindow: 200_000, maxOutputTokens: 64_000 },
  'claude-sonnet-4': { contextWindow: 200_000, maxOutputTokens: 64_000 },
  'gemini-3': { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  'gemini-2.5': { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
}

let runtimeRegistry: Record<string, RegistryCapability> = {}
let prefetchPromise: Promise<void> | null = null

function normalizeModelId(modelId: string) {
  return modelId.trim().toLowerCase()
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function findByExactOrPrefix(
  modelId: string,
  registry: Record<string, RegistryCapability>,
): RegistryCapability | null {
  const normalized = normalizeModelId(modelId)
  if (!normalized) return null
  if (registry[normalized]) return registry[normalized]

  let bestKey = ''
  for (const key of Object.keys(registry)) {
    if (!normalized.startsWith(key) || key.length <= bestKey.length) continue
    const boundary = normalized[key.length]
    if (boundary === undefined || '-:./@'.includes(boundary)) bestKey = key
  }
  return bestKey ? registry[bestKey] : null
}

function findOverride(config: ApiConfig, modelId: string) {
  const normalized = normalizeModelId(modelId)
  for (const [key, value] of Object.entries(config.contextWindowOverrides)) {
    if (normalizeModelId(key) === normalized && isPositiveInteger(value)) return value
  }
  return null
}

function getTokenizerFamily(modelId: string): TokenizerFamily {
  return normalizeModelId(modelId).includes('deepseek') ? 'deepseek' : 'cl100k'
}

function transformModelsDevPayload(payload: ModelsDevPayload) {
  const transformed: Record<string, RegistryCapability> = {}
  for (const provider of Object.values(payload)) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      const modelId = normalizeModelId(model.id || key)
      const contextWindow = model.limit?.context
      if (!modelId || !isPositiveInteger(contextWindow)) continue
      const maxOutputTokens = isPositiveInteger(model.limit?.output)
        ? model.limit.output
        : DEFAULT_MAX_OUTPUT
      const existing = transformed[modelId]
      // A custom gateway may expose a smaller window than the original vendor.
      // When providers disagree, use the conservative value.
      if (!existing || contextWindow < existing.contextWindow) {
        transformed[modelId] = { contextWindow, maxOutputTokens }
      }
    }
  }
  return transformed
}

function loadCachedRegistry() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(REGISTRY_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      timestamp?: number
      registry?: Record<string, RegistryCapability>
    }
    if (!parsed.registry || typeof parsed.timestamp !== 'number') return null
    runtimeRegistry = parsed.registry
    return { timestamp: parsed.timestamp, registry: parsed.registry }
  } catch {
    return null
  }
}

export function prefetchModelCapabilities() {
  if (typeof window === 'undefined') return Promise.resolve()
  if (prefetchPromise) return prefetchPromise

  const cached = loadCachedRegistry()
  if (cached && Date.now() - cached.timestamp < REGISTRY_CACHE_MAX_AGE_MS) {
    return Promise.resolve()
  }

  prefetchPromise = (async () => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(MODELS_DEV_URL, { signal: controller.signal })
      if (!response.ok) return
      const registry = transformModelsDevPayload((await response.json()) as ModelsDevPayload)
      if (!Object.keys(registry).length) return
      runtimeRegistry = registry
      window.localStorage.setItem(
        REGISTRY_CACHE_KEY,
        JSON.stringify({ timestamp: Date.now(), registry }),
      )
    } catch {
      // The bundled registry and manual overrides keep context management usable offline.
    } finally {
      window.clearTimeout(timeout)
      prefetchPromise = null
    }
  })()

  return prefetchPromise
}

export function resolveModelCapability(config: ApiConfig, modelId: string): ModelCapability {
  const override = findOverride(config, modelId)
  const runtime = findByExactOrPrefix(modelId, runtimeRegistry)
  const bundled = findByExactOrPrefix(modelId, BUNDLED_REGISTRY)
  const matched = runtime ?? bundled

  return {
    modelId,
    contextWindow: override ?? matched?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: matched?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    tokenizer: getTokenizerFamily(modelId),
    source: override
      ? 'override'
      : runtime
        ? 'runtime-registry'
        : bundled
          ? 'bundled-registry'
          : 'fallback',
  }
}

function getPreferredOutputReserve(task: ContextTask) {
  if (task === 'summary') return 8_192
  if (task === 'pipeline') return 32_768
  return 16_384
}

export function resolveModelContextBudget(
  config: ApiConfig,
  modelId: string,
  task: ContextTask,
): ModelContextBudget {
  const capability = resolveModelCapability(config, modelId)
  const outputReserveTokens = Math.max(
    512,
    Math.min(
      capability.maxOutputTokens,
      getPreferredOutputReserve(task),
      Math.floor(capability.contextWindow * 0.25),
    ),
  )
  const safetyReserveTokens = Math.max(256, Math.floor(capability.contextWindow * 0.03))
  const inputBudgetTokens = Math.max(
    1_024,
    capability.contextWindow - outputReserveTokens - safetyReserveTokens,
  )
  const threshold = Number.isFinite(config.contextCompactionThreshold)
    ? Math.min(0.9, Math.max(0.4, config.contextCompactionThreshold))
    : DEFAULT_COMPACTION_THRESHOLD

  return {
    ...capability,
    outputReserveTokens,
    safetyReserveTokens,
    inputBudgetTokens,
    compactionThresholdTokens: Math.floor(inputBudgetTokens * threshold),
  }
}

export function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_COMPACTION_THRESHOLD }
