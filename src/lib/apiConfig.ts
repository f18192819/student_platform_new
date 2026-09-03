import type { ApiConfig } from '../types'
import {
  DEFAULT_COMPACTION_THRESHOLD,
  prefetchModelCapabilities,
  type DiscoveredModel,
} from './modelCapabilities'

export const API_CONFIG_STORAGE_KEY = 'student-platform.api-config'
export const DEFAULT_DEEPSEEK_WEB_BRIDGE_URL = 'http://127.0.0.1:8765'

export const defaultApiConfig: ApiConfig = {
  baseUrl: 'https://llmapi.paratera.com/v1',
  apiKey: '',
  model: 'GLM-4.6V',
  models: ['GLM-4.6V'],
  ocrBaseUrl: 'https://llmapi.paratera.com/v1',
  ocrApiKey: '',
  ocrModel: 'GLM-4.6V',
  ocrModels: ['GLM-4.6V'],
  ocrProvider: 'api',
  doubtModel: 'GLM-4.6V',
  doubtModels: ['GLM-4.6V'],
  doubtProvider: 'api',
  deepseekWebBridgeUrl: DEFAULT_DEEPSEEK_WEB_BRIDGE_URL,
  contextWindowOverrides: {},
  contextCompactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
  embeddingBaseUrl: 'https://llmapi.paratera.com/v1',
  embeddingApiKey: '',
  embeddingModel: 'GLM-Embedding-3',
  embeddingModels: ['GLM-Embedding-3'],
  rerankBaseUrl: 'https://llmapi.paratera.com/v1',
  rerankApiKey: '',
  rerankModel: 'GLM-Rerank',
  rerankModels: ['GLM-Rerank'],
  neo4jEnabled: false,
  neo4jAutoStart: true,
  neo4jHome: '',
  neo4jUri: 'bolt://127.0.0.1:7687',
  neo4jUsername: '',
  neo4jPassword: '',
  neo4jDatabase: 'neo4j',
  homeworkSplitModel: 'GLM-4.6V',
  systemPrompt:
    '你是一个课堂学习助手。请只根据用户提供的课堂资料回答，不要编造资料中不存在的内容。你的输出必须是可直接渲染的 Markdown 正文，不要写“回答草稿”“资料依据”“参考资料”“总结如下”这类包装性标题。回答要条理清晰：优先先给简短结论，再用有序列表或无序列表展开关键点；若资料不足，要明确说明缺失点。',
  asrBaseUrl: 'local://conda-funasr',
  asrApiKey: 'local',
  asrModel: 'paraformer-zh',
  asrPrompt: '',
}

function normalizeModels(rawModels: unknown, selectedModel: unknown, fallbackModel: string) {
  const models = Array.isArray(rawModels) ? rawModels : []
  const fallback =
    typeof selectedModel === 'string' && selectedModel.trim()
      ? selectedModel.trim()
      : fallbackModel

  const normalized = models.filter((model): model is string => typeof model === 'string').map((model) => model.trim()).filter(Boolean)
  const uniqueModels = Array.from(new Set(normalized.length ? normalized : [fallback]))
  const activeModel = uniqueModels.includes(fallback) ? fallback : uniqueModels[0]

  return {
    models: uniqueModels,
    model: activeModel,
  }
}

function normalizeContextWindowOverrides(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const normalized: Record<string, number> = {}
  for (const [modelId, rawWindow] of Object.entries(value)) {
    const contextWindow = Number(rawWindow)
    if (modelId.trim() && Number.isFinite(contextWindow) && contextWindow >= 4_096) {
      normalized[modelId.trim()] = Math.round(contextWindow)
    }
  }
  return normalized
}

function normalizeCompactionThreshold(value: unknown) {
  const threshold = Number(value)
  return Number.isFinite(threshold)
    ? Math.min(0.9, Math.max(0.4, threshold))
    : DEFAULT_COMPACTION_THRESHOLD
}

