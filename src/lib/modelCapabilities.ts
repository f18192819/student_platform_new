import type { ApiConfig } from '../types'

export type TokenizerFamily = 'cl100k' | 'deepseek'
export type ModelCapabilitySource = 'override' | 'runtime-registry' | 'bundled-registry' | 'fallback'
export type ContextTask = 'chat' | 'summary' | 'pipeline'
export type ModelUsageCapability = 'chat' | 'vision' | 'embedding' | 'rerank' | 'asr'
export type ModelProviderSlot = 'text' | 'doubt' | 'ocr' | 'embedding' | 'rerank' | 'asr'

export type DiscoveredModel = {
  id: string
  capabilities?: string[]
  input_modalities?: string[]
  output_modalities?: string[]
}

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
  softTargetTokens: number
  conversationBudgetTokens: number
  pinnedContextBudgetTokens: number
  retrievalBudgetTokens: number
  auxiliaryBudgetTokens: number
  compactionThresholdTokens: number
}

type RegistryCapability = {
  contextWindow?: number
  maxOutputTokens?: number
  capabilities: Set<ModelUsageCapability>
}

type SerializedRegistryCapability = {
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: ModelUsageCapability[]
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
        modalities?: {
          input?: string[]
          output?: string[]
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
const SOFT_TARGET_ANCHORS = [
  [32_768, 16_384],
  [65_536, 24_576],
  [131_072, 40_960],
  [262_144, 65_536],
  [524_288, 81_920],
  [1_048_576, 98_304],
] as const

// Keep a small offline registry for the models used by this project. The
// runtime models.dev registry can enrich this list without making startup
// dependent on an external service.
function registryCapability(
  contextWindow: number,
  maxOutputTokens: number,
  capabilities: ModelUsageCapability[] = ['chat'],
): RegistryCapability {
  return { contextWindow, maxOutputTokens, capabilities: new Set(capabilities) }
}

const BUNDLED_REGISTRY: Record<string, RegistryCapability> = {
  'deepseek-v4-flash': registryCapability(1_048_576, 393_216),
  'deepseek-v4-pro': registryCapability(1_048_576, 393_216),
  'deepseek-v3.2': registryCapability(131_072, 32_768),
  'deepseek-v3.1': registryCapability(131_072, 32_768),
  'deepseek-v3': registryCapability(131_072, 32_768),
  'deepseek-r1': registryCapability(131_072, 32_768),
  'minimax-m3': registryCapability(1_048_576, 131_072),
  'minimax-m2.7': registryCapability(204_800, 131_072),
  'minimax-m2.5': registryCapability(204_800, 131_072),
  'minimax-m2': registryCapability(204_800, 131_072),
  'minimax-text-01': registryCapability(1_000_192, 65_536),
  'glm-4.7': registryCapability(204_800, 131_072),
  'glm-4.6v': registryCapability(131_072, 32_768, ['chat', 'vision']),
  'glm-4.6': registryCapability(204_800, 131_072),
  'glm-4.5v': registryCapability(65_536, 16_384, ['chat', 'vision']),
  'glm-4.5': registryCapability(131_072, 98_304),
  'glm-4-long': registryCapability(1_000_000, 128_000),
  'gpt-5': registryCapability(400_000, 128_000),
  'gpt-4.1': registryCapability(1_047_576, 32_768),
  'gpt-4o': registryCapability(128_000, 16_384, ['chat', 'vision']),
  'claude-opus-4': registryCapability(200_000, 64_000),
  'claude-sonnet-4': registryCapability(200_000, 64_000),
  'gemini-3': registryCapability(1_048_576, 65_536),
  'gemini-2.5': registryCapability(1_048_576, 65_536),
}

let runtimeRegistry: Record<string, RegistryCapability> = {}
let prefetchPromise: Promise<void> | null = null

function normalizeModelId(modelId: string) {
  return modelId.trim().toLowerCase()
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function normalizedValues(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string').map((value) => value.trim().toLowerCase()).filter(Boolean)
    : []
}

function capabilitiesFromModalities(input: unknown, output: unknown) {
  const inputModalities = new Set(normalizedValues(input))
  const outputModalities = new Set(normalizedValues(output))
  const capabilities = new Set<ModelUsageCapability>()
  if (inputModalities.has('image')) capabilities.add('vision')
  if (inputModalities.has('text') && outputModalities.has('text')) capabilities.add('chat')
  return capabilities
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

export function transformModelsDevPayload(payload: ModelsDevPayload) {
  const transformed: Record<string, RegistryCapability> = {}
  for (const provider of Object.values(payload)) {
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      const modelId = normalizeModelId(model.id || key)
      const contextWindow = model.limit?.context
      const maxOutputTokens = model.limit?.output
      const capabilities = capabilitiesFromModalities(
        model.modalities?.input,
        model.modalities?.output,
      )
      if (!modelId || (!isPositiveInteger(contextWindow) && capabilities.size === 0)) continue
      const existing = transformed[modelId]
      const knownContexts = [existing?.contextWindow, contextWindow].filter(isPositiveInteger)
      const knownOutputs = [existing?.maxOutputTokens, maxOutputTokens].filter(isPositiveInteger)
      transformed[modelId] = {
        contextWindow: knownContexts.length ? Math.min(...knownContexts) : undefined,
        maxOutputTokens: knownOutputs.length ? Math.min(...knownOutputs) : undefined,
        capabilities: new Set([...(existing?.capabilities ?? []), ...capabilities]),
      }
    }
  }
  return transformed
}

function serializeRegistry(registry: Record<string, RegistryCapability>) {
  return Object.fromEntries(Object.entries(registry).map(([modelId, capability]) => [modelId, {
    contextWindow: capability.contextWindow,
    maxOutputTokens: capability.maxOutputTokens,
    capabilities: [...capability.capabilities],
  } satisfies SerializedRegistryCapability]))
}

function deserializeRegistry(value: unknown): Record<string, RegistryCapability> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const registry: Record<string, RegistryCapability> = {}
  for (const [modelId, rawCapability] of Object.entries(value)) {
    if (!rawCapability || typeof rawCapability !== 'object' || Array.isArray(rawCapability)) continue
    const serialized = rawCapability as SerializedRegistryCapability
    registry[modelId] = {
      contextWindow: isPositiveInteger(serialized.contextWindow) ? serialized.contextWindow : undefined,
      maxOutputTokens: isPositiveInteger(serialized.maxOutputTokens) ? serialized.maxOutputTokens : undefined,
      capabilities: new Set(
        normalizedValues(serialized.capabilities).filter(
          (item): item is ModelUsageCapability => ['chat', 'vision', 'embedding', 'rerank', 'asr'].includes(item),
        ),
      ),
    }
  }
  return registry
}

function loadCachedRegistry() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(REGISTRY_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      timestamp?: number
      registry?: Record<string, SerializedRegistryCapability>
    }
    const registry = deserializeRegistry(parsed.registry)
    if (!registry || typeof parsed.timestamp !== 'number') return null
    runtimeRegistry = registry
    return { timestamp: parsed.timestamp, registry }
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
        JSON.stringify({ timestamp: Date.now(), registry: serializeRegistry(registry) }),
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

const SLOT_CAPABILITY: Record<ModelProviderSlot, ModelUsageCapability> = {
  text: 'chat',
  doubt: 'chat',
  ocr: 'vision',
  embedding: 'embedding',
  rerank: 'rerank',
  asr: 'asr',
}

function addCapabilitiesFromLabels(
  target: Set<ModelUsageCapability>,
  values: unknown,
) {
  for (const value of normalizedValues(values)) {
    if (/(^|[/.:-])(embedding|embeddings|embed)([/.:-]|$)/.test(value)) target.add('embedding')
    if (/(^|[/.:-])(rerank|reranker)([/.:-]|$)/.test(value)) target.add('rerank')
    if (/(^|[/.:-])(asr|whisper|paraformer|transcription|speech-to-text)([/.:-]|$)/.test(value)) target.add('asr')
    if (/(^|[/.:-])(vision|image|multimodal)([/.:-]|$)/.test(value)) target.add('vision')
    if (value === 'chat' || value.includes('chat/completions') || value.includes('text-generation')) {
      target.add('chat')
    }
  }
}

function providerUsageCapabilities(model: DiscoveredModel) {
  const hasMetadata = model.capabilities !== undefined
    || model.input_modalities !== undefined
    || model.output_modalities !== undefined
  const capabilities = new Set<ModelUsageCapability>()
  addCapabilitiesFromLabels(capabilities, model.capabilities)
  const modalities = capabilitiesFromModalities(model.input_modalities, model.output_modalities)
  modalities.forEach((capability) => capabilities.add(capability))
  return { hasMetadata, capabilities }
}

function heuristicUsageCapabilities(modelId: string) {
  const normalized = normalizeModelId(modelId)
  const capabilities = new Set<ModelUsageCapability>()
  if (/(^|[-_.:/])(embedding|embed)([-_.:/]|$)/.test(normalized)) {
    capabilities.add('embedding')
    return capabilities
  }
  if (/(^|[-_.:/])(rerank|reranker)([-_.:/]|$)/.test(normalized)) {
    capabilities.add('rerank')
    return capabilities
  }
  if (/(^|[-_.:/])(whisper|paraformer|speech-to-text|transcription|asr)([-_.:/]|$)/.test(normalized)) {
    capabilities.add('asr')
    return capabilities
  }
  if (
    /(^|[-_.:/])(vision|multimodal|ocr)([-_.:/]|$)/.test(normalized)
    || /(?:^|[-_])vl(?:$|[-_.:/])/.test(normalized)
    || normalized.includes('qwen-vl')
    || normalized.includes('internvl')
    || normalized.includes('pixtral')
    || normalized === 'glm-4.6v'
    || normalized === 'glm-4.5v'
  ) {
    capabilities.add('vision')
  }
  return capabilities
}

export function resolveModelUsageCapabilities(model: DiscoveredModel | string) {
  const discovered = typeof model === 'string' ? { id: model } : model
  const provider = providerUsageCapabilities(discovered)
  if (provider.hasMetadata) return provider.capabilities

  const runtime = findByExactOrPrefix(discovered.id, runtimeRegistry)
  if (runtime?.capabilities.size) return new Set(runtime.capabilities)
  const bundled = findByExactOrPrefix(discovered.id, BUNDLED_REGISTRY)
  if (bundled?.capabilities.size) return new Set(bundled.capabilities)
  return heuristicUsageCapabilities(discovered.id)
}

export function filterModelsForSlot(models: DiscoveredModel[], slot: ModelProviderSlot) {
  const required = SLOT_CAPABILITY[slot]
  return models.filter((model) => resolveModelUsageCapabilities(model).has(required))
}

export function partitionModelsForSlot(models: DiscoveredModel[], slot: ModelProviderSlot) {
  const recommended = filterModelsForSlot(models, slot)
  const recommendedIds = new Set(recommended.map((model) => model.id))
  return {
    recommended,
    unknown: models.filter((model) => !recommendedIds.has(model.id)),
    total: models.length,
  }
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

export function resolveSoftTargetTokens(contextWindow: number) {
  const normalizedWindow = Math.max(4_096, Math.floor(contextWindow))
  if (normalizedWindow <= SOFT_TARGET_ANCHORS[0][0]) {
    return Math.min(normalizedWindow, Math.floor(normalizedWindow * 0.5))
  }
  for (let index = 1; index < SOFT_TARGET_ANCHORS.length; index += 1) {
    const [rightWindow, rightTarget] = SOFT_TARGET_ANCHORS[index]
    if (normalizedWindow > rightWindow) continue
    const [leftWindow, leftTarget] = SOFT_TARGET_ANCHORS[index - 1]
    const progress = (normalizedWindow - leftWindow) / (rightWindow - leftWindow)
    return Math.round(leftTarget + (rightTarget - leftTarget) * progress)
  }
  return SOFT_TARGET_ANCHORS[SOFT_TARGET_ANCHORS.length - 1][1]
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
  const softTargetTokens = Math.min(inputBudgetTokens, resolveSoftTargetTokens(capability.contextWindow))
  const conversationBudgetTokens = Math.floor(softTargetTokens * 0.15)
  const pinnedContextBudgetTokens = Math.floor(softTargetTokens * 0.25)
  const retrievalBudgetTokens = Math.floor(softTargetTokens * 0.5)
  const auxiliaryBudgetTokens = Math.floor(softTargetTokens * 0.05)
  const threshold = Number.isFinite(config.contextCompactionThreshold)
    ? Math.min(0.9, Math.max(0.4, config.contextCompactionThreshold))
    : DEFAULT_COMPACTION_THRESHOLD

  return {
    ...capability,
    outputReserveTokens,
    safetyReserveTokens,
    inputBudgetTokens,
    softTargetTokens,
    conversationBudgetTokens,
    pinnedContextBudgetTokens,
    retrievalBudgetTokens,
    auxiliaryBudgetTokens,
    compactionThresholdTokens: Math.min(
      Math.floor(inputBudgetTokens * threshold),
      conversationBudgetTokens,
    ),
  }
}

export function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_COMPACTION_THRESHOLD }