function normalizeApiConfig(input: Partial<ApiConfig>): ApiConfig {
  const textModels = normalizeModels(input.models, input.model, defaultApiConfig.model)
  const ocrModels = normalizeModels(input.ocrModels, input.ocrModel, defaultApiConfig.ocrModel)
  const doubtModels = normalizeModels(input.doubtModels, input.doubtModel, textModels.model)
  const embeddingModels = normalizeModels(input.embeddingModels, input.embeddingModel, defaultApiConfig.embeddingModel)
  const rerankModels = normalizeModels(input.rerankModels, input.rerankModel, defaultApiConfig.rerankModel)
  return {
    baseUrl: input.baseUrl ?? '',
    apiKey: input.apiKey ?? '',
    model: textModels.model,
    models: textModels.models,
    ocrBaseUrl: input.ocrBaseUrl ?? input.baseUrl ?? '',
    ocrApiKey: input.ocrApiKey ?? input.apiKey ?? '',
    ocrModel: ocrModels.model,
    ocrModels: ocrModels.models,
    ocrProvider: input.ocrProvider === 'deepseek-web' ? 'deepseek-web' : 'api',
    doubtModel: doubtModels.model,
    doubtModels: doubtModels.models,
    doubtProvider: input.doubtProvider === 'deepseek-web' ? 'deepseek-web' : 'api',
    deepseekWebBridgeUrl: input.deepseekWebBridgeUrl?.trim() || DEFAULT_DEEPSEEK_WEB_BRIDGE_URL,
    contextWindowOverrides: normalizeContextWindowOverrides(input.contextWindowOverrides),
    contextCompactionThreshold: normalizeCompactionThreshold(input.contextCompactionThreshold),
    // Existing installations only have text credentials, so use them as the provider fallback.
    embeddingBaseUrl: input.embeddingBaseUrl ?? input.baseUrl ?? '',
    embeddingApiKey: input.embeddingApiKey ?? input.apiKey ?? '',
    embeddingModel: embeddingModels.model,
    embeddingModels: embeddingModels.models,
    rerankBaseUrl: input.rerankBaseUrl ?? input.baseUrl ?? '',
    rerankApiKey: input.rerankApiKey ?? input.apiKey ?? '',
    rerankModel: rerankModels.model,
    rerankModels: rerankModels.models,
    neo4jEnabled: input.neo4jEnabled === true,
    neo4jAutoStart: input.neo4jAutoStart !== false,
    neo4jHome: input.neo4jHome ?? '',
    neo4jUri: input.neo4jUri ?? 'bolt://127.0.0.1:7687',
    neo4jUsername: input.neo4jUsername ?? '',
    neo4jPassword: input.neo4jPassword ?? '',
    neo4jDatabase: input.neo4jDatabase ?? 'neo4j',
    // All text workflows use the active chat model. Retain this field only for old data compatibility.
    homeworkSplitModel: textModels.model,
    systemPrompt: input.systemPrompt ?? defaultApiConfig.systemPrompt,
    asrBaseUrl: input.asrBaseUrl ?? defaultApiConfig.asrBaseUrl,
    asrApiKey: input.asrApiKey ?? defaultApiConfig.asrApiKey,
    asrModel: input.asrModel ?? defaultApiConfig.asrModel,
    asrPrompt: input.asrPrompt ?? defaultApiConfig.asrPrompt,
  }
}

function resolveConfigApiUrl() {
  if (typeof window === 'undefined') {
    return '/api/config'
  }

  const runtime = (window as typeof window & {
    __OCTOPUS_SERVICE__?: { apiBase?: string; serviceId?: string; uuid?: string }
  }).__OCTOPUS_SERVICE__
  const apiBase = typeof runtime?.apiBase === 'string' ? runtime.apiBase.trim() : ''
  if (apiBase.startsWith('/')) {
    return `${apiBase.replace(/\/+$/, '')}/api/config`
  }

  const serviceKey =
    (typeof runtime?.uuid === 'string' && runtime.uuid.trim()) ||
    (typeof runtime?.serviceId === 'string' && runtime.serviceId.trim()) ||
    ''
  return serviceKey ? `/api/v1/service/${serviceKey}/api/config` : '/api/config'
}

export function resolveBackendApiUrl(path = '') {
  if (typeof window === 'undefined') {
    return path || '/api'
  }

  const runtime = (window as typeof window & {
    __OCTOPUS_SERVICE__?: { apiBase?: string; serviceId?: string; uuid?: string }
  }).__OCTOPUS_SERVICE__
  const apiBase = typeof runtime?.apiBase === 'string' ? runtime.apiBase.trim() : ''
  if (apiBase.startsWith('/')) {
    return `${apiBase.replace(/\/+$/, '')}${path}`
  }

  const serviceKey =
    (typeof runtime?.uuid === 'string' && runtime.uuid.trim()) ||
    (typeof runtime?.serviceId === 'string' && runtime.serviceId.trim()) ||
    ''
  return serviceKey ? `/api/v1/service/${serviceKey}${path}` : path
}

export function loadApiConfig(): ApiConfig {
  void prefetchModelCapabilities()
  if (typeof window === 'undefined') {
    return defaultApiConfig
  }

  try {
    const raw = window.localStorage.getItem(API_CONFIG_STORAGE_KEY)
    if (!raw) {
      return defaultApiConfig
    }

    const parsed = JSON.parse(raw) as Partial<ApiConfig>
    return normalizeApiConfig(parsed)
  } catch {
    return defaultApiConfig
  }
}

export function saveApiConfig(config: ApiConfig) {
  const normalized = normalizeApiConfig(config)
  window.localStorage.setItem(
    API_CONFIG_STORAGE_KEY,
    JSON.stringify(normalized),
  )
}

export async function loadApiConfigFromServer(): Promise<ApiConfig | null> {
  const response = await fetch(resolveConfigApiUrl())
  if (!response.ok) {
    throw new Error(`Unable to load server API configuration (HTTP ${response.status}).`)
  }

  const payload = (await response.json()) as { configured?: boolean; config?: Partial<ApiConfig> | null }
  if (!payload.configured || !payload.config) {
    return null
  }

  const config = normalizeApiConfig(payload.config)
  saveApiConfig(config)
  return config
}

export async function saveApiConfigToServer(config: ApiConfig): Promise<ApiConfig> {
  const normalized = normalizeApiConfig(config)
  const response = await fetch(resolveConfigApiUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    config?: Partial<ApiConfig>
    detail?: string
  }
  if (!response.ok || !payload.config) {
    throw new Error(payload.detail || `Unable to save server API configuration (HTTP ${response.status}).`)
  }

  const saved = normalizeApiConfig(payload.config)
  saveApiConfig(saved)
  return saved
}

export async function fetchProviderModels(baseUrl: string, apiKey: string) {
  const response = await fetch(resolveBackendApiUrl('/api/provider-models'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: baseUrl.trim(), api_key: apiKey.trim() }),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    models?: unknown
    discovered_models?: unknown
    count?: number
    detail?: string
  }
  if (!response.ok) {
    throw new Error(payload.detail || `获取模型列表失败 (HTTP ${response.status})`)
  }
  const modelsById = new Map<string, DiscoveredModel>()
  const discoveredModels = Array.isArray(payload.discovered_models)
    ? payload.discovered_models
    : payload.models
  if (Array.isArray(discoveredModels)) {
    for (const rawModel of discoveredModels) {
      const model = typeof rawModel === 'string'
        ? { id: rawModel.trim() }
        : normalizeDiscoveredModel(rawModel)
      if (!model?.id) continue
      const existing = modelsById.get(model.id)
      modelsById.set(model.id, existing ? mergeDiscoveredModels(existing, model) : model)
    }
  }
  const models = [...modelsById.values()]
  if (!models.length) {
    throw new Error('模型服务没有返回可选择的模型。')
  }
  return models
}

function normalizeDiscoveredModel(value: unknown): DiscoveredModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id) return null
  const stringArray = (raw: unknown) => Array.isArray(raw)
    ? Array.from(new Set(raw.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim().toLowerCase()).filter(Boolean)))
    : undefined
  return {
    id,
    mode: typeof item.mode === 'string' ? item.mode.trim().toLowerCase() || undefined : undefined,
    type: typeof item.type === 'string' ? item.type.trim().toLowerCase() || undefined : undefined,
    capabilities: stringArray(item.capabilities),
    supported_endpoints: stringArray(item.supported_endpoints),
    input_modalities: stringArray(item.input_modalities),
    output_modalities: stringArray(item.output_modalities),
  }
}

function mergeDiscoveredModels(left: DiscoveredModel, right: DiscoveredModel): DiscoveredModel {
  const merge = (first?: string[], second?: string[]) => {
    const values = Array.from(new Set([...(first ?? []), ...(second ?? [])]))
    return values.length ? values : undefined
  }
  return {
    id: left.id,
    mode: left.mode ?? right.mode,
    type: left.type ?? right.type,
    capabilities: merge(left.capabilities, right.capabilities),
    supported_endpoints: merge(left.supported_endpoints, right.supported_endpoints),
    input_modalities: merge(left.input_modalities, right.input_modalities),
    output_modalities: merge(left.output_modalities, right.output_modalities),
  }
}

export function hasUsableApiConfig(config: ApiConfig) {
  return Boolean(
    config.baseUrl.trim() &&
      config.apiKey.trim() &&
      (config.model.trim() || config.models.some((model) => model.trim())),
  )
}

export type DeepSeekWebBridgeStatus = {
  browser_running: boolean
  logged_in: boolean
  chat_available: boolean
  image_upload_available: boolean
}

async function readBridgeResponse(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as {
    detail?: string | { code?: string; message?: string }
  }
  if (!response.ok) {
    const detail = payload.detail
    const message = typeof detail === 'string' ? detail : detail?.message
    throw new Error(message || `DeepSeek Web Bridge request failed (HTTP ${response.status}).`)
  }
  return payload
}

export async function fetchDeepSeekWebBridgeStatus(): Promise<DeepSeekWebBridgeStatus> {
  const response = await fetch(resolveBackendApiUrl('/api/deepseek-web/status'))
  return (await readBridgeResponse(response)) as DeepSeekWebBridgeStatus
}

export async function openDeepSeekWebBridge(bridgeUrl: string) {
  const response = await fetch(resolveBackendApiUrl('/api/deepseek-web/open'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bridge_url: bridgeUrl.trim() }),
  })
  return readBridgeResponse(response)
}

export function hasUsableAsrConfig(config: ApiConfig) {
  return Boolean(config.asrBaseUrl.trim() && config.asrApiKey.trim() && config.asrModel.trim())
}
